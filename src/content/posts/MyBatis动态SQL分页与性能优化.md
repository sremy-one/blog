---
title: MyBatis 动态 SQL、分页与性能优化实践
published: 2026-06-13
description: 从 Mapper 代理与 XML 映射出发，系统讲解动态条件、批量参数、PageHelper 分页、稳定排序、N+1 查询、索引与执行计划分析。
tags: [实习, 后端开发, MyBatis, SQL优化, 分页]
category: 后端开发
image: https://img.asyore.cn/fengmian/EMT62.webp
slug: mybatis-dynamic-sql-pagination-performance
---

MyBatis 的优势是 SQL 可见、可控，也因此把更多责任交给开发者：条件组合是否正确、参数是否安全、分页是否稳定、索引是否生效，都需要在代码和数据库之间共同判断。本文从一个地址关键词查询开始，逐步梳理 Mapper 到 SQL 执行的完整过程。

## 1. Mapper 接口为什么不需要实现类

项目通过 `@MapperScan("com.ahebai.**.mapper")` 扫描 Mapper 接口。启动时，MyBatis 为接口创建代理对象并注册到 Spring 容器：

```java
public interface WxUserAddressMapper {

    List<WxUserAddress> searchAddress(
        @Param("wxUserId") Long wxUserId,
        @Param("keyword") String keyword);
}
```

XML 中的 `namespace` 必须等于接口全限定名，语句 `id` 必须等于方法名：

```xml
<mapper namespace="com.ahebai.manage.mapper.WxUserAddressMapper">
    <select id="searchAddress"
            resultMap="WxUserAddressResult">
        SELECT id, wx_user_id, receiver_name,
               receiver_phone, detail_address
        FROM wx_user_address
        WHERE wx_user_id = #{wxUserId}
          AND deleted = 0
    </select>
</mapper>
```

调用接口方法时，代理根据“接口名 + 方法名”定位 SQL，绑定参数并把结果转换为对象。因此接口重命名、XML 命名空间和语句 ID 必须同步修改。

## 2. `@Param` 让参数名保持稳定

当 Mapper 方法有多个参数时，应显式使用 `@Param`：

```java
List<DeliveryOrder> selectPage(
    @Param("status") Integer status,
    @Param("wxUserId") Long wxUserId,
    @Param("keyword") String keyword);
```

XML 可以稳定使用 `#{status}`、`#{wxUserId}` 和 `#{keyword}`。如果依赖编译器是否保留参数名，不同构建配置下可能出现 `Parameter 'xxx' not found`。明确命名也让 SQL 的语义更容易阅读。

## 3. `resultMap` 负责数据库列到对象字段的映射

字段命名不一致或需要关联对象时，可以使用 `resultMap`：

```xml
<resultMap id="WxUserAddressResult"
           type="WxUserAddress">
    <id property="id" column="id"/>
    <result property="wxUserId" column="wx_user_id"/>
    <result property="receiverName" column="receiver_name"/>
    <result property="receiverPhone" column="receiver_phone"/>
    <result property="detailAddress" column="detail_address"/>
</resultMap>
```

`<id>` 不只是普通字段标记，MyBatis 在处理关联结果时会借助它识别相同主对象。查询字段应显式列出，避免使用 `SELECT *` 导致无关大字段被加载，也避免表结构新增列后不知不觉改变查询成本。

## 4. 使用 `<where>` 和 `<if>` 组合动态条件

列表查询常见多个可选筛选条件：

```xml
<select id="selectOrderList"
        resultMap="DeliveryOrderResult">
    SELECT id, order_no, wx_user_id,
           status, create_time
    FROM delivery_order
    <where>
        deleted = 0
        <if test="wxUserId != null">
            AND wx_user_id = #{wxUserId}
        </if>
        <if test="status != null">
            AND status = #{status}
        </if>
        <if test="keyword != null and keyword != ''">
            AND (
                order_no LIKE CONCAT('%', #{keyword}, '%')
                OR receiver_name LIKE CONCAT('%', #{keyword}, '%')
                OR receiver_phone LIKE CONCAT('%', #{keyword}, '%')
            )
        </if>
    </where>
    ORDER BY create_time DESC, id DESC
</select>
```

