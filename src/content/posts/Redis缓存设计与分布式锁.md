---
title: Redis 缓存设计与分布式锁：从 Cache Aside 到并发控制
published: 2026-06-19
description: 结合系统配置与登录会话缓存，讲解 Cache Aside、键设计、一致性、穿透击穿雪崩、序列化，以及带令牌和 Lua 释放的分布式锁。
tags: [实习, 后端开发, Redis, 缓存一致性, 分布式锁]
category: 后端开发
image: https://img.asyore.cn/fengmian/EMT64.webp
slug: redis-cache-distributed-lock
---

Redis 在 Spring Boot 项目中经常同时承担登录会话、系统配置、验证码、热点数据和并发协调等职责。它速度快，但“把数据库结果放进去”只是开始。键如何命名、何时失效、数据库更新失败怎么办、多个实例如何竞争同一任务，都会影响系统正确性。

## 1. 先判断数据是否适合缓存

适合缓存的数据通常具有以下特点：

- 读取频率高，修改频率低；
- 查询或计算成本较高；
- 允许短时间内存在旧值；
- 可以定义明确的失效策略；
- 缓存丢失后仍能从权威数据源恢复。

系统配置就是典型例子。应用频繁读取配置键，但管理员很少修改。数据库是权威数据源，Redis 只是加速层。账户余额、库存扣减等强一致数据不能仅依赖普通缓存读写决定最终结果。

## 2. Cache Aside 的基本读路径

项目中的系统配置服务可以采用旁路缓存模式：先查 Redis，未命中再查数据库并回填。

```java
public String selectConfigByKey(String configKey) {
    String cacheKey = getCacheKey(configKey);
    String cachedValue = redisCache.getCacheObject(cacheKey);
    if (cachedValue != null) {
        return cachedValue;
    }

    SysConfig config = configMapper.selectConfigByKey(configKey);
    if (config == null) {
        return null;
    }

    redisCache.setCacheObject(cacheKey, config.getConfigValue());
    return config.getConfigValue();
}
```

这段代码中，数据库仍然决定真实值。Redis 故障时，可以降级查询数据库；Redis 数据被清空时，也能逐步重建。不要让缓存成为唯一副本，否则缓存重启会变成数据事故。

## 3. 启动预热与按需加载如何选择

若配置数量少且几乎每次请求都要使用，可以在服务启动后预加载：

```java
@PostConstruct
public void init() {
    loadingConfigCache();
}
```

`@PostConstruct` 在依赖注入完成后执行，适合加载必要的小型字典或配置。预热的优点是第一笔请求不会承担数据库查询；缺点是数据过大或依赖暂时不可用时会拖慢甚至阻止启动。

普通业务列表更适合按需加载，并设置过期时间。是否预热需要根据数据规模、首请求时延和启动可用性决定，不应把所有表都在启动时读进 Redis。

## 4. 键命名要包含业务边界

键名应当可读、可分组、不会与其他模块冲突：

```text
sys:config:delivery.timeout.minutes
login:token:7e6c8b...
wx:user:profile:1024
delivery:order:detail:202608040001
```

建议结构为“系统或环境 + 模块 + 资源 + 标识”。多个环境共用 Redis 时，还要加入环境前缀：

```text
prod:uav:sys:config:delivery.timeout.minutes
test:uav:sys:config:delivery.timeout.minutes
```

不要直接使用模糊短键，如 `user:1` 或 `config:a`。批量删除时也不要在生产代码中使用阻塞式 `KEYS *`，可以维护集合索引、按版本切换前缀，或使用渐进式扫描。

## 5. TTL 不只是节省空间

过期时间同时决定旧数据最长存在多久。不同数据应使用不同 TTL：

- 登录会话与登录有效期一致，并在活跃时按策略续期；
- 验证码只保存几分钟，读取成功后立即删除；
- 热点详情可以缓存几分钟；
- 很少变化的系统配置可以长时间保存，但修改时主动清理；
- 分布式锁必须有较短的安全过期时间，避免持锁进程崩溃后永不释放。

