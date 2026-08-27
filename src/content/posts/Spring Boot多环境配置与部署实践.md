---
title: Spring Boot 多环境配置与部署实践：从 YAML 到可执行服务
published: 2026-06-16
description: 介绍配置分层、Profile、ConfigurationProperties、敏感信息管理、日志与健康检查，并梳理 Jar、容器、优雅停机和滚动发布流程。
tags: [实习, 后端开发, Spring Boot, 多环境配置, 部署]
category: 后端开发
image: https://img.asyore.cn/images/EMT11.webp
slug: spring-boot-profile-configuration-deployment
---

同一套 Spring Boot 代码通常要运行在本地、测试和生产环境。真正变化的不应该是 Java 代码，而是数据库地址、缓存节点、日志级别、第三方接口和运行参数。配置与部署设计得越清楚，发布时需要临时手改文件的风险就越低。

## 1. 配置的目标是让代码与环境解耦

如果把数据库地址写进 Java 类，每次切换环境都要修改和重新编译：

```java
// 不推荐
String jdbcUrl = "jdbc:mysql://127.0.0.1:3306/app";
```

更合理的方式是代码只声明需要什么配置，具体值由运行环境提供：

```yaml
spring:
  datasource:
    url: ${DB_URL}
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}
```

`${DB_URL}` 表示从环境变量或启动参数中读取。配置文件可以进入版本管理，但真实密码不进入仓库。

## 2. 使用 Profile 拆分环境差异

基础配置存放所有环境共同内容：

```yaml
# application.yml
spring:
  application:
    name: uav-delivery-manage
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:dev}

server:
  shutdown: graceful
```

开发环境只覆盖差异：

```yaml
# application-dev.yml
logging:
  level:
    com.ahebai: debug

spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/uav_dev
```

生产环境则可以通过环境变量注入：

```yaml
# application-prod.yml
spring:
  datasource:
    url: ${DB_URL}
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}

logging:
  level:
    root: info
```

Profile 用于表达环境差异，不适合表达每个客户的业务分支。如果配置组合越来越多，应考虑配置中心或独立租户配置，而不是创建几十个 Profile 文件。

## 3. 理解配置覆盖顺序

Spring Boot 会从多个来源读取配置。实践中常用的优先级可以这样理解：

1. 命令行参数和系统属性用于临时覆盖；
2. 环境变量用于部署平台注入；
3. 当前 Profile 配置覆盖基础配置；
4. `application.yml` 提供默认值；
5. 代码中的默认值作为最后兜底。

例如：

```powershell
java -jar app.jar --server.port=9090
```

命令行的端口会覆盖 YAML。临时覆盖很方便，但生产环境要把最终参数纳入部署记录，否则服务器重启后很难解释“这个值为什么不同”。

## 4. 使用 `@ConfigurationProperties` 管理一组配置

第三方无人机平台通常包含基础地址、应用标识、密钥和超时时间。相比在多个类中零散使用 `@Value`，配置对象更便于校验和复用：

```yaml
dji:
  api:
    base-url: ${DJI_API_BASE_URL}
    app-key: ${DJI_APP_KEY}
    app-secret: ${DJI_APP_SECRET}
    connect-timeout: 3s
    read-timeout: 8s
```

```java
@Validated
@ConfigurationProperties(prefix = "dji.api")
public class DjiApiProperties {

    @NotBlank
    private String baseUrl;

    @NotBlank
    private String appKey;

    @NotBlank
    private String appSecret;

    @NotNull
    private Duration connectTimeout = Duration.ofSeconds(3);

    @NotNull
    private Duration readTimeout = Duration.ofSeconds(8);
}
```

`@Validated` 让应用在启动阶段发现缺失配置，而不是等第一笔业务请求到来才空指针。`Duration` 支持 `3s`、`500ms` 等可读格式，也避免不同代码对数字单位理解不一致。

## 5. 配置默认值要分安全与非安全两类

端口、超时和线程数可以提供合理默认值：

```yaml
server:
  port: ${SERVER_PORT:8080}
```

密码、签名密钥和生产数据库地址不应提供“看似可用”的默认值。否则环境变量遗漏后，应用可能连接到错误环境或使用弱密钥。对于关键配置，让启动失败比静默使用错误默认值更安全。

## 6. 敏感信息不能出现在代码和日志中

需要保护的内容包括数据库密码、JWT 密钥、对象存储凭据、第三方平台 Secret 和用户 Token。基本原则包括：

- 不提交真实 Secret 到 Git；
- 使用部署平台 Secret、环境变量或专用密钥服务；
- 日志打印配置对象时对敏感字段脱敏；
- 定期轮换长期凭据；
- 测试环境和生产环境使用不同凭据；
- 发生泄露时先吊销，再清理历史记录。

仅仅删除最新提交中的密码并不代表安全，因为 Git 历史中仍可能存在。正确响应应当先将凭据视为已泄露并立即轮换。

## 7. 数据源配置要同时关注连接池

项目可以将 Druid 等数据源配置放在独立文件中。除了 URL 和密码，还应关注连接池大小、连接验证和等待时间：

