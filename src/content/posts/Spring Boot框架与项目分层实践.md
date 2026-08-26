---
title: Spring Boot 框架与项目分层实践：从目录结构到一次请求的完整链路
published: 2026-08-26
description: 结合无人机配送项目介绍 Spring Boot、Maven 多模块目录、Controller-Service-Mapper 分层、IoC、自动配置、请求链路、事务、权限、异常、缓存与定时任务。
tags: [实习, 后端开发, Spring Boot, Java, 项目架构]
category: 后端开发
image: https://img.asyore.cn/fengmian/EMT41.webp
slug: spring-boot-project-layered-architecture
---

刚开始接触 Spring Boot 时，很容易把它理解成“写接口的框架”：加一个 `@RestController`，写一个 `@GetMapping`，浏览器就能拿到 JSON。真正进入完整项目以后才会发现，接口只是最外层，背后还有容器、自动配置、依赖注入、安全过滤器、业务事务、数据访问、缓存和异常处理。

本篇结合无人机配送管理平台，梳理 Spring Boot 在项目中到底承担什么角色，各个目录为什么这样划分，以及一次请求如何从 HTTP 进入数据库再返回前端。

## 1. Spring、Spring MVC 和 Spring Boot 的关系

这三个名称经常同时出现，但职责并不相同：

| 名称 | 主要作用 |
| --- | --- |
| Spring Framework | 提供 IoC、依赖注入、AOP、事务等基础能力 |
| Spring MVC | 提供 Web 请求映射、参数绑定、响应转换等能力 |
| Spring Boot | 约定项目启动方式，组织自动配置、Starter 和运行环境 |

Spring Boot 没有取代 Spring，而是降低了 Spring 项目的配置成本。它根据依赖和配置推断需要创建哪些 Bean，并内置 Web 容器，让应用可以通过一个 `main` 方法直接运行。

可以把三者的关系理解为：

```text
Spring Boot
  ├─ 组织和自动配置 Spring Framework
  ├─ 自动配置 Spring MVC
  ├─ 集成 Tomcat、Jackson、数据源等组件
  └─ 提供统一的配置、启动和部署方式
```

当前项目使用 Java 17、Spring Boot 4.0.6 和 MyBatis 4.0.1，并通过 Maven 父工程统一管理版本。

## 2. 项目的多模块目录

项目不是单一目录，而是 Maven 聚合工程：

```text
ahebai-uav-delivery-manage-new/
├─ pom.xml                 父工程，统一版本与模块声明
├─ uav-admin/              Web 服务入口
├─ uav-common/             通用返回、异常、注解和工具类
├─ uav-framework/          Security、Token、Redis、数据源等框架能力
├─ uav-system/             用户、角色、菜单、字典等系统模块
├─ uav-quartz/             Quartz 定时任务模块
├─ uav-generator/          MyBatis 代码生成模块
└─ uav-manage/             无人机配送业务模块
```

父工程的 `<dependencyManagement>` 负责统一版本，`<modules>` 决定构建哪些子模块。子模块只声明自己真正依赖的模块，例如 `uav-manage` 依赖 `uav-common` 和 `uav-framework`，`uav-admin` 再把系统、框架、任务与业务模块组装成最终应用。

这种结构的意义是把“可以复用的基础能力”和“当前项目的业务能力”分开：

- 更换配送业务时，不需要重写登录、分页和全局异常；
- 修改业务表时，不会直接影响代码生成器或系统菜单模块；
- 启动模块只负责装配，不需要堆放所有业务代码。

## 3. 启动类做了什么

应用入口位于 `uav-admin`：

```java
@SpringBootApplication(exclude = { DataSourceAutoConfiguration.class })
public class UavApplication {
    public static void main(String[] args) {
        SpringApplication.run(UavApplication.class, args);
    }
}
```

`@SpringBootApplication` 可以看成三个注解的组合：

```text
@SpringBootConfiguration  当前类是配置入口
@EnableAutoConfiguration 根据依赖和条件加载自动配置
@ComponentScan           扫描当前包及其子包中的组件
```

启动类位于 `com.ahebai` 根包，因此依赖模块中位于 `com.ahebai.*` 下的 Controller、Service、配置类和组件都能被扫描到。

