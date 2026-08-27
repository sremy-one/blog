---
title: Spring Bean 生命周期与自动配置原理
published: 2026-06-04
description: 从组件扫描、BeanDefinition、实例化、依赖注入和初始化回调讲到 Spring Boot 条件自动配置，并结合项目中的配置缓存与数据源配置说明扩展方式。
tags: [实习, 后端开发, Spring Boot, Bean 生命周期, 自动配置]
category: 后端开发
image: https://img.asyore.cn/images/EMT7.webp
slug: spring-bean-lifecycle-auto-configuration
---

在 Spring Boot 项目里，我们很少手动 `new Controller()` 或 `new Service()`，但这些对象并不是凭空出现的。Spring 容器负责发现类、保存定义、创建实例、注入依赖、执行初始化回调，并在应用关闭时完成销毁。

理解 Bean 生命周期以后，很多问题会变得清楚：为什么某个 Service 注入为空、为什么 `@PostConstruct` 能访问 Mapper、为什么循环依赖危险，以及自动配置为什么有时生效、有时不生效。

## 1. 从启动类开始扫描

```java
@SpringBootApplication
public class UavApplication {
    public static void main(String[] args) {
        SpringApplication.run(UavApplication.class, args);
    }
}
```

`SpringApplication.run` 会创建应用上下文。`@SpringBootApplication` 中的组件扫描从启动类所在包向下查找 `@Component`、`@Service`、`@RestController` 和 `@Configuration` 等组件。

扫描阶段并不会立刻执行业务方法，而是先把类转换成 `BeanDefinition`。BeanDefinition 类似一张创建说明，记录 Bean 类型、名称、作用域、是否懒加载和构造参数。

如果启动类放在过深的包中，其他模块就可能不在默认扫描范围。当前启动类位于 `com.ahebai` 根包，因此各 Maven 模块中的 `com.ahebai.*` 组件都可以被发现。

## 2. Bean 生命周期的主要阶段

可以把单例 Bean 的创建过程简化为：

```text
扫描或注册 BeanDefinition
  -> 选择构造器并实例化
  -> 属性填充与依赖注入
  -> Aware 接口回调
  -> BeanPostProcessor 初始化前处理
  -> @PostConstruct / afterPropertiesSet / initMethod
  -> BeanPostProcessor 初始化后处理
  -> 必要时返回代理对象
  -> Bean 可以被业务代码使用
  -> 容器关闭时执行销毁回调
```

“实例化”和“初始化”不是同一步。实例化只是得到 Java 对象，依赖注入完成后才进入初始化回调。因此 `@PostConstruct` 中可以使用已经注入的 Mapper 或 Redis 组件。

## 3. 项目中的 @PostConstruct

系统参数服务会在启动时加载配置缓存：

```java
@Service
public class SysConfigServiceImpl
        implements ISysConfigService {

    @Autowired
    private SysConfigMapper configMapper;

    @Autowired
    private RedisCache redisCache;

    @PostConstruct
    public void init() {
        loadingConfigCache();
    }
}
```

执行 `init()` 时，`configMapper` 和 `redisCache` 已完成注入。方法读取数据库配置并写入 Redis，让业务请求到来前就可以使用缓存。

初始化方法应尽量短且可预测。若它长时间请求外部服务，整个应用启动都会被阻塞；若异常直接抛出，Bean 创建失败，应用上下文通常也无法完成启动。非关键数据可以考虑延迟加载，关键初始化则应记录清晰错误并快速失败。

## 4. 构造器注入发生在什么时候

```java
@Service
public class OrderQueryService {
    private final HyDeliveryOrderMapper orderMapper;

    public OrderQueryService(
            HyDeliveryOrderMapper orderMapper) {
        this.orderMapper = orderMapper;
    }
}
```

Spring 在实例化 `OrderQueryService` 前必须先找到或创建 `HyDeliveryOrderMapper`。依赖通过构造器一次传入，对象创建后字段保持不可变。

字段注入则是先调用无参构造器，再通过反射设置字段。构造器注入更容易在普通单元测试中使用，也会更早暴露缺少依赖的问题。

如果只有一个构造器，现代 Spring 不要求再写 `@Autowired`。多个构造器同时存在时，需要明确告诉容器使用哪一个。

## 5. @Bean 适合创建第三方对象

无法修改源码的第三方类不能添加 `@Component`，可以在配置类中创建：

```java
@Configuration
public class SecurityConfig {
    @Bean
    public BCryptPasswordEncoder bCryptPasswordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
```

`@Bean` 方法的返回值进入容器，其他组件就能注入 `BCryptPasswordEncoder`。方法名默认成为 Bean 名称，返回类型用于按类型匹配。

配置方法也可以直接声明依赖：

```java
@Bean
public SqlSessionFactory sqlSessionFactory(
        DataSource dataSource) throws Exception {
    SqlSessionFactoryBean factory =
            new SqlSessionFactoryBean();
    factory.setDataSource(dataSource);
    return factory.getObject();
}
```

Spring 在调用方法前先解析 `DataSource`，不需要配置类手动从容器取对象。

## 6. BeanPostProcessor 与代理对象

