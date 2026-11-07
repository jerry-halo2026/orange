# 旧工作树可恢复归档清单

日期：2026-11-07。范围：同一 Orange Git 的39棵工作树、36个本地分支；非全电脑/Codex缓存迁移。精确路径/头/分支/未提交/ignored占用见[机器清单](2026-11-07-worktree-archive-manifest.json)；开发见[一期计划](../superpowers/plans/2026-11-07-phase1-execution.md)。

## 1. 结论与当前状态

- 当前OpenFilm与旧dev无共同祖先。专用`codex/archive-consolidated-20261107`只做查阅归集，不冒充功能已集成dev，不用`merge -s ours`制造完成记录。
- 旧历史含私人供应商文档链接，不能将旧commit作为PUBLIC归集祖先。公开只放五叶脱敏源码快照及原commit/tree/blob映射；完整原历史留私有bundle恢复原始归因。
- W36未提交4文件已私有备份并逐hash核验，未进入公开快照，不标完成。D原仓303条状态为原暂存/未跟踪混合现场，保留不动，不整体提交。
- 原生`list_artifacts`返回`Transport closed`，无法取得可靠受管身份；本轮不手工删除、迁移或prune任何树。“候选”不代表已归档或释放磁盘。
- 只对无树占用的冗余旧ref，在恢复演练、归集独审及远端回读后清理；实际结果另记回执。绑定树的分支先原生归档，不能强删绕过。

## 2. 已做私有恢复备份

稳定目录`E:/CodexData/archives/orange-20261107/`，不在待归档旧树内、不上传PUBLIC。

| 项目 | 证据 |
| --- | --- |
| all-local-branches.bundle | 56,165,820 bytes，完整36ref，无外部prerequisite；SHA256 `bbacaa7a4a5a24858929e091d7574839de7550201a1dee24ecda568edb51e4b4` |
| 恢复演练 | bundle verify通过；独立restore-check.git取回36头，git fsck --full退出0；不是只凭文件存在 |
| ordinary-gates-wip/ | W36四个修改文件，逐一与盘点SHA256相同，原文件未重置 |
| ordinary-gates-index | W36索引副本，不覆盖原暂存区 |
| worktrees-private.json | 状态/文件摘要/ignored分组；不是ignored字节备份，不据此删除 |

恢复原ref新建`codex/recovered-*`，先核bundle哈希和原头，不覆盖dev/main/旧暂存区。受管归档树用原生restore；目前尚未成功归档任何树，不虚构restore identity。

## 3. 已做成果的查阅覆盖

| 快照 | 原始叶提交 | 范围 |
| --- | --- | --- |
| current-openfilm | e6ed48764320c537778f052b3083a1f935125771 | 原v0.3.0＋Fission70文件＋新docs |
| legacy-dev | dcb44a28d895dd3a59e9429644116ae90b125fd2 | 旧独立壳/Auth/Studio接入，只参考不启用 |
| legacy-k01 | 6e8c3133a7a6cd9c3e0b6bf8509e106bec32ddc4 | dev没有的字幕N1独有patch，9文件，不能遗漏 |
| legacy-gate | ebcc2cf80da72b2d5471e11ba84b13786a45a28f | 17非祖先原提交，patch已等效在旧dev，归因仍保留 |
| legacy-k07 | e6ad2b9e3c1abdba93d1057cb2157b3c71173a76 | 7非祖先原提交，patch已等效在旧dev；K07是其祖先 |

旧四叶覆盖78原提交，五叶覆盖盘点时全部36本地分支。公开快照不是原始提交链；完整OID恢复由私有bundle保证，不能仅凭公共manifest里的孤立hash删除唯一历史副本。

## 4. 逐树批次与暂停项

| 批次 | ID | 数量 | 处理 |
| --- | --- | --- | --- |
| 保留 | W00、W38 | 2 | D原仓main/暂存/归档，E当前原版；E仍有Electron进程，不动 |
| 无ignored归档候选 | W06、W08、W14、W15、W24、W25、W26、W29、W30、W32、W33、W34、W35、W37 | 14 | 重核writer/登记双向链接/原头，原生archive回执及restore验证后才清分支 |
| C盘含ignored | W01–W05、W07 | 6 | 优先释放C；先分类.orange-local、未知产物/配置/日志，必要内容私有打包hash后才归档 |
| D/E含ignored | W09–W13、W16–W18、W23、W27、W28、W31 | 12 | 同上；门禁产物/取证/profile不能当node_modules丢弃 |
| 索引元数据变化待核 | W19–W22 | 4 | 盘点前后index字节hash变化，原因未证明，暂停清理；各gitdir独立、未发现硬链接，不能猜是无害刷新 |
| 未提交待审 | W36 | 1 | 四文件已备份但未提交/审查；ignored约197MiB待分类 |

合计39。不是“已归档37棵”；归档前重核最新状态，不能用过期盘点批准删除。

### 占用数字

ignored普通文件逻辑字节：C盘7树约10.83GiB、D盘24树约26.58GiB、E盘8树约7.88GiB（含活跃原版约7.68GiB）。不是整树物理占用或可释放空间；硬链接/reparse/共享依赖及需留存profile/媒体/取证须另核。
可重建依赖缓存核验后才可不归档；云端推送不替代ignored备份。本轮不整迁.codex、不清会话或全局缓存。

## 5. 清理顺序和恢复门禁

1. 停旧writer，重核树/分支/HEAD/暂存/WIP/ignored/嵌套Git，不凭任务名判完成。
2. 已提交进脱敏公共快照＋原始私有bundle；WIP/必要ignored私有保全、记hash与归属。凭据/媒体/完整日志不推PUBLIC。
3. 非作者审归集、扫描、原始到公开映射；准确自有远端分支推送后回读相同commit/tree。
4. 原生archive取得精确身份/回执并验证restore，不手工Remove-Item或git worktree remove/prune绕过工具。失联只暂停此步骤。
5. 删ref前确认无树占用、无新增头、恢复库可读，只删白名单，保留当前原版/基线pin/dev/main。删除ref不释放树的磁盘。
6. 登记归档身份/恢复位置/远端OID/删除清单/实际磁盘变化；缺证据不标完成。

## 6. 远端与开发线

只推自有jerry-halo2026/orange，不推官方；不迁dev/main、不打tag/发布、不改保护。当前dev仍是旧壳，不从它派一期新功能树；一期测试/独审后另做保全旧头的一次切换方案，以后才从验证后的dev分任务。
