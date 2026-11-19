# 变更记录

版本遵循 semver。`1.0.0-rc.1` 起配置字段名冻结；`1.0.0` 起为正式版，新增字段只增不改名。

## 1.14.1 — 2026-11-19

宿主 DSH 桌面版从 `0.2.2-rc.3` 升到 `0.2.2-rc.5`，本包原先只钉 rc.3，导致 `plugin_version_mismatch` 在新宿主上恒成立：`balanced` 报 WARN 尚可，**`hardened` 会因加载门拒载**（该 code 在 `hardened.posture.failOn` 里）。本版只做兼容收口，不动任何检测语义。

- **版本门改为"钉住 + 曾验证"两表**：`PINNED_VERSIONS` 升到 `0.2.2-rc.5`（本轮在真实桌面 host 上实测：8/8 接缝可用、judge 路由可用、账本可写），新增 `PREVIOUSLY_VERIFIED_VERSIONS` 记 `0.2.2-rc.3`（1.14.0 的实测宿主），两表内版本均通过；表外版本仍按 WARN（balanced）/ FAIL（hardened）处理，拒绝理由里直接列出可接受的版本。旧宿主用户不因升级插件而失去 hardened。
- **只加不删**：删表项等于宣布不再支持该宿主，属于破坏性变更，需单独发版说明。
- **测试**：新增 `tests/host-versions.test.ts`（4 条：钉住宿主 hardened 可载、rc.3 hardened 仍可载、未实测 rc.4 hardened 拒载且不留任何接缝、未实测 rc.4 balanced 只 WARN 且消息里列出两个可接受版本）；测试 53 文件 / 847 用例。
- **文档**：README/MANUAL 的宿主行改成 `0.2.2-rc.5`（兼容 rc.3），MANUAL §11 第 1/2/10 条重写为"粗门 engines + 细门版本表"两门语义；安装/打包示例改用 `<ver>` 占位，避免每版腐化。

## 1.14.0 — 2026-11-18

规则目录的**快照与一键回滚**（P2 最后一项）：内核把规则版本存在数据库里（保留 10 版），插件没有库，用"目录快照"给出等价能力。

- **写入前自动快照**：`rules.dir` 每次经面板「写入并重载」前，整个规则目录（顶层 `.yaml`/`.yml`）连同 `manifest.json`（每个文件的 sha256）复制到 `$DSH_HOME/safeharness/rules-writes/history/<id>/`。最多保留 **10** 份，超出按时间淘汰。快照失败只记 `warn` + 账本，**不阻断**已经通过 loader 的写入。
- **一键回滚**：面板「规则 → 快照与回滚」列出历史（时间、文件数、大小、类型、是否当前状态），回滚两步确认。Host 端流程是：校验 id → 校验每份文件 sha256（不符即 `snapshot_corrupt` 语义的拒绝）→ **在临时目录里跑真实 loader**（打包规则 + inline 一起参与）→ 通过后才动磁盘 → 先把**当前**状态拍一份 `pre-rollback` 快照（所以回滚也能反悔）→ 原子写回快照文件、删掉快照里没有的规则文件 → 热重载。
- **边界**：只动 `rules.dir` 顶层的 `.yaml`/`.yml`（脚本、笔记等其它文件不碰）；`rules.dir` 为空/相对/指进包内或历史目录时拒绝；单份快照最多 64 个文件、单文件 256 KiB，超限跳过并告警；回滚失败（编不过/文件校验失败）**一个字节都不写**。
- **账本**：写入记 `rules_written`（新增 `labels.snapshot`），回滚记 `rules_written` + `labels.mode=rollback`/`snapshot`/`pre_rollback`，重载失败另记 `invariant_probe`。
- **协议/面板**：`write-rule` 端点新增 `op: history | rollback`（同一道 loopback + Origin 栅栏、同一 16 KiB 体积上限、同样 POST-only）；`PanelFace` 新增 `ruleHistory()` / `rollbackRule(id)`；规则页新增「快照与回滚」卡片。
- **测试**：新增 `tests/rules-history.test.ts`（13 条：捕获/去重 id/淘汰/激活态、回滚恢复与清理、反向回滚、损坏快照拒绝、编不过拒绝且不落盘、非法句柄、重载失败、写入前快照集成、跳过快照不阻断写入）＋路由 5 条；52 文件 / 843 用例。

## 1.13.0 — 2026-11-18

面板阶段二余项 + 阶段三只读视图 + 档位对照（P2 第 7 项）。

- **列表编辑器（阶段二）**：设置页新增「列表与匹配」卡片——`tools.denyTools` / `askTools` / `allowOnce` / `denyTags`（每行一个，glob 只认 `*`）、`tools.tagOverrides`（每行 `pattern: tag1, tag2`，`#` 注释）、`approval.allowOnce`、`results.blockOn`（凭据/注入/PII 三个类别勾选，这是 1.12.0 PII 拦截缺的最后一块拼图）、`rules.dir` / `rules.watch`、`patrol.windowMinutes` / `factor` / `minCount`。
- **写前校验**：glob 必须单行且有界（≤200 字符、≤200 条），标签只接受标识符（`[A-Za-z0-9_.:-]`），`blockOn` 只接受三个已知类别，`tagOverrides` 每条至少一个标签，目录必须单行，数值有下限（窗口 ≥1 分钟、倍数 ≥1、最少拒绝数 ≥0）。任何一条不合法 → 整个保存被拒，一个字节都不写。
- **合并语义**：`tools` / `results` / `approval` / `rules` / `patrol` 各自成对象，和同一面的 `mode` 一次保存不会互相覆盖；列表按**无序**比较，仅调整行序不会触发保存或重载。
- **只读视图（阶段三）**：新增「只读配置」卡片——输入引擎（kind/command）、规则来源（内联条数 + 文件份数）、账本（format/目录/轮转/写入失败语义）、加载闸门（`posture.failOn`）、巡检通知（**仅通道类型与数量**，webhook / token 永不回显）+ profile patch 路径复制。这些值只能在 patch 里改，面板明说。
- **档位对照（P2 第 7 项）**：MANUAL §5 增加内核 `demo / hardened / production` ↔ 插件 `observe / balanced / hardened` 的意图映射表，写清"三对三但 env 项不是一对一"（网关/健康探针/记忆守卫属内核服务端，插件不移植）。
- **协议**：`PanelSettingsValue` 新增 `lists` / `source` / `facts`，`PanelSettingsPatch` 新增 `lists` / `source`；旧面板缺字段时按服务端返回渲染，草稿兼容 1.12.0 及更早（缺失字段回落到加载值）。
- **测试**：新增 4 条（列表写入、source/patrol 写入、非法值拒绝、只读事实回读且不含凭据）；51 文件 / 825 用例。

## 1.12.0 — 2026-11-18

检测面与 SafeHarness 内核对齐（P1）：**SQL 表白名单、工具描述符注入扫描、轨迹阈值、PII 10 类**，并把四组开关接到面板。

- **SQL 表白名单（`tools.sql.allowedTables`，空 = 不限制）**：移植内核 `SqlGuardPolicy` 的 `allowed_tables`。非空时，被扫描的 SQL 参数里每个表引用都要命中白名单（`public.users` 也按裸表名 `users` 匹配），否则以 `unauthorized_sql_table` 拒绝；破坏性语句仍先按危险 SQL 拒绝（`tool_denied_by_args`）。只作用于 `tools.sqlScan` 认定的可执行工具。
- **工具描述符扫描（`tools.descriptorScan`: `off` / `warn` / `enforce`，默认 `warn`）**：移植内核 `mcp_guard` 的描述符部分——用注入规则扫工具**自己的 name/description**（最多 8 KiB）。`warn` 只记一次 `tool_descriptor_flagged`（每会话每工具一次，避免刷账本），`enforce` 每次调用都拒（`tool_descriptor_injection`）。宿主没有「从模型工具表里移除工具」的接缝，所以强制是**逐次拒绝**而不是下架，已写进 MANUAL §4.10。
- **轨迹阈值（`tools.repeatedAttemptThreshold` / `tools.entropyThreshold` / `tools.entropyMinLength`，默认 0 = 关）**：移植内核 `trajectory.py` 的两个 0 即关闭的阈值。同一工具连续失败达到阈值即拒（`tool_repeated_attempts`，成功清零）；字符串参数长度 ≥ 最短长度且 Shannon 熵 ≥ 阈值即拒（`tool_high_entropy_payload`，只记 index/长度/熵值，不记内容）。
- **PII 10 类（`results.pii` 默认开，`results.piiClasses` 默认全类）**：把内核 `memory/sanitizer.py` 的十条正则搬进工具结果面，类别名与内核逐条一致（`id_card` / `phone_cn` / `email` / `bank_card` / `api_key` / `jwt` / `doc_no` / `gov_serial` / `customer_id` / `internal_url`），产出 `pii` 类别事件（`rule_ids` = 类别名）。默认只告警：要拦截需把 `pii` 加进 `results.blockOn`（该类别已进白名单校验）。不返回命中文本；邮箱/内网地址两条正则加了长度上界，否则 256 KiB 结果上的回溯是二次的（实测单次扫描 111 s）。
- **面板**：设置页新增「工具与结果检测」卡片——描述符三档、两个阈值与最短长度、SQL 白名单文本域（每行一个，非热更新：保存会重载插件）、PII 总开关 + 10 个类别勾选。新增 `toolDetection` / `pii` 读写字段，仍走 `POST /safeharness/settings` 的 `op: save`（revision CAS、逐字段覆盖；`tools` / `results` 各自合并，不与同一面的 `mode` 互相覆盖）。审计只记 `tool_detection: changed` / `pii: changed`。
- **差异（与内核）**：① 内核在 `list_tools` 时扫描描述符并可下架工具，插件在工具调用前扫描、且每个会话只告警一次；② 内核对 SQL 白名单在内容面也算，插件只在工具参数面算（内容面仍只拦破坏性语句，避免讨论 SQL 的良性文本被拒）；③ PII 在内核是记忆写入的脱敏/拒绝，插件没有记忆库，落在工具结果面且默认不拦截。
- **测试**：新增 4 个文件 / 50 条（PII 20、描述符 9、SQL 白名单 9、轨迹阈值 12）＋面板 4 条；51 文件 / 821 用例。

