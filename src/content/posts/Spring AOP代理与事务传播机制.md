---
title: Spring AOP 代理与事务传播机制
published: 2026-06-07
description: 结合操作日志、数据权限与订单事务，介绍 JDK/CGLIB 代理、切点与通知、自调用失效、事务传播、隔离级别和外部系统一致性边界。
tags: [实习, 后端开发, Spring AOP, Spring 事务, 代理模式]
category: 后端开发
image: https://img.asyore.cn/images/EMT8.webp
slug: spring-aop-proxy-transaction-propagation
---

项目中的 `@Log`、`@DataScope`、`@RateLimiter` 和 `@Transactional` 看起来只是注解，真正执行功能的是 Spring AOP 创建的代理。代理在目标方法前后插入通用逻辑，让业务代码不用重复编写日志、权限、限流和事务模板。

## 1. AOP 解决横切逻辑

订单、用户、异常工单的接口都需要操作日志。如果每个方法手写相同代码，会出现大量重复：

```java
long start = System.currentTimeMillis();
try {
    Object result = doBusiness();
    saveLog("SUCCESS", System.currentTimeMillis() - start);
    return result;
} catch (Exception e) {
    saveLog("FAILED", System.currentTimeMillis() - start);
    throw e;
}
```

AOP 把共同逻辑抽到切面，业务方法只声明意图：

```java
@Log(title = "用户异常反馈",
     businessType = BusinessType.INSERT)
@PostMapping("/feedback")
public AjaxResult feedback(...) {
    return success(service.submitUserExceptionFeedback(dto));
}
```

切面读取注解内容，在方法执行前记录参数，执行后记录结果，异常时记录失败信息。

## 2. 切点、通知和连接点

```java
@Aspect
@Component
public class OperationLogAspect {
    @Pointcut("@annotation(com.ahebai.common.annotation.Log)")
    public void logPointcut() {
    }

    @Around("logPointcut()")
    public Object around(ProceedingJoinPoint point)
            throws Throwable {
        long start = System.currentTimeMillis();
        try {
            Object result = point.proceed();
            saveSuccess(point, result,
                    System.currentTimeMillis() - start);
            return result;
        } catch (Throwable e) {
            saveFailure(point, e);
            throw e;
        }
    }
}
```

`@Pointcut` 选择哪些方法需要增强，`@Around` 定义增强内容，`point.proceed()` 才是真正调用目标方法。忘记调用 proceed，业务方法就不会执行；调用两次则会重复执行业务。

切面中捕获异常后必须重新抛出，否则上层会认为方法成功，事务也可能提交。

## 3. JDK 代理和 CGLIB

Spring 常用两种代理：

| 代理方式 | 依据 | 特点 |
| --- | --- | --- |
| JDK 动态代理 | 接口 | 代理对象实现相同接口 |
| CGLIB | 类继承 | 生成目标类子类 |

Service 使用接口时通常可以采用 JDK 代理；没有接口时 Spring 可以使用 CGLIB。两者都只能拦截经过代理对象的可代理方法，private 方法和某些 final 方法不能按普通方式增强。

调用方应依赖 Service 接口，而不是强制转换成实现类，否则 JDK 代理场景下可能出现类型转换问题。

## 4. 自调用为什么绕过代理

```java
@Service
public class OrderService {
    public void process() {
        saveWithTransaction();
    }

    @Transactional
    public void saveWithTransaction() {
        mapper.insert(...);
    }
}
```

外部调用 `process()` 时经过代理，但 `process` 内部的 `saveWithTransaction()` 等价于 `this.saveWithTransaction()`，目标对象直接调用自己，没有再次经过代理，事务注解可能不生效。

更清晰的做法是把事务放在外部业务入口：

```java
@Transactional
public void process() {
    mapper.insert(...);
}
```

或者把内部动作移动到另一个 Service，由 Spring 注入后调用。为了一个注解强行从容器获取自身代理，会让依赖关系更难理解。

## 5. @Transactional 的执行过程

```text
Controller 调用 Service 代理
  -> TransactionInterceptor 读取事务属性
  -> 从 DataSource 获取连接
  -> 关闭自动提交并绑定到当前线程
  -> 执行 Service 与多个 Mapper
  -> 正常返回：提交
  -> 匹配异常：回滚
  -> 释放连接
```