`<where>` 会在存在条件时自动添加 `WHERE`，并清理开头多余的 `AND` 或 `OR`。关键词的三个 `OR` 必须放在括号内，否则 SQL 运算优先级可能让 `deleted = 0` 和用户条件只约束第一个分支，造成已删除数据或其他用户数据被查出。

## 5. `#{}` 与 `${}` 的安全差异

`#{keyword}` 通过预编译参数绑定，数据库把输入当作值；`${keyword}` 是字符串直接替换，可能形成 SQL 注入：

```xml
<!-- 正确：值参数 -->
WHERE order_no = #{orderNo}

<!-- 危险：客户端输入直接拼接 -->
ORDER BY ${sortField} ${sortDirection}
```

排序字段不能用 `#{}` 代替列名。如果确实需要动态排序，应在 Java 中把用户输入映射到固定枚举，再在 XML 中白名单选择：

```xml
<choose>
    <when test="sortField == 'status'">
        ORDER BY status
    </when>
    <when test="sortField == 'orderNo'">
        ORDER BY order_no
    </when>
    <otherwise>
        ORDER BY create_time
    </otherwise>
</choose>
```

方向也只允许 `ASC` 或 `DESC`，不要把任意字符串放进 SQL。

## 6. 使用 `<foreach>` 处理批量参数

批量查询和批量更新可以避免循环执行多次 SQL：

```java
List<DeliveryOrder> selectByIds(
    @Param("ids") List<Long> ids,
    @Param("wxUserId") Long wxUserId);
```

```xml
SELECT id, order_no, status
FROM delivery_order
WHERE wx_user_id = #{wxUserId}
  AND deleted = 0
  AND id IN
<foreach collection="ids"
         item="id"
         open="(" separator="," close=")">
    #{id}
</foreach>
```

Service 层要先判断集合非空，并限制单次批量数量。几万个 ID 会产生超长 SQL、增加解析成本，也可能超过数据库或驱动限制。通常应按几百或一千条分批处理，并在事务和内存之间取得平衡。

## 7. PageHelper 的调用顺序决定分页是否生效

PageHelper 通过线程上下文和 MyBatis 拦截器改写紧随其后的查询：

```java
public TableDataInfo list(OrderQuery query) {
    startPage();
    List<DeliveryOrder> list =
        orderService.selectOrderList(query);
    return getDataTable(list);
}
```

`startPage()` 必须位于目标查询之前。中间如果先执行了其他查询，分页可能作用到错误 SQL。分页参数也要设置最大值，避免客户端请求一页十万条数据。

分页查询通常会额外执行一条 `COUNT`。复杂关联和分组查询的计数可能很慢，可以针对列表场景编写更简单的计数 SQL，或在不需要总条数的滚动加载中使用“是否还有下一页”模式。

## 8. 稳定排序防止翻页重复和遗漏

只按 `create_time DESC` 排序并不稳定，因为多条记录可能拥有同一时间。数据库可以在并列记录间使用任意顺序，第二页可能重复第一页的数据。加入唯一主键作为第二排序条件：

```sql
ORDER BY create_time DESC, id DESC
```

数据量很大且页码很深时，`LIMIT 100000, 20` 仍需扫描并丢弃大量记录。可以改为游标分页：

```sql
SELECT id, order_no, create_time
FROM delivery_order
WHERE deleted = 0
  AND (
      create_time < #{lastCreateTime}
      OR (create_time = #{lastCreateTime} AND id < #{lastId})
  )
ORDER BY create_time DESC, id DESC
LIMIT 20
```

客户端携带上一页最后一条记录的时间和 ID，数据库可以从索引位置继续扫描，适合时间线和无限滚动列表。

## 9. 识别并消除 N+1 查询

如果先查询 100 个订单，再循环查询每个订单的用户信息，就会执行 101 条 SQL：