## 1.11.0 — 2026-11-18

输入面与 SafeHarness 内核对齐：**归一化 + MODIFY**，以及**输入语义评审**。

- **归一化（默认开，`input.normalize`）**：匹配前按内核 `InformPolicy` 的顺序清洗——去零宽字符（`U+200B`–`U+200F`、`U+202A`–`U+202E`、`U+2060`–`U+2064`、`U+FEFF`、软连字符）、去 HTML 注释、NFKC 折叠。`ig\u200Bnore all rules`、`ＩＧＮＯＲＥ` 这类绕过现在会命中同一批规则。被清洗且**放行**的输入以清洗后的文本进入模型（内核的 MODIFY 语义；DSH `agent/pre-step` 的 `enter` 可带改写消息）；账本只记 `normalized` / `zero_width` / `html_comment` 标签与字符数差。
- **输入语义评审（`input.judge`: `off` / `flagged` / `always`，默认 `flagged`）**：复用 `output.judge` 的 provider/model/超时/字符上限，对可疑输入（或每轮）做一次结构化复核。`block` → 拒绝（`input_judge_blocked`）；无结论（超时/空回复/低置信/坏 JSON）在 `input.judgeFailClosed: true` 时拒绝（`input_judge_unavailable`），否则保持结构规则判定（默认 fail-open；`hardened` 预设自动 fail-closed）。结构规则已经拒绝的回合不再额外调用。
- **面板**：「防护面」卡片新增输入评审三档、fail-closed 开关与归一化开关，保存仍走 `op: save`（revision CAS、逐字段覆盖）。
- **差异（与内核）**：内核 `UNCERTAIN` 一律拦；插件默认 fail-open，仅 `hardened` / 显式开关 fail-closed。这是为避免没有评审路由的 profile 被整体拒绝而做的取舍，已写进 MANUAL §4.9。
- **测试**：新增 11 条（归一化 5、输入评审 6：判定注入、flagged 不多调、fail-closed 两态、结构已拒时不调用、解析器阈值）；47 文件 / 767 用例。

## 1.10.0 — 2026-11-18

安全能力开关：**每个防护面都能在设置页单独打开/关闭**，同时修掉概览页的排版空洞。

- **防护面开关（新）**：设置页新增「防护面」卡片，五面各一个下拉——输入 / 工具调用 / 工具结果（强制拦截 · 仅告警 · 关闭）、模型输出（强制拦截（缓冲流式）· 仅告警 · 关闭）、审批桥（插件策略 · 委派宿主）。改动经 `POST /safeharness/settings` 的 `op: save` 写入 `input.mode` / `tools.mode` / `results.mode` / `output.mode` / `approval.mode`：逐字段覆盖，`preset` 不变；与语义评审同一次保存时合并进同一个 `output` 对象，不会互相覆盖；沿用 revision CAS，stale 表单被拒。审计只记 `surfaces: changed`，不记具体值。
- **概览排版**：四张卡片原先是等高网格，`会话` 很高会把 `防护面` 拉出一大片空白。改成两列瀑布（`columns: 2` + `break-inside: avoid`），窄容器（<700px）自动单列。
- **协议**：`PanelSettingsValue.surfaces` 与 `PanelSettingsPatch.surfaces` 新增；旧面板缺这个字段时按服务端返回渲染。
- **未改**：检测逻辑、规则、账本、端点栅栏全部不变——这一版只把已经存在的 `mode` 字段接到界面上。
- **测试**：新增「逐面保存 + 与 judge 合并」「拒绝未知 mode」两条；45 文件 / 756 用例。

## 1.9.5 — 2026-11-18

插件页信息分级：**只留简要信息，完整手册放到按钮后面**。

- **限制（宿主）**：插件详情页的「包文档」是**纯 Markdown**——raw HTML 被丢弃、相对链接不可点（宿主文档原文：*detail documents omit raw HTML … relative links … are not clickable*）。所以页内 `<details>` 折叠和 `[MANUAL.md](MANUAL.md)` 这类相对链接都做不到，长文只能走绝对 URL。
- **修法**：`README.md` 再收短——一句话定位、安装命令、面板入口、三条 **GitHub 绝对链接**（手册 / 变更 / 示例）与安全边界；新增 `plugins.detail.actions` 页头按钮「完整文档」，在本包 bundle 页与行页渲染（按 `subject.pkg.name` 判定，别人的详情页返回 null），`target="_blank"` 打开 MANUAL.md。
- **效果**：点进插件 → 描述 → 十几行简介 → 五标签工作台；要读长文点页头按钮或 README 里的 GitHub 链接。
- **未改**：三个配置槽、端点、闸门、账本、规则装载全部不变。
- **测试**：`tests/client-bundle.test.ts` 增加「按钮只出现在自家页面 + 链接是 https 绝对地址 + `_blank`」；`tests/acceptance-m4.test.ts` 的 README 断言改为「少于 30 行、含 GitHub 手册链接、不含相对链接」；45 文件 / 754 用例。

## 1.9.4 — 2026-11-18

插件页顺序修复：**工作台紧跟描述，不再被整本手册压在下面**。

- **现象（1.9.3 真机）**：1.9.3 把面板注册进 `plugins.bundle.config` 后工作台确实出现了，但宿主的插件详情页先画「包文档（README）」再画配置区；本包的 README 是 790 行的完整手册，于是五个标签被推到整篇文档之后，点进插件的第一屏仍然是 README。
- **修法**：完整手册移到包根 `MANUAL.md`（章节号不变，`README §4.7` 一类引用继续指向同一节），`README.md` 收成简短门面（一句话定位、安装命令、面板入口、文档索引、安全边界），并把 `MANUAL.md` 加进 `files` 与发布白名单，公开树同样可读。
- **未改**：注册面（`settings.plugins.tab` / `plugins.bundle.config` / `plugins.row.config`）、端点、闸门、账本、规则装载全部不变。
- **测试**：`tests/acceptance-m4.test.ts` 增加「README 少于 40 行且链接 MANUAL.md」的回归，`files` 断言同步为六项；45 文件 / 753 用例。

## 1.9.3 — 2026-11-18

面板入口修复：**点进插件就看到工作台，不再只剩 README**。

- **问题（1.9.2 真机反馈）**：1.9.2 让这个包成为组合包后，「插件」页里确实出现了条目页，但点进去只有包自带的 README。原因是面板只注册了 `settings.plugins.tab`（设置里的标签页），而条目页正文由宿主按配置槽拼装：注册了 `plugins.bundle.config` / `plugins.row.config` / `plugins.item` 的包才有自己的配置界面，否则宿主用包 README 填满正文。安装随附的四个配置页（shell 执行器、agent loop、子智能体、DeepSeek 搜索提供方）就各来自一个注册 `plugins.item` 的伴生包。
- **修法**：浏览器半侧在 `settings.plugins.tab` 之外，再注册宿主的两个**键控**槽——`plugins.bundle.config`（`key: '@upear/dsh-safeharness'`，渲染在组合包页面的描述与行之间）与 `plugins.row.config`（`key: '@upear/dsh-safeharness#safeharness'`，让该行多出「配置」控件）。三处共用同一套组件与 face；只有 `view: 'page'` 渲染工作台，`view: 'summary'` 返回 null。三个注册都走 `ctx.slots.inject`，槽不存在时安静缺省，不影响浏览器启动。
- **未改**：面板端点、闸门、账本、规则装载与宿主半侧全部不变；这一版只改浏览器半侧的注册面。
- **测试**：`tests/client-bundle.test.ts` 新增「注册三个槽 + 键名与语言命名空间 + page/summary 视图」断言；45 文件 / 752 用例。

## 1.9.2 — 2026-11-17

打包形态修复：**这个包现在是一个真正的 DSH 组合包（bundle）**，装完就能在宿主「插件」页里点开面板。

