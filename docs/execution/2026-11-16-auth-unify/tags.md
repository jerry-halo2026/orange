# 云端素材的 badge 字段、合集树字段，与"产品"层统一键（只读调查）

范围与约束：只读阅读 + 只读运行态查询（`GET /api/materials/{facets,list}`，`x-studio-key` 取自 `~/.openfilm-dev/run.json`），
未改代码、未 commit、未启停应用。唯一新增文件即本文件。行号取自 `HEAD` = `49638ca`（分支 `chore/vendor-0.3.2`）。
运行态 app 的 `origin` 在 4757 端口；下文"实测"均为该进程返回的真实 JSON 片段（不含任何 token / accountKey 值）。

---

## 0. 三句话结论

- badge 渲染的是**名称字符串**（`oneLevelVideoType.name` / `twoLevelVideoType.name` / `videoLabels[].name`），id 只在模型里，**没进 DOM**。
- 素材的 `twoLevelVideoType.id` 与合集卡的 `data-group-card={group.id}` **是同一个 id 空间**：两者都来自供应商
  `video/type/list` 的 children `id`，且被同一参数 `twoLevelTypeIds` 回收（实测 4 组，含加法校验）。
- 把素材归到"产品"这一层，唯一键用 `twoLevelVideoType.id`（= `group.id`）；**不要用 name**（同名不同 id 有 15 处），
  **不要用 `categoryId`**（它比一级还高一层：品牌/分类目录）。

---

## 1. 云素材数据结构：原始字段 → 我们映射后的名字

类型：`MaterialCard`（`packages/openfilm/studio/ui/src/lib/material-center/model.ts:21-39`），
"已确认的 13 个卡片字段"白名单：`model.ts:11-14`（`CARD_FIELDS`）。
来源接口：`GET /api/materials/list?pageNo&pageSize&videoType&name&videoIds&scope&twoLevelTypeIds`
（`contract.ts:14` 白名单；服务端 `apps/api/src/zhishang.ts:208-227` 转成供应商 `POST /openapi/video/list`，
body 含 `{pageNo,pageSize,isInner:0,videoType,…}`）。每一项是 `{videoId:{value,sourceType,source}, observation:{原始行}}`
（`contract.ts:73-76`；`zhishang.ts:224`），页级另有 `authorization/providerScope/total/providerTotal/filtered/grants`
（`contract.ts:78-91`，`providerTotal` 是供应商口径总数）。

| 原始字段（observation / item） | 映射后（MaterialCard） | 位置 |
|---|---|---|
| `item.videoId.value` | `videoId: string` | `model.ts:90` |
| `name` | `title`（空则 `素材 #id`） | `model.ts:94,97` |
| `coverUrl` | `coverUrl: string\|null` | `model.ts:98` |
| `downloadCount` | `downloadCount: string\|null`（保留字面量） | `model.ts:99` |
| `collectCount` | `collectCount: string\|null` | `model.ts:100` |
| `accountName` | `accountName` | `model.ts:101` |
| `accountKey` | `accountKey` | `model.ts:102` |
| `createTime` | `createTime` + `createdAtMs` | `model.ts:103-104` |
| `duration` | `durationSeconds: number\|null` | `model.ts:105` |
| `fileSize` | `fileSizeBytes: number\|null` | `model.ts:106` |
| `oneLevelVideoType{id,name}` | `oneLevelVideoType: CardCategory\|null` | `model.ts:107`、`57-62` |
| `twoLevelVideoType{id,name}` | `twoLevelVideoType: CardCategory\|null`（`parentTypeId` 被丢弃） | `model.ts:108`、`57-62` |
| `videoLabels[{id,name}]` | `videoLabels: CardLabel[]`（每项只留 id+name） | `model.ts:109`、`64-73` |
| `videoState{id,name,frontColor,backgroundColor}` | `videoState: CardState\|null` | `model.ts:110`、`75-81` |
| `videoType`(0..4) | `videoType: VideoType\|null` | `model.ts:111`、`83-86` |

**存在于 observation 但没有任何映射**（`decodeCard` 不读，`CARD_FIELDS` 不含）：
`categoryId`、`categoryName`、`desc`、`picRemark`、`rawFileSize`、`rawMd5`、`shootTime`、`recycleTime`、
`lastModifyTime`、`lastUseTime`、`dislikeTime`、`state`、`viewCount`、`totalStatCost`、`videoUrl`。
实测一条行的字段全集（`videoId=20728596`）：
`accountKey,accountName,categoryId,categoryName,collectCount,coverUrl,createTime,desc,dislikeTime,downloadCount,
duration,fileSize,lastModifyTime,lastUseTime,name,oneLevelVideoType,picRemark,rawFileSize,rawMd5,recycleTime,
shootTime,state,totalStatCost,twoLevelVideoType,videoId,videoLabels,videoState,videoType,videoUrl,viewCount`。
（注：`videoUrl` 在 observation 里是**真实可播地址**，但编辑器模型层从不读它——若后续要"统一字段"，这是唯一需要当心的一列。）

