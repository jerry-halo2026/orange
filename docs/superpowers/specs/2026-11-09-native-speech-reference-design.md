# T07.native 原生语音时间参考特征验证

## 目标与授权边界
这是一期计划T07明确允许先行的纯合成/原生复用准备，不是T07完整实现或T02.d业务契约冻结。直接调用OpenFilm v0.3.0原clipSpan/sourceAt/spokenLines/vttOf/clipCues，证明原生秒/毫秒/实例ID/展示时长的真实边界，不复制函数、另造时间线/编辑API/词协议。完整T07仍依赖T02.d，ASR、置信度/重叠/选区业务、用户确认与媒体提交保持pending。

## 独立子包与治理
在唯一project-tasks登记显式子项T07.native，父T07及其T02.d依赖不改；子包只消费T01已冻结隔离和T02.a已审原生源码子集，不消费被冻结Fetch B或未知业务字段。Root在新assignment开工前具名为唯一作者，模型/effort未暴露不伪造；新卡/输入独审/immutable/受管树/新N5a先于测试编写。
注册候选从已提交05cfd派生，仅追加子项。E1现有其他Auth/Fetch/CI状态WIP不提交、不覆盖；如需标准Git partial-index staging，必须先独审目标registry bytes/hash、确认空index、保存working WIP并事后逐字节核对；不创建第二可执行registry、不冒用T01身份绕过T07依赖。

## 最小实现选择
只新增packages/openfilm/studio/server/speech-native-reference.test.mjs一个测试文件。生产模块、原测试、07、workspace/lock/config、UI、CLI、API均只读。多数是首次GREEN的native-reuse特征，不编造新feature RED；发现原生缺陷只记录，本包不擅改production。未来新增业务分析功能另按失败测试先行。

## 实际依赖与隔离
只读TS AST已确认31个静态模块和唯一外部playwright-core；host.mjs导入时还读timeline.mjs与overrides.mjs文本（另两资源已在模块集合），这些读取资源也须冻结，浏览器入口仅作文本读取不执行。Core使用原已有1.61.1/Apache-2.0/106文件，不安装/下载。精确源/fixture/读取资源/工具manifest在新卡冻结。
先配置E3新.dev/t07-native-characterization/<attempt>下的七HOME/temp位置，再在新测试中用原resolveIsolationProfile/isolationEnvironment配置OPENFILM_*，最后dynamic-import原字幕模块。原Guard的默认构造无FS直到acquire，但不能调用默认Guard/项目读写；不得触及userInfo.homedir的默认协调目录。所有profile路径私有且已明示，端口只作profile配置、绝不listen。
允许必要的私有profile目录与测试证据IO；禁止真实工程/原片/字幕文件写入、Server/HTTP/端口、Worker/子命令/provider/ffprobe/browser/ASR/model、全局monkeypatch或高层fake成功。原Core模块初始化不等于启动浏览器，须核具体调用链。任何意外资源获取/后台未终态/路径越界即停。

## 有限特征样例
1. 明确trim与2x speed，用原clipSpan/sourceAt验证源秒及实例局部秒；clipCues映到film-ms，期望用独立手算literal，不镜像生产公式。
2. 同源两个非UUID/中文ID实例，偏移/速度不同，仍绑定各自clip/src；deep-freeze输入，证明不改原值，不宣称已实现业务选择器。
3. 两个合成provider Word集合仅内词endSec不同（0.2/0.8/缺失）、末词end与起点相同，短文本的原SpokenLine/VTT/展示可相同：展示durMs不保真声学词尾。所有期望须经真实原函数验证，不能手工制造相同输出当测试。
4. 未给词时间时原展示估时存在但无可靠marks，不标为ASR/完整词区间。
5. 原展示最短cue规则可抑制短trim中的已提供timed-word；这只证明元数据展示省略，不能冒称真实静音或授权删除。
6. 原VTT回读只保留其明示词起点/行结束，不重写/扩增原格式。无法保真证据需明确pending，不造词尾。

## 验证与交付
新特征测试固定6项，若原语义不符先根因定位，不降低原断言/时间阈值或静默跳过。单独顺序运行完整原film-doc.test、development-isolation.test、新测试；每个用独立Node进程和新私有home namespace，--test-isolation=none，避免共享process.env及隐藏file-test子进程。记录每个实际close/exit、stdout/stderr/TAP、source前后hash。原两测试实际数量照实记录，不预猜，不等于全项目suite。
源码与Core/读取资源/原测试前后不变；仅一新测试写集，代码来源/原license不改。非作者分别规格/质量审查，正式card+哈希绑定结果后才本地提交；不push，不触发额外CI，不claimT07功能/真实ASR/媒体/ownerN1/目标Win客户端/Mac/PG完成。仍保留全部完整Goal范围。

额外工具门禁：新测试语法node --check必须exit0；原server noEmit使用已冻结只读E1 TypeScript/NodeTypes必须exit0/零诊断，不使用“if available”跳过。三个测试进程与语法/tsc工具进程分别记录真实close，不混算测试数；不安装新依赖或放宽配置。
