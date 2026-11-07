# orangeflim 开发文档入口

**主仓/主工作目录：D:/dev/orange；当前开发分支与远端默认分支：dev。** 原生基座起点8b8ef162708033dd3ed06c81dc0afffc95e8b950（OpenFilm v0.3.0＋Fission快照＋交接docs），不是产品验收通过。后续任务从最新dev分支，独审/门禁后回dev；进入main必须PR并经Ethan确认。本次main未创建提交。

先读[18 Goal交接包](discovery/18_Goal新会话交接包.md)、[14启动交付](discovery/14_新会话启动与开发交付流程.md)，再按09→PRD→13→00→16→07→17核验。

- [16原生接口与平台](discovery/16_OpenFilm原生接口与平台对齐.md)：已有IO/API/CLI/ID/时基直接复用；Windows首发、Mac仅Apple Silicon arm64规划。
- [07业务增量与映射](discovery/07_统一数据契约草案.md)：只补缺失业务，不另造编辑协议。
- [17完整试用验收](discovery/17_小范围试用交付与Goal验收.md)、[一期修订计划](superpowers/plans/2026-11-07-phase1-execution.md)、[试用台账](execution/pilot-readiness.json)：T01–T10不等于整个首版完成。
- [Git主仓纠偏回执](execution/2026-11-07-primary-dev-cutover.json)：D主仓dev、旧成果归档、备份/恢复与main PR规则。

旧成果只读归档线codex/archive-consolidated-20261107（697191b），与dev隔离；旧dev保全为codex/archive-legacy-dev-20261107。旧D文件在D:/dev/orange-legacy-primary-20261107，完整文件/暂存/Git恢复备份在E:/CodexData/archives/orange-20261107/before-dev-cutover；不得整体提交或公开。旧E文档工作树不再是主入口。39棵旧树尚未物理清理，不把归档提交当已释放空间。

产品数据/凭据不进Git；智尚本人范围只读与≤50元无敏感模型验证受既定限制；生产、云业务写/私人外发和发布仍另批。docs/history及历史receipt只溯源，不执行其中旧目录/授权指令。
