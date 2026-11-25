# 适配器：按次自定义属性

按次属性属于一次原生调用，不属于会话、Agent 进程或者 Trace ID。一个常驻宿主的不同请求可以用不同的属性。业务调用方在已验证的调用上下文中准备属性；适配器负责把它们和本次原生执行绑定；Collector 负责投影到事件，原有 `otlpTrace.spanAttributePassthroughPrefixes` 决定哪些业务字段进入 Span。

新的适配器可复用 `assets/hooks/shared/invocation-attributes.mjs`：

1. 在真实原生调用开始时取得专属元数据，或者用可复核的原生消息 UUID 读取事先登记的快照。不能按 prompt、会话最近一轮、到达顺序或全局 env 匹配。
2. 在生命周期内为同一次调用保存独立快照。Node producer 可用 `parseInvocationAttributes()` 校验。在受控 producer → Input 的内部记录里使用 `INVOCATION_ATTRIBUTES_FIELD`（`pilot.invocation.attributes`）。
3. Canonical Input 显式设置 `preserveInvocationAttributes: true`，或取出载体、走现有原生归一化后调用 `projectInvocationAttributes(entry, snapshot)`。不要把整个载体、源请求或未经选择的 metadata 输出。投影不会覆盖已存在的原生字段。
4. 采用字符串、有限 number（整数不超过安全整数范围）、boolean；最多 32 项、16 KiB JSON，键最长 128 ASCII 字符，字符串最长 512 UTF-16 单元。非法/超限组不部分投影，`{}` 是明确没有本轮属性。保留、结构及常见敏感字段名不能用作自定义键。值使用业务选定的非敏感 ID，键名校验不代替应用权限或值脱敏。

这是生产者与 Collector 的公共契约，不是给所有原生 Agent 增加了新 RPC 参数。SDK、Hook 或 App 仍须有真实可观察的本次执行边界。可独立于上游 Trace 串联使用；本能力不创建、提取或改写父上下文。
