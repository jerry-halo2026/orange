# 分析组件（rea-video）

`openfilm analyze` 用的视频分析组件，**不随安装包分发**，首次使用时按需安装。

- 上游：<https://github.com/madebyollin/rea-video>，Apache-2.0
- 运行前提：Python ≥ 3.10（随包的 Python 运行时见 `apps/desktop/src/python-runtime.mjs`；没有时用系统 Python）
- 安装位置：`%APPDATA%\<product>\services\rea-video`（macOS：`~/Library/Application Support/<product>/services/rea-video`）
- 大小：约 180 MB（含模型权重，安装时下载）
- 入口：`-m rea_video`，由本目录的 `manifest.json` 描述

## 现在是什么状态

- `manifest.json` 是**契约**：名字、版本、许可、Python 版本下限、安装位置、体积、入口。
- `install.mjs` 是**骨架**：能算出该装到哪、多大、缺什么，但**不做真正的下载/解包**（那一步要等组件清单与 sha256 定稿，并按 W3 的 `python-runtime` 范式写）。
- `openfilm analyze` 在组件缺失时返回结构化提示（`reason: component-missing`）并以 **exit code 4** 退出，**不当作用法错误（2）**，也不抛栈。

## 为什么放在这里而不是安装包

模型权重与 Python 依赖合计约 180 MB，且许可证（Apache-2.0）与 Python 生态版本绑定；随包分发会让安装器体积与更新包翻倍。按需安装让"没用到分析"的安装保持精简。
