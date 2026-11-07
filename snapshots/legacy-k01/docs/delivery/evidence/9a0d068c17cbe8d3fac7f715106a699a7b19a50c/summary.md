# 本地候选验收与恢复记录

已实测代码提交：9a0d068c17cbe8d3fac7f715106a699a7b19a50c；树：5fb582a1b9aed9991500c1e8cbaef1698e3a9df4。分支 codex/orange-g2-source。本记录的后置元数据提交不是实测代码头。
本地候选九门通过、退出 0。Windows 9/9、TS 125/125、C# 114/114，零跳过；双端 114 个相同 ID；60 文件 120 扫描无发现；固定离线快照审计 npm 61、NuGet 13，无发现。离线结果不代表未来在线漏洞状态。
G5 正反只读回放原对象为 d1759a63e8dc9405daf9cc0caa288fefca4a453a，独立已审入口 ebcc2cf80da72b2d5471e11ba84b13786a45a28f；另在实测代码头复验相同四场。真实冻结证据只获只读确认，均未准入写者。
G5 两提交串行整合：084019b26963cee280c2dc8b83fdb6a4bd9d4a2a → bbfa0ebf29b77575fccc4e05b0bf10a5dd370b8e；ebcc2cf80da72b2d5471e11ba84b13786a45a28f → 9a0d068c17cbe8d3fac7f715106a699a7b19a50c。实际27个线性提交、43条历史写路径。旧证据保留。

## 可恢复证据
- 实际候选原始门禁：C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/g5fc-HKzEo1/raw.stdout；SHA-256 9af62d377c1fdaa376f5f28ab7e7e0ab5814a339517f076e119672775c9af64e
- 实际命令、固定工具和控制：C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/g5fc-HKzEo1/invocation.json；SHA-256 04ec0e27b622baf93ce5431a01cc2cfb6967a5c98e21edcfd849a0bf2789fbe8
- 原生测试/扫描/控制复核：C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/g5fc-HKzEo1/verified.json；SHA-256 6a6c3e36c268cfe74905de1d44450a87c9211066d5bde187255cd3247d7517c5
- 整合前实际只读正反回放：C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/g5-real-replay-CEjvpt/verified.json；SHA-256 a516a64f6a7e66778d1500a61bc703457bdb29fbb0e2664e73ab62c45de1df6f
- 实测代码头只读正反回放：C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/g5-same-head-bg90pX/verified.json；SHA-256 9900f689c45e40adf2c58c6dd6ae25745b21f9a96a5bcc7265e212520dc398b3
- Git串行移植与原差异摘要：C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/orange-g5-integration-9a0d068.json；SHA-256 8c022c4ba2157e15ab946a9ae9932e24d6e7e2a1705032160cceea405f3fe664
- 整支非作者规格/质量审查：C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/orange-g5-whole-candidate-9a0d068-review.md；SHA-256 68e37e216565e91ebc565fe1f929676a41f0df1b004e33e2f19d72e9e6e6d905
- G5 P2非作者复审：C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/orange-g5-review-ebcc2cf.md；SHA-256 677b515b450cf64c30592e4fa0ca55bc9914e17822b5dcf568b15efe5469bc4c
- D.K07登记非作者审查：C:/Users/Administrator/.codex/visualizations/2026/11/05/01a1aa95-b1e2-7181-85c8-d88ec79d7302/orange-k07-registration-independent-18e29f7.md；SHA-256 bccd0875bb4c0e26e19377bd692ec561e216b7d0e670708cbc9cbc7e3cffc9fd

## 未决
- N5a：not issued: no two genuinely ready independent product write cards
- E21Admission：partial evidence, no real two-card positive reservation
- E21Runtime：not observed; no product-write overlap
- M0：not accepted: Studio and applicable contract/environment evidence not complete; no blanket requirement for unrelated K or M1
- FissionRuntime：real media runtime unverified; not an E20.integration/M1 acceptance and not a blanket M0 requirement
- E20Base：partial only
- Studio：Ethan approval of reproducible controlled local OpenFilm source not received; no integration
- K01：named human technical signer and N0 producer/consumer approval pending

无主线合并、无远端/生产变更、无发布。恢复先重核真实当前 Git、控制时效、任务与进程句柄；不要重派已完成或仍在执行的任务。
