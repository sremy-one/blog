---
title: Spring Security 请求链与参数校验：从 JWT 到资源归属校验
published: 2026-06-10
description: 结合无状态 JWT 登录链路，说明过滤器顺序、SecurityContext、接口与方法授权、对象级资源归属、Bean Validation 和统一异常返回。
tags: [实习, 后端开发, Spring Security, JWT, 参数校验]
category: 后端开发
image: https://img.asyore.cn/images/EMT61.webp
slug: spring-security-request-validation
---

后端安全并不只是“登录成功后发一个 Token”。一次请求从进入应用到执行 Controller，至少会经历跨域处理、Token 提取、身份解析、权限判断、参数校验、业务规则校验和资源归属校验。任何一层缺失，都可能让一个表面正常的接口留下越权入口。

## 1. 先区分认证、授权与资源归属

这三个概念经常被混在一起：

- **认证（Authentication）**：回答“当前请求是谁发出的”；
- **授权（Authorization）**：回答“这个角色能不能调用该功能”；
- **资源归属（Ownership）**：回答“这个用户能不能操作这一条具体数据”。

例如，普通微信用户已经登录，说明认证通过；他可以修改收货地址，说明功能授权通过；但他只能修改自己的地址，最后还必须校验地址记录中的 `wxUserId` 是否等于当前用户。这一步不能只依赖前端隐藏按钮，也不能只依赖路径权限。

## 2. 无状态请求的安全过滤链

项目采用前后端分离模式，服务端不保存传统 Session，会话状态由 JWT 和 Redis 共同维护。核心配置可以概括为：

```java
@Bean
SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http
        .csrf(AbstractHttpConfigurer::disable)
        .sessionManagement(session -> session
            .sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/login", "/register", "/captchaImage").permitAll()
            .requestMatchers("/manage/user/wx-user/login").permitAll()
            .requestMatchers(HttpMethod.GET, "/profile/**").denyAll()
            .anyRequest().authenticated())
        .addFilterBefore(corsFilter, JwtAuthenticationTokenFilter.class)
        .addFilterBefore(jwtAuthenticationTokenFilter,
            UsernamePasswordAuthenticationFilter.class)
        .build();
}
```

`STATELESS` 表示 Spring Security 不创建和读取服务器 Session。`permitAll()` 只表示这些路径无需登录，并不表示其中的业务参数可以不校验。`anyRequest().authenticated()` 则建立兜底规则：没有被明确放行的接口默认需要身份。

过滤器顺序也有实际意义。跨域过滤器需要尽早处理浏览器的预检请求；JWT 过滤器必须在用户名密码认证过滤器之前写入当前身份，后续授权逻辑才能读取 `SecurityContext`。

## 3. JWT 过滤器到底做了什么

JWT 过滤器的职责应当保持单一：读取请求头、解析登录标识、恢复用户身份并交给后续过滤器。典型结构如下：

```java
@Component
public class JwtAuthenticationTokenFilter
        extends OncePerRequestFilter {

    private final TokenService tokenService;

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {

        LoginUser loginUser = tokenService.getLoginUser(request);

        if (loginUser != null
                && SecurityContextHolder.getContext().getAuthentication() == null) {
            tokenService.verifyToken(loginUser);

            UsernamePasswordAuthenticationToken authentication =
                new UsernamePasswordAuthenticationToken(
                    loginUser,
                    null,
                    loginUser.getAuthorities());

            authentication.setDetails(
                new WebAuthenticationDetailsSource().buildDetails(request));
            SecurityContextHolder.getContext()
                .setAuthentication(authentication);
        }

        chain.doFilter(request, response);
    }
}
```

`OncePerRequestFilter` 保证同一请求分派过程中只执行一次。过滤器没有直接调用 Controller，而是通过 `chain.doFilter` 把请求交给下一环节。身份对象写入 `SecurityContextHolder` 后，`@PreAuthorize`、权限表达式以及业务层获取当前用户的方法才能使用它。

JWT 中不宜保存随时变化的完整用户信息。更稳妥的做法是只携带随机登录标识，详细登录状态放在 Redis 中。这样禁用账号、退出登录或刷新权限时，可以主动删除或更新 Redis 会话，而不必等待旧 JWT 自然过期。