- **问题（1.9.1 实测发现）**：≤1.9.1 的包只声明了 `dsh.client`，没有 `dsh.bundle.patch`。靠手写 `insert:` 挂载时功能一切正常（`safeharness_status` / 端点 / 账本都对），但宿主不把它当作组合包：`dsh.profile.bundles` 里没有它，「插件」页里没有它的条目页，于是 `settings.plugins.tab` 的五个标签**无处渲染**——桌面 app 里用户根本没有入口点开面板。历史上面板截图全部来自 `dsh web` 起的 web/dev profile，正是这个原因。
- **修法**：包内新增 `cordis.patch.yml`（`insert: [ { id: safeharness, name: '@upear/dsh-safeharness' } ]`，不带 `config`，让 schema 默认值生效），`package.json` 增加 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，并把该文件加进 `files`。这是宿主文档对组合包的定义（*"A bundle is a package whose `package.json` declares `dsh.bundle.patch`"*，与官方包写法一致）。
- **安装方式随之变简单**：`dsh plugin add` / 桌面 app「添加插件」装完即挂载，**不需要再写 patch**。要覆盖配置时，profile 的 `cordis.patch.yml` 用**按 id 的覆盖**（只写 `id:` + `config:`，不要 `insert:` / `name:`），否则同一 id 会出现两行；覆盖是整体替换该行 `config`。README §3.3 / §3.4 已按此重写。
- **测试**：45 文件 / 751 用例；新增 `tests/bundle-patch.test.ts`（声明了 `dsh.bundle.patch`、patch 进 `files`、`dsh.client` 仍在、patch 能被 loader 方言解析且只 insert 本包一行），`tests/acceptance-m4.test.ts` 的 `files` 断言同步。
- **未改**：运行期行为、账本格式、规则装载、面板端点与闸门全部不变——这一版只改打包与文档。
## 1.9.1 — 2026-11-17

1.9.0 装机验证时发现的一个真实缺口：**账本新种类没有接进查询工具**。

- **问题**：`rules_written` 加进了 `AuditKind`，但 `safeharness_audit_query` 工具自己维护了一份 kind 白名单，于是 `kind: "rules_written"` 被参数校验拒绝——记录写进了账本却查不出来（面板事件页也不显示 `decision: ok`，只能手读 NDJSON）。
- **修法**：把账本种类改成**单一来源** `AUDIT_KINDS`（`as const` 数组），`AuditKind` 从中派生，工具的参数枚举直接引用同一数组——以后再加种类不会再漏。
- **顺带**：`safeharness_draft_rule` 的 `next` 文案补上 1.9.0 的面板落地路径（人点「写入并重载」），不再只说“自己存文件”。
- **回归**：新增 `tests/audit-kinds.test.ts`（种类唯一、含 `rules_reloaded` / `rules_written`），并在 `tests/hooks.test.ts` 钉住“工具枚举 == `AUDIT_KINDS`”。
- **测试**：44 文件 / 747 用例。
## 1.9.0 — 2026-11-17

规则落地体验：**起草出来的 YAML 可以在面板里“写入并重载”**，不再需要去 `node_modules` 里粘贴。新增的是**人发起的一条受限写路径**，不是模型可调用的工具。

- **新端点** `POST /safeharness/write-rule`（body：`filename` / `yaml` / `overwrite`）。只写 `rules.dir`：未配置或不是绝对路径直接拒绝；解析后落在安装包自带 `rules/` 内的也拒绝（升级会覆盖它）。
- **文件名校验**：`[a-z0-9][a-z0-9._-]{0,63}\.ya?ml`，拒绝路径分隔符、`..`、盘符、前导点与 Windows 设备名；正文 ≤ 12 KB。
- **默认不覆盖**：同名文件先返回 `rule_exists`，只有前端第二次确认（`overwrite: true`）才会替换。
- **写前 loader 试编译**：新增 `validateRuleCandidate()`，用**真实 loader** 把候选文件与 packaged/dir/inline 三层合并后编译；候选文件按“替换自身”参与合并（覆盖不会与自己的旧规则重名），失败返回具体 problems、**一个字节都不落盘**。它与真实加载共用 `assembleRuleSet`，所以“会不会加载失败”与“加载失败”不会分叉。
- **原子写**：同目录 `tmp`（不带 `.yaml` 后缀，watcher 不会读到半截文件）+ rename；成功后写账本 `rules_written`（只记文件名/字节数/规则数/链数），然后热重载；重载失败保留旧规则集并在返回里标 `reloaded: false`。
- **热更新跟随**：`rules.dir` 在运行中改变时，面板重载与文件 watcher 现在都按**实时配置**读取，watcher 也会随目录迁移（此前只认加载期目录，热改后静默失效）。
- **不变量**：仍然是“人点按钮才能落地”，插件没有对应工具，端点有 loopback + 同源栅栏；D37 因此改写为 D62。
- **测试**：43 文件 / 745 用例（新增候选校验 10、写入器 11、端点闸门 6、客户端动作 1）。
## 1.8.4 — 2026-11-17

面板与结果扫描的加固：**收紧面板方法面、补齐自定义路由的两处一致性缺口、设置写入加 CAS、SRI 摘要不再当凭据**。没有新增能力，也没有新增磁盘写路径；「写入并重载规则」仍是 1.9.0 的待定项。

- **面板方法面（安全）**：所有端点（含只读 `status`）改为 **POST-only**，其他方法返回真正的 `405` + `Allow: POST`。此前 `status` 接受 GET，写端点用 GET 会拿到 200 信封 `method_not_allowed`——代理、测试脚本或 devtools 都可能把拒绝当载荷解析；GET 也是导航 / `<img>` / 预取能触发的请求。栅栏（Host loopback + 同源 Origin）现在先于方法判断执行，未受信 Host 连“方法规则”都问不到。
- **自定义路由双写回滚（一致性问题）**：`addProvider` 先写 profile、再写面板索引 `providers.json`；索引写失败时**回滚刚写的路由与凭据**并返回 `provider_index_failed`。此前索引写失败只告警，留下“配置里有、面板删不掉”的孤儿路由（1.8.0 起的 P1）。
- **删除守卫扩展（安全问题）**：删除自定义路由时，除评审/起草路由外，还扫描 `llm-pi-ai` 里**所有**指向该 id 的字段（如 `defaultProvider`），命中即 `provider_in_use`；`providerConfigurable` 改为 `update` 与 `mutate` 都存在才为真（删除走 `mutate`，此前会给出一个必然失败的按钮）。
- **设置写入 CAS**：面板把读到的 `revision` 作为 `expectedRevision` 回传，`settings.update` / `mutate` 在配置已被别处改过时拒绝，映射为 `settings_conflict`（不再 last-writer-wins）。宿主 `describe()` 不暴露 revision 时行为不变。
- **日志零回显**：面板 settings 日志不再打印宿主异常 message（可能含 profile 路径或配置值），只记错误名 + 机器码 + 消息长度。
- **SRI 豁免（结果面误报）**：高熵启发式对 `sha1-` / `sha256-` / `sha384-` / `sha512-` 前缀的完整性摘要直接放行，读 `pnpm-lock.yaml` 不再被 `results.mode: enforce` 整条替换；长度/熵阈值不变，无前缀的同类令牌仍会命中。
- **测试**：41 文件 / 717 用例（新增 revision CAS、冲突映射、索引回滚、引用守卫、只读判定、405 方法面、SRI 共 8 条）。
## 1.8.3 — 2026-11-17

起草诊断与超时修复：**“起草路由不可用”不再吞掉真实原因**。

- **根因**：面板把所有非 `ok` 的起草状态（`timeout` / `empty` / `bad_json` / `invalid` / `error`）都映射成 `draft_unavailable`，客户端又只按错误码显示固定文案。实测起草调用耗时 5.8s / 6.1s / **18.9s**，默认 20s 超时很容易被触发。
- **修复**：服务端按状态返回 `draft_timeout` / `draft_empty` / `draft_bad_json` / `draft_invalid` / `draft_failed`，并把 reason 带回客户端；面板显示具体原因，不再一律说“路由不可用”。
- **可观测性**：起草失败写一条 `invariant_probe`（`reason_code: panel_draft`），只记录 status、耗时与 prompt/reply 字符数，不记录描述或回复内容。
- **默认值**：`draft.timeoutMs` 20000 → 60000，`draft.maxTokens` 400 → 2048（起草模型实测接近 19s；400 tokens 对带推理的模型偏紧）。
- **测试**：新增状态映射用例。41 文件 / 709 用例（公开 38 / 691；CI 37 / 683）。
## 1.8.2 — 2026-11-16

安全修复与证据完整性：**面板栅栏的 DNS rebinding 绕过、结果层对源码的误拦、巡检漂移自比对、hardened 门禁的两个不可达 code**。