永久缓存并非一定错误，但必须有主动更新、删除和重建机制。

## 6. 更新数据库后删除缓存

Cache Aside 常用的写路径是先更新数据库，再删除缓存：

```java
@Transactional
public void updateConfig(SysConfig config) {
    int rows = configMapper.updateConfig(config);
    if (rows != 1) {
        throw new ServiceException("配置更新失败");
    }
    redisCache.deleteObject(getCacheKey(config.getConfigKey()));
}
```

下一次读取会从数据库获得新值并回填。相比“同时更新数据库和缓存”，删除策略少维护一份值转换逻辑，也避免数据库成功而缓存写入旧结构。

不过，这里仍存在短暂竞态：请求 A 查询到旧数据库值，还未回填；请求 B 更新数据库并删除缓存；随后 A 把旧值写回。对于配置类数据，可以通过较短 TTL、更新后延迟二次删除或版本号减轻影响。强一致业务则应避免让缓存承担判断依据。

## 7. 事务与缓存操作不是同一个原子事务

`@Transactional` 只能控制数据库事务，不能自动让 Redis 操作一起回滚。如果方法删除缓存后数据库事务最终回滚，缓存虽然丢失，但下次会重新读取旧数据库值，通常只是性能损失；若先写缓存后数据库回滚，则可能留下数据库中不存在的新值。

因此更常见的是数据库提交成功后再失效缓存。可以注册事务同步回调：

```java
TransactionSynchronizationManager.registerSynchronization(
    new TransactionSynchronization() {
        @Override
        public void afterCommit() {
            redisCache.deleteObject(cacheKey);
        }
    });
```

对可靠性要求更高时，可以使用事务消息、Outbox 表或变更数据捕获，让缓存失效事件可重试、可观测。

## 8. 缓存穿透：查询不存在的数据

攻击者反复查询随机 ID 时，Redis 永远未命中，所有请求都会落到数据库。这就是缓存穿透。常用方法包括：

1. 在入口校验 ID 和业务参数格式；
2. 对不存在结果缓存一个短时空值；
3. 使用布隆过滤器判断标识是否可能存在；
4. 对异常频率请求限流。

空值缓存示例：

```java
if (data == null) {
    redisTemplate.opsForValue().set(
        cacheKey,
        NULL_MARKER,
        Duration.ofMinutes(2));
    return null;
}
```

空值 TTL 应比正常数据短，否则刚创建的新数据可能在一段时间内仍被旧空值遮挡。创建成功时也应主动删除对应空值键。

## 9. 缓存击穿：热点键同时失效

当一个极热点键过期，大量请求同时发现未命中并访问数据库，会形成缓存击穿。可以使用互斥重建：只有一个线程加载数据库，其他线程短暂等待后重试。

另一种方案是逻辑过期：Redis 中保留数据和逻辑过期时间，过期后先返回旧值，再由一个线程异步刷新。这种方式保证响应速度，但业务必须允许短时间旧数据。

不能把锁等待设置得无限长。数据库异常时，等待线程会不断堆积。应配置较短超时、降级返回和失败告警。

## 10. 缓存雪崩：大量键同一时刻过期

批量缓存若统一设置 30 分钟 TTL，可能在同一秒集中失效。可以加入随机抖动：

```java
long baseSeconds = 1800;
long jitterSeconds = ThreadLocalRandom.current().nextLong(0, 300);
Duration ttl = Duration.ofSeconds(baseSeconds + jitterSeconds);
```

还可以将热点数据分批预热、限制数据库并发、准备降级值，并确保 Redis 本身具备高可用能力。雪崩治理不是只调整 TTL，而是要为缓存整体不可用时保护数据库。

## 11. 序列化格式决定可读性与兼容性

