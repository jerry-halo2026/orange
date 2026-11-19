# 业务「合集」能否通过现有 API 拿到（只读调查）

约束：只读阅读 + 只读运行态 HTTP（`x-studio-key` 取自 `~/.openfilm-dev/run.json`，origin `http://127.0.0.1:4757`），
未改代码、未 commit、未启停应用；唯一新增文件即本文件。行号取自 `HEAD=49638ca70a`（分支 `chore/vendor-0.3.2`）。
下文"实测"均为该进程真实返回；**不含任何 token / accountKey / 密钥值**。

## 0 结论

1. 供应商 **OpenAPI 侧没有合集维度**：`apps/api` 的传输层只有 7 个字面量端点（`zhishang.ts:128`），
   `materials.test.ts:351` 断言这 7 个是全集；其中无 `collection`/`album`/`set`/`pack` 任何形态。
2. 素材行里**没有合集字段**：实测 30 个键，唯一的 `collectCount` 是"收藏数"，与合集无关。
3. 业务合集 **≠** 分类树：1955006 / 1942062 / 1938613 在全 5 个 `videoType` 树（315 一级 / 2467 二级）里 **0 命中**，
   也不是 `videoId`（该空间是千万级，1955006 落在空档），判定为独立序列（供应商侧 `videoCollectionId`）。
4. 但**名称高度同源**：三个合集名去掉「日期-」前缀后与某个二级分类名逐字相同，3/3；“该二级分类 ∩ 该日期前缀”在
   现有 `/api/materials/list` 上分别得到 **214 / 259 / 216 行**（加法自洽：214+225=439=`name=20261113` 全量）。
   这是**近似分组**，不是合集本身——名称在树里不唯一（同名最多 4 条），不能当业务键。
5. 要给真合集，缺两件：①供应商 OpenAPI 的合集端点（`/openapi/*` 是否有 `video-collection` 镜像**未证**；
   控制台走的是 session 鉴权的 `/api/video-collection/*`）②一条 `/api/materials/collections` 路由 + `list` 的合集筛选键。

## 1 供应商 OpenAPI 端点清单（全量）

`request()` 的 `endpoint` 是**字面量联合类型**（`zhishang.ts:128`），不加类型就发不出新端点；`ACCOUNT_SCOPED`
（`zhishang.ts:127`）列出其中必须带 `account_key` 的 5 个。

| # | 路径（POST） | 入参（body 键） | 返回 | 代码 |
|---|---|---|---|---|
| 1 | `/openapi/auth/access_token` | `{}` | `data.accessToken`（24h） | `zhishang.ts:172` |
| 2 | `/openapi/account/list` | `pageNo,pageSize,account\|name` | `list[]/total`，行含 `accountKey,state` | `zhishang.ts:264` |
| 3 | `/openapi/video/list` | `pageNo,pageSize,isInner=0,videoType,name,videoIds`+筛选键 | `list[]/total` | `zhishang.ts:223` |
| 4 | `/openapi/video/type/list` | `videoType` | 裸数组，一级 `{categoryId,categoryName,children,…}`，子 `{id,level:2,name,parentTypeId}` | `zhishang.ts:298`、`typeTree` `:243` |
| 5 | `/openapi/video/state/list` | `{}` | 裸数组 5 条状态 | `zhishang.ts:304` |
| 6 | `/openapi/label/list` | `pageNo,pageSize,videoType` | `list[]/total`（33） | `zhishang.ts:280,306` |
| 7 | `/openapi/video/query/raw` | `videoId,isInner=0` | `rawUrl`（**计下载次数**） | `zhishang.ts:329` |

`/openapi/video/list` 的筛选键白名单 = `filters.ts:112`（`FILTER_KEYS`）：
`twoLevelTypeIds,includeLabelIds,excludeLabelIds,teamIds,groupIds,accountKeys,oneLevelTypeId,videoStateId,orderByType,esUpdateStartTime/EndTime,uploadStartTime/EndTime`。
**无 `collectionId`/`collectionIds`/`albumId`/`setId`/`typeGroupIds`。**