- **面板栅栏（安全）**：Host 校验从 `127.` 字符串前缀改为 `net.isIP() === 4` + 127/8。`127.0.0.1.attacker.example` 这类域名过去会被当成 loopback（Origin 也由攻击者域名决定），可绕过面板写端点；现在被拒。新增三个回归（attacker.example / nip.io / 普通子域）。
- **结果扫描误报**：`credential_assignment` 不再把 `apiKey: z.string()`、`token: process.env.X`、`secret: config.secret` 当凭据；真实赋值（`password = hunter2…`、`api_key=sk-…`）仍拦。此前 `results.mode: enforce` 下读取插件自己的源码/配置会被整条替换（真机实测）。
- **巡检 `config_drift`**：先读上一条 `posture_report` 再跑当前姿态，修掉“自己刚写的那条对比自己”导致永远 OK。
- **hardened 门禁**：`hmr_enabled` 在 hardened 判 FAIL（与 README 一致，加载会拒绝）；`approval_never` 移出默认 `failOn`（无 session 时永远 SKIP，门禁不可达），仍会报告。
- **评审/扫描窗口**：judge prompt 总上限 4096→16384，默认 `judge.maxChars: 12000` 不再被静默截断；输出扫描上限与 `bufferMaxChars` 统一为 512K，超出配置直接拒绝。
- **enforce-buffer 降级**：超过字符/时延上限后真正逐块透传，不再继续缓冲到流末（首 token 延迟与内存增长）。
- **审批桥**：delegate 分支的 `next()` 抛错返回 `unavailable`，不再把异常抛出调用方，也不会变成授予。
- **配置校验**：`posture.failOn` / `results.blockOn` 未知 code 拒绝加载（拼写错误不再静默削弱强制）；`output.bufferMaxChars` 超上限拒绝。
- **零回显**：面板路由失败只记录长度，不再把宿主异常文本写进 `labels`；`routeField` 拒绝换行。
- **发布卫生**：sidecar 脚本与 README/CHANGELOG 去掉私有绝对路径；`publish-guard` 新增“发布文本不含私有路径”扫描。
- **宿主钉版**：运行时 `PINNED_VERSIONS` 更新到桌面实测的 `0.2.2-rc.3`（构建期类型仍来自 rc.1 的 profile 副本；`engines.dsh` 仍允许 `>=0.2.2-rc.1 <0.3.0`）。升级后姿态的 `plugin_version_mismatch` 恢复 OK。
- **测试**：41 文件 / 708 用例（公开 38 / 690；CI 37 / 682）。
## 1.8.1 — 2026-11-12

高熵误报修复，为 `results.mode: enforce` 上线做准备：**纯十六进制摘要与长路径片段不再被判成凭据**。

- **问题（R35 的后果）**：高熵启发式只要"≥40 字符、≥3.5 bits/char"就报 `credential_high_entropy`。真实账本里 `safeharness_status`（含 64 位 ruleset 哈希）、`safeharness_audit_query`（含 sha256 链哈希）、`git log`（40 位 commit id）以及 Code Mode 堆栈里的 `@scope/pkg/lib/...` 路径片段都会被命中。`balanced` 只记 WARN 时还能忍；一旦把 `results.mode` 改成 `enforce`，这些**正常工具结果会被整条替换成拦截回执**，等于把插件自己的诊断入口也封了。
- **修复**：新增形状闸门 `isCredentialShapedToken()`——只有**同时含小写、大写和数字**、**不是纯 hex**、且**不是 Windows 路径**（`C:/...` / `file:///C:/...`）的令牌才进入熵计算。哈希是 hex（含大小写混排的 hex 也仍然排除），路径片段通常全小写，Node 报错里的 `file:///C:/Users/.../x.mjs` 带盘符，三者都在熵计算前被跳过；长度（40）与熵阈值（3.5）保持不变，带前缀的真实密钥（`sk-…` / `Bearer` / PEM / `password=`）仍由各自的形态规则命中。
- **取舍**：全小写且无前缀的 40+ 字符随机串不再由高熵启发式兜底（仍可能被 `credential_assignment` 命中）；这是为了换取"正常结果不被误拦"。
- **测试**：`tests/tool.test.ts` 的 R35 已知误报改为断言放行；新增纯 hex（sha256 / git id）、大小写混排 hex、Windows 文件 URL 三个回归用例。全套 **41 文件 / 697 用例**（公开树 38 / 679；CI 37 / 671）。
- **配置建议**：修好误报后桌面 profile 才把 `results.mode` 设为 `enforce`（`balanced` 的 `blockOn` 已含 `credential_leak`）。真实宿主验证见 `evidence/1.8.1-results-enforce.md`。
## 1.8.0 — 2026-11-12

自定义模型 + 账本导出：**面板里可以直接添加任意 OpenAI / Anthropic 兼容端点（URL + Key + 协议 + 模型）并一键设为评审路由**，同时补齐 T5.3 最后一项可选项"账本片段导出"。

- **自定义模型**：设置页新增卡片，支持 pi-ai 可手写声明的三种协议——`openai-completions`、`openai-responses`、`anthropic-messages`；字段为路由名、显示名、Base URL、API Key、模型 ID/显示名，以及"添加后设为评审模型"（默认开）。路由写进宿主 `llm-pi-ai` 的 `providers.<id>`（`providers` 整段是 volatile，经宿主 `settings` 服务落 profile 并热更新），随后出现在供应方/模型下拉里；评审路由用同一套 `settings.update` 指过去。
- **Key 的处理**：只经 loopback POST 一次，写宿主凭据服务（`ref = SAFEHARNESS_<ID>_API_KEY`，落在 `.credentials.yaml`），**不写 profile YAML、不回显、不进账本/日志/错误消息**。删除路由时一并 `unset`；添加失败会回滚刚写的凭据。
- **路由管理**：插件自有 `$DSH_HOME/safeharness/providers.json` 只记录本面板添加的路由（id/显示名/协议/URL/模型/凭据引用名/时间），不存 Key；删除时若路由仍被评审或起草使用，返回 `provider_in_use`，先改路由再删。
- **校验**：路由名 `[a-z][a-z0-9-]{1,39}`；URL 必须是 http/https 绝对地址、不得内嵌用户名/密码；Key 单行、≤4096；模型 ID 必填；重复路由返回 `provider_exists`；没有 settings/credentials 服务时返回 `provider_unavailable` 并保持只读说明。
- **协议边界**：pi-ai 的手写路由只支持上述三种协议；Bedrock（SigV4）、Vertex（project/location/ADC）、Azure（部署环境 + api-version）、Codex（OAuth）需要各自的环境与签名，无法用一个 URL + Key 表达，面板不提供，仍走宿主自己的 provider 配置。
- **账本片段导出**：新端点 `POST /safeharness/export`（POST-only、body ≤ 16 KiB、`limit` 1–500，默认 200）返回 `{filename,count,content}`，`content` 是账本已有脱敏记录的 NDJSON（哈希/长度/代码，不新增字段、不读模型内容）；概览的账本卡片提供"导出账本片段"按钮，浏览器用 Blob 保存，宿主不落盘。
- **测试**：新增面板设置路由 4 例（添加不泄漏 Key / 重复与非法输入 / 在用删除拒绝 / 无凭据服务）、导出端点 2 例。全套 **41 文件 / 694 用例**（公开树 38 / 676；CI 37 / 668）。
- **真实宿主验证**（0.2.2 Web 壳 + 本机 fake OpenAI 兼容服务器 `127.0.0.1:18080`）：添加 `fake-local`（openai-completions、`http://127.0.0.1:18080/v1`、`sk-fake-sentinel`、`fake-model`）→ 评审路由自动切到 `fake-local/fake-model` → probe 返回 `status: ok / verdict: allow / 149ms`；删除时先返回 `provider_in_use`，改回空路由后删除成功，profile 中 `providers.fake-local` 与凭据引用均消失。
- 未能验证：真实飞书/钉钉/企业微信 webhook 投递（用户无法提供），仍以本地 mock 与单测覆盖 payload/发送路径；真实人工审批同理。
- 仍不做：面板写规则文件；通用调度器（定时只跑巡检）。
## 1.7.0 — 2026-11-12

修复 + 面板重做 + 评审设置：**工作区/对话筛选真正可选**，面板改为跟随宿主主题的五标签工作台，新增"设置"页直接在面板里改语义评审与起草路由，并给拒绝措辞加上来源标记。回应四条反馈：筛选选不了、拒绝看不出是谁拦的、面板仍丑、judge 用的什么模型/怎么在面板里设置。

