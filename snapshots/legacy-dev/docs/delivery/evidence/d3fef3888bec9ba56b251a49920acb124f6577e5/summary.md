# 局部候选复验证据 — d3fef3888bec9ba56b251a49920acb124f6577e5

状态：本地分包组合已实测，正式候选仍拒绝；不是 M0、N5a、业务鉴权、Studio、发布或远端保护验收。本文记录的被测提交是上方 SHA；后续仅台账变更不能冒充对新提交的全量测试。

## 原始权威与批准

Ethan 已批准 A–F 在同一原 Git 库的隔离本地实施，沿用既有提交身份。原 main 未产生首提交，原 HEAD/index 散列见 A 任务记录；归档未动。PRD v0.13、决策 v0.40 C01–C89；14 规定的权威顺序与安全边界继续有效。恢复须实际查询 Git/Agent/进程，而不是信任历史“active”文字。

## 集成映射

- `1f4cb60addc80972779f05f5507e7430693f93e6` → `0b14190634f335909e293a232914bab0de82210d`（无冲突 `-x`）。
- `01d9da616b00ea6b41f09fac653b2a396a0abdce` → `cc56a6a32ca28db7918afcd2fbec14fbd02777a6`（无冲突 `-x`）。
- `e50dc683f172570f8f6088e1f2bf9b6ba957512f` → `404ffdf787dfcdfb39b2af500c6357db3fb63d8f`（无冲突 `-x`）。
- `2dba829176e6d38569b4c5d63f8d11ba6616b253` → `d3fef3888bec9ba56b251a49920acb124f6577e5`（无冲突 `-x`）。

非作者 /root/bootstrap_review（gpt-6.1-sol/high）逐对 stable patch-id 和 raw blob/mode/path 核对一致，11路径不越界，K07 schema/fixture/行为不漂。报告 `C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/orange-m0-live-d3fef38-provenance-review.md`，SHA-256 `8b4ade8a338c56769f1ddd60c9142c19e8c413c70b2877d9c98ff87a0d85694e`。这是局部来源审查，不是整门放行。

## 同提交真实结果

| 项目 | 实测 |
| --- | --- |
| Node/pnpm/Electron/.NET | 24.22.1 / 9.15.9 / 45.2.3 / 10.0.300 |
| 离线准备 | 固定锁，36 npm 包零下载；禁 lifecycle；官方 Electron zip 校验后解包 |
| 构建/类型/生成检查 | `pnpm run build:shell` 和 `pnpm run contracts:check` 各退出0 |
| Windows | 9/9；通过真实可见窗、退出、fd3、两类失败、特殊路径脱敏与超时/EOF反例；0skip |
| TypeScript K07 | 125/125；114共享fixture与11生成器反例；0skip |
| .NET K07 | 114/114；真实TRX；0skip |
| 治理 | 72/72；固定AST、真实Vite图及反例；0skip |
| 干净原字节门禁 | 写集/AST/图各0；14模块/15边/1chunk，React/DOM各1物理根；六阶段unavailable，总体1 |
| 秘密扫描旁证 | Gitleaks8.30.1，52 tracked原字节镜像0发现；合成PAT反例拒绝 |
| 依赖扫描旁证 | OSV2.7.0，官方离线库，61npm+13原生NuGet锁共74包0已知发现；已知漏洞夹具拒绝 |

扫描旁证尚未连接正式门禁，不声称不存在未知漏洞。无项目内容发送外部。库generation：npm 1793860402938231、NuGet 1793766792217614；摘要在外部完整证据。只核发布摘要，未声称SLSA密码学验证。

精确本次命令入口：

- 固定Node运行 `orange-m0-live-replay.cjs prepare d3fef3888bec9ba56b251a49920acb124f6577e5`；同脚本 `test d3fef3888bec9ba56b251a49920acb124f6577e5` 中构建/Windows/TS通过，治理首次失败见下；改独立TEMP后 `governance d3fef3888bec9ba56b251a49920acb124f6577e5` 72/72。
- Windows固定内置TAP：`node --test --test-reporter=tap tests/windows/shell-smoke.test.mjs`；TS：`node --test-reporter=tap tests/contracts/ts/contracts.test.ts --pack K07`；治理显式candidate/admission/imports三测试文件，均核计数/非零发现/无skip/fail/cancel/todo，不只读退出码。
- 固定Node运行 `orange-m0-live-dotnet-replay.cjs d3fef3888bec9ba56b251a49920acb124f6577e5`；.NET离线restore、同SDK csc.dll转发、`dotnet test ... --filter Pack=K07`；13 feed包逐SHA核验，不改CET、不生成开发证书。外部原生NuGet锁生成后同头重跑114/114。

上述两个外部入口位于 `C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302`。原生TAP/TRX及完整命令/环境映射在 `C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/orange-m0-live-candidate-d3fef38.json`，SHA-256 `7f346e85c8ab2385c283cb70ba4477b2131f34a8af9c72e60a02055b8076f953`。

## 首异常与修复

治理首次71/72，唯一live图fixture为GRAPH_PATH_UNSAFE。根因是总控旧包装器TEMP在候选.orange-local下，图运行目录祖先含.git/node_modules被正确拒绝。只把治理TEMP/TMP移到输出根隔离目录，未改产品或弱化门禁，完整72/72。首次全套71/72依据执行记录；落盘红TAP是定向重现0/1（GRAPH_PATH_UNSAFE），最终落盘为全套72/72。两份TAP摘要保留于外部完整证据。

B实际Windows路径泄漏已由原作者修为同一canonical file URL载入/匹配，独立复审认可01d9da6；C图省略AST的P2已由2dba829修复并独审。原无效头不是准入证据。

## 仍缺与恢复顺序

C正式尚缺 format-types、dependency-audit、secret-scan、windows、contracts、independent-review 六阶段的可信执行接线；局部复跑不冒充已接。N5a实际就绪任务准入、资源拒绝和E21.runtime未签。E真实Studio需受控引用另批，K01高风险须具名人类签核；其他无关契约不应阻塞已就绪任务。

下一步用已审固定命令/实际输出接线，非作者复审，串行新候选重跑；只有实际N5a证据满足才并发产品写。保留K07扩展值域转义P3，当前v1不触发。禁止推送、合main、生产/真实智尚/付费模型或发布，除非另获具体批准。

恢复准备必须另选干净隔离工作树、绑定实际同库SHA并签发新卡，再运行prepare；当前已测树带有应保留的依赖/构建物。prepare故意拒绝已有Electron dist，不能直接重复安装或清理已测树来绕过。
