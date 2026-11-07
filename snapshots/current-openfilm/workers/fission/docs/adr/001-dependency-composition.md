# ADR-001 · 依赖方向与组合根

状态：已批准（PRD v1.2 · 2026-11-03）

## 背景
多项目 monorepo 需要防依赖腐化：Step 依赖 Provider 实现、Core 反向依赖上层等会在第二批功能接入时爆炸。

## 决策
- 依赖只能向下：`Cli/Web（组合根）→ {Steps, Providers, AI} → Core → 无`
- **Steps / Providers / AI 互不依赖**，仅依赖 Core 抽象
- 全部抽象定义于 Core：`IStep` `StepContract` `StepOutput` `IVideoEngine` `IMediaProbe` `IGLTransition` `ILLMProvider` `ITTSProvider` `IAssetRegistry` `IStepRegistry` `MaterialPool` + 公共类型（JobSpec/JobEvent/ProviderError/FissionException 族）
- Cli/Web 是组合根：DI 注册、路由、进程入口；禁止业务逻辑
- 新功能 = 新 Step + 模板 JSON，不改引擎

## 后果
- 跨 Step 复用逻辑只能下沉到 Core（工具/扩展方法），防止横向耦合
- 组合根测试断言依赖方向（Architecture 测试，M2 补）