```yaml
spring:
  datasource:
    druid:
      initial-size: 5
      min-idle: 5
      max-active: 30
      max-wait: 3000
      validation-query: SELECT 1
```

`max-active` 不是越大越好。若应用有 10 个实例，每个实例允许 100 个连接，数据库可能面对 1000 个连接。应从数据库容量、实例数、请求耗时和峰值并发共同计算，并监控连接等待和活跃连接数。

## 8. 日志配置也应区分环境

本地开发可以打开包级 DEBUG，生产环境通常使用 INFO，并对慢请求和异常保留足够上下文：

```yaml
logging:
  level:
    root: info
    com.ahebai: info
    org.springframework.security: warn
  file:
    name: ${LOG_PATH:./logs}/application.log
```

生产环境不建议长期输出完整 SQL 参数，尤其是用户手机号、证件信息和签名字段。调试问题时可以临时调整日志级别，但要有恢复机制，避免日志量突然增长占满磁盘。

## 9. 打包后的 Jar 如何启动

Spring Boot 可执行 Jar 内含应用依赖和内嵌服务器，部署时无需额外安装 Tomcat：

```powershell
java -jar app.jar --spring.profiles.active=prod
```

常见 JVM 参数包括：

```powershell
java -Xms512m -Xmx1024m `
  -Duser.timezone=Asia/Shanghai `
  -jar app.jar `
  --spring.profiles.active=prod
```

堆内存应根据容器限制和非堆内存预留确定。不要把 `-Xmx` 设置为容器全部内存，否则线程栈、元空间、直接内存和本地库没有余量，进程仍可能被系统终止。

## 10. 使用容器固定运行环境

一个简化的运行镜像可以写成：

```dockerfile
FROM eclipse-temurin:17-jre

WORKDIR /app
COPY target/app.jar /app/app.jar

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
```

配置仍应从容器环境注入，而不是写入镜像。镜像标签最好包含版本号或提交标识，避免所有环境都使用不可追踪的 `latest`。运行用户应使用非 root 账号，基础镜像和依赖也要定期更新。

## 11. 健康检查不等于端口能连通

应用端口打开，只说明进程已经监听，不代表数据库、Redis 和关键依赖可用。可通过 Actuator 暴露受控的健康端点：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics
  endpoint:
    health:
      probes:
        enabled: true
```

存活检查回答“进程是否需要重启”，就绪检查回答“实例是否可以接收流量”。如果数据库短暂抖动，不一定应该立刻让存活检查失败并重启所有实例，否则可能放大故障。

管理端点不应无条件暴露到公网。需要通过网络隔离、认证和最小暴露列表保护。

## 12. 优雅停机保护正在处理的请求

启用：

```yaml
server:
  shutdown: graceful

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

收到终止信号后，应用先停止接收新请求，再等待现有请求在限定时间内完成。部署平台也要给进程足够的终止宽限期。若平台五秒后强制杀死进程，而应用配置等待三十秒，优雅停机仍然无法发挥作用。

## 13. 滚动发布需要兼容过渡期

发布过程中，新旧版本可能同时运行几分钟，因此数据库变更应兼容两代代码。更安全的顺序是：

1. 先新增可空字段或新表，不立即删除旧结构；
2. 发布能同时兼容新旧结构的代码；
3. 完成数据回填和观测；
4. 所有实例升级后，再停止写旧字段；
5. 后续版本中清理旧字段。

直接重命名字段或修改枚举含义，容易让旧实例在滚动期间报错。配置变更也要考虑回滚：新版本新增的必填配置，在回滚到旧版本时是否会造成副作用。

## 14. 部署失败时如何定位

可以按启动链路逐层检查：

- 进程是否启动，退出码是什么；
- Java 版本是否符合项目要求；
- 当前激活的 Profile 是否正确；
- 必填环境变量是否注入；
- 数据库和 Redis 网络是否可达；
- 配置绑定或 Bean 创建在哪一步失败；
- 端口是否冲突；
- 健康检查路径和权限是否正确；
- 实例是否因内存限制被系统终止。

保留启动日志和最终生效配置的非敏感摘要，通常比反复重启更有帮助。

## 15. 发布前检查清单

- 配置文件中是否不存在真实密码和 Token；
- 环境变量名称是否与 `@ConfigurationProperties` 一致；
- 数据库迁移是否向前、向后兼容；
- 日志目录、轮转和磁盘告警是否就绪；
- 健康端点是否受保护且能区分存活与就绪；
- JVM 内存是否为线程栈和直接内存留出空间；
- 优雅停机时间是否与平台宽限期匹配；
- 镜像、Jar、配置和数据库版本是否可追踪；
- 回滚步骤是否经过书面确认。

## 16. 小结

多环境配置的核心不是多写几个 YAML，而是让代码、普通配置和敏感凭据各自处在正确位置。部署也不只是执行 `java -jar`，还包括资源限制、健康检查、日志、优雅停机、数据库兼容和回滚路径。把这些内容纳入开发阶段，服务才能从“本地能运行”走向“环境中可维护”。