两个易踩的"group"：
- `groupIds`（`filters.ts:23`）透传给供应商，语义是**组织小组**（供应商文档 `/openapi/group/list` 那一族：角色/团队/小组），
  不是合集；实测 `groupIds=1955006` → `providerTotal=0`（不报错，只是空）。
- UI 里的 `filters.groupIds` **其实映射到 `twoLevelTypeIds`**（`filters.ts:123`），`groups.ts:43-47` 把二级类目当卡片。
  同名不同义，将来加合集参数**不能**再叫 `groupIds`。

## 2 真实素材行的键名（Q2）

`GET /api/materials/list?pageSize=1&videoType=1&scope=company` → 200，`providerTotal=179831`，`items[0].observation` 的键（逐字）：

```
accountKey, accountName, categoryId, categoryName, collectCount, coverUrl, createTime, desc, dislikeTime,
downloadCount, duration, fileSize, lastModifyTime, lastUseTime, name, oneLevelVideoType, picRemark,
rawFileSize, rawMd5, recycleTime, shootTime, state, totalStatCost, twoLevelVideoType, videoId,
videoLabels, videoState, videoType, videoUrl, viewCount
```

按 `coll|album|group|set|pack|folder` 过滤后只剩 `collectCount`、`lastUseTime` 两个假阳性（收藏数、最后使用时间）。
**行内没有任何合集归属字段**；一行的分类归属只能靠 `twoLevelVideoType{id,name}`（+ 上层的 `categoryId/categoryName`，
它比一级还高一层，见 `tags.md` §5）。

## 3 三个 id 打我们自己的接口（Q3，全部实测）

| 请求 | 结果 |
|---|---|
| `GET /api/materials/collections` | **404** `{"error":"Unknown material route.","code":"material-route-unknown"}` |
| `GET /api/materials/collection` | **404** 同上 |
| `GET /api/materials/facets?videoType=1&scope=company&kind=collection` | **422** `invalid-query` |
| `GET /api/materials/list?...&collectionId=1955006` | **422** `invalid-query` |
| `GET /api/materials/list?...&collectionIds=1955006` | **422** `invalid-query` |
| `GET /api/materials/list?...&albumId=1955006` | **422** `invalid-query` |
| `GET /api/materials/list?...&twoLevelTypeIds=1955006` | 200，`providerTotal=0` |
| `...&twoLevelTypeIds=1955006,1942062,1938613` | 200，`providerTotal=0` |
| `...&oneLevelTypeId=1955006` | 200，`providerTotal=0` |
| `...&videoIds=1955006` | 200，`providerTotal=0` |
| `...&groupIds=1955006` | 200，`providerTotal=0` |
| `...&name=20261113` | 200，`providerTotal=439`（按名称能查到同日批次行） |

白名单在四个地方一致地挡住合集参数：`contract.ts:14`（UI）、`server.ts:74`（HTTP 参数）、`materials.ts:80`（契约）、
`zhishang.ts:100`（传输）。Studio 侧路由只有 `['list','facets','labels']`（`material-center-routes.mjs:26`）+ `raw`/`binding`/`cover`/`cache`。
**结论：客户端目前根本没有接合集维度——不是"没查到"，是"没有这个维度"。**

## 4 三个 id 与 `twoLevel`/`categoryId` 的比对（Q4）

**id 空间比对（全树扫描）**：对 `videoType=0..4` 各取 `/api/materials/facets`，一级 114/81/55/26/39 共 315 条，
二级 1023/888/144/186/226 共 2467 条，把 `id`、`categoryId`、`parentTypeId` 全部与 {1955006,1942062,1938613} 比对：
**5 个树、2782 个 id，0 命中**。`videoId` 侧是 20728596、34891188 这一量级，1955006 不在其中（`videoIds=1955006` → 0 行）。
即三个 id 既不是分类 id（任何层级），也不是 videoId。

**名称比对（强相关，3/3）**：把合集名去掉「日期-」前缀，在二级树里逐字查：

