# Rust 发布与测试优先级

## 本轮交付顺序与边界

先更新文档，再交付自动发布 CI，随后分批提交生产代码、脚本和文档，最后迁移独立测试。内嵌 `#[cfg(test)]` 模块及编译必需 fixture 随所属源码提交，不为拆分提交破坏源码闭包。

推送前必须通过 `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`。不降低 lint 等级、不添加全局 allow、不使用 `continue-on-error` 把诊断变成绿色。Git 推送目标为 `origin/loongsuite-pilot-rust`，不推 main，不自动创建 tag 或实际 Release。

## 2026-10-29 开发收口进展（尚未发布）

- main 20c702f（#516）与 aae031b（#521）的 SLS insight schema、可复用 SQL、枚举标签及 Skill 路由已同步；三份文件逐字节对照 04d0de4 的 Git blob 通过。这批为文档同步，不代表其中新增 Codex/Copilot 能力已完成 Rust 实现。目前原基线之后的 11 个上游提交已承接 7 个；Codex 子工作/输出确认、Copilot、磁盘治理与依赖修订仍在进行，尚未合入 main 的祖先关系。


- main 2e98f30（#502）的 Codex Hook 耗时已迁入 Rust：响应刷新后固定单调时钟耗时，空文件锁、1 MiB 活动文件、50 ms 写锁等待、.draining 恢复及每周期 64 个维度与上游协议兼容；耗时超过一天被拒绝，不误称为样本年龄限制。L2 新增 type=hook，沿用 pilot_pipeline、自监控身份和独立本地镜像，日志保留策略覆盖新流。默认 1,473 项、all-features 1,475 项全量通过，另有两个原有 doc-tests ignored；严格 clippy 通过。真实原生 Codex 子进程、collector、本地镜像和私有 HTTP 接收端在隔离测试中连通，公开构建同一配置不联网。Windows/macOS 的现有发布任务加入该实际链路用例；仍不视为真实 Agent 注入或 SLS 查询验收。


- d68b532 dry-run 的两处平台差异已修订，仍等待新的跨平台实跑：Windows 账号测试夹具不再把含正斜杠的多段字符串直接 join 到反斜杠路径，创建的缓存先由真实身份读取器校验；不放宽生产的账号来源或指纹匹配。macOS 模拟崩溃的低层入口此前绕过正式入口的父目录规范化，导致 journal 目标集合不同；新增 HookConfigTargets 明确准备阶段，正式锁与 journal 使用同一组提前固定的路径，模拟崩溃也必须经过同一步骤，锁内不重新解析父目录。新增 Unix 目录别名下的真实进程退出/重试回归在 Linux 先重现同一目标集合错误，修订后通过；文件链接拒绝、不同目标拒绝与恢复材料保护保留。HookStrategy 20 项、Qoder 20 项专项通过；fmt、严格 clippy、默认 1,460 项及 all-features 1,462 项通过，两个原有 doc-test ignored。b9cd5e9 已替换远端（PID 49717），本地指标和 Dashboard 正常，11:10:18Z 的新进程 pilot_pipeline 批次获真实接收端接受。

- main ca54c11（#475）的 OpenCode V1/V2 兼容已移植：原生安装事务携带 index.js/package.json/plugin.mjs/v2.mjs，以目录 URI 为统一入口；同时清理 plugin/plugins 中本安装的旧文件、包名、tuple 和 package 对象引用，保留其他安装、用户对象及注释。健康检查可发现重引入旧项，迁移/重装/卸载及包内真实资产修复回归通过。Rust 输入把 V1 序列化工具 JSON 与 V2 原生 JSON 归一，保留普通/截断文本；V2 仅 execution 的 turn.end 关闭输出缓冲，步骤结束与可重试错误不提前截断，V1 finish reason 行为保留。50 项原语言宿主测试通过并加入既有 CI；严格 clippy、默认 1,459 项及 all-features 1,461 项通过，两个原有 doc-test ignored。真实 CLI/模型兼容脚本已同步但未执行，仍受已同意暂缓真实 Agent 注入矩阵的范围限制。
- d68b532 的八平台 dry-run 40860815058 通过四个 Linux 包；Windows 两架构在 Qoder CLI 缓存身份专项失败，macOS 两架构在 Hook 崩溃后恢复的目标集合校验失败。新增逐轮关联测试在已执行的平台通过，整体仍失败；下一批修复这两处平台差异。DSH 原锁竞争阻塞仍保留，不能因本轮在更早的步骤退出就视为已消失。

- main 的 4e019d0（#508）已由 Rust 承接逐轮上游关联：原子发布完整 owner 标记，保留 Node JSON 字段顺序与摘要兼容；native turn 可重放自己的上下文，其他轮次/进程不可重复消费。输入优先关联但保留源顺序，空元数据不消耗 session 回退，原生 subagent 父关系优先；producer UTF-8 全文 hash 支持展示截断，claim 随有效来源保留。OpenClaw 丢弃 before_model_resolve 元数据，Hermes 原生宿主插件同步上游暂存/重试逻辑。回归包括 8 进程竞争、重启/淘汰重放、精确 mtime 下追加、归属文件兼容、四类真实插件重放 × 单批/逐条的 Rust InputManager→converter 链路及 token/父子树断言；不将这些回放当作真实 Agent 注入验收。宿主测试仍用原语言，在独立 Python 3.12 下验证并加入现有 CI；Rust 回放使用校验 producer/source 摘要的生成 fixture，Cargo 测试和安装运行不依赖 Python。宿主 73 项、原生关联/链路 8 项通过；严格 clippy 和默认 1,455 项、all-features 1,457 项全量通过，原有两个 doc-test 仍 ignored。Windows/macOS 的现有发布任务加入 upstream_context，不增加 runner；该新分组的跨平台实跑仍待执行。

- 内部心跳补齐为可配置的 WebTracking 发送路径：仅 proprietary 构建读取实际 dataDir 下的 `configs/inner/telemetry_config.json`（schema 1，alarm/status 各有 url），公开版即便存在该文件也不连接。目标来自私有安装配置，不写入公开仓库或业务输出配置；缺失/损坏/超出 64 KiB 时保持关闭。真实 HTTP 回归覆盖告警/状态 JSON、中文、400 不重试、503 重试、整体超时；独立进程从 load_config 到生产 sender 验证 dataDir 生效及公开版不发送。网络日志只保留错误类别/状态码，不记录 URL、请求体或响应体。严格 clippy 及隔离 HOME 的默认 1,447 项、all-features 1,449 项回归通过，原有两个 doc-test 仍 ignored。52c0dad 内部候选已替换远端安装并启动，业务配置 mtime 未变；2026-10-29 10:27:23Z 的真实接收端已接受 pilot_pipeline 批次，Dashboard 为 HTTP 200、四类本地指标持续刷新。这里只确认 HTTP 接受，尚未直接查询 SLS 索引可见性。

- 远端 e111237 本地候选实际升级在 Cursor/Qoder Hook 部署阶段失败并回滚，旧采集进程恢复。新增回归重现其配置 home 指向 SSD 缓存目录的符号链接被事务锁拒绝；现只在 Unix 配置事务中固定父目录的真实路径，保留配置文件本身及运行资源路径的链接拒绝规则。Cursor/Qoder/Codex/Kiro 的目录链接安装、重复安装、状态及卸载保留用户内容通过；最终配置文件链接拒绝用例和原有外部缓存/配置链接保护通过。HookStrategy 19 项、旧配置清理 4 项、严格 clippy、默认/all-features 各 1,445 项通过；aad955c 已实际升级远端为 2.0.0，Dashboard/拦截正常，L1/L2 指标连续刷新。该候选仍是公开版，不把本地指标更新当作 SLS 心跳送达；内部 sender 修复见上条。

- 上游 2b516fb（Qoder CN 经 sh 启动）与 51886a2（Qoder Desktop/CN 账号元数据）已移植至原生路径：入口与生成器一起引导 Bash/退出 POSIX 模式；账号快照只限明确 app 调用，16 KiB 有界读取，验证来源/登录/时间并逐 Stop 刷新，不混入独立 CLI 账号，重试沿用已观测身份。Qoder 20 项、原生 Hook 入口 4 项和生成器 2 项通过；非 Linux 发布回归加入同一账号与真实脚本组。main 的其他新增能力仍待对齐。

