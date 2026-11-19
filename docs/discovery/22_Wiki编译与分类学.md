# Wiki 编译与分类学

文档集 U2（2026-11-13）。起点 `dev @ 3f66692`。职责：说明素材理解结果如何变成可读、可查、可复核的知识库：三层数据模型、8 类实体、triage 的判定权归属、零写入保证、版本与幂等、以及分歧仲裁。

本文件描述的是 `apps/api/src/wiki/` 这个库的实际行为；它是库 + 测试，**不是**已上线的 HTTP 接口（见末节）。

## 1 结论表

| # | 结论 | 证据 |
| --- | --- | --- |
| 1 | 三层：`wiki_source`（不可变证据）→ `wiki_summary`（纪要卡）→ `wiki_entity`（Markdown 实体页） | `[代码]` `docs/sql/002_schema.sql`、`apps/api/src/wiki/compile.ts:6` |
| 2 | 实体页正文是 Markdown（`body_md`），可原样落盘给 Obsidian 读 | `[代码]` `compile.ts:62`、`:67`；导出实现未发现（见末节） |
| 3 | 分类学 8 类，封闭集合 | `[代码]` `types.ts:7` `ENTITY_KINDS` |
| 4 | triage（new/update/disputed）由**代码判定**，不问模型 | `[代码]` `compile.ts:4-8` 模块注释 |
| 5 | 冲突（disputed）**不覆盖正文**：现任文本原样保留，新读数只记作对方主张 | `[代码]` `compile.ts:137-154` |
| 6 | 已 disputed 的页面**不会**被后续证据自动翻案（只扩 tags/sources） | `[代码]` `compile.ts:155-161` |
| 7 | sources 取旧∪新，tags 取并集 | `[代码]` `compile.ts:77-83`、`:150-151` |
| 8 | 零写入：两阶段编译，schema 全过才落库；校验器遇未知 schema 关键字或未知属性直接失败 | `[代码]` `schema.ts:32`、`:36`、`:72` |
| 9 | `analyzer_ver` 用**字典序**比较，`a1.0 < a1.10`；compile 与 store 双层校验 | `[代码]` `compile.ts:117`、`store.ts:37`、`store.ts:43` |
| 10 | 事件幂等键 `event_id` 由 store 去重；重复编译同一视频不增量 | `[代码]` `store.ts:48-50`、`compile.ts:180` |
| 11 | 仲裁三选一：`a` 保原文清标志、`b` 采纳挑战者正文并保留双方 sources、`keep` 不动；三者都写 `kind='arbitrate'` 事件 | `[代码]` `arbitrate.ts:29-71` |

## 2 三层数据模型

```
智尚素材 ──抽取──▶ wiki_source（不可变证据：content_hash + 结构化事实）
                      │
                      ├─编译─▶ wiki_summary（纪要卡：标题/摘要/embedding）
                      └─编译─▶ wiki_entity（实体页：kind+slug+Markdown 正文）
                                     │
                                     └─▶ wiki_edge（实体间关系）
                                          wiki_event（每次编译/仲裁的事件流）
```

- **`wiki_source` 不可变**：一条素材换模型版本重跑时，同 `content_hash` 的证据可复用（`003_indexes.sql:26` 的 `(company_key, content_hash)` 索引就是为此建的）。证据层可追加、不可改写——这是「同一结论能被追溯」的前提。
- **`wiki_summary`** 承载检索：`embedding` 的 HNSW 建在这张表（见 19 号文档）。
- **`wiki_entity`** 是给人读的层：`body_md` 是 Markdown，`(company_key, kind, slug)` 唯一。

## 3 分类学（8 类）

```ts
// apps/api/src/wiki/types.ts:7
export const ENTITY_KINDS = Object.freeze([
  'product', 'person', 'scene', 'style', 'brand', 'collection', 'hook', 'selling_point',
] as const);
```

