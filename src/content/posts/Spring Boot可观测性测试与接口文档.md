---
title: Spring Boot 可观测性、测试体系与 OpenAPI 接口文档
published: 2026-06-25
description: 从日志、指标和追踪出发，介绍 Actuator、MDC 请求标识、慢请求观测，并用 Mockito、MockMvc、容器化集成测试和 springdoc 建立质量反馈链路。
tags: [实习, 后端开发, Spring Boot, 可观测性, 自动化测试, OpenAPI]
category: 后端开发
image: https://img.asyore.cn/fengmian/EMT66.webp
slug: spring-boot-observability-testing-openapi
---

一个接口在本地调用成功，并不代表它进入测试和生产环境后仍然容易维护。出现故障时，需要知道哪一个请求、经过哪些服务、在哪个 SQL 或外部调用上变慢；修改代码时，需要测试快速反馈行为是否被破坏；交给前端时，需要接口文档准确表达参数和错误。可观测性、测试和文档其实共同解决“系统行为能否被理解和验证”的问题。

## 1. 可观测性的三个互补信号

通常把可观测性分为：

- **日志（Logs）**：记录离散事件和上下文，适合回答某次请求发生了什么；
- **指标（Metrics）**：记录可聚合数字，适合回答整体错误率、吞吐量和延迟是否异常；
- **追踪（Traces）**：记录一次请求跨组件的调用路径，适合定位时间花在哪里。

只记录日志会难以观察趋势；只有指标又看不到具体失败原因；追踪没有业务字段时也很难关联订单。三者通过统一的请求标识、服务名和环境标签连接起来，才能形成完整视图。

## 2. 为每个请求生成追踪 ID

单体应用也需要请求 ID。可以在过滤器中读取上游标识，没有则生成新的：

```java
@Component
public class TraceIdFilter extends OncePerRequestFilter {

    private static final String TRACE_ID = "traceId";

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {

        String traceId = request.getHeader("X-Trace-Id");
        if (!StringUtils.hasText(traceId)) {
            traceId = UUID.randomUUID().toString().replace("-", "");
        }

        try {
            MDC.put(TRACE_ID, traceId);
            response.setHeader("X-Trace-Id", traceId);
            chain.doFilter(request, response);
        } finally {
            MDC.remove(TRACE_ID);
        }
    }
}
```

日志格式加入 `%X{traceId}` 后，同一次请求的 Controller、Service 和 Mapper 日志就可以关联检索。响应头返回同一标识，前端反馈错误时可以直接提供它。

必须在 `finally` 清理 MDC。Web 容器线程会重复使用，不清理会让后续请求继承旧标识。异步线程也需要通过 `TaskDecorator` 显式传播并清理上下文。

## 3. 日志应该记录什么

一条有用的业务日志通常包含事件名称、业务标识、结果、耗时和必要上下文：

```java
long start = System.nanoTime();
try {
    deliveryService.dispatch(orderId);
    log.info("delivery_dispatch_success orderId={} costMs={}",
        orderId,
        elapsedMillis(start));
} catch (Exception e) {
    log.error("delivery_dispatch_failed orderId={} costMs={}",
        orderId,
        elapsedMillis(start),
        e);
    throw e;
}
```

错误日志要保留异常堆栈，不能只打印 `e.getMessage()`。但日志也不是越多越好：循环内逐条打印大对象会显著增加 I/O，完整请求体可能包含密码、Token、手机号或文件内容。应为敏感字段建立统一脱敏规则。

面向机器分析时，稳定字段比自然语言更有价值。无论使用 JSON 日志还是键值文本，都应保持 `orderId`、`costMs`、`result` 等字段命名一致。

## 4. 用统一入口观测请求耗时

可以通过拦截器或过滤器记录 URI、状态码和耗时：

```java
public class RequestTimingInterceptor
        implements HandlerInterceptor {

    private static final String START_TIME = "requestStartTime";

    @Override
    public boolean preHandle(
            HttpServletRequest request,
            HttpServletResponse response,
            Object handler) {
        request.setAttribute(START_TIME, System.nanoTime());
        return true;
    }

    @Override
    public void afterCompletion(
            HttpServletRequest request,
            HttpServletResponse response,
            Object handler,
            Exception ex) {
        long start = (long) request.getAttribute(START_TIME);
        long costMs = TimeUnit.NANOSECONDS.toMillis(
            System.nanoTime() - start);
        log.info("http_request method={} uri={} status={} costMs={}",
            request.getMethod(),
            request.getRequestURI(),
            response.getStatus(),
            costMs);
    }
}
```

URI 指标不能直接使用包含订单号的真实路径，否则每个 ID 都会变成一个独立标签，造成高基数。应尽量记录路由模板，如 `/orders/{id}`，日志中再保留具体业务 ID。

## 5. Actuator 提供运行时观察入口

引入 Actuator 后，可以按需开放健康、指标和信息端点：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  endpoint:
    health:
      show-details: when_authorized