## 2. 三个 badge 各自由哪个字段渲染

渲染链：`cloudEntry()` 造 `badges`（`library.ts:117-119`）→ `MaterialCard.tsx:106` / `147`、
`MaterialListRow.tsx:48` 输出 `data-badge={badge.kind}`；`LibraryBadge.kind` 三值（`library.ts:38`）。

| DOM | 来源字段 | 值形态 | 位置 |
|---|---|---|---|
| `data-badge="one-level"` | `card.oneLevelVideoType.name` | **名称字符串**（如 `公司宣传`） | `library.ts:118` + `model.ts:167` |
| `data-badge="two-level"` | `card.twoLevelVideoType.name` | **名称字符串**（如 `茉莉飘雪(万山A款)`） | `library.ts:118` + `model.ts:168` |
| `data-badge="label"` | `card.videoLabels[0..2].name` | **名称字符串**（最多 2 个） | `library.ts:119` |

三个 badge **全部丢 id**（`categoryBadges()` 只 push `name`，`model.ts:165-170`）；
但 id 在模型里可用：`oneLevelVideoType.id` / `twoLevelVideoType.id` 由 `wireInt(row.id)` 得来（`model.ts:61`），
`videoLabels[].id` 同理（`model.ts:70`）。要"统一"，直接从 `MaterialCard` 取 id，**不需要改供应商读链**。

## 3. 合集树：`group.id / key / name`、`section.oneLevel`

构造：`buildGroupSections()`（`groups.ts:36-52`）；类型 `GroupRef`（`groups.ts:19-25`）、`GroupSection`（`groups.ts:28-32`）。

- `group.id` = 供应商二级类目 `children[].id`（`groups.ts:43`）——**数字 id**，如 `271500`、`256084`、`100279`。
- `group.name` = `children[].name`（`groups.ts:44`）——**名称字符串**，如 `新仓`。
- `group.oneLevelId / oneLevelName` = 父行 `one.id / one.name`（`groups.ts:45-46`）——如 `271499 / 公司宣传`。
- `group.key` = `one.id + '/' + child.id`（`groups.ts:47`）——会话缓存键，如 `"100277/100279"`（不是供应商字段）。
- `section.oneLevel = {id, name}`（`groups.ts:49`）= 一级类目 `id/name`；`section.flat`：该一级只有 1 个合集时为真（`groups.ts:49`）。
- 数据源：`client.facets({videoType, scope})`（`groups.ts:195`）→ `GET /api/materials/facets`（`client.ts:274`）→
  供应商 `POST /openapi/video/type/list {videoType}`（`apps/api/src/materials.test.ts:165` 断言 body 为 `{videoType:1}`；
  拆分逻辑与"81 一级 / 888 二级"的记录见 `zhishang.ts:228-255`，台账 `.dev/zhishang/receipts/first-read-20261112-111516.json`）。
- 渲染：`data-group-section={section.oneLevel.id}`（`CloudMaterialsTab.tsx:182`）、
  `data-group-toggle={section.oneLevel.id}`（`:183`）、`data-group-card={group.id}`（`:191`）、
  面包屑 `data-crumb="one-level"`→`open.oneLevelId`、`data-crumb="group"`→`open.name`（`:204-206`）。
- 点开合集后请求：`twoLevelTypeIds=String(group.id)`（`groups.ts:169`）；筛选器同理 `filters.groupIds → twoLevelTypeIds`
  （`filters.ts:123`）。服务端把 `twoLevelTypeIds` 原样转成供应商 `two_level_type_ids`（`apps/api/src/zhishang.ts:93,100`；
  HTTP 断言 `apps/api/src/main.test.ts:736-740`）。

实测树规模（`scope=company`）：`videoType=1` → 81 一级 / **888** 合集；`0` → 114/1023；`2` → 55/144；`3` → 26/186；`4` → 39/226。
五个 `videoType` 的二级 id **互不相交**（两两交集 0，合计 2467 个不同 id）。
注意：合集面板把 `videoType` 硬编码为 `1`（`CloudMaterialsTab.tsx:81`），而列表页可切其它大类——因为 id 跨大类不重叠，
今天不冲突，但"统一键"必须带上 `videoType` 才严密。

