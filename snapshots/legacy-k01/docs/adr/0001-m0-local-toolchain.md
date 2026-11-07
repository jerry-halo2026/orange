# ADR 0001：M0 隔离桌面壳的本地工具链

状态：T01 候选，待独立审查。基线：`405b45f322e29e097dca57efef6c0be90e95f699`。

## 决策

- 固定验证环境为 Windows x64、Node 24.22.1、pnpm 9.15.9。选择实际可运行的 Node 24 而不是机器默认 Node 26；固定的 Electron/Vite 均满足该 Node 版本要求。pnpm 9.15.9 与 OpenFilm 固定样本的根声明一致；未把机器上可调用的 pnpm 11.25.0 当作兼容替代，也不把版本对齐当成 OpenFilm 已构建。
- 桌面唯一入口是 `@orange/desktop`。Electron 45.2.3、Vite 8.3.6、TypeScript 5.9.3、React/React DOM 19.3.1、仅用于冒烟的 Playwright Core 1.64.1 固定到根锁。主进程、无能力预加载和页面分别构建；生产启动只加载本地打包页面，不依赖 Vite 服务、旧应用、第三方账号或网络。
- 在 Electron ready 前为每次启动创建新的系统临时目录，设置 `userData`、浏览器存储、日志与崩溃记录位置。壳不发现或迁移旧目录，不提供跨启动的业务持久化。测试使用树内专用 TEMP/TMP，并仅在测试结束清理该次生成的目录；手工启动生成的临时 profile 由系统临时目录策略管理。
- 预加载不发布桥或 IPC；页面运行在开启上下文隔离和沙箱、关闭 Node 的窗口中。页面 CSP 不允许联网，窗口阻断页面主动导航/弹窗和权限请求。第一方身份尚未接入，所有路径只显示启动提示，不开放模拟登录、缓存或工作区。未来接入必须重新审查授权、离线处理和必要的窗口权限。
- `E20.base` 在此仅包含壳构建/真实入口和 Windows 冒烟。跨语言、允许/禁止导入、单 React 候选图、film/Fission、真实身份、旧版发布隔离和正式视觉均不因 B 通过而通过。

## 可复现的 Windows 验证

在实际获准的独立工作树内，使用项目局部工具和依赖缓存；不修改全局 Node、pnpm、机器安全设置或旧安装。验收使用 `cmd.exe`（不启用登录语义），固定 1100×760 窗口与设备缩放 1。未安装外部字体，也未以画面像素作断言；正式视觉需另锁字体和 Windows 显示设置。

1. 先确认 `node --version` 为 `v24.22.1`、`pnpm --version` 为 `9.15.9`。可以在忽略的 `.orange-local/toolchain` 中使用 npm 官方 tarball `pnpm-9.15.9.tgz`，解压前按 registry 的 dist.integrity 核对：`sha512-aARhQYk8ZvrQHAeSMRKOmvuJ74fiaR1p5NQO7iKJiClf1GghgbrlW1hBjDolO95lpQXsfF+UA+zlzDzTfc8lMQ==`。
2. 指定工作树内的 `npm_config_store_dir`、`XDG_CACHE_HOME` 和 `electron_config_cache`，仅用 npm 官方 registry 执行 `pnpm install --frozen-lockfile`。Electron npm 包与二进制安装分开。
3. 独立工作树首次安装二进制时，在经批准的联网步骤执行 `pnpm --filter @orange/desktop exec install-electron`。使用 Electron 官方 GitHub release，不用镜像或 override path。实际 Windows x64 压缩包 SHA-256 为 `489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0`，与锁定 npm 包所附校验一致。冒烟找不到本地二进制会报错，不触发下载。
4. 运行 `pnpm run build:shell`，再独占 Windows 桌面运行 `pnpm run test:shell`。真实应用进程由 Playwright 启动，只为本次测试使用回环调试；主进程不启用调试端口。冒烟检查单窗口、本地根页面、临时 profile、两个模拟旧目录哨兵、实际窗口配置、不可见 Node 全局、没有第一方会话时的启动门、Chromium 上下文离线后的创作路径重载，以及关闭真实最后一个窗口后的进程退出码。测试不主动调用 app.quit；10 秒未退出即失败，清理只限测试启动的进程树且有独立超时。非 Windows 或缺二进制时失败而不跳过。

退出反例使用忽略的构建成品：保留 `window-all-closed` 订阅，只移除订阅体的 `app.quit()`，使关闭最后窗口后进程不退出。删除整个订阅不能构造该故障：[Electron 默认退出](https://www.electronjs.org/docs/latest/api/app#event-window-all-closed)，本机也复现了这一行为。故障注入后还原成品再重建。

正式分发、安装升级、SBOM 与系统级策略不属于本 ADR 的候选验收。

## K07 v1 本地启动证据（B/F 接入）

仅获准的 Windows 验证启动器会向 Electron 传递 `--orange-diagnostics-fd3` 和独立继承管道 fd 3。普通启动不发 K07，也不以 stdout/stderr 回退。主进程在建立临时 profile 之前启动单调计时；仅在页面加载完成、同一存活窗口显示且可见时记成功。页面加载拒绝和启动/显示失败使用不同固定错误码。失败尝试在 750 毫秒内送达并关闭 fd 3 后退出 1；超时或不可观测不补证。Electron 45.2.3 本身还会产生含本地 URL 的加载警告：主进程将同一个规范 file URL 交给 Electron 的实际本地加载和精确警告匹配，避免 Windows 合法路径中的方括号或百分号使两条转换路径的编码不同。仅在本次加载期间替换与该 URL 精确匹配的框架警告，加载完成或失败即恢复原处理；无关同类警告照常可见。Windows 冒烟分别复验左方括号、右方括号和百分号的真实缺页路径，并在含三者的合法目录里验证真实窗口可见。

主进程构建嵌入当前 Git SHA 和桌面包版本，并生成 `dist/main/build-identity.json`（含主进程成品 SHA-256）。从干净的实际候选树重建后再跑冒烟：验证启动器从 Git HEAD/已提交包元数据和主进程成品独立核对清单，不能信任诊断事件自报身份。仅将本次 child 的 fd 3 原始字节送入冻结的 K07 流校验器；12 秒内未收到 EOF，即使已有两条记录仍失败。stdout/stderr 仅用于隔离用例的哨兵检查，不参与事件解码；原流不写证据。

`pnpm run test:shell` 保留原真实窗口/离线/最后窗口退出冒烟，并以同一构建成品的独立副本检查 K07 正向、真实缺 renderer、真实早期 profile 失败、缺终态、缺 EOF。profile 负例保持原生 Electron 的 TEMP/TMP 有效，在隔离副本包装入口设置已有隔离目录作为原生 sessionData，再将产品实际 mkdtempSync 的父路径指向普通文件，使受控入口处理真实文件系统失败；没有新增产品注入接口。传输负例仅在副本拦截 fd 3 写/关闭，保留真实 Electron 进程。缺 EOF 必须先被拒绝，再由隔离包装器通过私有 stdin 接收关闭真实窗口的请求；确认正常退出及 child close 后才清理。强制终止只作故障兜底，不能代替正常关闭断言。失败检查固定代码、退出码及合成路径/令牌不出现在事件流、stdout/stderr 或隔离日志；故障样例不包含真实路径数据。Windows fstat 提供 fd 的 FIFO mode 位，不依赖 Windows 上恒为 false 的 `Stats.isFIFO()`。这些只证明本地 K07 接缝，不扩大到遥测、身份、E12、N5a 或 M0。