Java 原生序列化体积大、跨语言差，也可能带来安全风险。JSON 更容易排查，但类型信息和日期格式需要明确。存对象时应考虑：

- 类字段新增或删除后旧缓存能否读取；
- 枚举值变化是否兼容；
- 是否把敏感字段写入缓存；
- 单个对象是否过大；
- 是否真的需要缓存整个实体。

许多场景只缓存字符串、数字或专用缓存 DTO，会比直接序列化数据库实体更稳定。

## 12. 分布式锁必须同时满足三件事

多个应用实例竞争同一订单超时处理时，本地 `synchronized` 只能约束一个 JVM。Redis 锁的加锁需要原子地实现“不存在才写入并设置过期”：

```java
String lockKey = "lock:delivery:timeout:" + orderId;
String lockValue = UUID.randomUUID().toString();

Boolean locked = redisTemplate.opsForValue().setIfAbsent(
    lockKey,
    lockValue,
    Duration.ofSeconds(30));

if (!Boolean.TRUE.equals(locked)) {
    return;
}
```

三个必要条件是：

1. `SET NX` 防止多个实例同时获得锁；
2. 过期时间防止持锁进程崩溃造成死锁；
3. 唯一 `lockValue` 防止线程删除其他实例后来获得的锁。

“先 setIfAbsent，再单独 expire”不是原子操作。进程可能在两条命令之间崩溃，留下永久锁。

## 13. 解锁必须比较令牌后再删除

以下写法有并发错误：

```java
// 不安全：可能删除别人的锁
redisTemplate.delete(lockKey);
```

假设线程 A 的锁过期，线程 B 获得同一键；随后 A 执行删除，就会删掉 B 的锁。比较和删除必须在 Redis 内原子完成，可使用 Lua：

```lua
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

```java
DefaultRedisScript<Long> unlockScript =
    new DefaultRedisScript<>(UNLOCK_LUA, Long.class);

redisTemplate.execute(
    unlockScript,
    Collections.singletonList(lockKey),
    lockValue);
```

业务执行时间可能超过锁 TTL 时，需要续期机制，或使用 Redisson 等经过验证的锁实现。即使使用成熟库，也仍要理解等待时间、租约时间和故障语义。

## 14. 锁不能替代数据库幂等与状态条件

分布式锁可能因网络分区、长暂停和过期时间估算错误失效。关键操作仍应通过唯一索引、幂等键或条件更新兜底：

```sql
UPDATE delivery_order
SET status = 'TIMEOUT'
WHERE id = #{orderId}
  AND status = 'PENDING'
```

即使两个实例都进入业务逻辑，也只有一个能把 `PENDING` 更新为 `TIMEOUT`。锁用于减少重复工作，数据库约束用于保证最终正确性。

## 15. 登录 Token 缓存与业务缓存要区分

登录 Token 是安全状态，失效必须及时且可控；商品详情一类业务缓存更关注性能，允许短时旧值。它们最好使用不同的键前缀、TTL 策略、序列化方式和监控指标。

如果资源允许，也可以按用途拆分 Redis 实例，避免大量业务缓存淘汰登录会话，或慢命令影响认证链路。

## 16. 需要观测哪些指标

- 命中率和未命中率；
- Redis 请求耗时与错误率；
- 内存使用、淘汰数量和过期数量；
- 热点键、大键和慢命令；
- 数据库回源次数；
- 分布式锁获取成功率、等待时间和持有时间；
- 会话数量和异常失效数量。

命中率低不一定表示缓存无效，也可能是键粒度过细、TTL 过短或访问本身不重复。指标必须结合业务类型解释。

## 17. 小结

Redis 缓存设计的核心是承认数据库仍是权威数据源，并为失效、并发和故障提前定义行为。Cache Aside、合理键名、分级 TTL、空值保护、随机过期和可观测指标解决读性能问题；唯一令牌、原子解锁和数据库条件更新共同解决分布式并发问题。缓存提升速度，但正确性仍需要完整链路保证。