```

健康端点适合部署平台判断实例状态，指标端点可以输出 JVM、HTTP、连接池和自定义业务指标。端点可能暴露环境、Bean 或线程信息，因此必须遵循最小暴露原则，并使用内网、网关或认证保护。

## 6. 自定义业务指标比只看 CPU 更有意义

CPU 正常并不代表业务正常。可以记录订单调度成功与失败：

```java
@Service
public class DeliveryMetrics {

    private final Counter dispatchSuccess;
    private final Counter dispatchFailure;

    public DeliveryMetrics(MeterRegistry registry) {
        this.dispatchSuccess = Counter.builder("delivery.dispatch.total")
            .tag("result", "success")
            .register(registry);
        this.dispatchFailure = Counter.builder("delivery.dispatch.total")
            .tag("result", "failure")
            .register(registry);
    }
}
```

标签值必须是有限集合，例如 `success`、`failure`。不要把订单号、用户 ID 或异常消息作为指标标签，否则时间序列数量会不断增长。具体订单放日志和追踪，聚合维度放指标。

还可以观测订单处理延迟、第三方调用耗时、Redis 命中率、线程池队列长度和定时任务最后成功时间。告警应尽可能接近用户影响，例如连续五分钟订单调度失败率超过阈值，而不是仅仅监控进程是否存在。

## 7. 测试体系按反馈速度分层

后端测试可以分为：

1. 纯单元测试：不启动 Spring，验证业务分支，速度最快；
2. Controller 切片测试：只加载 MVC 和相关组件，验证协议、校验与响应；
3. Mapper/数据库集成测试：验证 SQL、事务和数据库方言；
4. 完整应用测试：验证多个模块共同工作；
5. 少量端到端测试：从真实入口覆盖核心用户路径。

层次越高，真实性越强，但启动更慢、故障定位更难。大部分业务分支应在快速测试中覆盖，把少量集成测试留给框架配置和基础设施边界。

## 8. 使用 Mockito 验证 Service 业务规则

订单只能从待接单进入配送中，可以在不启动 Spring 的情况下测试：

```java
@ExtendWith(MockitoExtension.class)
class DeliveryOrderServiceTest {

    @Mock
    private DeliveryOrderMapper orderMapper;

    @InjectMocks
    private DeliveryOrderServiceImpl orderService;

    @Test
    void shouldRejectDispatchWhenOrderIsCompleted() {
        DeliveryOrder order = new DeliveryOrder();
        order.setId(10L);
        order.setStatus(OrderStatus.COMPLETED.getCode());
        when(orderMapper.selectById(10L)).thenReturn(order);

        ServiceException exception = assertThrows(
            ServiceException.class,
            () -> orderService.dispatch(10L));

        assertEquals("当前状态不允许调度", exception.getMessage());
        verify(orderMapper, never()).updateStatus(anyLong(), anyInt(), anyInt());
    }
}
```

这个测试同时验证输出和副作用：异常消息符合预期，而且 Mapper 没有执行更新。单元测试不应过度验证内部每一步调用，否则重构实现时会产生大量无意义修改；应围绕可观察业务行为断言。

## 9. 使用 MockMvc 验证接口协议

Controller 测试关注路径、HTTP 方法、JSON、参数校验和权限响应：

```java
@WebMvcTest(WxUserAddressController.class)
class WxUserAddressControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private WxUserAddressService addressService;

    @Test
    void shouldReturnValidationErrorWhenPhoneIsInvalid()
            throws Exception {
        String body = """
            {
              "receiverName": "张三",
              "receiverPhone": "123",
              "provinceId": 1,
              "detailAddress": "测试地址"
            }
            """;

        mockMvc.perform(post("/manage/user/address")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(500))
            .andExpect(jsonPath("$.msg").value("手机号格式不正确"));

        verifyNoInteractions(addressService);
    }
}
```

如果项目统一用 HTTP 200 包装业务错误，测试应准确反映现有协议；从长期设计看，也可以逐步使用 400、401、403、404 和 409 等标准状态码，让网关和客户端更容易判断错误类型。

启用 Security 后，测试还应覆盖未登录、无权限和合法身份。不要为了让测试通过而整体关闭过滤器，否则最关键的安全链路没有被验证。

## 10. 数据库测试应使用真实方言

MyBatis XML 可能使用 MySQL 的函数、分页和锁语法。H2 等内存数据库即使能运行，也不能完整代表生产数据库。可以使用 Testcontainers 启动临时 MySQL：

```java
@Testcontainers
@SpringBootTest
class DeliveryOrderMapperIT {

    @Container
    static MySQLContainer<?> mysql =
        new MySQLContainer<>("mysql:8.4")
            .withDatabaseName("uav_test");

