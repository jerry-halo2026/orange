# 转场能力清单：66 个 gltransition 转场 → FFmpeg 9.0.2 单引擎

> 范围：W1-E（Fission 适配 OrangeFilm 0.3.2 随包 ffmpeg 9.0.2）。本文是**判定依据文档**，代码实现与本文一一对应：
> `src/Fission.Providers/Media/TransitionCatalog.cs`（映射表 + 后端选择）、`TransitionCapability.cs`（能力探测）、
> `CommandBuilders.cs`（命令）、`Pipeline/FissionEngine.cs`（ASSEMBLE 降级链）、`Diagnostics/DoctorService.cs`（体检口径）。
>
> 本文不删任何既有转场定义：`TransitionCatalog.List/Resolve` 仍以 GLSL 目录为唯一名字来源，`XfadeMap` 只做"额外可降级"的加法。

## 1. 结论（统计）

| 判定 | 条数 | 含义 | 运行时行为 |
| --- | ---: | --- | --- |
| **可映射** | 24 | 9.0.2 内置滤镜（`xfade` / `blend`）能接住，视觉族一致 | 其中 **23 条**已写入 `TransitionCatalog.XfadeMap`，gltransition 缺失时自动降级执行（outcome `applied-xfade`）；1 条（`multiply_blend`）需手工 `blend` 表达式，本阶段不自动降级 |
| **需预渲染** | 40 | 9.0.2 无等价滤镜；着色器是 (from, to, progress, uv) 的纯函数，只能离线把 GLSL 渲染成片段再 `overlay` 合成 | 本阶段无渲染管线 → 与"不支持"同样路径：明示回落（outcome `fallback-no-transition` + 事件） |
| **不支持** | 2 | 依赖 `uniform sampler2D` 外部贴图（位移图 / 亮度图），9.0.2 无对应输入，预渲染也缺素材 | 明示回落，不静默 |
| 合计 | 66 | 目录 `TransitionsDir` 下全部 `.glsl` | — |

自动降级 = 23 条；"可映射但未自动" = 1 条（`multiply_blend`）。

## 2. 依据：本机实测 9.0.2 能力面

二进制：`%APPDATA%\OrangeFilm Dev\runtime\ffmpeg-9.0.2\ffmpeg.exe`（`apps/desktop/src/ffmpeg-runtime.mjs:21` 固定的 gyan `9.0.2` essentials build）。

```
$ ffmpeg -hide_banner -version
ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers

$ ffmpeg -hide_banner -filters | findstr /i "xfade blend overlay gltransition shader placebo"
 TSC blend             VV->V      Blend two video frames into each other.
 TSC overlay           VV->V      Overlay a video source on top of the input.
 .S  xfade             VV->V      Cross fade one video with another video.
```

三条硬事实：

1. **没有 gltransition**：9.0.2 essentials 的滤镜表里不存在 `gltransition`（该滤镜来自 4.1 msvc 定制构建，见 `EnginePaths.FFmpeg6` 的历史注释）。因此 `gltransition=` 命令在 9.0.2 上必然失败，不能作为默认路径。
2. **有 xfade，58 个转场名**（`ffmpeg -h filter=xfade`，`transition` 取值 from -1 to 57）：
   `custom`，`fade fadeblack fadewhite fadefast fadeslow fadegrays`，`wipeleft wiperight wipeup wipedown wipetl wipetr wipebl wipebr`，
   `slideleft slideright slideup slidedown`，`smoothleft smoothright smoothup smoothdown`，`circlecrop rectcrop circleopen circleclose`，
   `vertopen vertclose horzopen horzclose radial distance dissolve pixelize`，`diagtl diagtr diagbl diagbr hlslice hrslice vuslice vdslice`，
   `hblur`，`zoomin`，`hlwind hrwind vuwind vdwind`，`coverleft coverright coverup coverdown`，`revealleft revealright revealup revealdown`。
   本文所有映射目标名都取自这份实测清单（单测 `TransitionCapabilityTests.XfadeMap_OnlyContainsNamesThatExistInFfmpeg9` 守住这一点）。
3. **没有 GLSL 执行通道**：essentials build 无 `shader*` / `libplacebo` / `gltransition`，所以"需预渲染"只能走仓库外的离线渲染，不在 9.0.2 里就地完成。

