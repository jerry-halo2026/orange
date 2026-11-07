# ADR-006 · BGM 分级资产库（BgmRegistry）

状态：已定案（Ethan 确认方向 · PRD v1.1.1）

## 背景
BGM 需求 = 预存可选 + 可上传 + 上传后可复用（自产）。若做成任务级附件，每次重传，资产无法生长。

## 决策
- **三来源一出口**：`preset/`（构建期下载 CC0，只读，升级不覆盖）｜`library/`（上传即入库、跨任务复用）｜`generated/`（AI 生成，二批，MiniMax Music 同 key）
- 裂变只面对 Registry；「背景音乐使用规则」语义不变
- 上传流水：magic number 校验 → SHA-256 去重 → probe（时长/声道/采样率）→ loudness 预扫（loudnorm 单遍积分 LUFS，v1 存数不启用）→ 元数据（名称/哈希/时长/LUFS/来源/标签/启用位）
- **BGM 是耐用品**：不进消耗事务（ADR-002 仅约束配音）；「替换」= 禁用/启用 + 任务级规则，禁用不删文件
- 分发：预存不入 git（构建期下载脚本）；library 入 .gitignore、纳入备份清单

## 后果
- LUFS 数据为二批"响度自动匹配/智能选曲"铺路
- 来源标记 `preset(cc0) | library(user-upload)` 承载合规责任边界（PRD §13.3）