| kind | 含义 | 备注 |
| --- | --- | --- |
| `product` | 商品/货品 | 与 `brand` 分离：同一品牌下多个商品是不同实体 |
| `person` | 人物（达人、口播、出镜者） | |
| `scene` | 场景（拍摄/使用环境） | |
| `style` | 风格（画面/剪辑调性） | |
| `brand` | 品牌 | **只信元数据 + OCR**，不接受 VLM 读字（见 21 号文档 §5） |
| `collection` | 合集/专题 | |
| `hook` | 话术钩子（开场三秒的抓手） | 业务专有类别，非通用本体 |
| `selling_point` | 卖点 | |

封闭集合的意义：`kind` 一旦开放，`(company_key, kind, slug)` 唯一键就会因为同义类别（`product` vs `goods`）而分裂，检索与去重都失效。`isEntityKind()` 是唯一的准入判据（`compile.ts:14` 引入）。

## 4 triage：判定权在代码，不在模型

模块注释写得很直白（`compile.ts:4-8`）：claims 是**已经理解好**的输入，编译这步只决定「新页 / 扩写 / 冲突」，而这个决定**不能**交给模型——被问「这是不是冲突」的模型有时会说是。

判定结果只有三个值，且都落成事件：

| triage | 触发 | 对已有页面的效果 |
| --- | --- | --- |
| `new` | 该 `kind+slug` 不存在 | 建页，`status='active'` |
| `update` | 存在且无冲突 | 走正常更新路径（受版本校验约束，见 §5） |
| `disputed` | 存在且新主张与现任正文冲突 | **正文不动**，记录 dispute |

### 4.1 冲突不覆盖正文

```ts
// compile.ts:137-154（节选）
}else if(entry.triage==='disputed'){
  // The incumbent text is kept **verbatim**; the new reading is only recorded as the other side.
  const dispute = Object.freeze({ at:now, side:'b', reason:claim.claim,
    candidate: candidateOf({claim,page,videoId,version}),
    incumbent: Object.freeze({ claim:existing.body_md, body_md:existing.body_md,
      sources:Object.freeze([...existing.sources]), analyzer_ver:existing.analyzer_ver, … }) });
  row = Object.freeze({ ...existing, status:'disputed', sources:mergeSources(existing.sources,videoId),
    tags:mergeTags(existing.tags,page.tags), disputes:Object.freeze([...existing.disputes,dispute]), last_updated:now });
}
```

要点：`...existing` 铺开保证正文与其余字段原样；`disputes` 数组追加而不是替换，所以一条页面可以积累多次分歧。

### 4.2 disputed 之下不自动翻案

```ts
// compile.ts:155-161（节选）
}else if(existing.status==='disputed'){
  // A page under dispute keeps its text until a human decides: more evidence may widen it
  // (tags, sources) but never quietly rewrites the sentence two sources disagree about.
  row = Object.freeze({ ...existing, tags:mergeTags(existing.tags,page.tags),
    sources:mergeSources(existing.sources,videoId), … });
}
```

即：证据再多也只能把 tags/sources 变宽，正文要等人仲裁（§7）。这条规则防止「谁跑得多谁说了算」。

## 5 版本与幂等

- **版本比较用字典序**：`analyzer_ver` 形如 `a1.0`、`a1.10`。按字符串比 `a1.10 < a1.9`，按数值比 `a1.0 < a1.10`——本实现取后者（`compile.ts:117` 的 `compareVer`）。
- **双层校验**：编译层拒绝 `stale-analyzer-version`（`compile.ts:117`），存储层再拒一次（`store.ts:37` 的 summary、`store.ts:43` 的 entity）。任何绕过编译层直接写 store 的路径都拦得住。
- **事件幂等**：`store.recordEvent` 用 `${company_key}/${event_id}` 作键，已存在即直接返回（`store.ts:48-50`）。所以同一视频重复编译不会倍增事件。