补充实测：`blend`（`all_mode=multiply` 等）与 `overlay` 都在，是"预渲染后合成"与 `multiply_blend` 的落点。

## 3. 判定口径

- **可映射**：9.0.2 内置滤镜能在**一阶命令**里产出同一视觉族，且时长语义与现有"入片转场 + concat"链一致。
- **需预渲染**：9.0.2 无对应滤镜，但着色器不依赖外部贴图 → 可用离线 GLSL 渲染成定长片段，再用 `overlay`/`blend` 叠加。当前仓库没有该管线，故运行时回落。
- **不支持**：着色器声明了 `uniform sampler2D`（`displacement` 的 `displacementMap`、`luma` 的 `luma`），9.0.2 与现有资产库都提供不了这张图，预渲染也不等价。
- **方向语义注意**：`wipe*` / `slide*` / `horzclose` / `vertclose` 的左右/上下方向定义与 GLSL 实现未必逐像素一致（GLSL 用 `step(1.0-p.x, progress)` 之类的写法）。代码里这些条目按"视觉族一致"降级，**方向需以样片比对确认**；若与产品预期相反，改 `XfadeMap` 一个值即可，无需改流程。

## 4. 运行时降级链（代码位置）

`Pipeline/FissionEngine.cs:652` 起（ASSEMBLE）：

1. **能力探测**：`TransitionEngineProbe.DetectAsync`（`TransitionCapability.cs:32`）经唯一执行通道跑一次只读 `ffmpeg -filters`，判定 `gltransition`（FFmpeg6）与 `xfade`（FFmpeg）是否可用；结果按运行缓存（`FissionEngine` 的 `Lazy<Task<TransitionCapability>>`）。未注入 `FFmpeg6` 直接记为"可选能力缺失"，不启动进程。
2. **后端选择**：`TransitionCatalog.SelectBackend`（`TransitionCatalog.cs:101`）
   - gltransition 可用 **且** 着色器路径存在 → `TransitionBackendKind.GlTransition`，命令 `CommandBuilders.EntryTransition`（`CommandBuilders.cs:78`），outcome `applied`；
   - 否则若 xfade 可用 **且** 转场名在 `XfadeMap` 中 → `Xfade` 后端，命令 `CommandBuilders.EntryTransitionXfade`（`CommandBuilders.cs:98`），outcome `applied-xfade`；
   - 都不成立 → 返回 `null`，**明示回落**：`Outcome = fallback-no-transition` + `RUN_TRANSITION_FALLBACK` 事件（带能力探测原文与"无 9.x 等价后端"说明）。
3. **执行期失败**（非 strict）：沿用原"用一份全新 owned 产物重做 concat"的回退，事件带退出码。strict（`execute-prepared`）下不吞掉后端执行失败。

`xfade` 命令形状（与 gltransition 语义对齐，输出=第二输入时长）：

```
-y -i "tail.mp4" -i "seg.mp4"
-filter_complex "[0:v]settb=AVTB,setpts=PTS-STARTPTS[a];[1:v]settb=AVTB,setpts=PTS-STARTPTS[b];[a][b]xfade=transition=circleopen:duration=0.25:offset=0[vt]"
-map "[vt]" -an -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart "out.mp4"
```

实测（9.0.2，tail=0.25s、seg=2.00s）：输出 `Duration: 00:00:02.00` = 第二输入时长，与 `gltransition=offset=0` 的既有语义一致，concat 总时长不变。

## 5. 逐条清单（66）

判定列：✅ 可映射（★=已自动降级）／🟡 需预渲染／⛔ 不支持。