项目排除了默认数据源自动配置，是因为 `uav-framework` 中使用 Druid 和动态数据源配置自行创建数据源。排除自动配置不代表不使用 Spring Boot，而是告诉框架：“这一部分由项目接管”。

## 4. 一个业务模块内部有哪些目录

以 `uav-manage` 为例，它不是简单按文件类型堆放，而是形成一条清晰的业务调用链：

```text
uav-manage/
└─ src/main/
   ├─ java/com/ahebai/manage/
   │  ├─ controller/
   │  │  ├─ admin/         管理端接口
   │  │  └─ user/          小程序用户端接口
   │  ├─ service/          Service 接口
   │  │  └─ impl/          业务实现
   │  ├─ mapper/           MyBatis Mapper 接口
   │  ├─ domain/           数据库实体
   │  │  ├─ dto/           请求参数对象
   │  │  └─ vo/            返回对象
   │  ├─ dji/              大疆平台适配
   │  ├─ task/             定时任务入口
   │  ├─ exception/        业务专用异常
   │  └─ utils/            当前模块工具
   └─ resources/
      └─ mapper/manage/    MyBatis XML 与 SQL
```

目录结构不是强制规范，但它表达了依赖方向。正常情况下，请求从 Controller 进入 Service，再由 Service 调用 Mapper；Mapper 不应该反过来依赖 Service，Service 也不应该依赖 Controller。

## 5. Controller 层：HTTP 与业务的边界

Controller 负责理解 HTTP，但不应该承担完整业务。

它适合处理：

- URL 与请求方法映射；
- 路径、查询和请求体参数接收；
- `@PreAuthorize` 权限声明；
- 开启分页；
- 调用 Service；
- 返回 `AjaxResult` 或 `TableDataInfo`。

```java
@RestController
@RequestMapping("/manage/user/exception-ticket")
public class UserHyExceptionTicketController extends BaseController {
    @PostMapping("/feedback")
    public AjaxResult feedback(@RequestBody UserExceptionFeedbackDto dto) {
        return success(exceptionTicketService.submitUserExceptionFeedback(dto));
    }
}
```

Controller 不应该直接写 SQL，也不应该在里面完成退款、改订单、写日志等多步操作。否则业务规则会和接口协议绑死，定时任务或其他入口也无法复用。

## 6. Service 层：真正的业务中心

Service 负责回答“这件事能不能做，以及做了以后哪些数据必须一起改变”。

例如异常退款不是单表更新，而是：

```text
校验工单状态
  -> 新增退款支付记录
  -> 更新原订单状态
  -> 更新异常工单状态
  -> 新增订单过程日志
```

这些步骤应该放在同一个 Service 方法和事务中。Controller 只需要调用“取消退款”这个动作，不需要知道内部修改了几张表。

项目把 Service 分为接口和实现：

```text
IHyDeliveryOrderService
  └─ HyDeliveryOrderServiceImpl
```

接口可以隔离调用方和实现、便于替换实现或测试，也符合 Spring 通过代理添加事务和切面的方式。不过并不是所有简单类都必须为了形式建立接口，是否抽象仍应由复用、替换和边界需求决定。

## 7. Mapper 层：Java 方法与 SQL 的连接点

Mapper 接口声明数据访问能力，Mapper XML 保存 SQL 和结果映射：

```java
public interface HyDeliveryOrderMapper {
    HyDeliveryOrder selectHyDeliveryOrderByOrderId(Long orderId);
    int insertHyDeliveryOrder(HyDeliveryOrder order);
}
```

```xml
<select id="selectHyDeliveryOrderByOrderId"
        resultMap="HyDeliveryOrderResult">
    select ... from hy_delivery_order where order_id = #{orderId}
</select>
```

`@MapperScan("com.ahebai.**.mapper")` 会扫描 Mapper 接口，MyBatis 为它们创建代理对象。调用 Mapper 方法时，代理根据方法名找到 XML 中同名语句，再通过 `SqlSessionFactory` 使用数据源执行 SQL。

Mapper 适合表达查询和持久化，不适合决定“当前用户是否有权退款”。业务权限属于 Service，SQL 则可以继续承担数据范围和条件更新等数据库最擅长的工作。

## 8. Entity、DTO 和 VO 为什么要分开

三个对象看起来字段相似，但面对的边界不同：

