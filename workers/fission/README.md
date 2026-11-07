# Fission · 多场景顺序裂变引擎

7D 全自动批量混剪 v43.5「超级混剪 · 多场景顺序裂变」的模块化重写：Step/Provider 架构 + Web 工作台 + AIGC 生产链（DeepSeek 文案 → 豆包/MiniMax TTS → 配音池驱动裂变）。行为对齐原版（报错文案原文照抄），性能目标 **20 路并发稳定**（压测 24@20 PASS，95s）。

## 目录

```
src/
  Fission.Core/       主循环状态机·素材池事务(ADR-002)·对齐八策略·字幕规划
  Fission.Providers/  ffmpeg/ffmpeg6 命令构建·引擎执行·硬件探测·裂变引擎
  Fission.AI/         DeepSeek 文案·豆包/MiniMax TTS·离线兜底·Key 三槽位
  Fission.Steps/      自描述 Step 契约（工作流复用面）
  Fission.Web/        Kestrel 工作台(127.0.0.1+token)·SSE·静态单页
  Fission.Cli/        run / mkaudio / normalize / doctor / stress
tests/                UnitTests(纯逻辑) · IntegrationTests(命令形状/适配器解析)
docs/                 PRD · ADR · contracts(error-messages/align-strategies/ini-mapping) · bench
tools/csc-shim/       CET 绕过 shim（Win10 19044 未打补丁 × .NET 10 SDK）
```

## 快速开始

前置：.NET 10 SDK；原厂引擎资产在 `D:\dev\7d`（`bin\ffmpeg.exe`、`lib\ffmpeg6.exe` + 66 GLSL 转场）——路径可在 `EnginePaths` 覆盖。

```bash
dotnet build Fission.slnx -c Debug
dotnet test tests\Fission.UnitTests -c Debug --no-build
dotnet run --project src\Fission.Web            # 工作台（控制台打印带 token 的 URL）
dotnet src\Fission.Cli\bin\Debug\net10.0\Fission.Cli.dll stress   # 24 条 @20 路压测断言
```

工作台流程：**① AIGC 文案配音（生成文案 → 生成配音 → 应用为配音目录）→ ② 素材池（场景组逐组设置：顺序或随机/每次抽N/变速/用后删/重复抽取/图片数）→ ③ 输出 → ④ 任务 → ⑤ 分割·转场(66 GLSL)·字幕 → ⑥ 执行日志**。成片数量由配音池耗尽驱动（用后即删）。

## AIGC Key

工作台 ① 卡「Key 配置」三槽位（DeepSeek / 豆包 / MiniMax），存本机 `work/ai-keys.json`，界面脱敏回显。无 key 自动离线兜底（模板文案 + 合成配音），全链不断。文案模板可自由编辑（`work/prompt-template.json`，`{{占位符}}` 表单替换）。

## 契约与基线

- 报错文案 = 原版原文：`docs/contracts/error-messages.zh.json`
- 对齐八策略真值表：`docs/contracts/align-strategies.json`
- ini 参数双向映射：`docs/contracts/ini-mapping-spec.md`
- 性能基准：`docs/bench/`

密钥、运行时产物（work/ out/）、用户资产绝不入库（见 .gitignore，PRD §13.2）。