| # | gltransition | 9.x 落点 | 判定 | 依据 |
| ---: | --- | --- | --- | --- |
| 1 | `angular` | 无（离线 GLSL） | 🟡 | `atan(uv-0.5)` 角度扫掠遮罩；`xfade radial` 是同心圆环，非同族 |
| 2 | `BookFlip` | 无（离线 GLSL） | 🟡 | 透视翻页（`skewRight/skewLeft` + 投影），2D 滤镜无法等效 |
| 3 | `BowTieHorizontal` | 无（离线 GLSL） | 🟡 | 三角形/蝴蝶结遮罩逐帧推进 |
| 4 | `BowTieVertical` | 无（离线 GLSL） | 🟡 | 同上（纵向） |
| 5 | `BowTieWithParameter` | 无（离线 GLSL） | 🟡 | 同上 + `adjust`/`reverse` 参数 |
| 6 | `burn` | 无（`blend` 表达式不等价） | 🟡 | 逐像素加色 `mix(from+progress*color, to+(1-progress)*color)`，非纯交叉淡化 |
| 7 | `ButterflyWaveScrawler` | 无（离线 GLSL） | 🟡 | 波形位移 + 色分离（`colorSeparation`） |
| 8 | `cannabisleaf` | 无（离线 GLSL） | 🟡 | 非矩形叶片遮罩（`atan` + 半径曲线） |
| 9 | `circle` | `xfade transition=circleopen` | ✅ ★（近似） | GLSL 硬边圆形展开；`circleopen` 软边展开，族一致 |
| 10 | `CircleCrop` | `xfade transition=circlecrop` | ✅ ★ | 圆形裁切随 progress 缩放，同名族 |
| 11 | `circleopen` | `xfade transition=circleopen` | ✅ ★ | 同名同族 |
| 12 | `crosswarp` | 无（离线 GLSL） | 🟡 | 交叉 warp（`smoothstep` 位移场） |
| 13 | `cube` | 无（离线 GLSL） | 🟡 | 3D 立方透视 + 反射（`persp`/`unzoom`/`reflection`） |
| 14 | `displacement` | 无 | ⛔ | `uniform sampler2D displacementMap` 外部位移贴图，资产库无此图 |
| 15 | `DoomScreenTransition` | 无（离线 GLSL） | 🟡 | 竖条错速下移（`bars`/`amplitude`），非 `pixelize` 的像素溶解 |
| 16 | `doorway` | 无（离线 GLSL） | 🟡 | 3D 纵深门洞；`xfade zoomin` 仅缩放，无透视位移 |
| 17 | `Dreamy` | 无（离线 GLSL） | 🟡 | 相位抖动位移 `0.03*progress*cos(...)` |
| 18 | `DreamyZoom` | 无（离线 GLSL） | 🟡 | 旋转 + 缩放 + 模糊采样 |
| 19 | `EdgeTransition` | 无（离线 GLSL） | 🟡 | 3×3 邻域边缘检测 + 发光 |
| 20 | `fade` | `xfade transition=fade` | ✅ ★ | 精确等价（`mix(from,to,progress)`） |
| 21 | `fadecolor` | `xfade transition=fadeblack` | ✅ ★（近似） | GLSL 默认 `color=vec3(0)`（黑）时即"经黑过渡"；其它颜色需 `blend` 自建 |
| 22 | `fadegrayscale` | `xfade transition=fadegrays` | ✅ ★ | 灰度中转，同族 |
| 23 | `FilmBurn` | 无（离线 GLSL） | 🟡 | `rand()` 种子驱动的烧穿/噪点 |
| 24 | `GlitchDisplace` | 无（离线 GLSL） | 🟡 | Voronoi 噪声位移 |
| 25 | `GlitchMemories` | 无（离线 GLSL） | 🟡 | 16×16 块状乱序（hash 噪声） |
| 26 | `heart` | 无（离线 GLSL） | 🟡 | 心形隐函数遮罩 `step(a*a*a, ...)` |
| 27 | `HorizontalClose` | `xfade transition=vertclose` | ✅ ★（近似） | GLSL 以 `uv.y` 为轴内收（水平条带）；方向需样片校验 |
| 28 | `HorizontalOpen` | `xfade transition=vertopen` | ✅ ★（近似） | 同上，外张 |
| 29 | `InvertedPageCurl` | 无（离线 GLSL） | 🟡 | HP 卷页（3D 圆柱投影 + 背面贴图） |
| 30 | `kaleidoscope` | 无（离线 GLSL） | 🟡 | 7 段迭代镜像 + 极坐标扭曲 |
| 31 | `LeftRight` | `xfade transition=slideleft` | ✅ ★（近似） | 水平平移 + 越界黑边；方向需样片校验 |
| 32 | `luma` | 无 | ⛔ | `uniform sampler2D luma` 亮度图遮罩，无该贴图 |
| 33 | `multiply_blend` | `blend all_mode=multiply`（需时间表达式） | ✅（未自动） | 中段正片叠底再交叉淡出；`blend` 无 `duration/offset` 语义，需 `all_expr` 手工计时 |
| 34 | `pinwheel` | 无（离线 GLSL） | 🟡 | `atan` + `mod` 风车扇区遮罩 |
| 35 | `polar_function` | 无（离线 GLSL） | 🟡 | 极坐标多边形半径曲线遮罩 |
| 36 | `PolkaDotsCurtain` | 无（离线 GLSL） | 🟡 | 波点密度随半径变化（`fract(uv*dots)`） |
| 37 | `powerKaleido` | 无（离线 GLSL） | 🟡 | 极坐标镜像 + 幂次缩放 |
| 38 | `Radial` | `xfade transition=radial` | ✅ ★（近似） | 径向圆形推进 + smoothstep 软边 |
| 39 | `randomNoisex` | 无（离线 GLSL） | 🟡 | hash 噪声逐像素选边 |
| 40 | `Rectangle` | `xfade transition=rectcrop` | ✅ ★（近似） | 矩形遮罩；GLSL 为四角先后进入，`rectcrop` 为对称收缩 |
| 41 | `RectangleCrop` | `xfade transition=rectcrop` | ✅ ★ | 矩形裁切随 progress 缩放，同族 |
| 42 | `Rolls` | 无（离线 GLSL） | 🟡 | 四角滚入（旋转 + 平移 + 可选反向） |
| 43 | `rotate_scale_fade` | 无（离线 GLSL） | 🟡 | 旋转 + 缩放 + 背景色填充 |
| 44 | `RotateScaleVanish` | 无（离线 GLSL） | 🟡 | 旋转缩放消失（多布尔开关） |
| 45 | `rotateTransition` | 无（离线 GLSL） | 🟡 | 2D 旋转 + `fract` 平铺，无 xfade 对应 |
| 46 | `scale-in` | `xfade transition=zoomin` | ✅ ★（近似） | 第二画面由小到大 + 交叉淡化 |
| 47 | `SimpleZoom` | `xfade transition=zoomin` | ✅ ★（近似） | 缩放 + `smoothstep` 时序，节奏参数由 `duration` 近似 |
| 48 | `Slides` | `xfade transition=slideleft/right/up/down` | ✅ ★（近似） | `type`/`In` 参数化滑入；默认 `type=0` 映射 `slideleft` |
| 49 | `squeeze` | `xfade transition=squeezev` | ✅ ★（近似） | 纵向压缩 + 色分离；色分离无对应，压缩方向一致 |
| 50 | `static_wipe` | 无（离线 GLSL） | 🟡 | 雪花噪声阈值擦除（`rnd()`） |
| 51 | `StereoViewer` | 无（离线 GLSL） | 🟡 | 双画面卡片 + 圆角遮罩（立体查看器造型） |
| 52 | `swap` | 无（离线 GLSL） | 🟡 | 3D 交换（透视 + 深度 + 反射） |
| 53 | `Swirl` | 无（离线 GLSL） | 🟡 | 涡旋角度位移 |
| 54 | `tangentMotionBlur` | 无（离线 GLSL） | 🟡 | 切向多采样运动模糊 |
| 55 | `TopBottom` | `xfade transition=slidedown` | ✅ ★（近似） | 纵向平移 + 越界黑边；方向需样片校验 |
| 56 | `VerticalClose` | `xfade transition=horzclose` | ✅ ★（近似） | GLSL 以 `uv.x` 为轴内收（竖条带）；方向需样片校验 |
| 57 | `VerticalOpen` | `xfade transition=horzopen` | ✅ ★（近似） | 同上，外张 |
| 58 | `wind` | 无（离线 GLSL） | 🟡 | 行列随机偏移的"风扫"擦除 |
| 59 | `windowblinds` | 无（离线 GLSL） | 🟡 | 百叶窗交错进度 `mod(floor(uv.y*100*progress),2)` |
| 60 | `wipeDown` | `xfade transition=wipedown` | ✅ ★ | `step(1-p.y, progress)` 线性擦除，同族（方向需样片校验） |
| 61 | `wipeLeft` | `xfade transition=wipeleft` | ✅ ★ | 同上（横轴），方向需样片校验 |
| 62 | `wipeUp` | `xfade transition=wipeup` | ✅ ★ | `step(p.y, progress)` 线性擦除 |
| 63 | `x_axis_translation` | `xfade transition=slideleft` | ✅ ★（近似） | 水平位移 + 交叉淡化 |
| 64 | `ZoomInCircles` | 无（离线 GLSL） | 🟡 | 缩放 + 圆环遮罩叠加 |
| 65 | `ZoomLeftWipe` | 无（离线 GLSL） | 🟡 | 缩放 + 左向擦除的混合，无单滤镜等价 |
| 66 | `ZoomRigthWipe` | 无（离线 GLSL） | 🟡 | 同上（右向） |