- [PR #510](https://github.com/alibaba/loongsuite-pilot/pull/510) 的目标已改为 `dev/v2.0.0`；按 [#511 的主版本建议](https://github.com/alibaba/loongsuite-pilot/issues/511#issuecomment-6462162155)，产品版本从 1.2.0 调整到 2.0.0。Rust 编译器继续固定 1.99.1，1.x 仍由 main 维护。已获取相同提交 `04d0de4` 的最新 main 与 dev/v2.0.0；相对原迁移基线新增 11 个提交、203 个文件变化，正在按功能移植，尚不能宣称 main 行为已全部对齐。原工作区五处改动已经补丁、stash 与独立安全引用备份，并逐字节恢复。2.0.0 元数据下 fmt、严格 clippy、默认/all-features 各 1,436 项 Rust 测试通过，两个原有 doc-test ignored；Cargo.lock 仅修改自身包版本。上游能力对齐仍在进行，不创建 tag、正式 Release 或更新渠道。

- 工具链升级至 [Rust 1.99.1 稳定版](https://blog.rust-lang.org/2026/10/15/Rust-1.99.1/)（2026-10-15 发布）：rust-toolchain、主程序和 xtask 的最低版本、日常 CI/八平台构建/汇总工具链及开发文档均固定为 1.99.1。该工具链升级提交未调整依赖锁、edition 2021 与产品版本；后续 2.0.0 仅变更自身包的版本元数据。适配新版严格检查：盒装较大的错误返回/错误链、修正两处 Linux read 的 C void 指针签名，并简化等价迭代与排序；不增加 lint 豁免。远端已实际安装并由仓库自动选中 1.99.1，fmt 和严格 clippy 通过；隔离 HOME 的默认与 all-features 各 1,427 项测试通过，原有两个示例 doc-test 仍 ignored。升级前 0aac136 的 dry-run 40838904907 已通过八平台和汇总共九项；该记录仅作旧工具链基线，1.99.1 的 dry-run 40842246721 已通过日常 CI 和多个平台包，但 Windows ARM64 的 DSH 32 轮并发清理在第 22 轮再次出现 2 秒锁超时；受控共享句柄、安装器与其他 Windows 回归通过。该不稳定性仍是发布阻塞，不能用旧版全绿代替；本轮上游对齐后继续定位。仍不创建 tag/正式 Release。

- Windows 单 PID 身份已改为 Win32 `OpenProcess` / `GetProcessTimes`，单 PID 命令读取使用原生查询。历史 CIM token 与 FILETIME token 交接时保守保留存活锁；Windows 两架构的身份、控制台、锁、归档与同版本激活回归已实跑通过。全进程扫描仍保留原有 8 秒上限。
- Dashboard shortcut 的命令、配置、响应校验与失败清理已由 Rust 承接；macOS JXA 保留宿主实现。原语言策略测试实际展开为 20 项，已接入现有 Linux 日常 CI；真实桌面操作仍需 macOS 验收。
- 两端安装器的卸载流程已接原生 `cleanup-agents`，不调用旧 Node/Python 清理函数。停服务前验证候选资源和部署状态；卸载严格加载全部本地声明，拒绝损坏或非法覆盖，普通发现仍保留跳过坏声明并回退内置定义的既有策略。清理冲突时保留共享运行资源供重试。除持久化目标外，继续清理仍存在的默认/备选配置中的本安装引用，保留用户 Hook 和其他安装的插件。
- Claude 历史清理复用 Hook 配置锁与事务，支持旧式直接命令和 matcher 内嵌命令，保留带历史注释的已知 shell 标记；未知 Hook 结构或标记存在引用时保留缓存供重试。只删除三个旧日志配置字段；普通卸载保留 `sessions/`，彻底卸载才删除旧缓存。损坏配置、只读文件、标记不完整及外部符号链接均有回归；Unix 自定义缓存目录不再误清默认缓存。
- 旧安装缺少原生清理入口时，可以通过显式平台 `--package-url` / `-PackageUrl` 提供 Rust 候选；无法取得可靠清理入口时保留安装文件并报错。Unix shell alias 与 macOS/Windows 环境覆盖清理继续使用原生系统脚本。
- 4420a89 的完整默认与 all-features 回归各通过 **1,422 项顶层 Rust 测试**（主库 1,279、xtask 45、独立集成 98），另有 2 项 doc-tests ignored。计数按每个顶层测试程序最后的汇总行计算，不重复计入进程 fixture 内部的子测试汇总。全量测试使用隔离 HOME，并采用 CI 相同的 debug=0 配置；此前 debug 二进制下 Unix 多阶段桥接单跑约 28 秒，接近 30 秒上限，保留该失败记录。
- Windows 发布门禁尚未全绿：5304e68 的 dry-run 40829939809 两架构已通过 PowerShell 5.1/7 完整与受限模式配置桥接、真实 Qoder 父进程识别及旧插件清理，八架构中的四个 Linux 和 macOS ARM64 包通过。受限模式 fixture 先加载系统模块，再约束全部 Pilot 定义，并用禁止的 File API canary 验证约束生效；依据 [Microsoft 的受信任脚本/模块边界](https://learn.microsoft.com/en-us/powershell/scripting/security/app-control/how-app-control-works)，这不等同于真实 WDAC 策略验收。三个 Windows 卸载失败进一步定位到同一路径混用正/反斜杠：仅枚举两种纯格式不足，现只对已知命令的脚本路径做分隔符比较，命令 flags/引号/参数保持精确；直接与 nested 命令均有真实 HookManager 编辑回归，错误参数/其他安装仍保留。DSH 原协议与 2 秒上限不变，上一轮并发故障本轮两架构未重现，保留失败阶段/锁状态诊断并将现有用例重复 8 轮，不宣称根因已解决。下一轮复用既有任务执行整个 Windows installer_native 集成组，任何失败仍阻止打包。
- Qoder Desktop/CLI 的父进程识别已改为原生 sysinfo 快照，接通此前 Windows/macOS 返回空列表的运行入口，不再使用测试专用 CIM helper。真实改名父进程启动未改名探测子进程，在无脚本运行时 PATH 下验证 Desktop/CLI 分类；避免把探测器自己的名字当作父进程证据。Linux、Windows x64/ARM64 与 macOS ARM64 均已实跑通过；macOS Intel 的同一探针与整个包也通过；该轮整体仍因 Windows 卸载失败。
- 存活判定的 EPERM 分支已接入生产探针：Unix 直接 `kill(pid,0)`，Windows 使用 `OpenProcess(PROCESS_SYNCHRONIZE)` / `WaitForSingleObject` 并将权限拒绝归一化。禁止把过大 PID 转成负进程组选择器；Windows 避免将真实退出码 259 当作仍存活。Linux 的真实存活/回收/非法 PID、单实例锁回归通过，且已用自有降权 nobody 子进程实际验证对 root 父进程的 EPERM 仍判存活；Windows ARM64/x64 在 `627c32a` 的真实进程及退出码 259 回归均通过，EPERM 原分类也通过，关闭这一处部分覆盖。
- AgentActivityEntry 的 10 处历史契约由两个真实 Rust builder → 生产 JSONL 记录校验器回归承接：最小/可选字段、UUID v4、正数纳秒、agent.input、缺必需字段、坏事件名和坏时间均覆盖。独立快照从固定历史基线 AST 提取 38 个 ClientType / 8 个 ActionType 并保存源文件摘要；既验证没有丢失旧枚举成员，也遍历当前 Rust 全部成员。完整映射和执行后清理对应一个旧 TS 测试文件，历史分母保持不变。
- 拦截器拒绝事件、敏感类型规则、脱敏访问日志与运行身份四个历史文件的 18 处声明已逐项承接。补齐规范 UUID、消息深拷贝、原始合成凭据样本、空 verdict 字段和实际进程 token 断言；真实拦截器分组 80 项通过，执行后清理四个摘要未变的旧 TS 文件。测试名称存在本身不算完成映射。
- 配置、规则引擎、verdict store 以及 Qoder/千问办公/OpenClaw 适配协议共六个文件的 41 处声明完成逐项迁移。补齐完整 wire verdict、checkpoint 两条记录的所有字段、办公 prompt/tool payload、空白环境回退及脱敏计划的替换模式断言。环境值清洗统一放在生产配置解析边界，实际传入空白与空字符串验证；默认拦截器 80 项与严格全目标/all-features clippy 通过。六个旧 TS 文件仅在摘要未变且执行后删除；完整默认/all-features 1,416 项是上一批的全量证据，不能将其外推成此后所有改动的同 SHA 证明。
- Hook CLI、嵌入式服务及 Qoder surface 三个文件共 21 处声明完成迁移：20 处 Rust 承接，旧 PowerShell CIM 参数探针 1 处随外部进程机制退役，由真实原生父子进程测试替代。补齐完整 Pre/Post JSON 行、无输出 allow、缺 runtime 工具请求不求值/不落 checkpoint、办公 reason 只包装一次以及失败日志的事件/动作字段。正式二进制在无 Node/Python PATH 下连接真实 loopback 服务、内置敏感规则与真实 verdict checkpoint，验证四种宿主、放行、阻断、身份不匹配、缺 runtime 和坏 JSON；访问日志不出现合成明文密钥。默认 deployment 175、interceptor 83、installer_native 28 与该原生集成 1 项通过，严格 clippy 通过。非 Linux 也接入这条原生集成；这批完整 workspace 测试等待后续同 SHA 门禁，不冒用上一批的 1,416 计数。
- 最后一个历史 interceptor HTTP 文件的 7 处声明已逐项迁移，补齐三个请求的访问日志字段、两种工具 verdict 的完整 key、办公 HTTP 状态/完整 JSON、synthetic 请求字段、规则错误不调用 sink、sink 错误后保留 ruleId 和超大办公请求的空对象。6 个真实 HTTP 回归与 16 个 HookStrategy 回归、严格 clippy 通过；至此 tests/unit/interceptor 下固定基线的 14 个文件、87 处声明全部有明确去向，86 处 Rust 承接、1 处旧 CIM 机制退役。旧文件仅在执行和摘要检查后删除。
- Codex 信任记录的旧 handler 定位同步使用脚本路径比较规则，避免配置移除后漏清相应 trusted_hash；参数与实际被信任的 handler 文本不被改写。新增 Windows 真实混合路径配置→生产信任 writer→卸载清理回归，并接入现有非 Linux HookStrategy 分组；Windows 专属执行证据等待后续 dry-run。40829939809 在发出取消前已自行以失败完成，六个非 Windows 包成功，失败日志保留，新一轮 40831705514 正常启动；没有实际取消已完成任务。
- 空开关与服务关闭的旧 CLI/daemon 契约由正式 Rust CLI 的第二条原生集成承接：真实加载配置得到空规则，敏感形状 prompt 允许；关闭真实 loopback 服务并保留 runtime，验证实际连接失败后的 stdout 为空、返回 0、日志脱敏和无 verdict 文件。取消旧 dist 构建存在时才运行的条件跳过；两个原生集成 0.33 秒通过，严格 clippy 通过。独立 Node daemon 已由 collector 内嵌服务替代，该测试不声称启动旧独立服务进程。
- 55a26f6 的完整 Windows installer_native 两架构均为 21 通过、5 失败；此前三个卸载失败全部通过。新增失败包括原生 read-user-id 的 UTF-8 stdout 被 PowerShell 5.1 按控制台编码解码、包根目录的 8.3/长路径文字比较、取消夹具使用空配置导致没有实际覆盖字段、第二段 layout 脚本未隔离系统模块，以及真实 Cursor 选择后的 Hook 发布失败。read-user-id 新增可选 ASCII JSON 字符串输出，PowerShell 解码 Unicode 转义；不修改全局编码，不写临时凭据文件，Unix 明文协议保持兼容，正式 helper 两种接口在 Linux 均验证。修正三个夹具，并在隔离发布失败时打印仅该 fixture 的持久化 Hook 报告以定位剩余生产故障；产品仍不回显任意子进程诊断。
- DSH 八轮并发在 ARM64 重现 a=true/b=false、锁均已消失且没有锁超时的快速失败；尚不能证明与更早的 2 秒超时是同一根因。补齐标记/补丁编辑阶段错误记录，Windows 对 DeleteFile 的 access-denied/sharing/lock 竞争只重试幂等标记删除，沿用 2 秒边界；受保护标记仍失败并保留资源。Linux 八轮通过，Windows 根因及新修复等待再次实跑。
- 多模态 Agent 能力准入、LRU 和重试三文件的 15 处历史声明完成逐项迁移，14 处 Rust 承接；Node AbortSignal 监听器计数 1 处随语言机制退役，由正常/取消等待及 Arc/Weak 状态释放验证替代。零容量仍在运行时报错，负容量不可传入 Rust usize 接口，未用强转伪造等价输入。补齐 abort 后不带旧 status/requestId 的断言，49 项多模态分组与严格 clippy 通过。该纯测试批新增 1 项回归，完整 workspace 的上一次同 SHA 证据仍是 4420a89 的 1,422 项；不把它误报为新批已全量执行。
- 40834246667 的 Windows x64/ARM64 installer_native 均达到 25/26，上一轮四个编码/取消/路径/桥接失败均通过；DSH 八轮并发与新增 Codex 混合路径 trust 清理也通过。剩余一次首次 Hook 发布及 HookStrategy 组的 7 个失败同源：本轮新增的兼容命令集合误包含了当前命令，安装结果/健康校验将其视为待退役残留。现恢复 legacy 产出的排除规则，读取现有命令增补路径别名时也不加入当前命令；实际 flat/nested 首装、重装、幂等和健康检查新增回归，Linux HookStrategy 17、installer_native 28 与严格 clippy 通过。此项由本轮兼容修复引入，Windows 新修复结果待验证。
- DSH 的真实 Windows 安装器顺序证据已齐，关闭最后一个已登记的 partial 用例；这不关闭其余未逐项登记的迁移缺口。并发回归增至 32 轮并带轮次诊断，Linux 通过。新增 Windows DeleteFileW 删除后幂等场景和不共享删除句柄的真实冲突回归，覆盖临时共享冲突解除后删除及持续冲突有界失败；不把只读属性当作权限限制。更早一次 2 秒锁超时的根因仍未单独确认，保留诊断，不能仅凭八轮通过就称其已解释。
- e83d3f0 dry-run 40836320908 的 Windows x64/ARM64 安装器 26/26、HookStrategy 18/18、两条正式拦截 CLI 集成、32 轮 DSH 并发均通过。唯一失败来自新增受控删除用例的错误前置假设：该平台 DeleteFileW 后文件名可能已经返回 NotFound，而不一定报告 access-denied/delete-pending。修正为接受已验证的删除后状态，并增加真正不共享删除的句柄，分别验证临时冲突解除后的重试成功及持续冲突 2 秒后失败。依据 [Rust 1.91.1 的 unlink 实现](https://raw.githubusercontent.com/rust-lang/rust/1.91.1/library/std/src/sys/fs/windows.rs)，只读属性会被尝试忽略，因此不再将它当作拒绝路径。新增 Windows 用例仍待实跑，发布门禁仍阻断，未伪报整个发行成功。
- 多模态 factory 与 metadata rewrite 两文件共 19 处历史声明完成迁移。新增三个生产 factory→uploader→client→受控 HTTP 边界的行为测试，检查 OSS/SLS 的真实请求路由、鉴权、presign 目标绑定、签名 PUT 不转发 SLS 凭据、未知 origin 安全拒绝、存储发现、关闭行为及非法目标；metadata 11 处由既有完整字段断言承接。新链路发现 delegated OSS 桶解析拼接 scheme 漏冒号，使有效预签名响应仍报 missing bucket；已修复为正确的 scheme 分隔符，52 项多模态回归与严格 clippy 通过。这里没有执行真实云上传。
- 历史审计仍为 391 文件、4,694 声明：62 完整、21 部分、308 未映射；Rust 485、原语言保留 13、退役 9、未映射 4,187。已逐项登记的用例无部分覆盖，另 21 个文件仍保留文件级部分记录和未登记的历史声明。Windows 进程扫描的无控制台生产接线在两架构均有实际通过日志，关闭对应一处部分覆盖；工作区原有旧测试删除改动继续保留。DSH 的 7 处声明新增逐项映射，6 处由真实卸载 strategy 的固定历史语法夹具验证；安装器顺序这一处已有 Windows x64/ARM64 新入口执行证据，7 处声明均完成，摘要未变的旧文件已清理。DSH 的混合行尾、空补丁、缺失目录、坏标记以及陈旧锁并发清理专项在 Linux 通过，两个新增回归复用既有非 Linux 平台任务。严格完整映射门禁继续保留缺口。

本节是当前状态，后文旧提交/旧轮次的数据仅为历史证据。本批不创建 tag、Release，不切换开发机的已安装版本，不开启真实自动更新。

## 自动发布方案

- `.github/workflows/release.yml`：`v*` tag 触发正式发布；手动运行仅 dry-run，不创建 tag、Release，也不更新渠道。
- 固定六平台：Linux x64/ARM64 的 GNU libc，macOS Intel/Apple Silicon，Windows x64/ARM64 MSVC。按用户 2026-11-03 指令移除 musl 支持；每个平台 1 个构建任务，加 1 个汇总/发布任务，共 7 个 runner 任务，不因失败自动缩小剩余矩阵。musl 与未知 libc 在安装器下载、停止服务、写配置前明确拒绝；不回退 GNU 或系统 Node。
- Cargo 是版本唯一来源，工具链固定 Rust 1.99.1；tag 必须等于 `v<Cargo version>`，来源提交必须属于 main/master/dev/v2.0.0/loongsuite-pilot-rust 中的受信任分支。
- 公开构建不带 proprietary feature。每包仅包含相应平台二进制、白名单资源及 `runtime-manifest.json`。macOS 必须携带对应架构 Swift UI，Rust、C 依赖与 Swift 的最低系统版本统一为 macOS 13。
- `xtask package` 在对应 OS/架构执行包内 `--version`、`probe --build-edition`、`check --json`；隔离 HOME 和 PATH，核对执行前后文件未被修改。
- CI 候选包、汇总输入与发布输出放在 `RUNNER_TEMP` 下，按 run/attempt/target 隔离，不进入 Cargo `target` 缓存；包工具仍拒绝覆盖旧候选。`.sh` / `.ps1` 通过 `.gitattributes` 统一 LF，保持 Hook 模板逐字节校验。非 Linux 构建复用包、Hook、候选进程及 canonical 配置路径回归，不增加 runner。
- 汇总必须检查六个平台集合、版本、提交、edition、归档格式和 SHA-256；拒绝 dirty 候选、缺包、重复包或预检失败，不重新编译已验收的发行包。
- 正式发布使用 `release` Environment，手动使用 `release-dry-run`；写权限仅限汇总/发布 job（GitHub 权限按 job 生效），只有正式发布步骤显式传入 `GH_TOKEN`，dry-run 不调用远端写入。发布前及公开前核对远端 tag 实际指向的提交。先创建 draft，上传并核对完整资产，再公开。已有版本不覆盖；失败 draft 保留供检查，不静默补写可能不一致的文件。
- stable 与 prerelease 分开：预发布不得成为 latest，也不得更新稳定清单。工作流按仓库串行发布，不取消正在上传的版本；旧版本不得覆盖更新的 stable。
- 本次不接入 OSS 上传、不自动 bump Cargo 版本、不自动 commit/tag，不切换用户安装，不恢复真实自动更新。首次 Rust 安装使用显式平台包地址，见[安装指南](installation.md#rust-发行包与平台)。

`deploy/package-opensource.sh` 和 `deploy/release-opensource.sh` 仅转发对应 `xtask` 参数。打包前先构建目标二进制，再传 `--target`、`--binary`、`--commit`；旧 `--skip-build`、`-o <archive>` 不再支持。发布默认只准备本地资产，需要 `--packages`、`--output`、`--commit`、`--repository`；旧自动升版/OSS 参数不再支持，正式发布还需显式 `--tag` 和 `--publish`。

正式资产为六个 `loongsuite-pilot-<version>-<target>` 归档、安装脚本、`SHA256SUMS`、轻门禁摘要，以及 stable 的 `latest-rust.json`（预发布使用独立文件）。清单由当前候选包生成，不接受旧 Node 通用包。

这是一条“构建与包预检”发布门禁，不是完整 Agent 注入或安装生命周期验收。第五、六轮 GitHub dry-run 的八平台包及汇总均已通过，具体提交、日志与资产摘要见文末；不得把轻门禁通过称作八平台全部行为验收完成。系统签名、notarization、GUI/真实 Agent 会话不在本轮轻门禁内。文件采集与 WorkBuddy 的 inotify 唤醒仅限 Linux，非 Linux 使用既有轮询兜底，不代表已实现 macOS/Windows 原生文件监视。

## 日常 CI 预算

日常 PR、main/master/loongsuite-pilot-rust push 和手动 CI：目标为整个工作流 10 分钟内完成，不是每个矩阵任务各跑 10 分钟。使用一个 Linux 质量任务，现有 Secret Scan 独立任务保持不变；总数远低于 10。不在日常 CI 重复六平台 release 编译或新增逐 Agent runner。

日常阻断项：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --locked --all-features
```

默认 feature 的构建与现有测试放到发布的 Linux GNU 任务执行。独立 Rust 测试已分两批提交，并在同一个日常质量任务内执行，不逐测试扩张 runner。

10 分钟是预算与超时上限，不是所有运行的性能保证。实测：独立测试提交前冷缓存为 3 分 22 秒；纳入独立测试后缓存命中为 2 分 45 秒，未命中缓存的完整 1,367 项回归为 2 分 49 秒；最终代码 `2d56ecd` 的 1,369 项回归缓存命中为 2 分 04 秒，均为 1 个 runner。冷缓存、排队及依赖下载可能超出墙钟目标；超时则 CI 失败，不能直接跳过失败步骤。优先优化 Cargo 缓存、编译配置和重复 feature 编译，超预算仍无法解决时交由维护者决定下面的裁剪项。

发布构建单独计时，不受日常 10 分钟预算限制，但每次最多 7 个 runner 任务；每个构建有有限超时。不能用拆分 workflow 绕过 runner 预算。

## 测试优先级与可裁剪范围

| 优先级 | 内容 | 当前安排 | 裁剪风险 / 决策 |
|---|---|---|---|
| P0 | fmt、严格 clippy、Rust 编译、已有核心单元测试 | 日常阻断；不删已有快测 | 编译失败、类型错误和主要回归；不建议裁剪 |
| P0 | 六平台包完整性、版本/提交/摘要、包内原生预检 | 发布阻断，6 个构建内执行 | 错平台包或损坏包进入更新渠道；不建议裁剪 |
| P0 | 安装/更新事务、配置保护、checkpoint、脱敏、Hook 协议、真实 OTLP 编解码的现有 Rust 断言 | 已保留；独立测试已分批提交并通过 Linux CI | 数据丢失、破坏用户配置或泄漏；优先迁移，不按数量删减 |
| P1 | 默认与 all-features 的重复全量测试 | 日常 all-features，发布 Linux 跑默认 | 两种构建仍有覆盖；若改为周期运行需维护者确认 |
| P1 | Windows/macOS 专属路径、服务、编码、worker 测试 | 包、Hook、候选进程与配置路径已实跑；其余后续按平台归组 | 完整平台生命周期仍暂缓；不能把轻回归外推为全部通过 |
| P1 | 全部 Agent 的注入、重装、清理和失败矩阵 | 已同意暂缓新增到 CI | 轻门禁不保证每个 Agent 的跨平台配置注入 |
| P2 | Docker/远程真实会话、宿主插件加载、GUI、长时间稳定性和性能 | 本地或后续手动验收，不进日常 CI | 不能声明真实采集、桌面或长期稳定性已验证 |
| P2 | 历史断言中的重复 fixture、纯脚本文本匹配 | 迁移时归并同一行为，记录映射，不机械逐文件复制 | 仅在确认有等价 Rust 断言后删除冗余 |

schema 1 阶段的历史审计为 391 个文件：9 个文件级完整映射、14 部分映射、368 未映射。StateStore / SnapshotStore 两个历史文件的 28 个测试已逐项核对，全部由现有 Rust 断言承接；checkpoint 组 34 项回归耗时 0.04 秒，不新增测试或 runner，旧文件仍保留在提交树中。CP5 的单批/分批四个历史合同已合并为一个参数化 Rust 测试，本地 OTLP 集成组 4 项共耗时 0.27 秒，不新增 runner。这是待比对的文件数，不是失败测试或已知 bug 数。最终代码 `2d56ecd` 的本地、干净提交树及 GitHub Linux 回归已通过主库 1,252 项、xtask 单元 35 项、独立集成 82 项，共 1,369 项。相较早期 1,366 项，新增候选无后代正常退出、canonical 配置路径、HTTP 请求头分段读取三个回归；stdout JSON 诊断并入既有候选失败测试。另有 2 个 doc-tests ignored。Linux 中 Windows 专属测试为 0 项，不计作 Windows 通过；发布中的 Windows 轻回归单独记录。测试通过不等于旧断言全部承接。

`tests/fixtures/rust-migration-map.json` 保留覆盖缺口，`migration-audit --require-complete` 在未完整映射时继续失败。历史映射与旧工具链清理已开始，当前进展见下节；全部缺口补齐后接入日常门禁。需要进一步裁剪时，提交实际耗时和行为覆盖变化，由维护者决定。

## 历史用例清理（进行中）

映射升级为 schema 2，固定基线仍为 `ef8953de1b5d2aa6d719cb0409cb5f48f2b99b42`。开发用 TypeScript AST 解析器从 Git 历史读取 391 个文件，提取 4,694 处测试声明，记录原始位置、标题、套件、参数表达式与文件 SHA-256；不执行旧测试源码。参数化声明数与展开后的测试数分别看待。

- 每个用例记录行为断言、适用平台和去向：`rust`、`retained`、`retired`。保留项不计作 Rust 迁移；退役项需要理由和原生替代测试。
- Rust 引用由 `syn` 检查真实 `#[test]` / `#[tokio::test]`，拒绝注释、普通函数、ignored 测试和歧义名称。同文件只解析一次。
- 保留测试引用原语言测试、被测资源和 npm 执行入口，并与 Vitest 实际收集的完整名称、源码摘要核对；报告另列平台和执行状态。缺文件、缺资源或过期收集结果会阻止完整映射。
- 当前审计为 36 个完整文件、23 个部分文件、332 个未映射文件；337 处声明登记为 Rust 承接、7 处旧机制退役，其中 2 处仍为部分覆盖，另有 4,350 处未登记。基础与事件构建先后新增 50 条，Git 富化 10 条、turn 边界 16 条、敏感检测 3 条、条目脱敏 8 条及预览替换 11 条完成逐断言核对；新接规则加载 10 条 + 回退 2 条（真实 tracing subscriber 验证固定 ERROR 消息）、PII 检测器 19 条、string masker 24 条与 string masker performance 3 条（正确性入默认回归，历史 <2000/<100ms 上界因共享 runner 偷退且门禁不接受 #[ignore] 引用而标为退役）；原语言保留项尚未登记。已完整核对 checkpoint、部分 utils，以及产品映射、身份、消息、finish-reason、脱敏和序列化；旧文件级“完整”不会自动通过新门禁。
- 补测了真实配置加载器与数据目录解析器的一致性、初始化前日志 flush、采集器与 Trace 校验器的真实允许列表、脱敏副本独立性、同毫秒并发原子写，以及报告清空和失败状态。进程探针已接入 `CREATE_NO_WINDOW`，控制台断言现由原生测试子进程直接调用 `GetConsoleWindow`，避免 PowerShell/C# 冷启动影响；修订后的 Windows 实跑前保留部分覆盖。另一处缺口是 EPERM 测试仅调用未接入生产入口的旧 helper。
- 首批门禁、映射与补测提交为 `d1a88dd`；18 个完整文件（154 处历史声明）已由 `c21753f` 清理并推送，同步更新两处旧测试引用。删除后干净提交树的审计分母仍为 391 文件、4,694 声明；严格 clippy 与 1,377 项 Rust 回归通过。
- 首批本地默认及 all-features 均通过严格 clippy 和 1,377 项 Rust 回归（主库 1,252、xtask 43、独立集成 82），另有 2 项 doc-tests ignored；映射工具 Vitest 7 项通过。严格完整映射门禁仍按预期失败。
- `ps1-json-encoding.test.mjs` 已从清理前的 8 通过、2 失败、5 跳过修订为 12 通过、5 跳过：两处旧 Node 机制断言改为原生 span-attr 参数/退出码转发和安装器 Unicode 环境块协议，同时保留 UTF8、BOM、失败恢复及凭据不落盘/不打印合同，并补匹配器正负样本。5 个跳过均来自原有下游内部文件缺失，没有新增跳过。原生 CLI 的前导 BOM、字符串内部 BOM、中文及原字段类型保留专项通过；Windows 5.1/pwsh × FullLanguage/CLM 安装桥接强化后加入既有发布任务，平台结果另记。
- 第二批新增进程身份 9 条和归档 8 条逐用例映射。归档中的 7 条 ASCII staging、tar.exe、node_modules/ACL/npm 旧机制退役；仍有效的同版本活跃目录保护由真实原生激活测试承接。新增双格式 Unicode 解包/截断清理/重试、预检失败不改配置与指针、重复激活生成独立目录及旧二进制摘要不变的断言；不以旧 `win_archive` 无调用方 helper 的测试代替生产入口。
- 第二批本地专项回归已通过：pid-utils 12 项、process-discovery 5 项、package-archive 5 项、同版本激活 1 项。macOS/Windows 同组回归放入既有发布平台任务，隔离 HOME；Windows 另执行无控制台回归。平台执行结果待记录，本批不提交三个进程/归档历史文件的删除。
- 第二批默认及 all-features 均通过严格 clippy 和 1,381 项 Rust 回归（主库 1,256、xtask 43、独立集成 82），另有 2 项 doc-tests ignored。首次 all-features 安装回归曾因同时构建默认配置而报 edition 不匹配：fixture 从共享 `CARGO_BIN_EXE_loongsuite-pilot` 路径复制主程序，清单 edition 却来自测试自身 feature。保留默认测试二进制后构建 proprietary 主程序，可稳定复现同一错误；匹配的 all-features 测试通过，随后串行全量通过。不同 feature 的构建与集成测试必须串行，或使用独立 `CARGO_TARGET_DIR`；未改动安装断言。
- 单实例锁再补 12 条逐用例映射：外部持有者改为原生测试子进程，有界就绪握手及 RAII 回收；失效 PID 来自实际回收的子进程，命令匹配正向用例不再静默跳过，接任锁保留完整 JSON 对象。Linux 13 项通过（含 1 个 fixture 入口），对应测试加入既有 macOS/Windows 发布任务；旧文件删除等待平台结果。
- `94afc33` 的默认及干净提交树 all-features 全量各通过 1,382 项（主库 1,257、xtask 43、独立集成 82），另有 2 项 doc-tests ignored；日常 CI 耗时 2 分 46 秒。新增 25 条基础映射复用已有测试，并强化 global attributes 的完整结果及相同 mtime 下坏 JSON 修复重试断言；普通审计通过，严格完整映射门禁仍按预期失败。
- `c0303b8` 清理三个基础旧文件（25 处声明），`99e319f` 再清理输入双写、事件构建及代码事件转换三个文件（25 处声明），均已推送。双写参数化声明的 messages、messages_delta、空增量三场景全部保留；Rust 移动原条目并完整比较值，承接旧 JS 对象引用保持的业务合同。默认全量及干净 `c0303b8` all-features 全量各通过 1,382 项，另有 2 项 doc-tests ignored；干净 `99e319f` 的格式、严格 clippy、普通审计和三提交敏感扫描通过，完整映射门禁仍按剩余缺口退出 1。
- Git 富化和 turn 边界的 26 处声明复用现有回归，归一化模块 124 项通过。覆盖五个 namespace 别名、Windows/UNC 路径、失败后继续处理、十八种 Agent 默认生命周期、跨批结束、subagent 隔离、重复抑制与 4097 turn 淘汰。脱敏的另 22 处声明保留全部原预览字符串、参数化场景和内容白名单；条目未变化时增加 `Cow::Borrowed` 与输入地址相同的断言，none 模式检查完整原值；强化后脱敏模块 84 项通过，未修改生产脱敏逻辑。
- 第七轮 dry-run（`94afc33`）六个 Linux/macOS 包成功，Windows 两架构在进程身份探针处失败；ARM64 另有 PowerShell 控制台探针 15 秒超时。单 PID 查询的 5 秒上限现改为 30 秒，保留 `win32-cim-v1` 身份格式和查询失败时的保守锁行为，测试会暴露查询错误；全进程扫描仍为 8 秒。第八轮 `99e319f` 的原生无控制台回归在 Windows 两架构均通过；x64 的身份、进程、锁、归档和同版本激活通过，随后安装编码桥接报 exit=9009；ARM64 的 CIM 身份查询仍在 30 秒超时。两处失败继续处理，旧进程/锁/归档测试暂不删除。
- `e910380` 提交上述 48 条声明映射并清理对应五个旧测试文件，干净提交树 all-features 的 1,382 项回归和普通审计通过。随后定位 x64 安装桥接的 exit=9009：函数内局部 `$LASTEXITCODE` 遮蔽了原生命令更新的全局值。安装辅助入口、Agent 探测及服务入口三处改为显式读写 `$global:LASTEXITCODE`；双 Shell 测试同时覆盖成功、失败和上层同名变量，Windows 结果待实跑。Linux 脚本文本回归及编码专项 12 项通过，原有 5 项跳过保持不变。
- 旧 Node 工具链尚未退役。宿主 JS/Python、有效 E2E 工具和系统脚本测试保留；Windows 卸载的 Python 调用及 Dashboard shortcut 的 Node 包装层待原生替代后清理。

开发机先运行 `npm ci --ignore-scripts`，再生成审计报告：

```bash
cargo run -p xtask -- migration-audit --output target/migration-audit
cargo run -p xtask -- migration-audit --require-complete
```

第二条命令当前预期非零退出，报告保留全部未映射用例。保留测试执行时可添加 `--reporter=./scripts/testing/migration-reporter.mjs`，并设置 `PILOT_MIGRATION_REPORT=target/migration-audit/retained.json`；审计通过 `--retained-report target/migration-audit/retained.json` 读取结果。Node/TypeScript 仅用于开发测试审计，不进入原生运行包。

## 提交批次与验证

1. 文档：README、中英文安装/Trace、项目导航和本文。
2. 原生运行链路：Cargo/lock/toolchain、Rust 生产模块及其内嵌测试、必要 fixture；独立集成测试先留在工作区。
3. 运行脚本与资源：安装、服务、Hook 薄入口及必需资源；不清理尚未承接的历史工具。
4. 发布工具与 CI：Rust 打包/发布校验工具、薄脚本、六平台发布和日常质量工作流。
5. 独立测试：现有 Rust 集成测试与迁移映射分批提交，再按上表补齐旧行为。

推送前检查暂存文件清单、敏感内容、编译必需 `include_str!` / `include_bytes!` 引用及工作区以外依赖；从提交树验证构建和门禁，不能只依赖包含未提交 fixture 的工作区测试结果。提交历史可分批，本轮全部主要批次准备好且严格 clippy 清零后再推送，避免远端收到缺依赖的中间状态。

## 管理员接入与验收记录

需要确认 GitHub-hosted 八种 runner 可用、Actions 权限、`release` Environment 保护以及分支保护检查名。仅工作流代码不能配置仓库管理员设置。正式发布仍需单独批准创建 tag；手动 dry-run 不发布。

已记录的 GitHub 实跑（2026-10-27～28）：

| 提交 | 工作流 / 证据 | 缓存、耗时与任务数 | 结论 |
|---|---|---|---|
| `e2c5002` | [日常 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40482767167) | 冷缓存，3 分 22 秒，1 个任务 | 严格 lint 与 1,284 项单元测试通过；不含后提交的独立集成测试 |
| `7492d43` | [日常 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40486204539) | 缓存命中，2 分 45 秒，1 个任务 | 严格 lint 与 1,366 项 Linux 测试通过 |
| `e2c5002` | [首次发布 dry-run](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40482807142) | 9 个任务 | Linux x64 GNU/musl 成功，其余六平台失败，汇总正确拒绝 |
| `f9aa186` | [日常 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40487786813) | 2 分 21 秒，1 个任务 | 通过；此记录不作为冷缓存证据 |
| `7abac87` | [日常 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40618596606) | 未命中缓存，2 分 49 秒，1 个任务 | 严格 lint 与 1,367 项 Linux 测试通过；日志明确 `No cache found` |
| `f9aa186` | [第二次发布 dry-run](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40487786768) | 9 个任务，失败 | 八平台均越过上一轮编译错误；Linux ARM64 GNU/musl 成功。Linux x64 命中缓存中的旧候选目录，Windows Hook 字节校验失败，macOS 打包报 EPERM；汇总正确拒绝 |
| `7abac87` | [第三次发布 dry-run](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40618597067) | 18 分 56 秒，9 个任务，失败 | 四个 Linux 与两个 macOS 包成功，缓存目录污染和 macOS EPERM 修复已实跑通过；Windows 包/Hook 测试成功，主库测试编译因旧测试无条件使用 Unix 权限 API 失败，汇总正确拒绝 |
| `eb9fcd7` | [日常 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40620736566) | 缓存命中，2 分 03 秒，1 个任务 | 严格 lint 与 1,367 项 Linux 测试通过 |
| `eb9fcd7` | [第四次发布 dry-run](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40620737504) | 17 分 20 秒，9 个任务，失败 | Linux/macOS 六包成功；Windows 两架构已通过测试编译及候选进程回归，但实际包内 `check --json` 失败，汇总正确拒绝 |
| `a0c49cd` | [日常 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40622985965) | 2 分 37 秒，1 个任务，失败 | 严格 lint 通过；Dashboard 测试收到 `ConnectionReset`，主库 1,250 通过、1 失败，未将失败重跑为成功 |
| `a0c49cd` | [第五次发布 dry-run](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40622987158) | 12 分 58 秒，9 个任务 | 八平台包与汇总首次全部通过；Windows 原生配置路径修复已实跑验证 |
| `2d56ecd` | [日常 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40624833561) | 缓存命中，2 分 04 秒，1 个任务 | 严格 lint 与 1,369 项 Linux 测试通过，包含 Dashboard 修复 |
| `2d56ecd` | [第六次发布 dry-run](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40624834661) | 15 分 08 秒，9 个任务 | 最终代码的八平台包、原生预检与汇总全部通过；资产下载后 SHA-256 复核通过 |
| `c21753f` | [首批历史测试清理 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40649531061) | 2 分 51 秒，1 个任务 | 18 文件删除后严格 lint 与 Rust 全量回归通过；不含后续进程/归档补测 |
| `94afc33` | [进程与单实例锁 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40654259716) | 2 分 46 秒，1 个任务 | 严格 lint 与 1,382 项 Linux 回归通过 |
| `94afc33` | [第七次发布 dry-run](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40654728105) | 9 个任务，失败 | Linux/macOS 六包成功；Windows x64/ARM64 启动身份探针返回空值，ARM64 控制台探针超时，后续锁/归档回归未执行；汇总正确拒绝 |
| `99e319f` | [归一化清理与 Windows 修订 CI](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40658224629) | ci-gate 2 分 12 秒，1 个任务 | 通过；不包含此后新增的 Git 富化、turn 边界和脱敏映射 |

修复链路：候选输出移出 Cargo 缓存，脚本通过 Git 属性固定 LF；macOS 仅在 libproc 确认组内没有活进程时处理 XNU 的僵尸组 EPERM，查询不完整或真正权限失败仍报错。`6217343` 限定 Unix 专属权限测试，保留平台无关断言。`a0c49cd` 将内置配置路径改为原生 `Path::join`，避免 Windows `\\?\` 路径混入 `/`；同时保留有界 stdout/stderr 失败诊断，防止丢失 `check --json` 的错误报告。

`2d56ecd` 修复 Dashboard 将一次 TCP `read()` 当成完整请求的问题：累计读取至请求头结束，保留 8 KiB 大小上限和共享两秒总时限；新增分段、EOF、超限及超时断言，包含新增回归的四项 Dashboard 测试本地重复 30 轮通过。该提交的默认/all-features 严格 clippy、本地及干净提交树 1,369 项 all-features 回归均已通过，未跳过失败用例或降低门禁。

第六轮的非 Linux 实跑范围：每个 Windows 架构通过包测试 6 项、Hook 测试 2 项、候选进程测试 6 项及配置路径测试 1 项；每个 macOS 架构通过包测试 6 项、Hook 测试 2 项、候选进程测试 5 项、配置路径测试 1 项及 Swift 测试 28 项。上述项目包含测试 fixture 入口，不等同于同等数量的独立业务场景。每包还执行真实归档解包后的 `--version`、`probe --build-edition`、`check --json`。完整服务/worker 生命周期、真实 Agent、GUI 与系统签名仍未验收。

## 历史 1.2.0 八平台候选证明

来源为第六轮的 [release-assets](https://github.com/Takuka0311/loongsuite-pilot/actions/runs/40624834661/artifacts/12789945421)，保留期 90 天。已下载并回读 `release-summary.json`、`latest-rust.json`、`SHA256SUMS`，全部 12 个被校验文件均通过 SHA-256 复核。

- 版本 `1.2.0`，提交 `2d56ecd15ea907b16ff93ca1a1549b05ee247d11`，八包均为 `opensource`、`dirty=false`、`preflight.ok=true`，包内 `gitCommit` 一致。
- `release-summary.json` 的 SHA-256：`17d663cdf44e0993587921b7acfe277b1eab5f494cf9a80b5db4f5f03c1b27b9`。
- 摘要仍明确 `gate=build-and-package-preflight`、`agentInjection=deferred`、`platformLifecycle=not-verified`。

下表归档名统一为 `loongsuite-pilot-1.2.0-<target>`，Windows 后缀为 `.zip`，其他平台为 `.tar.gz`。

| target | 归档 SHA-256 |
|---|---|
| `aarch64-apple-darwin` | `65e54ab6e495c4aea3ce7b8d4d4c1338e5178912fe0a4168693d24578445a5bc` |
| `aarch64-pc-windows-msvc` | `0c9c8bb2dd598d87b1e25235d025db8336225090004394e392c86c0ba5a3bf25` |
| `aarch64-unknown-linux-gnu` | `49e5620b7fb154b64ff5b9bfc0d49442dac111c578cfaaa5e7ec5cae61e18200` |
| `aarch64-unknown-linux-musl` | `632148966da52f01fb809f9cbb1a43fdf5f70a3e0c254bccf76b174f6e2a73dd` |
| `x86_64-apple-darwin` | `83a63243c34ceb54e96c85d7ef8375513b81160d669ad35e358870fcf8ce8f27` |
| `x86_64-pc-windows-msvc` | `d6eeef50b1b9dd12ddf791e991c7ae979d119be9561bb5b0a6b53f198ad85e54` |
| `x86_64-unknown-linux-gnu` | `cd39025c9eacdc93256b39aa0ccaa836000d49ec4af44645751f0cbe42152570` |
| `x86_64-unknown-linux-musl` | `2b81e28f314b504d2e0dbd2a45a66c211a2ff2cdb5650e6b62be55fb73d5ca71` |

这些是 dry-run 候选，不是正式发行。`latest-rust.json` 中的 Release 下载地址仅为预生成地址，未上传为更新渠道；没有创建 tag 或正式 Release。后续仅补充本文的提交不改变上述候选的生产代码，发行候选 SHA 仍以上述完整提交为准。历史测试映射与旧工具清理的后续进展见上文，新增清理代码需要重新验证，不沿用本次候选的通过结果。

## 2026-10-29 Windows 发布修复（进行中）

当前基线 `668628e` 的日常 CI 通过，发布 dry-run `40665947674` 的六个 Linux/macOS 包成功；Windows ARM64 的 CIM 启动身份查询和 x64 的安装桥接测试均超时。

单 PID 命令读取同时改用 sysinfo 原生进程信息，避免身份修复后在命令匹配处再次进入 CIM。Windows 启动身份改为直接读取 `GetProcessTimes` 的创建 FILETIME，不再为身份查询启动 PowerShell/WMI。新 token 使用 `win32-filetime-v1`，旧 `win32-cim-v1` 与新格式之间不直接判为 PID 复用；旧锁持有 PID 仍存活时保持锁，待其正常退出后接任。同格式继续精确比较，权限失败仍保守处理。安装桥接专项补充受控阶段名，超时只报告阶段，不输出输入 JSON、环境或凭据。

本批第一次全 feature 全量回归 1,383 项通过，另有 2 个原有 doc-tests ignored；随后单 PID 原生命令读取补丁通过严格 clippy，pid-utils 12 项及单实例锁 14 项专项通过。当前提交树的 GitHub 全量回归及 Windows 实跑结果随工作流追加。已有工作区的 E2E 修改、四个历史测试删除和 Python 缓存未纳入本批。未创建正式 tag 或 Release。

\n首轮修复提交为 34a7066，日常 CI 40805082691 已通过。发布 dry-run 40805083175 中 Windows 两架构均已越过进程身份、命令匹配、锁、归档和同版本激活回归；两者仍在安装桥接处超时，第一版依赖 Set-Content 的阶段文件未生成。后续将阶段记录改为核心输出命令，超时仅提取受控阶段名，并保留 ComSpec、ProgramFiles 和 PATHEXT 等系统启动环境；PATH、HOME、用户配置与运行时仍隔离，Windows 结果待下一轮实跑。

\n### 原生 Dashboard 快捷方式与配置合同\n
快捷方式的参数、配置、图标摘要、响应输出、有界进程树及超时锁清理由 Rust CLI 承接，JXA 系统桥接内嵌于二进制；Shell 入口只转发原生 dashboard shortcut 子命令。status/uninstall 不读取配置内容或图标，非 macOS 在读取配置前拒绝。修复 collector 将 1.5 端口截为 1 的历史迁移差异，三处入口统一按整数 1–65535 校验，并与真实配置组装器交叉测试。\n
Linux all-features 全量 1,392 项通过，另有 2 个原有 doc-tests ignored；严格 clippy、Shell 语法和普通映射审计通过。快捷方式命令的 11 处历史声明已逐项登记，审计为 37 个完整文件、23 个部分文件、331 个未映射文件；Rust 348、退役 7、未登记 4,339，另有 2 条部分覆盖。JXA 策略及真实 macOS adapter 测试仍保留原语言，尚未登记，不沿用为本批平台通过证据。新原生专项加入既有发布任务，不增加 runner；macOS/Windows 实跑待记录。\n
继续扫描卸载的实际调用链发现 Unix 安装器也仍有活跃 Node 清理函数，DSH 分支甚至在未部署 DSH 时先解析 Node。后续卸载迁移应覆盖两端全部清理调用，不能只替换 Windows 的 Python helper。\n
\n第二轮发布 40806841286 仍在 Windows PowerShell 5.1 执行首条脚本前超时（stage=shell-startup），两架构的原生进程/锁回归均通过。对照已有 CREATE_NO_WINDOW 进程探针可正常启动 PowerShell，而安装夹具未设置该标志；本轮使隔离安装命令明确不创建控制台，避免无人值守的控制台/终端启动路径，保持原 30 秒上界和双 Shell / CLM 断言。实际结果待下一轮验证。\n
JXA 策略的 13 处声明已登记为 retained，实际 Linux Vitest 参数展开 20 项通过，命令为 npm run test:host:shortcut。带保留报告的审计现为 38 个完整文件、23 个部分文件、330 个未映射文件；Rust 348、原语言保留 13、退役 7、未登记 4,326，另有 2 条部分覆盖。审计需传 --retained-report target/migration-audit/shortcut-host-linux.json，缺少报告时保留项继续标为未收集；不会把原语言保留项计作 Rust 迁移。\n
### 2026-10-29 PowerShell 原生 Hook 输入交接

提交 b155c5f 的发布 dry-run 40865140200 中，四个 Linux 与两个 macOS 包成功；Windows 两架构的 Qoder 身份回归通过，随后原生 Hook 在 20 秒上界内未退出。共享 PowerShell 入口改为 Start-Process -NoNewWindow 继承原始标准句柄，避免 PowerShell 管道接管 stdin 与 UTF-8 输出；显式等待主进程，不等待后台重试子进程。Windows 参数按原生 argv 规则逐项转义。失败仍保留原有 fail-open 响应。

新增 Windows PowerShell 5.1 / PowerShell 7、FullLanguage / ConstrainedLanguage 的 BOM、Unicode、空参数、引号及尾部反斜杠回归。测试进程通过现有进程组/Job 管理，超时会清理整个测试进程树并报告 Shell 和语言模式。Linux 默认 1,460 项、all-features 1,462 项通过，严格 clippy 通过，另有两个原有 doc-tests ignored；新增 Windows 行为仍须实跑验证。本轮不延长 20 秒上界，也不跳过失败用例；更后面的 Windows DSH 回归尚未运行，不计作已修复。

2026-10-29 的 d2d9fa4 dry-run 40869976740 中，Windows 两架构仍在首次 PowerShell 5.1 FullLanguage 调用超时，两个独立 Hook 用例都没有 stdout/stderr。进一步发现候选进程管理器强制 CREATE_SUSPENDED 时没有带 CREATE_NO_WINDOW，覆盖了无控制台启动要求；已将两者同时设置，保留执行前加入 Job 和整棵进程树清理。新增独立 PowerShell 首条指令探针，使用相同的隔离环境和原 20 秒界限，使后续 Hook 故障能与 Shell 启动故障区分。Linux 默认 1,473 项、all-features 1,475 项以及严格 clippy 已通过；Windows 启动修订仍待新一轮实跑，不将本轮失败计作通过。

d2d9fa4 本地 proprietary 候选已通过原生安装器替换远端安装，业务配置 mtime 保持不变。新进程 PID 104046 在 12:04:44Z 获接收端接受 pilot_pipeline 批次，本地指标持续刷新，Dashboard 返回 HTTP 200；仍未直接验证 SLS 索引可见性。

### 2026-10-30 Windows 系统启动环境跟进

62e874d 的 dry-run 40872545795 通过四个 Linux 与两个 macOS 包；Windows 两架构的新独立探针均在 PowerShell 5.1 首条指令之前超时，说明单加无控制台标志不足以解决启动。候选进程和 Hook 测试夹具现保留与已通过安装夹具一致的 Windows 系统启动变量：TEMP/TMP、ComSpec、ProgramFiles 系列及 PATHEXT；HOME、USERPROFILE、配置与隐藏运行时的 PATH 继续隔离。未继承完整用户环境、认证变量或 Agent 设置，也没有延长 20 秒上限。这个环境修订仍待 Windows 实跑确认。

修订后 Linux 候选进程 5 项、Hook 入口 4 项，以及默认/私有构建各 1 项原生 Codex→指标镜像/HTTP 链路通过；fmt 与严格 clippy 通过。本批只调整测试夹具的系统启动环境，前一批默认 1,473 / all-features 1,475 的全量记录保留，不将 Linux 验证替代 Windows 结果。

后续实跑 40987515113 的 Windows x64 独立探针仍超时，系统环境修订不足以解释问题。更正前述定位范围：候选 output 工具在超时时丢弃部分输出，因此该探针的超时本身不能证明首条指令未执行。新增同环境、同脚本、同 20 秒上限的直接进程与 Job 候选对照，两条路径都执行后再汇总结果；用独立测试目录中的固定阶段标记区分脚本进入与执行完成，日志只输出受控阶段和固定脚本结果。对照覆盖独立 APPDATA/LOCALAPPDATA 与工作目录，保持隐藏运行时的 PATH；不会继承完整用户环境或输出认证变量。

这批只补充 Windows 诊断测试，生产进程管理行为保持 d776a4e 的实现。Linux 现有候选进程 5 项、fmt 和严格 clippy 通过；Windows 原失败继续保留，待对照结果定位后修复。

### 2026-10-30 Codex 标准事件兼容基础

main fd27d45（#487）的标准事件边界先独立迁入 Rust：保留六种 gen_ai.* 事件名及已有 extra 映射中的父身份、对端、出入站 invocation 字段。只在 Trace 转换的副本上适配四个模型/工具旧名；同 ID 去重，跨别名的语义副本忽略观测时间并递归规范对象键，内容不同的流式片段和同名独立记录保留。审计 invoke/result 不创建或关闭 OTLP 缓冲，也不抢占规范化工作轮次的开始/结束标记；原始日志保持不变。本地 Dashboard 计数支持标准模型/工具名。

默认 1,480 项、all-features 1,482 项全量通过，另有两个原有 doc-tests ignored；随后新增审计轮次边界用例，默认/私有构建的该模块 17 项均通过，最终严格 clippy 通过。新增测试包括标准字段往返、嵌套语义别名去重、真实原生 Span/token 转换、实际 OTLP 缓冲入口和磁盘 JSONL→Dashboard。这里只完成 #487 的事件兼容基础；子工作身份、incoming/outgoing 关联、journal、checkpoint 与输出确认尚未迁入，不将该上游提交计作全部完成。

40988431171 的 Windows x64/ARM64 对照均得到相同结果：直接进程与 Job 候选都留下 entered 标记，未留下 script-complete，停在固定 Write-Output 调用一段。这个结果排除了 Job 绑定是该超时的必要条件，也纠正了“Shell 未执行首条指令”的推断。下一轮夹具显式提供所选 PowerShell 安装目录下的 Modules 路径，检查内建命令自动发现；不继承调用者完整 PSModulePath，HOME 和隐藏运行时的 PATH 仍隔离。位置按 [Microsoft 的模块路径说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-5.1) 选择，尚不据此断言根因或修复完成。两个启动路径的阶段与成功断言均保留，每条路径仍为 20 秒。

Linux Hook 4 项、候选进程 5 项、fmt 与严格 clippy 已通过；Windows 新模块路径夹具的结果待记录。本批无生产实现变化。

41b3253 的 dry-run 40990254408 中，显式模块目录仍得到 entered 后超时，尚无修复证据。新增开发用 Windows Shell Diagnostics（x64/ARM64 两个任务），通过 Python 标准库直接运行固定 PowerShell 脚本，对照继承环境、隔离环境和显式模块目录，以及 Console、捕获 cmdlet、字面量和普通输出管道。每例诊断预算为 5 秒，记录退出码、固定阶段、输出长度和 sentinel 布尔值，不记录环境值、子进程正文或 stderr。任一用例超出诊断预算或断言失败，流程仍返回失败；不是发布门禁，也不改变原生用例的 20 秒上限和成功要求。Python 只用于开发诊断，不进入安装运行包。无需等待 Rust 编译或打包即可读取阶段证据。

日常 CI 与八平台发布门禁保持原有检查。该诊断流程仅手动运行或这两份诊断文件在 Rust 分支变化时运行，单次两个 runner 任务；不创建 tag 或 Release。脚本语法、fmt 和严格 clippy 已检查，Windows 对照结果待记录。

### 2026-10-30 执行顺序调整与 Codex 功能批次

按用户要求，先推进剩余功能、运行入口和测试迁移，再集中修复已知行为及跨平台问题；暂停逐个问题触发八平台发布 dry-run。保留严格 lint 门禁和已有失败证据，正式发布仍关闭。每次实际构建开发安装包后，继续替换 xuanyang-dev-inner 的安装态并验证，不能以未验证的功能批次冒充可发布候选。

本批接入 Codex 按 user/session/native turn 分组的持久化 journal、增量尾部修复、惰性恢复、独立 ACK 和有界清理；checkpoint 在输出接收确认前等待，失败或取消冻结磁盘进度。HTTP 对 Codex 等待真实接收并有界取消，SLS 等待所有输出端结果，OTLP 在所有服务及端点接收完整原生 turn 后 ACK，未完成 turn 的内存淘汰保留 journal。其他 Agent 继续使用原有缓冲策略。

子任务保留自己的 session/turn，以独立生命周期输出，父任务终止不再合成子任务终止。派工扩展到 spawn/followup/input 和批量位置；保存 invocation、明确的原生输入绑定、工作及精确结果摘要，恢复状态不保存任务或结果正文。派工/收到结果产生标准 Agent 审计事件；模型/工具标准副本仅在 trace 转换边界去重。Codex 专用转换器按具体操作计算工作属性，外部上下文一致时去除虚拟 ENTRY，保留原始审计上下文。

当前功能批次的 fmt、全 workspace/all-targets/all-features 严格 clippy 通过；all-features 下 Codex 相关 47 项与 StateStore 25 项通过（有交叠之外的原有测试，不相加为全量数量）。本批尚不将 main fd27d45 标为完成：端到端输出取消/恢复、独立子任务生命周期、验证脚本与历史用例映射仍需补齐和集中验收。没有据此创建 tag、Release 或声称 Windows 已通过。

集中验收保留的问题包括：Windows PowerShell 在 entered 后的管道阶段超时、Windows ARM64 DSH 竞争用例超时，以及这轮功能推进中新增的失败。Shell 快速诊断流程已准备，其结果不能替代八平台发布门禁。Copilot CLI、来源索引/磁盘治理、依赖安全同步和剩余历史测试迁移继续排在功能阶段。

本批提交前另执行 all-features 库级回归：1,352 项通过，0 失败、0 忽略；它不含独立集成测试、xtask、doc-tests 或 Windows/macOS 实跑，不能替代最终全 workspace/八平台验收。

### 2026-10-30 main #504 依赖同步

同步 main 8993a4d 的开发依赖约束、完整锁文件及 overrides，移除直接 uuid/zod/@types/uuid；保留 Rust 分支的 2.0.0 版本和宿主测试脚本。历史 fixture 改用 node:crypto.randomUUID，契约辅助校验采用 main 的独立实现，覆盖新标准事件名，不再依赖 zod。这些是开发/历史测试依赖，原生运行包不依赖 Node/npm。Rust 随机事件 ID 已使用 uuid crate，agent.input 的 SHA-1 UUID v5 实现及 RFC DNS 黄金向量原有测试继续保留；没有重新加入 TS 生产模块。

清单和锁文件根依赖逐项一致性检查通过；不据此宣称历史 TS 测试可直接运行，也不宣称完成新的全依赖漏洞扫描。main #504 的改动已承接，旧基线的 Qoder IDE 等其他迁移缺口仍由历史测试映射清单跟踪。

### 2026-10-30 Copilot 原生功能批次

迁入 main #430 的 Copilot 插件部署、原生 hook 发现入口和 collector，以及 #517 的来源索引、首次启用时间边界和原生时钟偏移恢复。插件设置采用 JSONC 局部编辑和内容对比写入；先记录绝对清理目标，保留其他插件注册与用户 shell 内容，已托管资产可修复。Unix 自动部署，Windows 自动部署继续显式禁用；原生 thin hook 不依赖 Node。新增脚本已通过 xtask 生成一致性检查。

采集以 interaction 为交付单位，使用原生模型调用 ID 关联 OTel 与 transcript；原生 Token 和时间来自匹配的 span，缺失时不补造。SQLite 独立保存读取位置和交付账本，分块保存未结束的长行；未能关联的早期原生证据仅保存字节定位，用户消息授权后重读恢复。首次启用边界在独立文件和 SQLite 中交叉校验，重启及索引恢复不擅自推进边界。当前 collector 使用轮询兜底；唤醒延迟、旧安装兼容和更完整的历史用例对照仍纳入最终集中验收。

OTLP 对 Copilot 重放事件按 ID 合并缺失字段，已有非空信息优先；hybrid-v2 只由交互边界收尾，会话 summary 仅写日志，取消会反映到 Agent 状态。15 项 Copilot 定向测试通过，覆盖实际 Input 生命周期、重启去重、原生用量关联、增量输入、部署修复、畸形记录、10 MiB 未结束行跨重启续读、事务失败回滚及跨时间边界的原生恢复。最终 fmt、全 workspace/all-targets/all-features 严格 clippy 与 1,367 项 all-features 库级回归通过；不包含独立集成测试或 Windows/macOS 新版本实跑。

尚不据此宣布 main 全部同步或迁移完成：#517 的 JSONL 分片、磁盘压力治理、Dashboard 文件身份竞态和 Codex 发现缓存竞态仍在下一批；#487 的端到端输出取消/恢复和验证规则迁移也仍需补齐。真实 Copilot 注入、跨平台回归与统一历史测试映射保持待验收状态。

### 2026-10-30 JSONL、磁盘治理与扫描缓存

原生 JSONL 和 OTLP 本地镜像统一按完整记录追加和分段，默认单片 100 MiB；写入、封片和删除共享每文件锁，保留超大片完整记录并告警。磁盘压力每分钟巡检，严格超过 3 GiB 的自有输出/失败文件可紧急回收，告警区分未发送数据；总输出上限允许回收当天已封片，保护活动文件和 Agent 原始数据。读写拒绝符号链接，Dashboard 在实际打开句柄上校验文件身份，跳过超大文件并保留已观察统计，覆盖轮转、删除、重名复用和重启。

Codex 默认目录扫描在读取前记录纳秒级目录代次，仅完整遍历可更新缓存，修复扫描期间发布文件和失败子目录被缓存的问题。Copilot 来源索引与 Dashboard 共用打开文件的身份实现，Windows 使用稳定的系统 API。fmt、全 workspace/all-targets/all-features 严格 Clippy 和 1,378 项 all-features 库测试通过，包含并发完整记录、Unix 稀疏文件压力、统计保留和扫描竞态用例；Windows/macOS 新行为及全 workspace 集成验收仍待最终阶段。不创建正式发布。

### 2026-10-30 原生标准事件与子任务校验入口

原生 validate-jsonl 接受六种标准事件，按别名统一配对但保留原始事件名和输入字节，拒绝同一操作的重复别名事实；Agent 审计必须携带 invocation。field-coverage 汇总四个模型/工具别名并加入 invoke/result 覆盖率。validate-trace 接受 TOOL 下的独立 AGENT，以及带有效非零外部父 ID 和明确派工证据的片段；身份、Token、步骤顺序和末步校验按 AGENT 执行边界隔离，外部片段继续告警，孤立节点和错误身份仍失败。规则生成升级 1.1，并纳入上游公开模型与默认规则。

核对上游构建器后移除 Codex 自动生成模型/工具标准副本的误差：每个原生操作只输出一次，仍保留标准事件输入兼容和独立 Agent 审计。新增 Copilot 注入验收场景，八平台基础组合增至 168，不凭模拟报告认定真实平台通过。

最终严格 Clippy 通过；all-features 库级 1,379 项、xtask 单元 45 项和原生 CLI 四套 30 项通过。扩大检查时发现的旧枚举拒绝断言、规则数量及 Copilot 清单缺项已按新合同更新，不跳过失败检查。端到端采集输出恢复和八平台真实验收继续执行，未正式发布。

### 2026-10-30 并行迁移：Copilot 运行与历史策略

用户明确授权并行 Agent 后，按独立模块开发，所有 Cargo 检查由主 Agent 串行执行。Copilot 原生 Hook 的原子唤醒标记现在触发快速采集：Linux 使用 inotify，其他平台保留目录代次轮询；停止和 Drop 都终止监听，重启重新建立监听。旧 main 安装只有在 manifest、完整固定资产及注册根都匹配时才接管；未知目录、资产缺失或符号链接不冒认所有权。

20 项运行/部署专项与 19 项 main #517 历史策略测试通过：真实时间启用边界、重启和索引重建、迟到原生定位恢复、跨交互隔离、8 traces / 256 locators 公平性及有界旧正文回收。静态严格 Clippy 通过；没有把局部专项当作全 workspace 或八平台验收。用户配置、业务数据和安装态未被测试读取或修改。

已补更多原生采集到输出集成测试：OTLP journal 重放与全部端点 ACK、当前隐私回调、未完成轮次淘汰，以及三种真实 SLS 认证路径的挂起请求/响应体取消。通过项与未修项分别记录；SLS 成功慢正文、初始零偏移来源恢复、非法排除配置、旧 JSONC 清理语义和 Windows 失败在集中阶段处理。未正式发布。

### 2026-10-30 原生回归与集中修复清单

先补功能与测试，再集中修复。原生 Codex 生命周期 6 项、真实 OTLP journal 3 项、SLS 三模式取消 6 项通过；HTTP 恢复/去重及发现启动背压 2 项通过。HTTP 初始零偏移且无来源元数据的重启恢复、SLS 成功但正文不结束各保留 1 项失败。测试仅用临时目录和 loopback；受控 TraceExporter 的生命周期结果不作为真实网络导出证据。

新增核心准入、拦截关联、工作区隐私、发现并发停止、InputManager 脱敏/身份/队列/多输出及配置的逐断言回归；历史映射同时核对固定源码摘要和唯一原生入口，部分覆盖保持 partial。扩大后的 all-features 库测试为 1,506 通过 / 9 失败 / 0 忽略，严格 Clippy 通过。保留的失败为非法排除配置、serviceName 与 mask preview 兼容、managed 多模态 BOM/诊断、Codex 稀疏事实合并/旧正文摘要迁移/重复结果摘要，以及 Copilot 缺少每步骤端点导致原始事件数量差异。不是合格发布候选。

新增 Copilot 压力测试保留原 60/180 秒和 1/100 MiB 界限，64 并发生产者完整记录、1024 条旧历史排除、原生64步骤Token及128个32MiB稀疏封片与三类严格超过3GiB文件回收通过；128/256/512重放数量断言仍失败，不能放宽成观察值。新库断言的通过数量不等于历史声明数，也不能替代八平台验证。

原生 SpanEnricher 尚拒绝旧有效脚本配置，是运行能力缺口，正在补原生嵌入式加载；不能用原生拒绝断言将其退役。Windows PowerShell、ARM64 DSH、JSONC清理与来源首次恢复保持集中验收条目。正式发布仍关闭；本批未生成新安装包，远端已安装开发版本未被这批测试变更覆盖。


## 2026-11-03 当前平台范围

按用户明确要求，当前发行、安装、原生包格式校验、更新清单和注入报告门禁统一为六个平台：Linux x64/ARM64 GNU libc、macOS Intel/Apple Silicon、Windows x64/ARM64 MSVC。移除 musl 构建器、产物允许项与未被原生安装流程调用的 managed Node 下载回退；原生运行和卸载清理不因此增加 Node 依赖。旧 managed-node 测试中只针对 provisioning/musl fallback 的合同随产品能力退出，保留不可变历史来源用于审计；不把它们冒充 Rust 迁移通过。

上文八平台实跑记录与摘要属于既往提交证据，保留原文；它们不是当前六平台的新验收结果。保留 GNU libc 2.34 验证环境和 libc 依赖，不降低工具链或其他依赖版本。本次不创建 tag 或正式 Release。
