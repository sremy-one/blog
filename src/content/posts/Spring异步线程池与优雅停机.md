---
title: Spring 异步任务、线程池与优雅停机实践
published: 2026-06-22
description: 介绍 @Async 代理机制、线程池参数、拒绝策略、上下文传播、异常处理、事务边界、定时任务拆分与服务停机时的任务收尾。
tags: [实习, 后端开发, Spring异步, 线程池, 优雅停机]
category: 后端开发
image: https://img.asyore.cn/images/EMT13.webp
slug: spring-async-thread-pool-graceful-shutdown
---

把耗时逻辑放到异步线程，可以降低接口等待时间，但也会引入队列堆积、上下文丢失、异常无人处理、事务提前提交和服务关闭时任务丢失等问题。异步并不是简单地加一个 `@Async`，而是要把线程池当成一项有容量、有边界的运行资源。

## 1. 哪些任务适合异步

适合异步的任务通常满足：

- 主流程不依赖它的即时返回值；
- 允许短时间延迟；
- 失败可以重试或补偿；
- 可以设计幂等；
- 能够单独监控成功和失败。

例如操作日志、非关键通知、报表快照和第三方状态同步可以考虑异步。库存扣减、订单状态确认等主流程关键步骤，如果接口已经向用户返回成功，就必须保证后续任务不会静默丢失。这类场景往往更适合可靠消息队列或 Outbox，而不是只放入进程内线程池。

## 2. `@Async` 仍然依赖 Spring 代理

开启异步能力：

```java
@EnableAsync
@Configuration
public class AsyncConfig {
}
```

异步方法放在 Spring Bean 中：

```java
@Service
public class NotificationService {

    @Async("businessExecutor")
    public CompletableFuture<Void> sendOrderNotice(Long orderId) {
        // 调用消息平台
        return CompletableFuture.completedFuture(null);
    }
}
```

调用方拿到的是代理对象。代理拦截方法，把任务提交给指定线程池，当前请求线程无需等待任务执行完毕。与事务相同，同一个类内部使用 `this.sendOrderNotice()` 会绕过代理，方法仍在当前线程同步执行。可以将异步职责拆到独立 Bean，或通过事件进行解耦。

## 3. 明确配置业务线程池

不应让所有任务共享一个参数不明确的默认执行器。一个可读的线程池配置如下：

```java
@Bean("businessExecutor")
public ThreadPoolTaskExecutor businessExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(8);
    executor.setMaxPoolSize(16);
    executor.setQueueCapacity(500);
    executor.setKeepAliveSeconds(60);
    executor.setThreadNamePrefix("business-async-");
    executor.setRejectedExecutionHandler(
        new ThreadPoolExecutor.CallerRunsPolicy());
    executor.setWaitForTasksToCompleteOnShutdown(true);
    executor.setAwaitTerminationSeconds(30);
    executor.initialize();
    return executor;
}
```

线程名称能让日志和线程转储更容易定位来源。队列容量和拒绝策略明确后，高峰压力才不会无声地转化为无限内存增长。

## 4. 核心线程、最大线程和队列如何协作

`ThreadPoolExecutor` 接收任务时大致遵循：

1. 当前线程数小于核心线程数，创建核心线程；
2. 核心线程已满，将任务放入队列；
3. 队列已满且线程数小于最大线程数，创建额外线程；
4. 队列和最大线程都已满，执行拒绝策略。

因此，如果队列设置得非常大，最大线程数可能长期不会生效。队列过小又会在短暂波动时频繁扩容或拒绝。参数应根据任务平均耗时、峰值到达速率、下游容量和可接受等待时间估算，并通过生产指标校准。

CPU 密集任务的线程数通常接近 CPU 核数；包含网络等待的 I/O 任务可以更多，但最终受数据库连接池、HTTP 连接池和第三方限流约束。线程开得比下游容量大，只会把等待搬到别处。

## 5. 拒绝策略决定过载时发生什么

常见策略包括：

