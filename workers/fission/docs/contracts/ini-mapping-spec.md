# ini-mapping-spec · FissionJob ⇄ 多场景裂变.ini 映射契约

版本 1.0.0 · ADR-003 · 依据：原版 ini 实物（32 键，_rea_analysis\原始功能ini\多场景裂变.ini）

## 1. 承诺范围

- **P0 键：双向映射**（读入 ↔ 回写，类型/默认值如下表）
- **非 P0 键：只读透传**——读入时保留原值原样，回写时原样写出；不解释语义
- **未知键（不在 ini 实物 32 键内）：显式忽略清单**——读入时收集，写入 report.json 与任务日志；**不静默丢弃**

## 2. P0 映射表

| FissionJob 路径 | ini 键 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `output.bitrateKbps` | 比特率 | int? | null=原码率 | 空=保持 |
| `output.fps` | 帧率 | int | 30 | 归一化 CFR |
| `output.threadCount` | 线程数 | int | 3 | 上限 3（CFG_THREAD_LIMIT） |
| `audio.voiceVolume` | 音量 | double | 1.0 | 0.0–2.0 |
| `output.count` | 生成数量 | int | 0=不限 | 0 = 由配音池驱动 |
| `align.targetDurationSec` | 生成总时长 | double? | null | 与 targetFromVoice 互斥；支持小数 |
| `assembly.transitionSec` | 转场时长 | double | 0 | 秒；0=无转场；有效域 0.1–0.4 |
| `output.width` | 分辨率宽 | int | 1080 | |
| `output.height` | 分辨率高 | int | 1920 | |
| `audio.bgmVolume` | 背景音量 | double | 1.0 | |
| `output.saveDir` | 保存目录 | string | 必填 | 绝对路径 |
| `img2vid.durationSec` | 图片时长 | double | 3.0 | 可区间随机（对象形式时为 min/max） |

## 3. 类型与转义规则

- ini 值一律字符串；读取按上表类型解析，失败 → 记入忽略清单并回退默认值（不中断）
- 空 ini 值（`键=`）= 使用默认值
- 路径含中文/空格原样保留（ini 无引号语义，不做转义）
- 双精度用 `.` 小数点，序列化保留 1 位小数（`1.5`）

## 4. 非 P0 透传键（原版 32 键中未映射的部分）

`[设置]` 组的其余键与未来原版新增键，全部走透传通道：`passthrough[key] = rawValue`。

## 5. 互操作场景

1. 原版写的 ini → Fission 读：P0 键生效，非 P0 键透传保留
2. Fission 回写 → 原版读：P0 键按原版键名/格式写出，透传键原样回写
3. 断言（契约测试）：对样例 ini 做读入→回写→字节级对比（P0 值语义等价 + 透传键逐一相等）