## 6. 引擎路径与能力约定（W1-E 相关）

- `EnginePaths` **不再有开发机默认值**（旧 `D:\dev\7d\...` 已删除）：`FFmpeg` / `FFprobe` / `TransitionsDir` / `AssetsRoot` / `LocalAssetsRoot` 必须由调用方注入，未注入即 `CFG_ENGINE_PATHS` 配置错误（`EnginePaths.ValidateConfiguration`）。
- `FFmpeg6` 是可选项（`EnginePaths.HasFFmpeg6`）：缺省时 `EnginePaths.EngineExecutables()` 只返回 `FFmpeg/FFprobe`，准备阶段的引擎固定、`EnginePathPolicy` 的只读批准集都不再要求它。
- doctor（`DoctorService.cs:51`）：`gltransition` 缺失只记为"可选能力缺失"；只有 `gltransition` 与 `xfade` **都**缺才判该项失败（此时转场退回直切）。
- 单引擎下 `TransitionsDir` 缺失不会阻断准备：`FissionEngine` 只在 GLSL 文件实际存在时冻结着色器证据（`Pipeline/FissionEngine.cs` 准备段），转场后端在 ASSEMBLE 阶段按能力决定。

## 7. 验证记录

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 9.0.2 有 xfade、无 gltransition | `ffmpeg -filters` / `-h filter=xfade` | 见 §2 |
| xfade 入片转场命令可用 | tail(0.25s)+seg(2.00s)，`xfade=<wipeleft\|vertclose\|fadegrays>:duration=0.25:offset=0` | 三条均退出码 0，输出时长 2.00s（= 第二输入） |
| 单引擎 doctor 不判失败 | `FISSION_ENGINE_PATHS=<9.0.2 路径>.json dotnet Fission.Cli.dll doctor`（不含 FFmpeg6） | 8/8 `[OK]`：`引擎·ffmpeg6(gl)`=「可选能力缺失」、`转场能力`=「xfade 可用，23 个转场可自动降级」、`资产扫描`=转场 66 |
| 未注入引擎路径即配置错误 | 同上但不设 `FISSION_ENGINE_PATHS` | 退出码 3，`[Fission:CFG_ENGINE_PATHS] …（必需：FFmpeg/FFprobe/TransitionsDir/AssetsRoot/LocalAssetsRoot/WorkRoot/OutRoot；可选：FFmpeg6），不猜测默认路径` |
| 映射表只含 9.0.2 实际转场名 | `dotnet test tests/Fission.UnitTests` → `TransitionCapabilityTests` | 通过 |
| 能力缺失降级链 | `RunAsync_GlTransitionMissingOnSingleEngine_DegradesToMappedXfade`（outcome `applied-xfade`）、`RunAsync_NoTransitionBackend_DegradesExplicitlyInsteadOfSilently`（事件含"无 9.x 等价后端"） | 通过 |

## 8. 后续（不属 W1-E）

1. 需预渲染的 40 条：需要一条离线 GLSL 渲染管线（离屏 GL/OSR 光栅化 → 定长片段），再以 `overlay` 合成；届时在 `TransitionCatalog` 增加"预渲染素材目录"后端，判定列可从 🟡 收窄。
2. `multiply_blend`：用 `blend=all_expr` 写出与 GLSL 同构的时间表达式（`if(lt(T,D/2), ...)`），加后可从"未自动"转为自动。
3. 方向语义：`wipe*/slide*/horzclose/vertclose` 用 2 段样片逐帧比对，确认后固定映射值。
