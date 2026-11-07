# tools/csc-shim · CET 规避说明（R8）

## 现象
本机 Windows 10 **Build 19044（21H2 未打补丁）** 缺 CET shadow-stack OS 支持。
.NET 10 SDK 的 Roslyn apphost（csc.exe/vbc.exe/VBCSCompiler.exe）启动即 FailFast：

```
Fatal error. Your Windows doesn't fully support CET. Please install all available Windows updates.
```

## 已验证无效的路径
- `DOTNET_CETCompat=0` / `COMPlus_CETCompat=0`（检查在 native 侧，环境变量救不了）
- PE 头 `DllCharacteristics` 摘 CET 位（实测 bit0 本来就未置位，非该机制）
- `CscToolExe=dotnet.exe`（Roslyn ToolTask 只做路径拼接，无 dotnet 特判）

## 生效方案（当前）
`csc.bat`：把编译参数原样转发给 `dotnet exec <sdk>\Roslyn\bincore\csc.dll`（**宿主形态不触发 CET 检查**，实测正常）。
由 `Directory.Build.props` 的 `CscToolPath/CscToolExe` 指向；bat 动态解析最新 SDK 版本，CI runner 同样可用。
副作用：全局关闭共享编译（`UseSharedCompilation=false`，不再拉起 VBCSCompiler）。

## 根治
打齐 Windows 更新（补上 CET shadow-stack 支持后可移除本壳与 Directory.Build.props 相关三行）。
参考：dotnet/runtime #113029 / #114673。

## 附带
`Directory.Build.props` 的 `<CETCompat>false</CETCompat>` 让**我们自己的产物**不要求 CET ——
未打补丁机器上自宿主运行同样安全。此行与编译壳独立，保留。