- **筛选根因（不是下拉坏了，是没有数据）**：工作区/对话选项原来只来自**本进程内存**里的会话表，重启后账本仍有事件、内存表却是空的，所以两个下拉永远只有"全部/未知项目"。现在 `SessionStateStore` 把**显示元数据**持久化到插件自己的 `$DSH_HOME/safeharness/sessions.json`（只存 `sessionId / workspace / createdAt / title / touchedAt`，不存计数、trail、prompt、参数或输出；tmp+rename、750ms 合并写、损坏文件忽略、随插件卸载 flush）。重启后这些会话以 `historical: true` 回到列表，工作区与标题仍可用于筛选。
- **对话下拉补全**：选项 = 持久化/本进程会话 ∪ 账本事件里出现过的会话；标签优先标题，其次"项目 basename · 短 id"，再其次短 id；同名标题保留短 id 后缀；只有存在无工作区事件时才出现"未记录工作区"。选择工作区会重置对话筛选，只列该工作区的对话。
- **标题采集时机**：除三个接缝外，`session/event` 也读一次 `sessionTitle` 服务。标题是宿主的标题提供方在事件流里生成的，只在下一次 pre-step 采会晚一轮；现在改名/建议标题随事件落进索引，仍然只用于显示。
- **拒绝来源标记**：四个模型可见的拒绝措辞都加上 `（SafeHarness 安全插件）`（输入/工具/结果/输出），保留"不点名规则、阈值或参数"的既有口径。用户能看出是本插件拦的，模型仍拿不到可绕过的细节。
- **面板重做为五标签工作台**：概览 / 事件 / 规则 / 巡检 / **设置**。新视觉系统（设计 token、卡片、KPI、时间线、空状态、复制按钮、键盘可达），**跟随宿主主题**（读 `documentElement` 的 `color-scheme`/`data-theme`，不再只靠 `prefers-color-scheme`）；概览把"本进程计数 / 历史会话"分开标注；事件页支持工作区、对话、类别、结论四重筛选 + 文本搜索 + 展开详情。
- **设置页（新端点 `POST /safeharness/settings`）**：`op: read|save|probe`，POST-only、body ≤ 16 KiB。读：当前评审启用/范围/路由/字符上限/超时、起草路由、宿主模型目录（provider → models，缓存 30s，上限 24 provider / 600 model）。写：只提交改动字段，走宿主自己的 `settings` 服务（`settings.update`，仅 volatile 路径）→ `cordis.patch.yml` → loader 热更新 → `applyHotConfig`，**不另建配置存储**；校验范围（maxChars 500–200000、timeout 500–60000、启用时 provider/model 必填），失败只回粗粒度错误码，不转发宿主原文。probe 发一次最小结构化请求，只回 status/verdict/耗时，不回模型文本。每次保存写一条 `invariant_probe`（`reason_code: panel_settings`）。
- **顺序加固**：`tools/pre-execute`、`agent/pre-step`、`llm/stream`、`approval/request` 四处监听改为 `{ prepend: true }`。DSH 0.2.2 **没有插件数值优先级**；同事件监听器按注册序执行，`prepend` 是 unshift（后 prepend 者更靠前），`tools.guard` 在 pre-execute 与审批之后、按 scope 分层且单调不可撤销。因此口径是"prepend 最佳努力 + guard 单调兜底"，文档不承诺"绝对第一个执行"。
- **测试**：新增 `tests/panel-settings.test.ts`（9）与 `tests/state.test.ts` 持久化三例、`tests/panel.test.ts` 历史/账本会话一例、`tests/panel-route.test.ts` 设置端点五例。全套 **41 文件 / 688 用例**（公开树 38 / 670；CI 37 / 662）。
- **真实宿主验证**（0.2.2 Web 壳 + 桌面同源 dev profile）：重启后 `sessions.json` 回读出 `Greeting`、本机工作区等历史行；工作区筛选从 20 条收敛到 2 条，对话下拉列出标题 + 短 id + 历史标记；设置页读到 `configurable: true`、`available: true` 与真实 provider 目录；保存 `judge.timeoutMs 4000→4100→4000` 往返成功；填 `liao/gpt-6-luna` 后 probe 返回 `status: ok / verdict: allow / 3685ms`，随后恢复空路由；新建会话发一条消息后插件状态目录写出 `sessions.json` 且标题被采集。
- **覆盖边界不变**：所有经 `tools/pre-execute` 的工具调用（内置、MCP、技能、子代理、工作流/PTC）都在调用级被判定；shell 内部二次命令与子进程、网络副作用、技能正文、模型推理流、MCP server 自身以及工具体开始执行之后不在"已防护"范围。DSH 的顺序机制也意味着一个更早注册且不调用 `next()` 的第三方监听器可以让我们看不到调用——这属于宿主组合层风险，文档如实标注。
- 仍不做：面板写规则文件；账本导出；通用调度器（定时只跑巡检）。桌面端需升级到 1.7.0 后确认五标签、筛选与设置页。
## 1.6.0 — 2026-11-12

新增功能（T5.3 第四步）：**面板从"一个长列表"变成能用的工作台**——四个标签、按工作区/对话标题/类别/结论筛选与分页、规则清单与 AI 起草、可设时间的定时巡检。回应四条反馈：信息堆积、会话只有 ID、看不到 AI 建规则、定时巡检不能设时间。

- **结构**：概览 / 事件 / 规则 / 巡检 四个标签。标签页全部挂载（非当前页 `display:none`），切换不丢起草结果、筛选和巡检结果。
- **事件**：新增四个下拉筛选——工作区（项目目录）、对话（**标题**，取不到用"项目 · 短 id"）、类别（输入/工具/工具结果/审批/预算/输出/巡检/姿态/内部错误/其他）、结论（全部/拦截/审批/告警/失败，带计数）；默认每页 20 条 + "显示更多"，不再无限堆叠。
- **对话命名**：`agent/pre-step`、`tools/pre-execute`、`approval/request` 从宿主 `sessionTitle` 服务读取最新标题写入会话状态（latest-wins）。标题只用于面板显示，**不进账本、不进模型上下文**；取不到就回落项目 + 短 id，不读会话日志。
- **规则标签**：列出编译后的 20 条规则 + 3 条链（名称/类别/严重度/来源文件/模式原文/本事件窗口命中数），支持搜索；"重新加载规则"走 `POST /safeharness/reload-rules`（与热更新同源的 loader 门，失败保留旧规则集，写 `rules_reloaded`）。
- **AI 起草**：新端点 `POST /safeharness/draft`（POST-only、body ≤ 16 KiB、描述 ≤ 2000 字、`draft.enabled` 检查、单飞）。返回经 loader 门校验的 YAML + 形状 warnings + 摘要，**不写入、不启用**；面板提供说明与"复制 YAML"。
- **定时巡检**：新端点 `POST /safeharness/schedule`（5–1440 分钟），状态持久化到插件自己的 `$DSH_HOME/safeharness/panel-state.json`（tmp + rename，写失败降级 memory-only 并在面板标注）；递归 `setTimeout` 不堆 tick，`dispose()` 随插件卸载清定时器，`unref()` 不拖住宿主进程。启停各写一条 `invariant_probe`。
- **巡检闸门重构**：`PatrolRunner` 成为手动与定时共用的单飞闸；冷却只作用于手动点击（定时不受"刚点过按钮"影响；定时跑完后 5 秒内手动点会被冷却拦住，避免连续写账本）。
- **其它交互**：防护面彩色胶囊；会话行点击直接跳到事件并只看该会话；规则搜索、路径展示、复制按钮；空事件窗口给出"这是正常，放行仍在计数"的说明；页脚固定动作清单。
- **测试**：新增 `tests/patrol-runner.test.ts`（4）与 `tests/schedule.test.ts`（7）；`panel.test.ts` / `panel-route.test.ts` / `state.test.ts` 扩充。全套 **40 文件 / 670 用例**（公开树 37 / 652；CI 36 / 644）。
- **真实宿主验证**（0.2.2 Web 壳，独立账本）：标题"读取机密文件并运行系统命令"出现在会话下拉；对话+类别筛选从 2 条收敛到 1 条；重新加载规则回 `20 条规则 · 3 条链`；AI 起草真实调用 `liao/gpt-6-luna` 产出 `curl_script_to_shell`（critical / command-execution）且切标签不丢；定时 5 分钟保存后 `panel-state.json` 为 `{"version":1,"enabled":true,"intervalMinutes":5}`、`nextAt` 正确；手动巡检 `FAIL 0 / WARN 0 / OK 2 / SKIP 3`、退出码 0。
- **澄清一个常见混淆**：DSH 工具卡片（参数/结果/Schema/计时）是宿主自带 UI；卡片里"该操作不被平台安全策略允许"是本插件的通用拒绝措辞，对应账本 `tool_denied`。
- 仍不做：面板写规则文件、写 profile 配置、账本导出；定时只跑巡检，不做通用调度器。桌面端需升级到 1.6.0 后确认四标签/起草/定时。
## 1.5.0 — 2026-11-12

新增功能（T5.3 第三步）：**面板从"几个数字"变成能回答"谁在什么时候、被哪条策略、拦了哪个工具"的视图**。1.4.0 的面板只显示最近 10 条 `deny` 的裸代码；这一版补齐上下文、颜色与筛选，并把"哪个对话"落实到会话标识上。

