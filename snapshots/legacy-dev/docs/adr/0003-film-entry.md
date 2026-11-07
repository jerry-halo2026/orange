# ADR 0003: 独立 Studio renderer 与经授权的普通入口

## 决策

普通桌面仍以本地 Auth renderer 为唯一可信壳。完成密码交换和 `/user` 验证后，固定 `window.orangeStudio` 仅提供无参 `getState/open/close`；三个 IPC 均只接受该壳的精确 URL、同一 webContents 的实际 mainFrame，并校验有限状态 DTO。没有 renderer 提交的路径、工程、receipt、origin、token 或 bounds。

同一 BrowserWindow 下创建独立 sandboxed WebContentsView、非持久 partition，无 preload/Node/权限。native 固定打开 `/projects/local-experience`，直接进入原版 App 的真实 ProjectView；仅内存本地体验，不是用户磁盘工程。native 边界保留顶部 128 DIP 可信返回/退出栏；窗口过小时关闭 Studio，不覆盖可信壳。

`installAuthIpc` 创建的唯一 main Auth 同时供 Studio 授权。main 计时器主动撤销过期会话，退出先本地撤权再等待远端。epoch 对 close/logout/expiry、挂载中止和旧故障回调设栅栏；挂载尚未完成时注册的 native invalidation 也同步关闭 token/view/sockets，晚到结果不能恢复。异常、进程崩溃、导航、壳关闭同样清理。

## 构建与可信字节

桌面普通 build 顺序为 typecheck → Studio → main → preload → Auth renderer；Studio 不再依赖额外手动构建。UI 仍为原 235 文件固定闭包，唯一 renderer 接缝为 `StudioProbe.tsx → @orange/film-adapter/renderer → App + globals.css`，单 React/内核规则不变。

main 构建核验 Studio 完整产物集合，将实际 `studio-build.json` SHA-256 编译入 native，运行时不接受调用者自报摘要。额外 native experience 闭包恰为同一固定 pin 的 film-doc、ops、timeline、overrides、bridge 五个 Git blob：逐一核路径、字节数和 SHA-256，直接从内存快照生成两个纯模块的精确虚拟 import 图及四段 immutable 浏览器源码。没有全量 upstream server/host/stage、运行时源码读盘或新依赖。`experience-build.json` 记录五条明细、pin、ledger digest、Studio receipt digest 和实际 main digest；原 `build-identity.json` 结构保持不变。

Studio/preview 使用两个隔离 loopback origins。native 核当前授权、webContentsId、实际 frame 祖先、initiator、精确 route/method/resourceType 后才注入短期头。preview document、raw-film xhr、四 runtime script、两固定 SVG image/必要 HEAD 分角色授权；preview 不得访问 API/WS、外网/file、二层 frame 或顶层 SVG。token 不进入 URL/DOM/回执。

## 验证与范围

原进程内 smoke Symbol 保留为测试专用能力，普通路径不读取它；fixture 不是产品体验替代品。单元测试覆盖 main 自主过期、同步退出、IPC/bridge 拒绝、epoch、挂载中关闭、native bounds、preview 角色和实际 main wiring（模拟 native）；这些不等于真实 Windows/账号验收。

最终候选仍须 root 集成后重建、更新精确图门禁并独立审查，运行真实普通登录/Studio 编辑/返回/重开丢弃/退出与既有安全回归。此变更不宣称 K01/N5a 准入、真实保存、导出、云端工程、生产发布或 M0/M1 完成。
