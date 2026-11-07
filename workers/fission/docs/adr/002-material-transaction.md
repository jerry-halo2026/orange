# ADR-002 · 素材消耗事务模型

状态：已批准（评审 B1 · PRD v1.1/v1.2）

## 背景
配音用后即删（原版铁律）+ 跨批次缓存 ini + 线程数 1–3 并发 + 断点续跑同时存在。若无事务模型，并发下同一配音/视频可能被两条成片重复选中，"素材未消耗"的 UAT 断言无法保证。

## 决策
四态状态机（唯一权威状态 = 内存 MaterialPool，池级锁）：

```
Available ──reserve──► Reserved(n) ──export成功──► Confirmed ──► Consumed(计次+1)
                           │
                           └─ 失败/取消/崩溃 ──► Released(回滚)
Consumed 副作用按 usePolicy（ADR-007）：once=删/移入 | count 到 N=删/归档/保留 | unlimited=仅计次
```

- 预留发生在 SELECT：一次成片所需配音（含复用计次）+视频片段**原子预留**
- 磁盘态（缓存 ini + report 流水）仅在**确认**时落盘；写法 = 临时文件 + 原子替换（File.Move）
- 崩溃恢复：启动扫描未确认 Reserved → 自动回滚；report 流水与 ini 对账，不一致以流水为准并告警
- BGM/视频素材不删，仅计流水；删除路径只作用于配音（usePolicy 决定）

## 后果
- 并发零重复可被集成测试硬断言（3 线程 × 10 成片）
- 原版「用后即删」语义保留为 usePolicy=once 默认值