- **事件卡片（替代原来的 5 列表格）**：每条显示结论徽标（红=拦截/失败，橙=告警，紫=审批，绿=放行）、工具名与来源（输入/工具/工具结果/审批/预算/巡检/姿态）、原因（`reason_code` 映射为中文，如"工具名黑名单""结果扫描命中"）、严重度与分类、规则 id、参数 sha256 前 8 位、项目与短会话 id、时刻。左侧 3px 色条按结论着色，窄面板下不再挤成多行表头。
- **筛选**："全部 / 拦截 / 审批 / 告警"四个计数徽标（计数来自当前账本窗口）；点事件或会话行可按会话过滤。窗口说明显示"账本最近 N 条中 M 条需要关注 · 从 … 起"。
- **会话列表**：本进程观察到的会话按最近活动排序，显示项目目录、短会话 id、创建与最近活动时间、拦截/审批/告警/放行计数与工具调用数。点击只看该会话的事件。
- **会话标识怎么来的**：`agent/pre-step`、`tools/pre-execute`、`approval/request` 三个接缝把 `agent.session.header.cwd` / `createdAt`（宿主的**会话元数据**，不是对话内容）记进插件状态；面板显示为"项目 basename + 短 id + 时间"。账本里 `session` 字段保留 `session-<uuid>` 全 id，短 id 就是它的前 8 位，便于和 `/safeharness audit` 对账。**不显示会话标题**：标题是模型生成文本，账本不存，面板也不为了好看去读会话日志（那会破坏"账本只含代码与哈希"的边界）。
- **计数口径**：四个指标是**本进程**计数（重启归零），事件列表是**账本**窗口（跨重启保留），面板分别标注"本进程 / 账本最近 N 条"，避免重启后数字对不上。
- **判定模式**：五个面改成彩色胶囊（强制拦截=红、仅告警=橙、关闭/透传=灰、插件策略=紫），比裸字符串更快看出"现在到底拦不拦"。
- **账本级**：新增"账本文件"绝对路径与"完整日志"提示（`safeharness_audit_query` / `/safeharness audit 50`）；内部计数错误仍只在放行卡片里显示个数。
- **宿主载荷**（`PanelPayload`）：`recentDenials` 替换为 `recentEvents`（从账本尾部 200 条里取最多 60 条非放行事件）+ `eventWindow{scanned,kept,since}` + `sessionDetails`（最多 8 条）+ `ledger.path`。`tool_result` 这类纯观察记录不再混进事件列表（被拒调用的 error 结果曾被误显示成"内部错误"）。
- **边界未变**：载荷仍不含 prompt、工具参数原文、模型输出、webhook、凭据。新增字段只有：会话 id 前缀、项目目录、创建时间、规则 id、严重度/分类、参数 sha256 前缀——都是账本已经存或会话元数据自带的粗粒度事实。路由栅栏、`panel_failed` 收敛、只读 + 巡检一个动作都不变。
- **测试**：`tests/panel.test.ts` 重写为 8 例（载荷投影、会话分页与短 id、事件过滤/窗口、尾部截断、账本与状态存储双故障降级、JSON 无损等），`tests/state.test.ts` +2（`describe` 首次写入优先、`list` 排序/分页/坏 limit），`tests/panel-route.test.ts` 的 stub 补 `state.list`。全套 **38 文件 / 651 用例**（公开树 35 / 633；CI 34 / 625）。
- **真实宿主验证**（0.2.2 Web 壳，dev profile + 独立账本）：面板显示 `v1.5.0 / balanced`；一条 `tool_denied`（`pwsh`、`tool_denied_by_name`、`高`、`Upear · 04b1b0e9`）与一条 `tool_result_flagged`（`read`、`严重`、规则 `credential_assignment · credential_openai_key`）分别渲染为红/橙卡片；筛选项显示"全部 3 / 拦截 2 / 审批 0 / 告警 1"；会话行显示项目、创建 11:29:52、最近 12:01:26 与各项计数；巡检按钮在 1.5.0 面板里仍跑出 5 项检查（FAIL 0、退出码 0）并回写 `patrol_report`。
- 仍不做：配置写入、账本导出、定时巡检面板化、会话标题。桌面端需升级到 1.5.0 后确认卡片布局与配色（与本次 Web 壳同一 bundle）。
## 1.4.0 — 2026-11-12

新增功能（T5.3 第二步）：**面板里可以运行巡检**。1.3.0 的面板是纯只读；这一版给它加了唯一一个动作，并把"写"的闸做在宿主侧。

- **端点**：`POST /safeharness/patrol`。`GET` 被拒（`method_not_allowed`），导航或 `<img>` 之类无法触发；浏览器栅栏与 `status` 同一套（loopback Host + 同源 Origin）。
- **宿主侧闸门**：单飞（同时只跑一次，重复调用回 `patrol_in_progress`）+ 5 秒冷却（`PANEL_PATROL_COOLDOWN_MS`，回 `patrol_cooldown`）。闸门在路由里而不是按钮里——同源脚本可以直接打端点。
- **语义与 `/safeharness patrol` 一致**：跑 5 项检查（`audit_rate` / `health_probe` / `config_drift` / `ledger_reconcile` / `notify`），写一条 `patrol_report`，配置了 `patrol.notify` 时发一条 `Upear SafeHarness: N FAIL / M WARN` 摘要；返回 `exitCode`（0/1/2）、summary 与 findings（code/severity/detail 都是只含代码与计数的既有契约）。
- **面板**：新增"巡检"区块，**两步确认**（运行巡检 → 确认运行 / 取消），运行中显示状态，完成后展示 FAIL/WARN/OK/SKIP、退出码、通知是否送达与 5 项明细；完成后面板自动刷新状态（账本条数 +1）。错误码映射为中文提示（冷却/进行中/未接入/失败），不显示宿主原始报错文本。
- **测试**：新增 7 例（`tests/panel-route.test.ts` +7：POST 投影、GET 拒绝、冷却、单飞、未接入、runner 抛错、栅栏；`tests/client-bundle.test.ts` +1：巡检请求与解包）。全套 **38 文件 / 646 用例**（公开树 35 / 628；CI 34 / 620）。
- **真实宿主验证**（0.2.2 Web 壳，独立 profile + 独立账本）：面板点"运行巡检" → 确认 → 返回 5 项检查（`health_probe` 因未配探针为 SKIP，其余 OK）与 `exitCode: 0`；账本新增一条 `patrol_report`，面板计数随之刷新。
- 仍不做：配置写入、账本导出、定时巡检的面板化（定时仍靠 OS 计划任务跑 `dsh` 命令或外部 cron）。
- 未验证：桌面端（Electron 窗口）里的巡检按钮（与本次 Web 壳同 bundle，需用户升级后确认）。
## 1.3.0 — 2026-11-12

新增功能（T5.3 第一步）：**桌面端只读状态面板**。设置 → 内置插件 → `SafeHarness` 标签页显示版本/预设、拦截与放行计数、五个面的判定模式、规则集与账本健康、最近 10 条拦截。这是计划里最后一个未开始的功能项（P4/T5.3）的第一个可用切片。

- **宿主半**（`src/panel/`）：`apply()` 检测到 `webServer` 后注册 `/safeharness` 前缀只读路由（`POST /safeharness/status`），返回固定投影（计数/模式/规则 hash 前缀/账本计数/最近拦截的 `ts`+`kind`+`reason_code`+`tool`+规则数）。注册结果写一条 `invariant_probe`（`labels.state = route_registered` / `web_server_unavailable` / `route_failed`），"面板为什么没出现"可直接查账本。
- **浏览器半**（`src/client/`）：预构建的 `lib/client.js`（CJS 闭包工厂，唯一副作用 `window.__ModuleLoader__.load({id, factory})`）；package.json 加 `dsh.client`（`platform: web`）与 `exports["./client"]`。组件只用平台 seed 的 `react`，通过 `ctx.slots.inject('settings.plugins.tab', …)` 注册标签页（等待声明，不假设宿主一定有该槽）。
- **构建**：新增 `scripts/build-client.mjs`（esbuild → `lib/client.js`）、`scripts/platform-modules.mjs`（浏览器模块表的 10 个 seed 说明符，作为外部依赖白名单）、`tsconfig.client.json`（DOM + `react-jsx`，`noEmit` 类型检查）；`pnpm build` / `pnpm typecheck` / `prepack` 都已包含浏览器半。devDependencies 加 `esbuild`、`@types/react`（仍是 `dependencies: {}`，运行时零依赖）。
- **安全口径**：路由只接受 loopback Host + 同源 Origin（跨站标记直接拒），与宿主 `/api` 的浏览器栅栏同义；插件不读 `trustedHosts`，不会从 LAN 暴露。响应不含 prompt/工具参数/模型输出/webhook/凭据；内部异常只回 `panel_failed`。面板不可用时插件照常加载。
- **测试**：新增 `tests/panel.test.ts`（5 例：载荷投影、deny 过滤与 limit、账本故障降级、引擎事实默认值、JSON 可序列化）、`tests/panel-route.test.ts`（10 例：栅栏四种拒绝、方法、未知端点、内部错误不回显、注册结果入账）、`tests/client-bundle.test.ts`（6 例：manifest、闭包工厂形状、只 require 平台模块、materialize 后注册标签页、载荷解包、失败上抛）。全套 **38 文件 / 638 用例**（公开树 35 / 620；CI 34 / 612）。
- **真实宿主验证**（0.2.2 桌面同源 Web 壳，`dsh web`，独立 profile + 独立账本）：启动图包含 `@upear/dsh-safeharness` 行；设置 → 内置插件出现 `SafeHarness` 标签页，显示 `v1.3.0`、`balanced`、计数与账本 3 条；在会话里发一条注入话术被输入面拒绝（**无模型调用**）后，面板"最近拦截"出现 `input_denied / input_rule_hit / 规则数 1`。
- 已知取舍：面板只读、无巡检触发按钮（`safeharness_patrol` 仍是工具/命令）；样式为内联样式（不跟随宿主主题 token）；仅 Web profile 有面板。
- 未验证：桌面端（Electron 内嵌窗口）里的同一标签页（与本次验证的 Web 壳同 bundle，但需用户升级后确认）；真实 IM 投递与人工审批仍是前几版遗留。
## 1.2.2 — 2026-11-12

修复（R42）：**写文档时引用一条破坏性 SQL 会被当成"在执行 SQL"而拒绝**。这是检测范围问题，不是检测能力问题。

