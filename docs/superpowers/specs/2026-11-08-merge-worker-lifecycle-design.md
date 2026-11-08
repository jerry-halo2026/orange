# 原共享 merge Worker 生命周期设计

这是已批准计划内的原生工程实现选择，不改变试用范围。目标是让原person-edits模块能证明已准入合并和所有current/retired真实Worker均结束，而非把unref/清map当退出。

## Approaches / Root technical ruling
- 仅unref或fire-and-forget terminate：不能证明真实exit，拒绝。
- 每个Studio.close直接停全局Worker：会影响同进程其他消费者，拒绝。
- 原模块新增显式stopMergeWorker/startMergeWorker与generation所有权：选择此最小producer方案；维持原消息格式和算法。后续process lease/多Studio所有权与server消费另包，不能据此宣称完整退场。

## 契约
模块初始active；stop先安装稳定Promise再同步关闭mergeFilmWrite准入，getter/state/计算前拒绝新调用；完整已准入调用登记在任何外部调用前且原工作同turn开始。调用结果、普通失败回退与timeout保留人的整片语义不变。current/retired每个真实Worker独有waiting/sent/exitPromise；configure同步摘除旧generation，旧message/error/exit不得拒绝新generation请求。stop等完整调用continuation及所有真实exit，idle线程也真正terminate，失败关闭且不把rejection当quiescence。实际未退出时不能允许start。start显式开启下代且延迟创建线程。

projects/notes/last编辑历史保留，trackIds可以继续WeakMap；新generation必须冷发送完整必要tracks。退出只证明Worker内部cache生命周期结束，不证明主进程全部私有状态已清空。原wire、1000clip阈值、person-merge-worker及merge算法均不改。

## 真实验证与边界
新producer测试观察委托真实Worker的创建、reply、exit；default native1000+clips/two roots/incremental合并结果必须正确；current+retired、configure A/B旧exit、timeout/error/postMessage/constructor、重入准入、start/stop和cache冷启动均覆盖。最多4个owned线程，finally等待真实退出。原person-merge.test为内存root+实际一个线程的兼容回归，进程结束/unref不作为新退出证据；原person-edits.test会启动Web，仅只读参考。全部新FS输出在E3自有隔离目录，无网络/端口/模型/媒体/.NET。

后续film.mjs keepAside/replace、已进入route IO、owner/Auth、server多消费者lease、N1及PG均未纳入本producer验收。
