# 变更记录

版本遵循 semver。`1.0.0-rc.1` 起配置字段名冻结；`1.0.0` 起为正式版，新增字段只增不改名。
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