- 1.2.1 及更早，`tools/pre-execute` 对**所有工具的字符串参数**跑危险 SQL 判定，于是 `write` / `edit` 只要内容里出现一条破坏性语句就 `tool_denied_by_args`。实际代价：写交接文档被拒 3 次（`args_chars` 33303 / 33618 / 105），每次都要改措辞；实现 1.2.0/1.2.1 期间也被拦过多次。
- 新增 `tools.sqlScan`（`execution` 默认 | `all`）：`execution` 只扫**执行面**工具——标签含 `db`/`shell`/`exec`，或名字词元含 `sql`/`query`/`exec`/`run`/`shell`/`bash`/`pwsh`/`cmd`/`psql`/`postgres`…；`write`/`edit`/`apply_patch`/`read` 这类只落文本的工具跳过 SQL 判定。
- **不做静默降级**：无法识别的工具（既不像执行面也不像落文本面）仍按旧规则扫（fail-closed）；一个同时像"写入"和"执行"的工具（`write_and_exec`）执行信号优先；输入面（`agent/pre-step`）完全不变，对话里贴破坏性语句照旧拒绝。
- 名字按**词元**匹配而非子串：`debug_dump` 不会因为含 `db` 被当成数据库工具，`mcp__postgres_query` 会命中 `postgres`/`query`。
- 恢复旧行为：`tools.sqlScan: all`；给自定义工具补扫描：`tools.tagOverrides` 打 `db`/`shell`/`exec` 标签。该字段是 patch-only（检测范围而非阈值，不进设置页）。
- 测试：新增 `tests/tools-sql-scope.test.ts`（12 例：内容类工具放行、执行类工具仍拒、未知工具 fail-closed、`all` 回退、tagOverrides 生效、词元边界、输入面不受影响、其他工具面行为未变）；`tests/robustness.test.ts` 的参数走查用例改用执行面工具名（走查只在被扫时运行）。全套 **35 文件 / 617 用例**。
- **真实宿主差分验证**（`r42-smoke` + 假模型，同一段"把含破坏性语句的备注写入文件"的 `write` 调用）：默认配置 → 无 `tool_denied`、工具照常执行；`tools.sqlScan: all` → `tool_denied` / `tool_denied_by_args` / `rules: dangerous_sql`。
- 与 Python 参考实现的关系：`SqlGuardPolicy` 同样只对 SQL 类参数键做判定，不是"所有字符串参数"。本版向那个取向靠拢，同时保留了本插件对 shell 命令的覆盖（Python 侧不覆盖）。
- 未验证：真实 IM 投递、真实人工审批（与前两版同口径）。

## 1.2.1 — 2026-11-12

修复：**桌面端设置页看不到、也改不了 safeharness 配置**（P3 §11.3）。这是宿主 0.2.2-rc.1 的 settings API 与插件按 0.1.0-rc.5 类型源实现之间的差异，不是配置错误。

- **根因（两处，实测确认）**：① 0.2.2-rc.1 的 `settings` 是表单服务（`describe`/`configure`/`write`），**没有** `register(ns, schema)`；旧代码只认 `register`，所以 `seams.settings` 永远 false。② 设置页只为 `Config` 里标了 `.volatile()` 的字段生成表单；插件原先一个都没标，于是 entry 不出现在 `describe()` 结果里。
- **设置面接入**：`Config` 的在线可编辑子集加 `.volatile()`（输入/工具/结果/输出/judge/审批/预算/起草）；`preset`、`engine`、`rules`、`audit`、`posture`、`patrol`（含 webhook/secret/token）与数组字段保持 patch-only。数值字段补 `.min()/step()`，保证设置页写入的值不会让下次启动的 `resolveConfig` 拒绝。
- **在线生效**：监听 Loader 的 `loader/volatile-update`（只派发给本 fiber 的监听器），重新 `resolveConfig` 后走 `applyHotConfig`：重编译规则、替换运行时配置、记一条 `rules_reloaded`。一次设置写入可能触发多次事件，按结构相等去重；fiber 拆除后不再处理。
- **配置兼容**：`resolveConfig` 入口新增 `unwrapVolatile`，把宿主解析出的 `.volatile()` box 还原为普通值；预设展开与校验逻辑不变（R37 保留）。公开的 `Config` 类型仍按普通形状声明，因为消费侧永远经过 `resolveConfig`。
- **设置服务检测**：改用 `ctx.inject(['settings'], …)` 延迟读（`settings` 在插件注入的 `tools`/`systemPrompt` 之后才启动）；旧宿主仍有 `register` 时继续走旧 watch 路径。`safeharness_status.seams.settings` 此时如实为 true。
- **测试**：新增 `tests/settings-surface.test.ts`（8 例：volatile 白名单、凭据字段不可在线编辑、box 还原、延迟检测、旧 register 兼容、volatile-update 生效与去重、非法更新保留旧配置）；全套 **34 文件 / 605 用例**。真实宿主冒烟：`safeharness-dev` 上 `settings.describe()` 出现 safeharness，`configEditor.edit` 改 `input.mode: off` 后运行时立即生效且账本恰好一条 `rules_reloaded`。
- 文档：README 新增 §4.5（设置页与 volatile 白名单）、已知限制第 19 条（表单不显示 preset 展开值）；handoff §11.3 改写。
- 未验证：真实 GUI 点击路径（本次用宿主 `configEditor`/`settings.describe` API 验证，行为等价）；真实 IM 投递与人工审批仍未验证。

> **补记（2026-11-12，仅测试，无运行时变更，版本号不变）**：`tests/perf.test.ts` 的 p99 断言在忙机器上会偶发失败（实测 6 次里 2 次把 `input evaluateInput 60KB` 判成 4.9–7.4 ms，而中位数 <0.5 ms）。原因是 `vitest` 并行 worker 的 GC/调度停顿恰好落在 p99 的取位（200 个样本时 p99 = 倒数第 3 个）。现把「超过批次中位数 10×」的孤立样本判定为调度停顿并剔除，同时把该用例的采样数提到 400（p99 取位从倒数第 3 变成倒数第 5）。真实性能回归会整体抬高分布（含中位数），因此仍会被拦住；预算值一个都没放宽。连续 8 次 `pnpm test` 全绿（p99 1.8–3.4 ms）。

## 1.2.0 — 2026-11-12

新增功能（M5 T5.1 第 2 步）：**可选的 Python 输入引擎**（sidecar）。默认仍是内置 TypeScript 引擎，行为与 1.1.1 完全一致；只有显式配置 `engine.kind: sidecar` 才启用。

- 新配置段 `engine`：`kind`（`builtin` 默认 / `sidecar`）、`command`、`args`、`cwd`、`timeoutMs`（默认 1500）、`startTimeoutMs`（默认 10000）。`kind: sidecar` 但 `command` 为空 → 加载期拒绝（不留到第一个用户回合才炸）。
- 新脚本 `scripts/safeharness_sidecar.py`：JSON-lines 协议（`health` / `set_rules` / `inspect_sql` / `inform_match` / `evaluate_input` / `shutdown`），危险 SQL 由本仓 Python 的 `inspect_sql` 判定；`--framework` 指向仓库 `src/` 以导入 `safeharness.policies`。只读、无网络、无凭据。
- **只接管输入面**：`tools.guard` 的同步无 IO 契约不变，工具/结果/输出/链式轨迹仍是内置引擎；`input.maxChars` 截断在 TS 侧完成后才发送。
- **判定合成留在 TS**：子进程只返回"哪条规则命中 / 是否危险 SQL"，`Decision`（severity/category/reason code/排序）由 `composeInputDecision` 合成，切换引擎不改变账本语义。
- **规则同源**：握手时下发当前规则集（名称 + 正则源），全部接受才算就绪；规则热更新后到确认前，异步输入路径拒绝（`sidecar_rules_stale`）。子进程报出本规则集没有的规则名 → `sidecar_unknown_rule`。
- **失败语义**：observe/balanced 记录一次 `input_engine_unavailable` 并回落内置引擎（攻击照拦，账本 `labels.engine: builtin` + `engine_error`）；hardened 拒绝输入，加载期不可用则拒绝加载。新增姿态 code `engine_sidecar_unavailable`（10 项），hardened 的 `failOn` 含它。
- 传输层加固：子进程事件代际守卫（重启后旧 child 的 exit 不会毒化新握手）、stdout 单行上限（超限杀进程）、在途请求上限（`sidecar_overloaded`）。
- 顺带修复：配置热更新后内置引擎的 `input.maxChars` / 工具 / 结果阈值不再陈旧（`Engine.reconfigure`）。
- 测试：新增 `tests/sidecar.test.ts`（13）、`tests/sidecar-engine.test.ts`（7）、`tests/sidecar-hook.test.ts`（4）、`tests/sidecar-apply.test.ts`（3）、`tests/sidecar-parity.test.ts`（1，内部，需本机 Python；内置与真实 Python 引擎对内部语料逐条同判）；全套 **33 文件 / 597 用例**。发布白名单新增 `scripts/safeharness_sidecar.py`（tarball 必须带它），一致性测试加入 `NEVER_PUBLISH`。

未验证（与 1.1.1 相同口径）：真实 IM 投递、真实人工审批；sidecar 只在 Windows + Python 3.14.7 冒烟，未在 Linux/macOS 验证。
## 1.1.1 — 2026-11-11

小修：给规则草稿加**形状警告**（shape warnings），其余行为不变。

起因是 1.1.0 上线后第一次真实使用：`/safeharness draft curl` 返回了 `pattern: '^curl$'` —— 结构合法但只匹配"整条消息正好是 curl"，实际等于没写规则。这类失败 loader 检查不出来，只能靠启发式提示。