事务、AOP 和部分注解能力都依赖 Bean 后处理器。真实 Service 完成初始化后，后处理器可能返回一个代理对象：

```text
Controller 注入的对象
  != 原始 HyDeliveryOrderServiceImpl
  = 带事务拦截器的代理
```

调用 `@Transactional` 方法时，代理先开启事务，再调用目标对象，最后提交或回滚。若绕过代理直接调用原始对象，相应增强就不会执行。

这也是为什么不要在配置阶段随意手动 `new HyDeliveryOrderServiceImpl()`：手动对象没有经过容器生命周期，自然也没有依赖注入、事务和切面。

## 7. 作用域与默认单例

Spring Service 默认是单例：整个应用上下文只有一个实例。因此 Service 不应该把某个请求的订单 ID、用户 ID 或临时列表保存在成员字段中。

错误示例：

```java
@Service
public class OrderService {
    private Long currentUserId;

    public List<Order> list() {
        currentUserId = SecurityUtils.getUserId();
        return mapper.selectByUserId(currentUserId);
    }
}
```

多个请求共享同一个字段，会互相覆盖。请求数据应保存在方法局部变量中，或者由线程安全的请求上下文提供。

常见作用域还有 prototype、request 和 session，但无状态后端通常让 Controller 与 Service 保持单例和无状态。

## 8. 循环依赖说明了什么

```text
OrderService -> NotificationService
NotificationService -> OrderService
```

循环依赖意味着两个对象都无法独立完成创建。部分字段注入场景下 Spring 曾能通过提前暴露对象解决，但构造器循环无法创建，而且代理、事务混入后行为更难预测。

更好的处理方式是重新划分职责：

- 把共同逻辑抽到第三个服务；
- 由上层编排 Service 依次调用两者；
- 使用领域事件降低直接依赖；
- 让通知接收订单 DTO，而不是反向调用订单 Service 查询所有内容。

不要把 `@Lazy` 当作默认解决方案，它只推迟暴露设计问题。

## 9. 自动配置如何判断是否生效

Spring Boot 自动配置大量使用条件注解：

```java
@Configuration
@ConditionalOnClass(RedisConnectionFactory.class)
@ConditionalOnMissingBean(RedisTemplate.class)
public class RedisAutoConfiguration {
    // 创建默认 RedisTemplate
}
```

含义是：classpath 中存在相关类，并且用户没有自己提供 RedisTemplate 时，才创建默认 Bean。项目一旦声明自己的同类型 Bean，默认配置就会“让位”。

常见条件包括：

| 条件 | 含义 |
| --- | --- |
| `@ConditionalOnClass` | classpath 存在指定类 |
| `@ConditionalOnMissingBean` | 容器中还没有指定 Bean |
| `@ConditionalOnProperty` | 配置项满足条件 |
| `@ConditionalOnWebApplication` | 当前是 Web 应用 |

自动配置不是扫描所有类后盲目创建，而是根据环境逐项判断。

## 10. 为什么项目排除默认数据源配置

```java
@SpringBootApplication(
        exclude = { DataSourceAutoConfiguration.class })
public class UavApplication {
}
```

项目使用 Druid、主从数据源和动态数据源，自行在 `DruidConfig` 中创建 DataSource。若默认数据源与自定义配置同时生效，可能出现多个候选 Bean、连接属性读取错误或 MyBatis 注入了错误数据源。

排除自动配置表示这一块完全由项目负责。代价是连接池、属性绑定、健康检查等细节也需要自己保证正确。

## 11. Starter 与自动配置的关系

Starter 本质上是依赖集合，例如 Web Starter 把 Spring MVC、JSON 和内置容器需要的依赖组合起来。自动配置模块再根据这些依赖提供默认 Bean。

可以把关系记为：

```text
Starter 解决“需要引入哪些依赖”
自动配置解决“这些依赖默认怎样创建对象”
application.yml 解决“对象使用哪些参数”
业务配置类解决“项目如何覆盖默认行为”
```

如果团队多个项目都需要相同的第三方平台客户端，可以把配置属性、客户端和条件配置封装成内部 Starter，而不是复制多份代码。

## 12. 排查 Bean 创建问题

遇到 `NoSuchBeanDefinitionException` 或注入冲突时，可以按顺序检查：

1. 类是否位于组件扫描范围；
2. 是否添加正确组件注解；
3. 接口是否真的有实现类；
4. 条件注解是否满足；
5. 是否出现多个同类型 Bean，需要 `@Qualifier` 或 `@Primary`；
6. 配置类是否被扫描或导入；
7. 初始化方法是否抛出异常导致 Bean 创建失败；
8. 是否手动 new 了本应由容器管理的对象。

开启 Spring Boot 条件评估报告，可以看到某个自动配置为什么匹配或没有匹配，比只观察最终异常更容易定位。

## 13. 本篇小结

Bean 生命周期描述了对象从定义到销毁的全过程，自动配置则是在容器创建阶段根据条件批量注册合理默认值。组件扫描、依赖注入、初始化回调和代理增强并不是互相独立的注解技巧，而是一条连续的容器工作链路。