- `AbortPolicy`：直接抛异常，失败明确；
- `CallerRunsPolicy`：由提交任务的线程执行，形成反压；
- `DiscardPolicy`：静默丢弃，不适合重要任务；
- `DiscardOldestPolicy`：丢弃队列最旧任务，业务语义通常难以接受。

`CallerRunsPolicy` 会让接口线程自己执行任务，从而增加响应时间，但可以降低继续提交的速度。对于不能丢的任务，单靠拒绝策略仍不够，应持久化任务或交给消息队列，并提供重试与死信处理。

## 6. 不同任务使用不同线程池

报表计算、日志写入和第三方 API 调用的耗时与失败模式不同。如果共享线程池，慢速第三方接口可能占满所有线程，连简单日志都无法执行。

可以按隔离边界配置：

```java
@Async("reportExecutor")
public void buildSnapshot() {
}

@Async("thirdPartyExecutor")
public void syncDjiStatus() {
}
```

隔离后可以为第三方调用设置更短队列和更严格拒绝策略，为报表任务设置较少线程，防止它挤占在线请求资源。这种做法类似舱壁：一个依赖出现问题时，不让所有异步工作同时失效。

## 7. 请求上下文不会自动传播

异步线程来自线程池，它不会天然继承请求线程中的 MDC、`SecurityContext`、语言环境和自定义 `ThreadLocal`。如果日志依赖追踪 ID，就要显式复制上下文：

```java
public class MdcTaskDecorator implements TaskDecorator {

    @Override
    public Runnable decorate(Runnable runnable) {
        Map<String, String> contextMap = MDC.getCopyOfContextMap();
        return () -> {
            try {
                if (contextMap != null) {
                    MDC.setContextMap(contextMap);
                }
                runnable.run();
            } finally {
                MDC.clear();
            }
        };
    }
}
```

```java
executor.setTaskDecorator(new MdcTaskDecorator());
```

`finally` 中清理非常重要，因为线程会被复用。不清理会让下一项任务继承上一请求的追踪信息，产生错误日志关联甚至数据泄露。

业务身份最好作为明确参数传入异步方法，而不是在后台线程中继续读取当前请求用户。异步任务可能在请求结束很久后才执行，此时请求上下文本就不应再存在。

## 8. 异步异常必须有接收者

返回 `void` 的异步方法抛出的异常无法返回给原请求线程，可以配置处理器：

```java
@Configuration
public class AsyncExceptionConfig implements AsyncConfigurer {

    @Override
    public AsyncUncaughtExceptionHandler
            getAsyncUncaughtExceptionHandler() {
        return (throwable, method, params) ->
            log.error("异步任务执行失败, method={}, params={}",
                method.getName(), params, throwable);
    }
}
```

如果调用方需要知道结果，使用 `CompletableFuture`：

```java
CompletableFuture<SyncResult> future =
    syncService.syncOrder(orderId);

future.whenComplete((result, error) -> {
    if (error != null) {
        log.error("订单同步失败, orderId={}", orderId, error);
    }
});
```

记录异常只是最低要求。关键任务还需要重试次数、下一次重试时间、最终失败状态和人工补偿入口。

## 9. 异步方法会开启新的事务边界

请求线程中的事务上下文不会跨线程传播：

```java
@Transactional
public void createOrder(CreateOrderRequest request) {
    DeliveryOrder order = saveOrder(request);
    notificationService.sendOrderNotice(order.getId());
}
```

异步任务可能在外层事务提交前就读取订单，导致查不到数据；也可能外层事务最终回滚，但通知已经发出。可以在事务提交后发布事件：

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Async("businessExecutor")
public void onOrderCreated(OrderCreatedEvent event) {
    notificationService.send(event.getOrderId());
}
```

这确保只有数据库提交成功后才提交异步工作，但进程在提交后、任务入队前崩溃仍可能丢失事件。要求可靠投递时，应使用事务消息或 Outbox 表。

## 10. 重试前必须先实现幂等

网络超时不代表第三方没有成功处理。直接重试可能发送两次通知或创建两笔资源。可以为每个业务动作生成幂等键：

```java
String idempotencyKey = "ORDER_NOTICE:" + orderId;
if (!taskRecordService.tryStart(idempotencyKey)) {
    return;
}