- `RuleDraft` 新增 `warnings: string[]`；工具与命令都会打印。
- 三条确定性规则（只看形状，不判断语义）：
  - 纯字面量（去掉 `^`/`$` 后没有正则元字符）→ "只匹配这段文字本身，不匹配它周围的措辞"；
  - pattern 短于 12 字符 → "太窄，变体都会漏过"；
  - 既无空白/`\s`、也无 `|` 或字符类 → "只匹配单个词元"；
  - chain 的两条腿若是纯字面工具名 → "工具名会变（`query` vs `mcp__postgres_query`），建议片段或交替"。
- prompt 补一句："要匹配攻击者写的整句话，不要把 pattern 锚定到一个裸工具名（例如 `^curl$`）"。
- 测试：`tests/draft.test.ts` 34 例（+5：锚定字面量、单词元、结构良好的 pattern 不告警、chain 字面腿、命令输出含 warnings）。
## 1.1.0 — 2026-11-11

新功能：**LLM 辅助规则起草**（M5 T5.2）。其余行为不变，配置字段只增不改。

- 新工具 `safeharness_draft_rule` 与新命令 `/safeharness draft <要抓什么> [--chain]`：一句自然语言描述 → 一条候选规则（`inform` 匹配不可信文本，`chain` 匹配"工具 A 然后工具 B"）。
- **草稿不落地**：返回值里是经 loader 校验、可直接粘贴的 YAML，并且 `applied: false`；插件不写文件、不改规则集、不触发重载。生效与否由人决定（存进 `rules.dir` 或 `rules.inline` 后重载）。
- 校验与加载器同一道门：`compileRule` / `compileChain`（含 Python-only 正则语法拒绝）、名字不得与已加载规则重名、severity 词表、category kebab-case、拒绝嵌套量词（ReDoS 风险）与控制字符、字段名按 kind 白名单（描述无法夹带额外字段）。
- 起草请求带 `DRAFT_REQUEST_MARK`：`llm/stream` 直接放行，既不自我评审也不计入预算；结果与账本都不含描述原文。
- 配置新增 `draft.enabled` / `draft.provider` / `draft.model` / `draft.maxChars` / `draft.timeoutMs` / `draft.maxTokens`；`provider`、`model` 留空即复用 `output.judge` 的路由。
- 测试：新增 `tests/draft.test.ts`（29 例：合法 inform/chain、围栏 JSON、引号转义、超时/坏 JSON/空回复/调用失败、重名/严重级/嵌套量词/超长/换行/多余字段/max_gap 校验、描述不外泄、工具与命令面、组合根只注册不落盘），全套 **27 文件 / 550 用例**。
- 示例：`examples/cordis.patch.draft.example.yml`；README 新增 §4.3 与已知限制第 17 条。

## 1.0.0 — 2026-11-11（GA）

首个正式版。内容 = `1.0.0-rc.4` 的整体转正，**没有功能、配置或行为变更**：只把版本号从 `1.0.0-rc.4` 改为 `1.0.0`，并补上本文件、发布说明与"待验证清单"的措辞。

### 能力

- **输入防线**（`agent/pre-step`）：20 条 inform 规则 / 3 条链，命中即拒；拒绝话术不泄漏规则内容。
- **工具执行面**（`tools/pre-execute` / `tools.guard` / `tools/post-execute` / `tools/result`）：危险 SQL、工具标签策略、链式轨迹、结果凭据扫描；`guard` 同步无 IO、fail-closed。
- **输出面**（`llm/stream`）：字符/usage 复核、可选语义 judge、可选 `enforce-buffer`（默认关）。
- **审批桥**（`approval/request`）：`policy` 模式一次性授予 / deny 名单，异常一律委托。
- **审计账本**：NDJSON + 哈希链 + 脱敏 + 轮转 + 查询；只存哈希与长度，原文、URL、token 永不落账本。
- **姿态自检**（`safeharness_posture`）与**巡检**（`safeharness_patrol`，退出码 0/1/2，五个检查）。
- **预算护栏**：每轮 token 上限，超限记一次 `budget_exceeded`。
- **通知**：`patrol.notify` 0..N 通道 —— 飞书 / 钉钉（含加签）/ 企业微信 / OneBot(QQ) / 通用 HTTP。
- **三档预设**：`observe` / `balanced`（出厂）/ `hardened`（含加载门禁）。
- **面**：4 个工具 + `/safeharness status|posture|patrol|judge [probe]` 命令 + 一条提示词条款 + 不变量入口。

### 兼容性

- 宿主 DSH `0.2.2-rc.1`（`engines.dsh: ">=0.2.2-rc.1 <0.3.0"`），Node ≥ 24，Windows x64 实测。
- 运行时零第三方依赖；宿主包只在编译期使用（`devDependencies`，精确版本固定）。
- 安装形态：tarball（`file:`）或 `link:`（开发期，支持 HMR 重载）。

### 未在发布环境中验证的事项（不阻塞 GA，部署方按需自证）

| 项 | 现状 | 怎么补 |
|---|---|---|
| 真实钉钉 / 企业微信 / 飞书机器人投递 | **待验证**：信封、加签、多通道语义均有单测与本地真实 HTTP 联调，但没有真实机器人 URL/access_token | 配一条 `patrol.notify`，制造一次 FAIL 巡检（例如 `healthUrls` 指向关闭端口），确认群里收到计数句 |
| 真实人工审批 | 未验证：需要人在 GUI 点击，且当前部署预设为 `danger-full-access`（`approval: never`）时该路径不可达 | 切 `workspace-write`，配 `approval.mode: policy` + `askTools`，分别点同意/拒绝 |
| 桌面端 `/safeharness` 命令 | **已验证（2026-11-11）**：桌面端输入框执行 `/safeharness status` 与 `/safeharness judge probe`，后者真实打到 `liao/gpt-6-luna`（4.3 s，`status=ok verdict=allow`）；`/safeharness patrol` 仍只有处理器单测 | 桌面端再敲一次 `/safeharness patrol` |
| 跨 turn 预算 | 一轮内多次调用已实测累计；跨轮需要同一进程多轮会话 | 同一桌面会话连发两轮，看 `budget_exceeded.metrics.turn` 递增 |

## 1.0.0-rc.4 — 2026-11-11

- **多通道巡检通知**：`patrol.notify` 数组，支持 `feishu` / `dingtalk` / `wecom` / `onebot` / `generic`；每通道独立 3 s 超时，互不影响。
- 钉钉：可选 `secret`，按官方 HMAC-SHA256(`${timestamp}\n${secret}`) 追加 `timestamp`/`sign`。
- 企业微信：群机器人 webhook 直接可用。
- OneBot（QQ）：`send_group_msg` + `groupId` / 可选 Bearer `accessToken`；官方 QQ 机器人协议未适配。
- 通用：`{"text":…}` 或 `body` 模板（`{{text}}`）。
- `notified` 仅当**全部通道成功**；部分失败记一条 `notify` WARN（只含通道类型与粗略原因），URL/secret/token/响应体一律不进账本。
- 兼容：`patrol.feishuWebhook` 保留，等价一条 `feishu` 通道；`notify` 存在时以它为准。
- 新增 `examples/cordis.patch.notify.example.yml`；巡检 `include` 补齐 `notify`。

## 1.0.0-rc.3 — 2026-11-11

- **可独立构建**：宿主包移入 `devDependencies`（精确版本），干净机器 `pnpm install && pnpm build && pnpm test` 即可，不再需要本机装 DSH。
- 修 `peerDependencies`：`@deepseek-ai/dsh-invariants` 由不存在的 `0.2.2-rc.1` 改为 `0.1.0-rc.8`（仅编译期类型）。
- 类型收敛：judge 消息 `source.kind: 'plugin'`、`JsonValue` 改为本地别名/显式 cast，兼容发布版类型。
- 新增 GitHub Actions CI（pnpm 10 + Node 24，剔除对机器抖动敏感的 perf 预算）。

## 1.0.0-rc.2 — 2026-11-11

- 新增 `/safeharness judge [probe]`：前者打印 judge 路由与 `llm` 服务状态，后者用同一条路由真打一次 canary，只回报 `status` / `verdict` / `blocked` / `duration_ms`。
- 巡检工具 `include` 枚举补齐 `notify`（此前 `PATROL_CODES` 有、工具面没有）。

## 1.0.0-rc.1 — 2026-11-11

- **首个发布候选**：observe / balanced / hardened 三档预设、输入/工具/输出/审批四类 seam、审计账本（哈希链）、姿态自检、巡检、预算护栏、四个工具 + `/safeharness` 命令、提示词条款、不变量入口。
- **修 R37**：schemastery 会把缺失数组物化成 `[]`，导致预设里的 `posture.failOn` / `results.blockOn` 在真实部署中被当成"显式写空"而失效 → 全部数组改用 identity-transform，保留"缺失"语义。**更早的预发布构建在真实 host 上 hardened 门禁实际未生效，请升级后复核。**
- **修 R36**：加载门禁失败时已注册的监听器不随 fiber 回滚 → 门禁前移到任何 seam 注册之前；拒绝加载时账本只有 `plugin_loaded` + `posture_report`。
- 打包：`pnpm pack` → tarball 仅含 `lib` / `rules` / `README` / `LICENSE`。
