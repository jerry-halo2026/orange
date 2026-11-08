# 原 Exports 队列、直接子进程与父层FS完成

已批准完整退场方向中的第一原生producer包，不改变试用范围。现有stopAll的8秒race、IPC done即settle、晚start和未保存FS尾部不是quiescence。

## Approaches / Root技术选择
- 假EventEmitter或高层fake renderer：无法证明真实child/FD，拒绝。
- 真实browser/ffmpeg全链马上运行：当前包无这些执行资源，也不能用媒体探测旧测试冒充Node-only，后续仍须实测。
- 选择原createExports+最小可信Node实例fork/encoder/FS wrappers：默认仍原入口/IPC/CLI，测试实际fork自有Node脚本，消息完全原格式、文件是合成文本即使后缀.mp4，父层真实copy/rename/cleanup。

## 边界
只exports.mjs及newexports-drain.test。保留全部Job/Ask/IDs/单位和原校验，sidecar省略不填false；validfilm.doc预验、h264/hardwarefalse/burnfalse/noclip/noalpha/noPNG，避免open/ffmpeg/hardware副作用。capabilities独立API不调用；oldexports.test会导入ffmpeg/WMI，只读不执行。所有默认home/output/logs/sweep均显式ownprofile，Node实例DI不向HTTP/renderer/env暴露，不globalpatch。

stopAll先稳定Promise/closing再通知，terminal阻新work、完整登记beforeexternal，等待真实业务尾部/owned directChild close及stdio/父层FS；不能8000ms resolve假成功，existingcancel升级只允许当前真实ownedfixturePID，timer结束后必须实际close。清理错误可观察，不虚称文件删除；callback异常不使其它ownedwork遗失。测试最多2个自有NodeCP，原below/setPriority仅自有CP；Windows原killProcess的taskkill /pid currentowned /T /F明确纳入范围，fixture无descendants，不枚举或killbyname。

原pool/NLE实际路径、browser descendants、render-worker4秒强退、desktop10秒外层deadline、server请求消费、完整IO退场/owner/N1/PG仍后续。actor只新Node/FS测试，不CPU84；Root独立pre/post/exactCPU84照常，不改旧fixture路径或总覆盖。类型必须不新增exports诊断，当前独立E4基础类型115修复不在本actor写集。