try {
    thirdPartyClient.sendNotice(orderId);
    taskRecordService.markSuccess(idempotencyKey);
} catch (Exception e) {
    taskRecordService.markFailed(idempotencyKey, e.getMessage());
    throw e;
}
```

幂等记录可以通过唯一索引防止重复创建。重试应区分可恢复错误和永久错误，例如网络超时可以指数退避重试，参数非法则应直接失败并告警。

## 11. 定时任务只负责调度，不承载大段业务

订单超时扫描或报表快照任务应保持轻量：

```java
@Component
public class DeliveryOrderTimeoutTask {

    private final DeliveryOrderTimeoutService timeoutService;

    @Scheduled(cron = "0 */1 * * * ?")
    public void execute() {
        timeoutService.processBatch();
    }
}
```

调度类决定何时触发，Service 决定查询哪些订单、如何抢占任务、怎样更新状态和记录结果。这样业务逻辑可以被普通单元测试覆盖，也能从手动补偿入口复用。

多个实例同时运行时，所有实例都会触发 `@Scheduled`。需要通过调度平台、分布式锁或数据库抢占控制重复执行，同时仍使用条件更新和幂等保证最终正确。

## 12. 长任务应分批并设置超时

一次查询几十万条记录并放进线程池会同时占用内存、数据库连接和队列。更稳妥的方式是小批量拉取：

```java
while (true) {
    List<Long> ids = orderMapper.selectPendingIds(200);
    if (ids.isEmpty()) {
        break;
    }
    processBatch(ids);
}
```

每批任务要有明确超时，第三方 HTTP 客户端同时设置连接、读取和整体调用超时。没有超时的线程可能永久占用池容量，让后续任务全部排队。

## 13. 优雅停机需要应用与平台配合

线程池启用：

```java
executor.setWaitForTasksToCompleteOnShutdown(true);
executor.setAwaitTerminationSeconds(30);
```

Spring Boot 服务同时启用：

```yaml
server:
  shutdown: graceful

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

发布时，负载均衡先停止向实例分配新流量，应用等待请求和异步任务完成，超过时间后才退出。对于执行数分钟的报表，不应无限延长停机时间，而应将任务进度持久化，使新实例可以继续。

进程内队列无法承诺跨重启保留任务。凡是“重启也不能丢”的工作，都应写入数据库或消息系统。

## 14. 线程池需要持续监控

至少关注：

- 活跃线程数与最大线程数；
- 当前队列长度与队列容量；
- 已完成任务数；
- 拒绝任务数；
- 任务排队时间和执行时间；
- 异常数、超时数和重试数；
- 下游数据库连接池与 HTTP 连接池使用率。

只有执行耗时而没有排队耗时，会遗漏“任务本身很快，但在队列里等了十分钟”的问题。告警阈值也应与业务时效关联，而不是只看线程数。

## 15. 异步任务检查清单

- 任务失败是否可以发现、重试和人工补偿；
- 是否具有业务幂等键；
- 是否误用同类内部调用导致 `@Async` 失效；
- 是否错误依赖请求线程的用户上下文；
- 线程池和下游连接池容量是否匹配；
- 队列满时的策略是否符合业务语义；
- 外层事务回滚时是否已经产生外部副作用；
- 应用重启时未完成任务是否会丢失；
- 是否为第三方请求配置所有必要超时；
- 多实例定时任务是否会重复执行。

## 16. 小结

Spring 的 `@Async` 解决的是“把方法提交到另一个执行器”，不是可靠任务系统。线程池容量、拒绝策略、上下文清理、异常接收、事务提交时机、幂等和停机恢复共同决定异步链路是否可信。普通低风险工作可以使用进程内线程池；关键任务则应进一步使用持久化消息和可恢复状态。