| 对象 | 面向对象 | 作用 |
| --- | --- | --- |
| Entity / Domain | 数据库 | 描述表字段和持久化结果 |
| DTO | 请求方 | 只接收某个动作允许输入的字段 |
| VO | 响应方 | 只返回页面真正需要的数据 |

例如用户资料实体包含状态、删除标记和登录失败次数，但修改资料 DTO 不应该允许用户提交这些字段；凭证实体包含真实存储路径，返回 VO 则只给出 `hasImage` 和鉴权图片接口所需的凭证 ID。

如果所有地方都直接使用 Entity，接口很容易出现“过度写入”和“过度返回”。对象分层本质上是在保护边界，而不只是增加文件数量。

## 9. IoC 与依赖注入

普通 Java 代码通常主动创建依赖：

```java
OrderService service = new OrderService();
```

Spring 则由 IoC 容器负责创建对象和维护关系。带有以下注解的类会成为 Bean：

```text
@Component       通用组件
@Service         业务服务
@Repository      数据访问组件
@RestController  Web 控制器
@Configuration   配置类
@Bean            配置类中手动创建的对象
```

Controller 依赖 Service、Service 依赖 Mapper，Spring 在启动时把对应 Bean 注入进去。项目当前较多使用字段注入：

```java
@Autowired
private IHyDeliveryOrderService deliveryOrderService;
```

新代码也可以优先使用构造器注入：

```java
private final IHyDeliveryOrderService deliveryOrderService;

public OrderController(IHyDeliveryOrderService deliveryOrderService) {
    this.deliveryOrderService = deliveryOrderService;
}
```

构造器注入可以让依赖保持不可变，更方便单元测试，也能在对象创建时立即发现缺失依赖。

## 10. 一次请求的完整生命周期

以一个需要登录的订单详情请求为例，大致会经过：

```text
客户端 HTTP 请求
  -> 内置 Tomcat 接收连接
  -> CORS、JWT 等 Servlet Filter
  -> Spring Security 建立认证上下文
  -> DispatcherServlet
  -> HandlerMapping 找到 Controller 方法
  -> 参数解析与校验
  -> Controller
  -> Service 代理（事务、日志等 AOP）
  -> Mapper 代理
  -> SqlSession / DataSource / MySQL
  -> Service 组装业务结果
  -> Jackson 序列化 JSON
  -> HTTP 响应
```

如果中途抛出异常，`@RestControllerAdvice` 会接管响应；如果方法带有 `@Transactional`，事务代理会根据异常决定提交或回滚。

理解这条链路以后，排查问题会更有方向：

- 请求没有进入 Controller：检查路径、方法、过滤器和 Security；
- Controller 参数为空：检查 Content-Type、字段名和参数注解；
- Service 没有回滚：检查事务代理和异常类型；
- Mapper 找不到语句：检查 Mapper 扫描、XML 路径与 statement id；
- 数据正确但 JSON 不对：检查 VO、Jackson 和日期配置。

## 11. 自动配置与显式配置

Spring Boot 的自动配置并不是“什么都不配”，而是根据条件提供默认值。例如存在 Web Starter 时配置 Spring MVC 和内置 Tomcat，存在 Jackson 时配置 JSON 转换器。

项目又通过配置类显式接管特殊需求：

- `SecurityConfig`：无状态安全链、JWT 过滤器与匿名地址；
- `DruidConfig`：主从数据源和连接池；
- `MyBatisConfig`：别名包、Mapper XML 和 `SqlSessionFactory`；
- `RedisConfig`：缓存序列化；
- `ThreadPoolConfig`：异步线程池；
- `ResourcesConfig`：静态资源和拦截器；
- `ApplicationConfig`：Mapper 扫描与 AOP 代理暴露。

自动配置适合通用默认值，显式配置适合项目特有规则。两者不是竞争关系，而是“约定优先，需要时覆盖”。

## 12. application.yml 与配置对象

`application.yml` 保存服务端口、日志级别、上传限制、Redis、Token、MyBatis 等配置，并通过：

```yaml
spring:
  profiles:
    active: druid
```

加载 `application-druid.yml` 中的数据源配置。

代码可以使用 `@Value` 读取单个值，也可以通过 `@ConfigurationProperties` 绑定一组配置：

