# OrangeFilm

OrangeFilm 是自有的视频生产工作台：桌面应用（Electron）、Studio 编辑器、`openfilm` 格式与 CLI，以及 `workers/fission`
下的 .NET 批量混剪 worker。

**专有软件，未经书面授权禁止修改与分发。** 版权归 OrangeFilm 所有；许可与授权范围见 [LICENSE](LICENSE)，名称与标识见
[TRADEMARK.md](TRADEMARK.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `apps/desktop` | 桌面应用：窗口壳、utility 进程里的 Studio、agent 对话 |
| `packages/openfilm` | 格式、CLI、Studio 的服务端与界面 |
| `packages/shared` | 渲染层与 Studio 共享的代码 |
| `workers/fission` | Studio 启动的 .NET 批量混剪 |
| `docs/` | 维护中的开发文档；入口 [docs/README.md](docs/README.md) |

## 开发

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @openfilm/desktop release --dir   # 未打包的应用 + 自检
```

平台：Windows x64 为首发目标，macOS Apple Silicon（arm64）单独测试支持；不承诺 Intel Mac、Linux 客户端或 Universal 包。

## 版本

产品版本取自 `apps/desktop/package.json`，发行 tag 必须与之相等（当前 `v0.1.0`）。