## 4. URL 授权与方法授权要相互补充

URL 规则适合声明整体边界，方法注解适合表达具体业务权限：

```java
@EnableMethodSecurity(
    prePostEnabled = true,
    securedEnabled = true)
@Configuration
public class SecurityConfig {
}
```

```java
@PreAuthorize("@ss.hasPermi('delivery:order:edit')")
@PutMapping("/{orderId}/status")
public AjaxResult updateStatus(
        @PathVariable Long orderId,
        @Valid @RequestBody OrderStatusRequest request) {
    orderService.updateStatus(orderId, request);
    return success();
}
```

方法权限应写在真正的业务入口上，避免只保护菜单而漏掉接口。新增接口时也要检查是否沿用了对应权限；否则前端没有入口，攻击者仍可直接构造 HTTP 请求。

## 5. 资源归属校验必须下沉到业务层

假设修改地址接口接收地址 ID。如果只执行 `updateById`，登录用户把路径中的 ID 换成其他人的 ID 就可能越权：

```java
@Transactional
public void updateAddress(Long addressId, AddressUpdateRequest request) {
    Long currentUserId = securityUserService.getCurrentWxUserId();

    WxUserAddress address = addressMapper.selectById(addressId);
    if (address == null || Boolean.TRUE.equals(address.getDeleted())) {
        throw new ServiceException("地址不存在");
    }
    if (!Objects.equals(address.getWxUserId(), currentUserId)) {
        throw new ServiceException("无权操作该地址");
    }

    address.setReceiverName(request.getReceiverName());
    address.setReceiverPhone(request.getReceiverPhone());
    address.setDetailAddress(request.getDetailAddress());
    addressMapper.updateById(address);
}
```

更紧凑的做法是让 SQL 同时限定主键和当前用户：

```sql
UPDATE wx_user_address
SET receiver_name = #{receiverName},
    receiver_phone = #{receiverPhone},
    detail_address = #{detailAddress}
WHERE id = #{addressId}
  AND wx_user_id = #{currentUserId}
  AND deleted = 0
```

然后检查影响行数是否为 `1`。这种“带条件更新”不仅能防止越权，也能减少查询后再更新之间的竞态窗口。

## 6. DTO 参数校验是第一道业务边界

Controller 不应该接收一个包含所有数据库字段的实体类。实体中可能有 `status`、`createBy`、`deleted` 等不允许客户端修改的字段。为具体接口建立 DTO，可以同时限制字段集合和校验规则：

```java
public class AddressCreateRequest {

    @NotBlank(message = "收件人不能为空")
    @Size(max = 30, message = "收件人不能超过30个字符")
    private String receiverName;

    @NotBlank(message = "手机号不能为空")
    @Pattern(
        regexp = "^1[3-9]\\d{9}$",
        message = "手机号格式不正确")
    private String receiverPhone;

    @NotNull(message = "省级行政区不能为空")
    private Long provinceId;

    @NotBlank(message = "详细地址不能为空")
    @Size(max = 200, message = "详细地址不能超过200个字符")
    private String detailAddress;
}
```

```java
@PostMapping
public AjaxResult create(
        @Valid @RequestBody AddressCreateRequest request) {
    return success(addressService.create(request));
}
```

`@Valid` 触发对象字段校验。对于查询参数、路径变量等方法参数，还需要在类上添加 `@Validated`：

```java
@Validated
@RestController
public class AddressController {

    @GetMapping("/{id}")
    public AjaxResult detail(
            @PathVariable @Positive Long id) {
        return success(addressService.detail(id));
    }
}
```

## 7. 字段校验不能替代业务规则

注解擅长判断非空、长度、格式和数值范围，却无法判断“这个行政区是否存在”“用户是否已有十个地址”“订单当前是否允许取消”。这些规则仍应由 Service 负责：

```java
public Long create(AddressCreateRequest request) {
    Long userId = securityUserService.getCurrentWxUserId();

    if (!regionService.isValidPath(
            request.getProvinceId(),
            request.getCityId(),
            request.getDistrictId())) {
        throw new ServiceException("行政区划层级不匹配");
    }

    int count = addressMapper.countActiveByUserId(userId);
    if (count >= 10) {
        throw new ServiceException("最多只能保存10个收货地址");
    }

    return addressMapper.insert(toEntity(userId, request));
}
```