```java
@ConfigurationProperties(prefix = "dji.api")
public class DjiApiProperties {
    private String baseUrl;
    private Duration connectTimeout;
    private Duration requestTimeout;
}
```

成组配置更适合类型校验和集中管理。数据库密码、Token 密钥、微信 Secret 与第三方 SecretKey 不应直接提交真实值，可以使用环境变量或部署平台的密钥管理服务注入：

```yaml
wechat:
  mini-program:
    app-id: ${WECHAT_APP_ID:}
    secret: ${WECHAT_APP_SECRET:}
```

## 13. Spring Security 在哪里生效

项目使用无 Session 的 Token 模式：

```java
session.sessionCreationPolicy(SessionCreationPolicy.STATELESS)
```

JWT 过滤器在用户名密码过滤器之前执行，从请求头读取 Token，恢复 `LoginUser` 并写入安全上下文。之后 Controller 和 Service 才能调用 `SecurityUtils.getUserId()`。

安全规则分为两层：

1. URL 层判断接口是否需要认证；
2. `@PreAuthorize` 判断当前用户是否拥有具体权限。

此外，用户只能操作自己的订单和地址属于对象级权限，需要在 Service 中检查资源归属。登录、菜单权限和对象归属解决的是三个不同问题。

## 14. 全局异常为什么必要

业务代码不需要在每个 Controller 中重复 `try-catch`。Service 可以抛出 `ServiceException`，全局异常处理器统一转换为 `AjaxResult`：

```java
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(ServiceException.class)
    public AjaxResult handleServiceException(ServiceException e) {
        return AjaxResult.error(e.getMessage());
    }
}
```

项目还分别处理权限不足、请求方法错误、路径变量缺失、参数类型错误和参数校验异常。

业务异常和系统异常应该区分：

- “订单已取消，不能再次支付”是可以展示给用户的业务异常；
- 数据库连接失败、空指针等属于系统异常，应记录完整日志，但生产响应不宜直接暴露堆栈和内部实现信息。

## 15. 事务为什么通常放在 Service

`@Transactional` 依赖 Spring AOP 代理。请求进入代理方法时开启事务，正常结束时提交，出现符合条件的异常时回滚。

```java
@Transactional(rollbackFor = Exception.class)
public HyDeliveryOrder mockPayUserDeliveryOrder(Long orderId) {
    // 支付记录、订单状态、过程日志必须一起成功
}
```

事务放在 Service，是因为 Service 知道一次完整业务动作涉及哪些 Mapper。Mapper 只看到单条 SQL，Controller 又不应该理解所有数据细节。

使用事务时还要注意：

- 同一个类中普通方法直接调用另一个事务方法，可能绕过代理；
- 捕获异常后不继续抛出，事务可能认为操作成功；
- 默认回滚规则与异常类型有关，项目使用 `rollbackFor = Exception.class` 明确范围；
- 数据库事务无法回滚已经发给微信或大疆的外部请求；
- 事务范围过大，会长时间占用连接和数据库锁。

## 16. AOP、过滤器和拦截器分别做什么

三者都能处理“很多接口共同需要的逻辑”，但工作位置不同：

| 机制 | 主要位置 | 适合场景 |
| --- | --- | --- |
| Filter | Servlet 请求最外层 | CORS、JWT、XSS、请求包装 |
| Interceptor | Spring MVC Controller 前后 | 防重复提交、Handler 级检查 |
| AOP Aspect | Spring Bean 方法调用 | 操作日志、数据权限、限流、事务 |

项目中的 `LogAspect`、`DataScopeAspect`、`RateLimiterAspect` 都属于 AOP。注解只是在方法上声明意图，真正的通用逻辑由切面统一完成。

## 17. 缓存与 Bean 生命周期

系统参数 Service 使用 `@PostConstruct` 在 Bean 创建并完成依赖注入后加载配置到 Redis：

```java
@PostConstruct
public void init() {
    loadingConfigCache();
}
```

读取参数时先查缓存，缓存没有再查数据库并回填。修改参数时同步更新缓存，删除时同时清理缓存。

这属于 Cache Aside 思路，但仍要注意数据库与缓存之间的短暂不一致。对于关键业务状态，不能因为接入 Redis 就默认缓存永远可靠；缓存更适合加速读取，数据库仍是最终事实来源。