    @DynamicPropertySource
    static void datasourceProperties(
            DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", mysql::getJdbcUrl);
        registry.add("spring.datasource.username", mysql::getUsername);
        registry.add("spring.datasource.password", mysql::getPassword);
    }
}
```

测试结束后容器销毁，环境可重复。数据库迁移脚本也应作为测试启动过程的一部分，这样可以同时发现“代码期待的表结构”和“部署脚本实际创建的结构”不一致。

本段是可继续引入的工程化方案，并不表示所有项目已经配置 Testcontainers；采用前要结合现有构建环境和 CI 容器能力。

## 11. 测试数据应表达业务场景

不要只创建一个所有字段均为默认值的实体。关键场景应明确命名：

- `pendingOrderOwnedByCurrentUser`；
- `completedOrderCannotBeCancelled`；
- `deletedAddressShouldNotBeReturned`；
- `sameRequestShouldNotCreateDuplicateFeedback`。

通过测试数据构造器集中填充不重要字段，让测试正文突出业务差异。每个测试独立准备数据，避免依赖执行顺序和共享可变状态。

## 12. OpenAPI 文档从 DTO 开始

Springdoc 可以根据 Controller 和 DTO 生成 OpenAPI 文档。接口注解描述操作，模型注解描述字段：

```java
@Tag(name = "微信用户地址")
@RestController
@RequestMapping("/manage/user/address")
public class WxUserAddressController {

    @Operation(summary = "新增收货地址")
    @PostMapping
    public AjaxResult create(
            @Valid @RequestBody AddressCreateRequest request) {
        return success(addressService.create(request));
    }
}
```

```java
@Schema(description = "新增收货地址请求")
public class AddressCreateRequest {

    @Schema(description = "收件人姓名", example = "张三")
    @NotBlank
    private String receiverName;

    @Schema(description = "中国大陆手机号", example = "13800138000")
    @Pattern(regexp = "^1[3-9]\\d{9}$")
    private String receiverPhone;
}
```

文档不能替代参数校验。`@Schema` 告诉调用者应该传什么，`@NotBlank`、`@Pattern` 才会在运行时拒绝非法输入。将二者都写在 DTO 上，可以减少文档和实现漂移。

## 13. 统一响应也要被准确描述

如果所有接口都返回 `AjaxResult`，文档只显示一个自由结构 Map，调用者无法知道 `data` 内容。可以为具体接口定义泛型响应或专用响应 DTO：

```java
public class ApiResponse<T> {
    private Integer code;
    private String message;
    private T data;
}

public class AddressDetailResponse {
    private Long id;
    private String receiverName;
    private String receiverPhone;
    private String fullAddress;
}
```

即使现阶段仍使用统一包装，也应在 `@ApiResponse` 中描述常见错误：参数错误、未认证、无权限、资源不存在和状态冲突。错误码是一项对前端的稳定契约，不能随异常消息临时变化。

## 14. 文档访问也需要安全边界

开发和测试环境可以开放 Swagger UI，生产环境应根据实际需求决定是否启用。若需要开放，应经过身份验证、网络限制或网关保护，避免直接暴露所有内部管理接口。

示例请求中不要填写真实手机号、密钥和 Token。第三方签名接口尤其要避免把 Secret 放进文档默认值。

## 15. 把日志、测试与文档串成反馈闭环

一次功能迭代可以形成这样的链路：

1. DTO 和 OpenAPI 定义输入输出契约；
2. Controller 测试验证协议和校验；
3. Service 单元测试验证业务分支；
4. Mapper 集成测试验证 SQL 和事务；
5. 上线后指标观察成功率和耗时；
6. 异常通过 traceId 定位日志和具体业务记录；
7. 线上问题沉淀为新的自动化测试，防止回归。

这比单独追求覆盖率数字更有价值。覆盖率只能说明代码被执行过，不能证明关键规则被正确断言。

## 16. 常见误区

- 只在异常时打一句消息，没有堆栈和业务标识；
- 指标标签使用订单号，导致监控系统时间序列爆炸；
- 测试中大量使用 `@SpringBootTest`，反馈过慢且难定位；
- Controller 测试关闭全部安全过滤器；
- 使用内存数据库验证生产 MySQL 特有 SQL；
- 文档直接暴露实体类，连内部状态和逻辑删除字段也成为输入；
- Swagger 示例保存真实敏感信息；
- 只看代码覆盖率，不验证状态流转、越权和幂等。

## 17. 实践检查清单

- 每个请求是否有可返回给调用者的追踪 ID；
- 日志是否包含业务标识、结果与耗时且完成脱敏；
- 是否观测 HTTP、数据库、Redis、线程池和第三方调用；
- 指标标签是否为有限集合；
- 核心业务规则是否有快速单元测试；
- 安全、校验和异常格式是否有 Controller 测试；
- 关键 SQL 是否使用真实数据库方言验证；
- OpenAPI 是否使用专用 DTO 描述输入输出；
- 常见错误码是否有稳定说明；
- 线上故障修复后是否增加对应回归测试。

## 18. 小结

可观测性让运行中的系统可以被解释，测试让修改后的系统可以被验证，OpenAPI 让系统边界可以被协作方理解。日志、指标、追踪、分层测试与 DTO 文档不是上线后的附属品，而是后端工程质量的一部分。把它们围绕同一业务契约组织起来，问题才能更快暴露、更快定位，也更不容易再次出现。
