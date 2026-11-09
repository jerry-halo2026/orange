# C23 现有 Native CI 的受控生命周期增量

## 目标与选择
用原driver/test/workflow三文件，在Windows预装实际Node22验证已独审Fetch与entered-request消费者；不改产品/API/UI/CLI工程格式，不另造恢复器/协议/网站。Root采纳只读builder方案：独立needs native-studio的新job，避免把新阶段挤入旧12min；同driver closed --lifecycle复用原Core/SRI/tar/Git/路径/安全诊断。只本地实现/TDD，本卡绝不授权cloudjob/push；云端需另卡新一次lease/全部payload独审/当前PUBLIC与标准硬件零成本核验。

## 原义保留与必要pin迁移
default runNativeStudioCI主体仍原Native110+Worker51=161；原27=23PINS+4SELF路径集合/validator/count不变，只现有23内server SHA迁移到已审producer f72304590af52555f6d36d1b5a0d4cd6b9b3270e的f965897ca11f6203cfd2c85b6001ccc4ab4a4d4ba2f6ca1d3a45c9681ca70acc。driver/test旧literal各恰一处 34d0e29bee3801a8e5cc4dbff52f4f69faf45181c80fda07981bcb80b77256b2→新SHA；旧399测试prefix仅允许这一处literal逆换精确恢复原bytes，名称/计数/断言/预算全部不变，其余新测试与imports全部append，不改旧import行，不双pin/不旧Source替身/不弱验证。driver除必要CLI dispatch修改及pin外优先append/reuse，原51worker600000ms文件/180000ms总限/8MiB、原Native及12min不变。

## 闭合接口与执行
开发工具exports按builder定名：selectNativeStudioMode(args)、deriveNativeLifecycleEnvironments(facts,systemRoot)、validateNativeLifecycleSources(records)、verifyFetchDrainTap(tap,exitCode)、verifyRequestDrainTap(tap,exitCode)、verifyLegacyFetchTap(tap,exitCode)、buildLegacyFetchAdapter(originalBytes,facts)、assessNativeLifecycleProcess(kind,result)、runNativeLifecycleCI()。select只[]native或[--lifecycle]lifecycle，其余拒绝；种类/路径/端口/测试/计数/pins不可由CLI或环境自选。新函数无顶层IO/await；CLI509在后置const前，必须将selector和run调用一起Promise.resolve().then延后到模块评估完成，防TDZ；原safeformatter不inspect未知error对象，不输出rawstdout/stderr/config/token。

新增独立固定9pin表（Fetch7+原17file+requestfile），不把原27validator改成36；固定actualraw/Git/UTF8/只CRLF差异规则沿用，不接受任意policy。全部9个path现workflow均无filter，必须逐条追加。新job同repo jerry-halo2026/orange、PUBLIC、refs/heads/codex/t05-path-policy、contents:read、固定checkoutSHA/readonlycredentials/submodules/lfs false、windows-2025/12min、needs native-studio，原job不增预算/权限，不cache/artifact/大机/secret/provider/Fission/model。

实际执行必须process.platform win32、actualprocess Node major===22/minor>=18，禁用env伪造/Node26冒充/下载或切换runtime；不存在预装22则失败。Node22官方v22.18 CLI已核--test --experimental-test-isolation=none（22.8新增），不复制Node26稳定拼写；这里只文档事实，不是实际22通过。每个testwave独立捕获Node ChildProcess exit/close、单写/峰值1（不计Git helper/tree或Node自己不可见进程），不假称wholeOS0。

## 三波与预算
先同候选verify原27+额外9、复用原Core1.61.1完整106/SRI/许可证恢复；然后Fetch64→Request6→Legacy17+独立guard1。新模式总deadline Root定540000ms（独立12min外留3min checkout/overhead），每阶段取remaining与自身cap较小，没时间不启动、未知退休/timeout/overflow/close未证/后验失败立即停下一波，不能加宽旧预算。Fetch180000ms/20MiB、request180000ms/20MiB、legacy120000ms/20MiB（stdout+stderr合计），stderr合法非空，仅bounded保存/hash不能直接print或以非空判fail，不加no-warnings。

Fetch七HOME/temp同fresh .dev/fetch-drain/lifecycle-<runID>-<attempt>/scratch，18481/82双栈前后bind；原fixture固定Gitexe/空globalconfig/NOSYSTEM/no prompts/no creds、真实Response/Writer/ownedGit保持。Request独立fresh .dev/studio-request-drain/runs/attempt-<runID>-<attempt>/scratch，原profile父与18483/84；6确切names/flat/suites0，不与Fetch共modulecache/profile。Legacy独立.dev/fetch-drain/legacy-<runID>-<attempt>/scratch，原06775083...SHA不改，两imports→canonicalURL/唯一listen0→18481/原immediatecancel双fetch-spawn拒绝guard0/独立guard18/逐针count+inverse exact原bytes/17原names顺序不改。新CI可直接一个真实Node test child/isolationnone，不伪称旧本地adapter runner+file2；实际process拓扑如实记录。

Fetch TAP单独strict parser：59顶层results、唯一phase A GitHub seams suite及6child、64leaf/suites1，完整名称、连续plan/编号/无多suite/重复/缺项/伪总数/skip/todo/cancel/nonzero；旧110/51 flat parsers不动。Request精确6distinctnames、Legacy精确17+guard1；requirednames来自当前冻结源与真实合格TAP，不信result自报总数。成功stdout只sanitized JSON含实际node/os/platform、源raw/Git/pins/tool hash、每波真实exitclose/counts/ports、stderrhash，不把fixture/APIkey/私人内容外发；失败沿原identity-safe诊断。

## 本地TDD与边界
本地只有Node26；先在实际新producer树原399得到serverpin真实RED，单literal迁移GREEN，才workflow9trigger/job缺口行为RED→实现；新增selectors/runtime/env/source9/TAP层级/adapter/进程超时overflow未close/后验不续/CLI deferred/noimportsideeffect等正反例全部append。允许本地纯单测、原399+新增、语法、有限自有Node进程lower executor fixture；不允许真实--lifecycle/native CLI运行、云/网络/Core下载、模型/媒体/浏览器/ffmpeg/Fission/.NET/OS策略/私人数据。negative实际CLI可仅证明Node26拒绝在任何子进程/FS新scope/下载前，不作22通过。所有source before/red/green/after、原prefix inverse、新总数actual、source/tool/Core/旧31281/端口/N5a后验记录；nonauthor source/result审后才local sourcecommit。完整server/ownerN1/真实Auth/桌面媒体/安装/Mac/PG仍未通过，不缩17目标。