| 供应商合集 | 候选二级分类 | 父一级 | `twoLevelTypeIds ∩ name=<日期>` |
|---|---|---|---|
| 1955006 `20261113李雪妮-轻益生菌28g/盒（元之道A款）` | **304017** `轻益生菌28g/盒（元之道A款）` | 303870 `益生菌new` | `name=20261113` → **214** 行，行名 `20261113-轻益生菌28g盒（元之道A款）-冲泡/包装` |
| 1942062 `20261109-油弃乌龙中医科学院联名款60g/盒` | **303945** `油弃乌龙中医科学院联名款60g/盒` | 303761 `花草养生茶` | `name=20261109` → **259** 行，行名 `20261109-油弃乌龙茶-茶干/汤色` |
| 1938613 `20261107李雪妮-猴头菇丁香沙棘茶80g/盒` | **304453** `猴头菇丁香沙棘茶80g/盒(大翔A款` | 303761 `花草养生茶` | `name=20261107` → **216** 行，行名 `20261107-猴头菇丁香沙棘茶80g盒-包装` |

自洽校验：`name=20261113` 全量 439 = 304017 区 214 + 304018（`舒益生菌8g/盒（元之道A款）`）区 225，严格相加。
第 3 行是**前缀匹配**不是等值（分类名末尾多了 `(大翔A款`）——已经能看出名称不是可靠连接。

**为什么名称不能当键**：`轻益生菌28g/盒（元之道A款）` 在树里有 **4 条同名**（`148101`/`303914`/`304017`/`304128`，
其中 303914 与 304128 还同属父级 `148089 益生菌`）；`油弃乌龙中医科学院联名款60g/盒` 有 2 条（`303945`/`305952`）。
只按名字聚合会串号——与 `tags.md` §4 的"15 组重名"是同一个坑。
另：`name` 是**模糊**筛选（`name=李雪妮` → 16246 行，明显匹配到了作者/其它字段），所以"日期前缀 ∩ 分类"这个配方
必须两个条件同时给，单靠 `name` 会把别人的行也算进来。

## 5 业务合集到底能不能拿到 / 缺什么

**现有 API 拿不到。** 三条独立证据同向：端点全集没有合集（§1）、素材行没有合集字段（§2）、三个真实 id 打不进任何
筛选维度（§3）。所谓"现在的合集卡"是二级分类（`groups.ts:43-47`，`CloudMaterialsTab.tsx:191` 的 `data-group-card={group.id}`），
**把"分类"当成了"合集"**，这个描述成立。

真合集在供应商侧是什么：控制台 `#/collection-detail/:collectionId`（路由名 `CollectionDetail`）对应
**`/api/video-collection/{page,query,detail,add,update-name,update-remark,batch-del,batch-download-collections,collect,move-out-collection,…}`**，
对象键是 **`videoCollectionId`**（表单必填），并另有 `/api/type/batch-move-collection-type(s)` 表示"合集↔分类"是两回事。
这一族是**控制台的 session 鉴权接口**（`/api/*`，非 `/openapi/*`），公司 `company_key/secret` 打不了；我们也没有 session。

缺的两件（按最小改动排序）：
1. **供应商 OpenAPI 是否有合集端点：未证。** 已试的取证途径：开放域有 Swagger UI
   （`/swagger-ui/index.html` 200），但 `/v3/api-docs` 返回 **500**、`/v2/api-docs` 404，无法从外部枚举端点清单。
   要证实只能在传输层加一个候选端点字面量并发一次签名只读调用（属于新的供应商调用，需单独批准，本轮未做）。
2. **我方缺一条路由 + 一个维度**：`GET /api/materials/collections`（合集列表/树）+ `list` 的 `collectionId` 筛选键
   （要同步改 `contract.ts:14`、`server.ts:74`、`materials.ts:80`、`filters.ts:112`、`zhishang.ts:100/128` 五处，
   白名单是四层一致的，漏一层就是今天的 422）。

过渡方案（只作近似，必须标"近似"）：`twoLevelTypeIds=<候选id> & name=<yyyyMMdd>` 三例 3/3 命中、加法自洽，
在拿到真合集前可以复现业务想看的批次；但它只在"运营按 `日期+产品名` 命名、且该产品确实挂在对应二级分类"时成立，
分类名不唯一（4 条同名）且 `name` 是模糊匹配，**不能当业务键写进任何聚合表**。