```java
List<DeliveryOrder> orders = orderMapper.selectList(query);
for (DeliveryOrder order : orders) {
    order.setUser(userMapper.selectById(order.getWxUserId()));
}
```

可以根据数据关系选择联表查询，或先收集全部用户 ID 再批量查询并组装：

```java
Set<Long> userIds = orders.stream()
    .map(DeliveryOrder::getWxUserId)
    .collect(Collectors.toSet());

Map<Long, WxUser> userMap = userMapper.selectByIds(userIds)
    .stream()
    .collect(Collectors.toMap(WxUser::getId, Function.identity()));

orders.forEach(order ->
    order.setUser(userMap.get(order.getWxUserId())));
```

联表适合数据量可控、关系简单的查询；批量组装更适合需要复用缓存或避免复杂笛卡尔积的场景。

## 10. 聚合统计尽量让数据库一次完成

分别查询待接单、配送中、已完成数量会执行多条扫描。可以使用条件聚合：

```sql
SELECT
    SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS pending_count,
    SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS delivering_count,
    SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS completed_count
FROM delivery_order
WHERE deleted = 0
  AND create_time >= #{startTime}
```

一次扫描返回多个指标，既减少网络往返，也让统计口径共享相同条件。若统计跨度很大且访问频繁，则应进一步考虑汇总表或定时快照，而不是每次扫描明细表。

## 11. 索引要围绕查询条件和排序设计

索引不是越多越好。对于以下查询：

```sql
WHERE wx_user_id = ?
  AND deleted = 0
ORDER BY create_time DESC, id DESC
```

可以评估联合索引 `(wx_user_id, deleted, create_time, id)`。等值条件通常放在前面，排序字段随后。最终设计仍要结合字段区分度、写入频率和其他查询，不应只凭一条 SQL 决定。

`LIKE '%关键词%'` 因为开头有通配符，普通 B+Tree 索引通常无法完成前缀定位。数据量小时可以接受；数据量大时应考虑前缀搜索、倒排索引或专用搜索服务，而不是不断追加普通索引。

## 12. 用执行计划验证推测

性能优化不能只看 SQL 长短，应使用 `EXPLAIN` 观察：

- 实际使用了哪个索引；
- 预计扫描多少行；
- 是否出现全表扫描；
- 是否发生额外排序或临时表；
- 联表顺序是否合理。

优化后还要用接近生产分布的数据重新测量。开发库只有几十条记录时，数据库选择全表扫描可能反而更快，不能代表生产环境表现。

## 13. 更新语句也要表达业务前置条件

订单状态更新不要先查再无条件写入：

```sql
UPDATE delivery_order
SET status = #{targetStatus},
    update_time = NOW()
WHERE id = #{orderId}
  AND status = #{expectedStatus}
  AND deleted = 0
```

如果影响行数为零，说明订单不存在或已经被其他请求修改。条件更新把状态机前置条件交给数据库原子判断，可以减少并发覆盖问题。它与事务并不冲突：事务负责一组操作的整体一致性，条件更新负责单条语句的并发竞争。

## 14. Mapper 测试应验证 SQL 语义

Mapper 测试重点不是“方法能调用”，而是动态条件是否组合正确：

- keyword 为空时是否省略模糊条件；
- 多个 `OR` 是否被括号正确包裹；
- 逻辑删除和用户隔离条件是否始终存在；
- 空集合是否生成非法 `IN ()`；
- 同时间数据的分页顺序是否稳定；
- 条件更新在状态不匹配时是否返回零行。

对于数据库方言、索引和锁行为，使用真实 MySQL 的集成测试比内存数据库更可信。

## 15. 小结

MyBatis 让 SQL 成为业务代码的一部分。写好 Mapper 不仅是把语句放进 XML，还要同时考虑安全参数、动态条件优先级、分页稳定性、查询次数、索引路径和并发前置条件。保持 SQL 可读、用执行计划验证、用集成测试保护关键语义，才能真正发挥“可控”的优势。
