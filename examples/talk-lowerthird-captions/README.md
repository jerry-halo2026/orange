# 口播 + 下三分之一 + 字幕（可跑样例）

一个完整、离线、可直接渲染的 OpenFilm 工程：**人物镜头 + 下三分之一姓名卡 + 逐词高亮字幕**。没有真实素材依赖（人物是用代码画的替身），三件东西都在时间线上，随时可改、可删、可换。

用它验证的是我们这条链路的最终形态：**库里的组件 → 时间线上的 clip → 检查器里改参数 → 渲染成 mp4**。

## 里面是什么

```
talk-lowerthird-captions/
  film.html                       三条轨道：字幕（上）/ 姓名卡（上）/ 人物（下）
  speaker.html                    "口播"画面替身：背景、光、会动嘴的头（纯 frame(t)）
  saved/openfilm/
    text-hf-lt-clean-bar/hf-lt-clean-bar.html        下三分之一（库条目 text/hf-lt-clean-bar 的副本）
    text-hf-caption-highlight/hf-caption-highlight.html  逐词高亮字幕（text/hf-caption-highlight 的副本）
```

`film.html` 的三条轨道（`<section>` 第一条在最上层）：

| 轨道 | clip | 时间 | 作用 |
| --- | --- | --- | --- |
| V3 | `saved/openfilm/text-hf-lt-clean-bar/hf-lt-clean-bar.html#t=0,4.8` | `at="1"` | 1.0s–5.8s 的姓名卡，放在左下、比字幕高一行 |
| V2 | `saved/openfilm/text-hf-caption-highlight/hf-caption-highlight.html#t=0,8` | `at="0"` | 0–8s 的逐词字幕，贴画面底部 |
| V1 | `speaker.html#t=0,12` | `at="0"` | 12s 的"人物镜头"替身 |

两处示范了"在片子里改组件"，不是改组件源码：

```html
data-props='[{"name":"Name","type":"text","at":".lt-name"}, …]'
overrides='[{"at":".lt-name","text":"Ada Lovelace"},
           {"at":".lt-role","text":"Mathematician · Writer"}]'
```

字幕的强调色也是 `overrides` 改的：`{"at":"html","style":{"--hl-accent":"#ff8a00"}}`。

## 怎么跑

```bash
cd examples/talk-lowerthird-captions

openfilm open .                 # 在 Studio 里打开（Studio 会把它收进工程库并显示地址）
openfilm look . 3.2             # 单帧：看 3.2 秒那一帧
openfilm look . 0-12            # 密片：整段的接触表
openfilm render                 # 出 mp4：talk-lowerthird-captions.mp4
```

`render` 需要 ffmpeg 在 PATH 上（`openfilm doctor` 会告诉你有没有）。

## 换成真的口播素材

1. 把拍的片段放进 `assets/`，比如 `assets/take.mp4`；
2. 把 V1 那条从页面换成视频，时长按素材改：

```html
<section>
  <video src="assets/take.mp4#t=0,12" at="0"
         style="left: 0; top: 0; width: 1280px; height: 720px"></video>
</section>
```

3. `speaker.html` 就可以删了（它只是替身）。

## 声音（重要）

**页面没有声音**：组件里的音频不会被采进去。声音只能是时间线上的 clip：

```html
<section><audio src="assets/bed.m4a#t=0,12" at="0" volume="0.25"></audio></section>
<section><audio src="assets/vo.wav#t=0,11.4" at="0.2"></audio></section>
```

`<video>` 自带的声音也算 clip 的声音，可以直接用（不想听就 `muted` 或 `volume="0"`）。

## 改文案与位置

- **文案/颜色**：在 Studio 里点中那条 clip，右侧 `Properties` 直接改（`Name`/`Role`/`Accent`），或手改 `film.html` 的 `overrides`；
- **位置与大小**：改 clip 的 `style`（`left/top/width/height`），或 Studio 里拖动画面上的框；
- **时间**：改 `at` 与 `#t=in,out`；
- **换组件**：把 `src` 换成库里别的条目（例如 `text/hf-lt-dark-card`、`text/hf-caption-neon-glow`），`--take` 会告诉你确切的 `<iframe>` 行。

## 已知约定

- 组件页画的是**自己的盒子**（下三分之一 760×160、字幕 1720×130），所以样例里按 1280×720 的舞台把它们等比缩小（507×107、1147×87）；换到 1920×1080 就用原尺寸；
- 字幕内容是页面自带的一行示例文；要做真实字幕，把页面里的 `WORDS` 换成你的台词与时间（或等后续的字幕轨 `<track kind="captions">` 方案）。