## 4. 关键比对：`two-level` 与 `group.id` 是同一个 id 空间（实测）

判定依据：`group.id` 就是二级类目 id（`groups.ts:43`），而素材行的 `twoLevelVideoType.id` 是**同一个二级类目 id**
（供应商行内嵌对象，`model.ts:61`）；两者都由 `twoLevelTypeIds` 这一参数回收。实测四组：

1. **同名同 id**：合集 `data-group-card="100279"`（`茉莉飘雪(万山A款)`，父 `100277 茉莉花茶类`）
   → `GET /api/materials/list?twoLevelTypeIds=100279` → `providerTotal=1632`，首行
   `videoId=34891188 twoLevel={id:"100279",name:"茉莉飘雪(万山A款)"} oneLevel={id:"100277",name:"茉莉花茶类"} categoryId="1737"/"李陌茶new"`。
2. **第二组**：合集 `271500`（`新仓`，父 `271499 公司宣传`）→ `providerTotal=171`，行 `videoId=20728596`
   `twoLevel={id:"271500",name:"新仓",parentTypeId:"271499"} oneLevel={id:"271499"} categoryId="5908"/"公司素材"`。
3. **加法校验（证明是精确过滤、同一空间且互斥）**：`twoLevelTypeIds=100279,283561`
   → `providerTotal=2257` = 1632（100279）+ 625（283561），逐项相加严格相等。
4. **负样本**：合集 `303425`（同名 `茉莉飘雪(万山A款)`，父 `303004 屈屈有好茶-直播录屏`）→ `providerTotal=0`；
   `256084`（`格丽亚小灯泡发光滋润素颜霜`）→ `providerTotal=0`。即"有卡片 != 有素材"，卡片列出的是供应商全树，
   和素材有无数据无关（888 张卡里大量为 0）。

由此：**同一 id 空间成立**，`two-level` 的 id ∈ 888 个 `group.id`；反过来每个 `group.id` 都是某一级类目下的二级 id，
可直接用于聚合，不需要任何映射表。**但名称不是键**：`videoType=1` 的 888 个合集里有 **15 组重名**（如上面的 100279 / 303425），
只按名称聚合会把两个不同产品合并。

## 5. 若不等（这里相等，但仍有更上层字段的问题）→ 推荐归类字段与覆盖率

- `categoryId / categoryName` **不是产品层**，是更上一层的"品牌/分类目录"：`100277 茉莉花茶类` 的 `categoryId=1737`
  （`李陌茶new`）；`271499 公司宣传` 的 `categoryId=5908`（`公司素材`）；`231556 泰国-美妆类` 的 `categoryId=5504`
  （`【泰国】产品类new`）。它同时出现在 facets 的一级行和素材行里，**粒度太粗，会把多个产品合并**。
  若将来要"品牌"层，这才是它的名字；`categoryId` 在 `CARD_FIELDS` 之外，取用需要在 `model.ts` 加字段。
- **推荐**：产品层唯一键 = `twoLevelVideoType.id`，显示名 = `twoLevelVideoType.name`；父层 = `oneLevelVideoType.id`
  （对应 `section.oneLevel.id`）；若要做面包屑，`key = oneLevelId + '/' + twoLevelId`，与 `GroupRef.key` 完全一致。
- **覆盖率实测**：`videoType=1` 抽 500 行（`pageNo=1/200/400/900/1500`，每页 100，`scope=company`）：
  `twoLevelVideoType` 齐全 **500/500**，其中 16 个不同二级 id **100% 命中合集树（0 个孤儿 id）**。
  `videoType=0` 50/50、`videoType=3` 12/12 齐全。
- **缺字段素材的兜底**（当前抽样为 0 例，但接口契约允许缺）：
  1. `twoLevelVideoType` 为 null → 归"未归类"桶，但仍挂到 `oneLevelVideoType`（一级），不丢行；
  2. `twoLevelVideoType.id` 不在当前 `videoType` 的树内（类目被删/跨大类）→ 同样落"未归类"，保留原始 `id` 与 `name` 以便对账；
  3. `oneLevelVideoType` 也缺 → 归"全部素材"根（`data-group-all`，`CloudMaterialsTab.tsx:175`），按 `videoId` 仍然可寻址；
  4. **永远不要用名称回填 id**（15 组重名会串号）；需要人工归并时，用 `(oneLevelName, twoLevelName)` 二元组提示，
     由人决定，不自动写回。
