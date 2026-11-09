# C22 原生 startStudio 已进入 editor HTTP 请求退休 consumer

## 目标与最小选择
只关闭原server1207–1218没有登记/等待已进入route Promise的缺口；复用原startStudio、原HTTP路由、原projects/film/person-edits/Guard和现有configure({keep})测试接缝。Root选择在原函数内维护每instance私有集合，不导出新manager/协议，不加生产FS/route替身。新增通用fs DI没有必要；模拟route成功或全局patch不可接受。原UI/IO/CLI/项目格式/时间单位/ID与startStudio签名/返回字段不改。

## 唯一源码写集
server.mjs 与新 server-request-drain.test.mjs；其他生产/原测试/CI/package/lock/07/entrypoints不改。server为共享入口，只授权Root此卡单写。现有close先发布稳定Promise与stopping，再启动原全部stop/network关闭；新增强持有的已进入请求完成Promise，必须在调用任何route/外部回调之前登记，关闭fence后不准新请求，snapshot在external stop前取得，仍启动原stop避免deadlock，然后await所有已入请求完整处理/error/完成记账。每请求不管reject值为null/false/undefined都必须正确结账，防unhandled rejection。

## 错误与兼容边界
保留原HTTP状态/JSON映射；已处理的HttpError（含明确隔离capability503）和原已知4xx不是退休失败。非HttpError的>=500处理/IO异常以及error处理自身异常，若该请求被本次close接管，close在所有任务settled后可见拒绝；不按错误truthiness、不新公共错误DTO，沿用close已有rejection能力/稳定identity。已完成历史请求不追认成新失败，不引入全局Worker stop。原/api/quit继续setImmediate退出，必须验证不因等待自己产生deadlock。

## 真实TDD与安全夹具
- child启动前7HOME/temp同一fresh短scratch、显式nativeprofile/Guard，再动态import生产模块；newpair18483/18484，旧回归18475/18476。所有输入为自有空film（tracks=[]，0clips/无assets），避免server755 warmFilmPoster。subtitleTranscriber工厂只返回closure，绝不调用ASR/provider。禁止pages内容请求/browser/ffmpeg/ffprobe/Worker/Git历史/Fission/.NET/模型/真实账号。
- native createProject产生实际id，filmHtml/native filmWritten登记人改stage，再把完整theirs写入同一自有film；真实GET /api/projects/:id触发原settle。原documented personEdits.configure.keep测试provider写实际agent.html/merged.html原bytes到私有.evidence，完成后持有gate，随后原film.replaceIfStill真实替换。不是fake route/clone/project/merge，也不声称测试原Git历史。default native keep生产代码不改，所有cases finally恢复真实historyKeep引用（不调用Git），forget仅本fixture。
- 首RED必须证明：client/socket与双port已关闭，但真实keep/film尾部仍held时旧close过早settled；不能把fixture/import/权限/超时当缺陷RED。GREEN在gate前保持pending，放行后原native film实际bytes/rev与stage符合原merge，之后无新FS写、close同一Promise、新请求拒绝且无新callback。
- 真实HTTP GET projects配原working callback同步reenter close并抛Error及null：close保留拒绝/falsey原因。明确HttpError503拒绝兼容不应变退休失败。原quit自关稳定不死锁。所有错误/终态均真实HTTP+原生模块，不能新增公开测试getter。兼容firstGREEN如实标记，逐项RED→最小修复→GREEN，每run保留实际server/newtest before/after bytes和raw输出。
- finally先release所有gates，再await原settleProjectFilm串行尾部、client结果、studio close/known预期拒绝与Guard，端口和捕获Node实际exit/close；任何未知退休立即停止后续，不PID扫描/kill外人，不能靠截图/数个tick宣称FS完整。旧原回归2files默认process隔离（不与新file共享profile全局）；无skip/pattern弱化，原server tsconfig noEmit0。

## 明确保留未关闭项
只editor HTTP route Promise，不签WS升级/pages/render descendants/desktop parent/共享mergeWorker或完整owner N1。现有personEdits.configure全局test状态仅序列化单Node文件使用并finally恢复；新生产request集合必须在startStudio实例闭包，绝不全局。原Git history保存/真实媒体/授权生产接线仍独立门禁。server source pin会改变，现CI旧pin须后续共享CI单写包在本producer独审冻结后更新，并加已设计Fetch Node22job；本包不运行/伪称旧CI新头通过，不合dev/main/tag/push。完整17目标不缩、模型调用仍0/50。

环境精度：新consumer文件在显式profile应用时仅写原OPENFILM_*映射，7HOME/temp保留同freshscratch；原不可改回归文件仍按既有isolationEnvironment自行映射其显式profile，全部仍在自有profile内，但不冒称其内部始终七值相等。两波分进程运行，绝不共享全局profile/personEdits配置。

资源闭集：newconsumer仅.dev/studio-request-drain/{profiles,runs}内全新native attempt/attempt-<timestamp>-<pid>，所有scratch/log/report/evidence/project/cache均落该族；原回归只原.dev/studio-auto-close/profiles与.dev/studio-watch-close/profiles的新attempt；原N5a仅原.dev/t01-profile-* fresh mkdtemp及可信checker固定runner-temp安全规则。协调工件仅E1.dev/native-request-consumer-prep独占目录。旧目录/文件/link逐项前后保持，不泛授权.dev或任意新根。
