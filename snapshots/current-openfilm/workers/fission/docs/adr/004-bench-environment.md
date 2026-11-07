# ADR-004 · bench 环境指纹与回归阈值

状态：已批准（评审 B6 · PRD v1.1/v1.2）

## 背景
性能 NFR 若不绑定环境，版本间比较无意义（nvenc≥3x 依赖 GPU，归一化 ≥6x 依赖 CPU/盘）。

## 决策
- 每次 bench 记录**环境指纹**：CPU 型号、GPU 型号+驱动、内存、盘型号、ffmpeg `-version` 全文、fixture 文件 SHA-256
- **基准机 = 本开发机**（i5-13400F / RTX 4060 Ti 8GB / 32GB / NVMe；日常有桌面负载，属指纹一部分）
- 无 N 卡时 nvenc 指标记 N/A 条件化，不做跨机比较
- 指标口径：单条成片 = 标准模式**中位数** ≤ 成片实时时长
- 回归阈值：**同机同 fixture** 下版本间劣化 >10% 阻断合并
- 表存 `docs/bench/`（Markdown，入库），原始产物不入库

## 后果
- 换机器 = 重建基准线（旧表标注 superseded）
- bench 命令必须可一键复跑（`fission bench --fixture standard`）