一个实用的分工是：Controller 处理协议格式，Service 处理业务规则，数据库约束处理最终一致性。三者不是互相替代，而是逐层缩小非法数据进入系统的可能性。

## 8. 跨字段规则可以使用类级校验器

当“预约开始时间必须早于结束时间”涉及两个字段时，可以建立自定义注解：

```java
@ValidTimeRange
public class AppointmentRequest {
    @NotNull
    private LocalDateTime startTime;

    @NotNull
    private LocalDateTime endTime;
}
```

```java
public class TimeRangeValidator
        implements ConstraintValidator<ValidTimeRange, AppointmentRequest> {

    @Override
    public boolean isValid(
            AppointmentRequest value,
            ConstraintValidatorContext context) {
        if (value == null
                || value.getStartTime() == null
                || value.getEndTime() == null) {
            return true;
        }
        return value.getStartTime().isBefore(value.getEndTime());
    }
}
```

空值交给 `@NotNull` 处理，类级校验器只关心字段间关系，可以避免同一错误被重复报告。

## 9. 统一异常返回让前端正确处理错误

参数校验失败通常抛出 `MethodArgumentNotValidException`，表单绑定可能抛出 `BindException`，业务拒绝则使用统一的 `ServiceException`。全局异常处理器把它们转换为稳定的响应格式：

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public AjaxResult handleValidException(
            MethodArgumentNotValidException e) {
        String message = e.getBindingResult()
            .getFieldErrors()
            .stream()
            .map(FieldError::getDefaultMessage)
            .findFirst()
            .orElse("参数校验失败");
        return AjaxResult.error(message);
    }

    @ExceptionHandler(ServiceException.class)
    public AjaxResult handleServiceException(ServiceException e) {
        return AjaxResult.error(e.getCode(), e.getMessage());
    }
}
```

生产项目最好为错误分配稳定的业务码，不要让前端根据中文消息判断流程。日志中记录详细上下文，响应中只返回用户可理解且不泄露内部结构的信息。

## 10. CORS、CSRF 与无状态接口

关闭 CSRF 并不意味着可以忽略安全，它依赖于“认证信息放在自定义请求头中，浏览器不会像 Cookie 那样自动附带”的前提。如果以后改用 Cookie 保存 Token，就要重新评估 CSRF 防护。

CORS 也不是权限控制。它只限制浏览器中的跨源读取，脚本、移动端和命令行客户端不受同样限制。因此任何业务接口都必须在服务端完成认证和授权。

## 11. 一次安全请求的完整路径

以“修改地址”为例，请求链可以按以下顺序理解：

1. CORS 过滤器处理来源和预检请求；
2. JWT 过滤器从请求头恢复登录身份；
3. URL 规则判断请求是否需要认证；
4. Controller 使用 `@Valid` 校验请求结构；
5. `@PreAuthorize` 判断当前用户是否具备功能权限；
6. Service 校验地址是否属于当前用户；
7. Mapper 使用用户 ID 和资源 ID 完成条件更新；
8. 全局异常处理器把失败转换为统一响应；
9. 操作日志记录结果，但避免记录 Token、密码等敏感字段。

安全是链路属性，而不是某个注解的属性。只有每层职责清楚，才能在接口增长时持续维护边界。

## 12. 实践检查清单

- 未显式放行的接口是否默认要求认证；
- JWT 失效、Redis 会话失效和用户禁用是否都能拒绝请求；
- 新增接口是否配置了对应方法权限；
- 所有按 ID 修改、删除、下载的接口是否校验资源归属；
- Controller 是否使用专用 DTO，避免实体字段被越权写入；
- 参数错误、业务错误和系统错误是否使用可区分的错误码；
- 日志是否脱敏，是否避免输出 Token、密码和完整身份证号；
- 是否覆盖未登录、无权限、跨用户访问、非法参数和重复提交测试。

## 13. 小结

Spring Security 提供了认证与授权骨架，Bean Validation 提供了协议层校验能力，但真正可靠的接口还需要业务层资源归属检查和数据库条件约束。把过滤链、方法权限、DTO 校验、业务规则和统一异常串起来，才是一次请求完整的安全边界。
