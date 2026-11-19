# M1 基准 · 归一化（4K HEVC 竖版 → 1080x1920 H264 CFR30 无音轨，逐文件）

- 日期：2026-11-03 01:54
- 基准机：13th Gen Intel(R) Core(TM) i5-13400F · 16 线程 · 31.8GB RAM
- GPU：NVIDIA GeForce RTX 4060 Ti 8.0GB · 驱动 537.58 · CUDA 12.2
- ffmpeg：gyan 2022-05-16 git-e3580f6077（libavcodec 59.28.100）
- 素材：sucai 1筛果 10×MOV（4K HEVC，单文件 3.7–15.5s）· 内容合计 66.3s · 清单 sha256:BA2EC93A27794C3B
- 形状：逐文件归一化（= M2 生产形态），含每文件引擎启动开销；每配置 2 轮取最好
- 注：日常桌面负载环境（GPU 常时约 35% 占用），属指纹一部分

| 配置 | 总墙钟(s) | 实时倍率 | 均/文件(s) |
|---|---|---|---|
| nvenc+cuda解码 | 24.5 | 2.7x | 2.45 |
| nvenc+软解 | 21.5 | 3.1x | 2.15 |
| x264软编软解 | 29.2 | 2.3x | 2.92 |

回归阈值：同机同素材下版本间劣化 >10% 阻断（ADR-004）。复跑：`dotnet run --project tests/Fission.Bench`（M4 接入 `fission bench`）。