同一线程内的 MyBatis 操作会使用事务上下文中的连接，因此订单、支付记录和过程日志可以一起提交或回滚。

## 6. 回滚规则

Spring 默认对运行时异常和 Error 回滚，对受检异常的默认行为不同。项目常写：

```java
@Transactional(rollbackFor = Exception.class)
public HyDeliveryOrder createUserDeliveryOrder(...) {
}
```

这表示包括受检异常在内的 Exception 都触发回滚。仍需注意，方法内部 catch 后不再抛出的异常不会到达事务拦截器。

业务校验应尽量发生在写数据库之前，减少已经持锁后才失败的情况。

## 7. 传播行为解决嵌套调用

最常见的 `REQUIRED` 表示加入已有事务：

```text
订单 Service 开启事务
  -> 支付记录 Service 加入同一事务
  -> 过程日志 Service 加入同一事务
```

`REQUIRES_NEW` 会暂停外层事务并创建新事务。它适合必须独立保存的审计信息，但若过程日志描述的是订单成功节点，独立提交可能留下与回滚订单矛盾的记录。

`SUPPORTS` 在有事务时加入，没有时以非事务运行；`MANDATORY` 要求调用方必须已经开启事务。传播行为不是性能选项，而是数据一致性语义。

## 8. 隔离级别与并发现象

数据库隔离级别处理脏读、不可重复读和幻读。订单状态更新更常遇到的是“两个请求都读到相同旧值，然后后写覆盖前写”。

可以使用条件更新或乐观锁：

```sql
update hy_delivery_order
set order_status = 'DELIVERING',
    version = version + 1
where order_id = #{orderId}
  and order_status = 'WAIT_DISPATCH'
  and version = #{version}
```

受影响行数为 0 表示数据已变化，Service 应重新读取并提示用户。提高隔离级别并不一定是最合适的解决方案，它可能增加锁竞争。

## 9. 事务范围应该多大

事务应覆盖一个必须共同成功的本地业务动作，但不要包含无关的慢操作：

```java
@Transactional
public void updateOrder() {
    validate();
    mapper.update(...);
    processLogMapper.insert(...);
    // 不适合在这里等待几十秒的外部接口
}
```

长事务会占用数据库连接和锁。大文件上传、第三方 HTTP 调用和复杂计算可以在事务前准备，或者通过状态表与事件拆开。

## 10. 数据库事务无法回滚第三方请求

```java
@Transactional
public void sendAndUpdate() {
    wechatClient.sendMessage(...);
    notificationMapper.updateSuccess(...);
}
```

若微信已发送成功，数据库更新失败，事务回滚也收不回消息。可以先在本地事务中写待发送事件，提交后由异步消费者调用微信，再更新发送结果。

对大疆创建任务这类不可随意重复的动作，还需要稳定业务请求号、第三方状态查询与人工补偿入口。

## 11. 多个切面的执行顺序

一个方法可能同时经过权限、日志、限流和事务切面。可以通过 `@Order` 明确顺序，例如：

```text
权限检查
  -> 限流
  -> 操作日志开始
  -> 事务开始
  -> 业务方法
  -> 事务提交/回滚
  -> 操作日志结束
```

日志若需要准确记录事务是否提交，应理解它位于事务切面的外部还是内部。顺序不明确时，可能记录“成功”后事务才提交失败。

## 12. AOP 的使用边界

适合放入切面的逻辑通常具有这些特点：跨多个模块、与单个业务无关、可以通过方法上下文获得所需信息。

订单状态校验、退款金额计算不适合藏在通用切面，因为它们属于明确业务规则。切面过多会让方法源码看起来简单，运行时却有大量隐式行为，排查困难。

## 13. 本篇小结

AOP 的核心不是注解，而是代理在方法边界插入行为。事务正是一种特殊的 AOP 增强。理解代理对象、自调用、传播行为和外部系统边界以后，才能判断 `@Transactional` 为什么生效、为什么失效，以及哪些一致性问题根本不能靠数据库事务解决。
