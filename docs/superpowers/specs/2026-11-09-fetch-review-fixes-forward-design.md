# Fetch F01–F04 前向修复草案：治理未解除，禁止执行

本草案只准备已批准原生下载接缝范围的既有独审修复，不追认历史作者行为。C17、旧作者终态、实际Root贡献、冻结candidate7d8636及199文件原样保留；C18只是review-only proposal。必须先有Ethan明确处理方式或已有有效非作者治理授权，才形成前向C19唯一Root作者正式卡、输入/policy独审、immutable/受管资源/新N5a。之前不改四文件、不编写失败用例、不运行actor。

## 最小技术改动（未实现）
- F01 P1：分别保留首个普通worker失败与全部私有cleanup品牌失败，await所有worker后优先返回安全generic branded FetchError；普通首错/原cause仅私有。不能按文本猜，不公开路径，不降低四并发/五次重试/退避/原生格式/白名单。
- F02 P2：外部URL coercion只做一次，string准备完、登记job与调用library之前重查terminal。原parseRepoUrl规则不改，给primitive避免再次外部toString；completion先于library回调登记。
- F03 P2：实际返回published folder后、open准入判断前保存到随job存续的私有entry或强持有事实；不加publicJob字段/错误文本/协议，不只用马上失强引用的临时error键，不为测试加公开getter。保留完整目录，不虚构回滚。
- F04 P2：unused error Response退休也依据真实reader.closed/readerror与cancel promise区分既有read错误和真实cancel拒绝；只release当前拥有reader。已locked未知归属不能抢foreign reader或冒称成功；仍用私有品牌，冻结FetchError文件不改。

## 真实失败用例先行：均尚未编写或执行
1. F01四worker先确定普通404；另外三项取得real Response、适用者建real WriteStream；abort后一个cancel gate拒绝、另两个成功。等待全部操作/fileclose后cleanup品牌及manager stop拒绝必须保留，public不含路径。分别覆盖pipeline/error-body retirement/writer-setup retirement，不fake clone/project。
2. F02 toString内stop后返回合法原生URL：start拒绝且library/FS/fetch/spawn0。另计正常prepare只coerce一次，不能重复转换跨终态。
3. F04真实404 body.start中error、underlying cancel0，不得cleanup品牌、普通失败可完整drain；已有真正cancel reject正例仍fatal。
4. F03现有actualrename后cancel文件保留/不open/public无path是已运行可观察firstGREEN边界，不伪造新RED。新增私有强存续不新增公开行为，须具名非作者data-flow核验assignment/lifetime/retention；不能静态字符串假测试或测试专用public API。若需新可观察恢复消费者，另定最小边界，不偷塞此卡。

## 源、资源、证据
仍只fetch-repo.mjs、fetch-github.mjs和两drain.test.mjs；editable baseline为冻结dirty候选+HEAD289b，未合格/未有producercommit。治理确认后重新绑定实际消费的19 immutable inputs/PhaseA资格及新原始工具/资源；不拿旧C17当Root准入。E4单写、18481/18482自有loopback、fresh七HOME/temp/profile/library/log/output、真自有Git及captured子进程实际close规则保留。每次RED/GREEN保存4实际before源码和after hash；不覆盖旧failed证据。
原54不移除/skip/弱化；新增数量按actual，原17resource-adapted＋单独guard重验（不称未改原文件执行），server类型0/Core/TS/NodeTypes/输入/旧ignored/exit-close均核。source/result非作者复审后才localcommit；整合/hosted/UI/ownerN1/PG仍需独立真实门禁。

## 不解除项
Ethan处理历史交接的答复未到。此草案不是C19 writer许可。真实Auth仍缺安全配置位置/第二Supabase身份/应用绑定；ASR费用/工具边界未核，产品调用仍0/50。既有CI35/native参考50不代本修复、全server退场、T02、真实客户端/媒体/安装/Mac或完整试用签收。