`event_id` 的构造在 `compile.ts:180`：`eventId(videoId, entry.kind, entry.slug, version)`。

> **注意（写进末节的待核项）**：`eventId` 的声明有 **5** 个参数（`compile.ts:47-49`：`videoId, kind, slug, triage, version`），调用处只传了 **4** 个。实际产出的键是 `"<videoId>:<kind>:<slug>:<version>:undefined"`——`version` 落在 `triage` 槽位，第 5 段恒为字面量 `undefined`。后果是**键不随 triage 变化**：同一视频、同一版本、同一实体从 `update` 变成 `disputed` 时，事件会被幂等去重直接丢弃。本工作树未安装 typescript，未能用 typecheck 确认该调用是否本应报错。

## 6 零写入：两阶段编译

1. **阶段一（决策 + 生成）**：对每条 claim 判定 triage，必要时让模型只写 Markdown 正文（`compile.ts:62` 的提示词明确「只写正文，不要编造 claim 里没有的事实」）。此阶段只产出内存对象。
2. **阶段二（校验后写入）**：`store.upsertEntity(row)` 在 schema 校验通过之后才发生（`compile.ts:177`）。

校验器（`schema.ts`）是严格子集实现，不是通用 JSON Schema：

- 未知的 **schema 关键字**直接失败：`unsupported schema keyword`（`schema.ts:36`，白名单在 `:32`）；
- 未知的 **属性**直接失败：`not allowed`（`schema.ts:72`）；
- 因此模型多吐一个字段就是硬失败，而不是被静默忽略——「零写入」不是「尽量写」。

## 7 仲裁

```ts
// arbitrate.ts:29-71（结构）
if(!latest) throw Object.assign(new Error('no dispute to arbitrate'),{code:'no-dispute',status:409});
```

| choice | 效果 |
| --- | --- |
| `a` | 采纳**现任**（原文保留），清除 disputed 标志 |
| `b` | 采纳**挑战者**正文，并把**双方 sources** 合并保留 |
| `keep` | 不动正文，只记录「已裁决」 |

- 三者都写一条 `wiki_event(kind='arbitrate')`（`arbitrate.ts:66-71`），事件 id 里带 choice 与时间戳；
- 采纳挑战者时，新页的 `analyzer_ver` 取双方较大者（`:56` 的 `compareVer(...)>0?…:…`），避免裁决后版本号倒退；
- 没有分歧的页面不能被「仲裁」成结论（测试 `arbitrate.test.ts:78-82`）；
- 未知实体直接拒绝（`arbitrate.test.ts:69-71`），不创建任何写入。

## 8 未验证 / 待定

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `eventId` 5 参声明 vs 4 参调用 | **待核（优先）** | 见 §5 引用块；运行时表现为事件键尾段恒为 `undefined`，triage 变化被幂等吞掉；未跑 typecheck（本工作树无 typescript） |
| 「两阶段编译」是否在异常时真的零写入 | 未验证 | 只读了结构（先决策后写）；未构造「第 N 条校验失败时前 N-1 条是否已落库」的用例 |
| 实体页导出为 `.md` 文件（Obsidian 可直接读） | **未落地** | `body_md` 是 Markdown，但仓库内未发现导出实现或路由 |
| wiki 库的 HTTP 暴露 | 未落地 | `apps/api/src/wiki` 是库 + `node --test`，未发现路由；对外接口形态待定 |
| `compareVer` 对非 `aN.M` 形态的容忍度 | 未验证 | 只确认了 `a1.0 < a1.10` 这一组 |
| `disputes` 无限追加的存储增长 | 待定 | 没有上限/归档策略 |
| `hook` / `selling_point` 的自动判定质量 | 未验证 | 二者是业务类别，判定规则未在本文件范围内验证 |
| 仲裁 `keep` 之后的分歧可追溯性 | 待定 | 只记录「已裁决」，未定义后续是否允许再开 |