## 18. 定时任务如何复用业务层

Spring Bean 不只由 Controller 调用。Quartz 也可以按配置调用任务 Bean：

```java
@Component("deliveryOrderTimeoutTask")
public class DeliveryOrderTimeoutTask {
    public void cancelTimeoutUnpaidOrders() {
        orderService.cancelTimeoutUnpaidOrders(15);
    }
}
```

任务类只负责触发，超时判断、状态更新和日志写入仍放在 Service。这样人工补偿、接口调用和定时调度能够复用同一业务规则。

报表快照也采用相同结构：Quartz 决定执行时间，Service 负责日报、周报、月报的统计口径与幂等落库。

## 19. Spring Boot 没有替我们完成什么

Spring Boot 能自动创建很多基础设施，但不会自动保证业务正确：

- `@Transactional` 不会自动决定事务应该包含哪些步骤；
- `@PreAuthorize` 不会自动检查订单是否属于当前用户；
- MyBatis 不会自动避免慢 SQL 和错误索引；
- Redis 不会自动解决缓存一致性；
- 全局异常处理不会自动区分哪些信息可以暴露；
- 自动配置不会替项目选择正确的模块边界。

框架解决的是通用机制，开发者仍然要定义业务规则和数据边界。

## 20. 项目中常见的分层误区

### Controller 过重

在 Controller 中查询多张表、修改状态并写日志，会导致业务无法复用，也难以统一事务。

### Service 只是转发 Mapper

简单 CRUD 可以很薄，但订单审核、退款等动作如果仍只是转发，业务校验就会散到前端或 Controller。

### 为每张表机械生成所有接口

数据库表不等于公开资源。支付记录、过程日志等表可能只应该由业务动作生成，不一定需要开放通用新增和删除接口。

### 直接返回 Entity

容易暴露存储路径、删除标记和内部字段，也让数据库字段变化直接影响接口契约。

### 只在前端限制状态和权限

按钮隐藏不能阻止直接请求。状态前置条件、资源归属和字段白名单都必须由后端再次检查。

## 21. 还可以继续分享哪些 Spring Boot 内容

围绕当前项目，还可以继续扩展成以下专题：

1. **Spring Bean 生命周期**：实例化、依赖注入、`@PostConstruct`、销毁回调和循环依赖。
2. **自动配置原理**：Starter、条件注解、配置类加载以及如何编写自己的 Starter。
3. **Spring AOP 与代理**：JDK 代理、CGLIB、自调用失效和注解切面实现。
4. **事务进阶**：传播行为、隔离级别、锁、并发更新和分布式事务边界。
5. **Spring Security 请求链**：JWT 解析、认证上下文、方法权限和对象级权限。
6. **参数校验与接口契约**：`@Valid`、自定义校验、DTO 分组和统一错误结构。
7. **MyBatis 深入实践**：动态 SQL、结果映射、批量操作、分页原理和 SQL 性能分析。
8. **配置与环境隔离**：Profile、环境变量、配置中心和敏感信息管理。
9. **缓存设计**：穿透、击穿、雪崩、缓存更新和分布式锁。
10. **异步与线程池**：`@Async`、任务队列、上下文传递和优雅停机。
11. **可观测性**：结构化日志、Trace ID、Actuator、指标与慢请求定位。
12. **测试体系**：Service 单元测试、Controller 切片测试、数据库集成测试与 Testcontainers。
13. **接口文档**：Springdoc 分组、DTO Schema、错误码与前后端契约维护。
14. **部署与运行**：可执行 Jar、Docker、JVM 参数、健康检查和滚动发布。

这些主题可以从“框架怎么用”继续深入到“框架为什么这样工作”，也能结合项目中的真实问题，而不是只罗列注解。

## 22. 本篇小结

Spring Boot 项目的核心不是记住多少注解，而是理解对象由谁创建、请求经过哪些组件、每一层负责什么，以及通用机制与业务规则在哪里交汇。

从目录上看，Controller、Service、Mapper、DTO 和 VO 是分层；从运行过程看，过滤器、安全上下文、MVC、事务代理和 MyBatis 又组成了一条完整链路。只有把静态目录和动态调用过程放在一起理解，才能真正读懂一个 Spring Boot 项目，也才能知道新功能应该写在哪里。
