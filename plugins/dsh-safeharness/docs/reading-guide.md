# dsh-safeharness 插件开发引导：功能表与代码阅读路线（2026-11-20）

> 读者：接手本插件开发的人。假设会 TypeScript、了解 Cordis 事件模型，但没读过本仓库。
> 本文只回答两个问题：**有什么功能、功能在哪个文件**，以及**代码按什么顺序读**。
>
> 与既有文档的分工（互相引用，不重复）：
>
> | 文档 | 回答的问题 |
> |---|---|
> | **`docs/handoff-2026-11-24.md`** | **当前真相**（零上下文交接）：现状、环境、发布流程、坑与铁律、**与内核的完整对比**、欠账、后续计划。**接手先读它 §0–§2，再读 §9 与 §12** |
> | **`docs/verification-2026-11-25.md`** | **判官结案**：79 条 `empty` 全量取证、空回答是路由问题而非预算问题、`attempts=2` 零触发、`output_reviewed.metrics` 被覆盖的铁证、输入面超时拒答 |
> | **`docs/incident-2026-11-25.md`** | **事故复盘**：宿主「重试本轮」插入空 `content` 的 user 消息 → 会话永久 400。**与插件无关，账本里零信号**；含时间线、复算脚本、三层修复建议 |
> | `docs/handoff-2026-11-23.md` | 上一版交接（1.16.3 → 1.19.0 的逐版取证都在这）。**1.16.2 时代的事故细节以它为准**，当前状态以 11-24 版为准 |
> | `docs/handoff-2026-11-18.md` | 1.14.0 时代的环境/架构初版（其 §4.2 的发布步骤是**旧版**，已被 11-23 §4.2 取代） |
> | `docs/plan-2026-11-18.md` | 内核能力对照表、移植计划、剩余任务（§16 前后的热修与 1.16.0） |
> | `MANUAL.md` | 面向使用者的权威配置手册（§4 配置 / §5 预设 / §11 已知限制） |
> | `CHANGELOG.md` | 逐版变更与理由（每版"为什么这么改"都在） |
> | **本文** | 功能 → 代码位置的功能表；按天推进的代码阅读路线 |

---

## 0. 30 秒坐标

- **是什么**：`@upear/dsh-safeharness`，DSH（DeepSeek Harness）的 profile 级 Cordis 插件（组合包形态），把 SafeHarness 内核的安全语义装进 DSH 的执行生命周期。TypeScript，**运行时零第三方依赖**，不 patch 宿主、不改内核（`src/safeharness/**` 是 Python 内核，插件不 import 它）。
- **当前版本**：**1.20.0**（**67 个测试文件 / 1062 用例全绿**；公开树口径按每版 CHANGELOG 记录）。1.19.0 是 66 / 1042。宿主 DSH 桌面 `0.2.2-rc.5`，版本门两表同时接受 `rc.3`。**2026-11-25 实测**：`vitest run` 67/1062 全绿、两道 `tsc` 均 0 错。
- **最近一次结案**：判官"空回答"——是**路由**问题（`2026-11-24T02:36Z` 换 provider 后归零），**不是** 1.19.0 的预算/重试（`attempts=2` 至今 0 条）。见 `docs/verification-2026-11-25.md`。
- **核心原则（改代码前默念）**：插件是内核的应用，不凌驾于内核——只移植内核**已实现**的能力；宿主已托管的（审批对话框、工具执行、OS 沙箱）不重造；内核没有的（记忆/租户/PG sink/网关回执/管理面/进化闸门）一律不做。
- **第一大纪律：零回显**。账本/日志/错误消息/面板载荷只许出现哈希、长度、代码、配置名。凭据只在 `~/.dsh/.credentials.yaml`，profile 里只存 `apiKeyEnv` 引用名。

---

## 1. 功能表（功能 → 接缝/配置 → 代码 → 文档锚点）

### 1.1 五道防护面（判定主干）

| 面 | 接缝 | 行为 | 关键配置 | 代码 | 备注 |
|---|---|---|---|---|---|
| 输入 | `agent/pre-step`（`hooks/input.ts`） | deny / 归一化改写放行 / 输入面 judge | `input.mode`、`input.normalize`、`input.judge: off/flagged/always`、`input.judgeFailClosed`、`input.maxChars` | `hooks/input.ts` + `engine/input.ts` | 1.11.0 起：NFKC + 零宽/HTML 注释清洗（内核 MODIFY 语义）；judge 默认 fail-open，`hardened` 预设强制 fail-closed。**注意：输入面偷用 `output.judge.timeoutMs`（6000），失败即整轮拒答**——见 §4 P0-2 |
| 工具调用（异步） | `tools/pre-execute`（`hooks/tools.ts`） | ask / deny，waterfall | `tools.mode`、`tools.denyTools`、`askTools`、`allowOnce`、`denyTags`、`tools.tagOverrides`、`tools.maxArgsBytes` | `hooks/tools.ts` + `engine/tool.ts` | 宿主 8/8 接缝的 AS 面早注册 `{prepend:true}`（顺序语义见下 §2.1） |
| 工具调用（同步兜底） | `ctx.tools.guard` | 单调不可撤销 deny | 同上 | `index.ts`（IO-free，built-in 引擎路径） | 补 waterfall 可被丢弃的口子；**别在这做需要 IO 的判定** |
| 工具结果 | `tools/post-execute` + `tools/result`（观察） | block / 替换 | `results.mode`、`results.blockOn`（credential_leak / injection / pii）、`results.pii`、`results.piiClasses` | `hooks/tools.ts` + `engine/pii.ts` | 1.12.0 PII 10 类（与内核 sanitizer 逐条同名，默认只告警） |
| 模型输出 | `llm/stream`（`hooks/llm.ts`） | warn / enforce-buffer 整条替换 | `output.mode`、`output.judge.*`、`output.bufferTimeoutMs`、`output.bufferMaxChars` | `hooks/llm.ts` + `judge/client.ts` | 1.15.1 起：**凭据扫描进输出面**（`scanCredentialLeaks` 复用）+ 流内脱敏（256 字符尾部窗口覆盖跨 delta 拆分，`[REDACTED:credential]`） |
| 审批 | `approval/request` | 一次性授予 → deny 列表 → 委派宿主 / 插件策略 | `approval.mode`、`approval.allowOnce` | `hooks/approval.ts` | TTL/approver 由宿主托管，插件不重造 |

### 1.2 检测引擎（`src/engine/`，全部无 IO、可独立单测）

| 能力 | 配置 | 代码 | 测试 | 说明 |
|---|---|---|---|---|
| 20 条注入规则（inform）+ 3 条链规则 | `rules/` 包内 YAML；`rules.dir`、`rules.watch`、`rules.inline` | `engine/rules.ts`（loader 门、`validateRuleCandidate`） | `tests/rules.test.ts`、`rules-redos.test.ts` | 正则 `iu` 编译；**loader fail-loud**：任一文件错→整次加载失败保留旧集；1.14.2 起 loader 拒 `(a+)+` 无界嵌套形状（ReDoS 门，四条入口一致） |
| 输入归一化 | `input.normalize` | `engine/normalize.ts` | `tests/input-normalize*.test.ts` | 零宽字符 / HTML 注释 / NFKC，内核 `InformPolicy` 同序 |
| SQL 形状 + 表白名单 | `tools.sqlScan`、`tools.sql.allowedTables`（空=不限） | `engine/sql.ts` | `tests/sql*` | 白名单不匹配 → `unauthorized_sql_table`；`DEL/**/ETE` 注释剥离有回归钉 |
| 轨迹阈值 | `tools.repeatedAttemptThreshold`、`entropyThreshold`、`entropyMinLength`（默认 0=关） | `engine/tool.ts` | 轨迹阈值测试 | 同工具连续失败达阈值拒（成功清零）；高熵串参数拒（只记 index/长度/熵值） |
| 工具描述符扫描 | `tools.descriptorScan: off/warn/enforce`（默认 warn） | `engine/tool.ts`（`name`+`description` ≤8KiB） | 描述符测试 | warn 每会话每工具记一次；enforce=逐次拒（宿主无"下架工具"接缝，MANUAL §4.10） |
| 参数形状规则（1.16.0） | `tools.argSchemas`（六种原语：pattern/enum/minBytes/maxBytes/pathPrefix/urlScheme/commandAllowlist） | `engine/argschema.ts`（编译+判定）+ `engine/tool.ts` 第 (4b) 步 | `tests/arg-schema.test.ts` | 内核 `constrain.py` 的 argument-schema 一半；编译失败只丢该条并报 `arg_schema_invalid`；**pattern 走规则 loader 同一道 ReDoS 门** |
| PII 10 类 | `results.pii`、`results.piiClasses` | `engine/pii.ts` | `tests/pii*` | `id_card/phone_cn/email/bank_card/api_key/jwt/doc_no/gov_serial/customer_id/internal_url`，两条正则有长度上界（防 256KiB 回溯灾难，实测教训） |
| 凭据形态（三面共用） | 结果/输出面自动 | 凭据扫描（`scanCredentialLeaks`，结果面与输出面同一份） | `tests/credential-leak.test.ts` | 1.15.1 真实事故修复：JSON 引号键名、`LLM_API_KEY` 长前缀形状、引用排除（`z.string()`/`process.env.X`）；**改这套正则前先读该版 CHANGELOG 的性能段**（无界前缀曾把测试卡死数分钟） |

### 1.3 模型侧

| 能力 | 配置 | 代码 | 说明 |
|---|---|---|---|
| 输出语义评审 | `output.judge: {enabled, scope: flagged/always, provider, model, timeoutMs}` | `judge/client.ts` | 结构规则命中才调（flagged）；不可用时按预设降级（hardened fail-closed） |
| 输入语义评审 | `input.judge` + `input.judgeFailClosed` | `judge/client.ts`（复用同一路由） | 1.11.0；结构已拒的回合不再额外调用 |
| 规则起草 | `draft: {enabled, provider, model, maxChars, timeoutMs, maxTokens}` | `draft/rule.ts` | 只产 YAML 文本；写入走面板（人触发），模型侧无写规则工具 |

### 1.4 规则运维（信任根，写路径必须窄）

| 能力 | 入口 | 代码 | 红线 |
|---|---|---|---|
| 目录热更新 | watcher（2s 内生效） | `engine/rules.ts` 装配 + `index.ts` watch | fail-loud，坏文件保留旧集 |
| 面板「写入并重载」 | `POST /safeharness/write-rule` | `panel/rules-write.ts` | 只写 `rules.dir`；文件名白名单；写前真实 loader 试编译（一个字节都不落盘）；原子写；账本只记元数据 |
| 写入前快照 + 一键回滚 | 同端点 `op: history/rollback` | `panel/rules-history.ts` | 保留 10 份（sha256 清单）；回滚前先拍 pre-rollback；恢复前临时目录跑真实 loader，编不过不写 |
| `rules check` 命令 | `/safeharness rules check [dir]` | `surface/commands.ts` + `util/packaged.ts` | 只读；目录不存在是错误不是"空通过" |

### 1.5 运维与辅助面

| 能力 | 配置/入口 | 代码 | 说明 |
|---|---|---|---|
| 审计账本 | `$DSH_HOME/safeharness/audit/ledger.ndjson` | `audit/ledger.ts`、`redact.ts`、`paths.ts`、`types.ts`（`AUDIT_KINDS` 单一来源，加种类只改这里） | NDJSON sha256 链；脱敏（content→sha256、敏感键、16KB 截断）；轮转 |
| 姿态自检 11 项 | `safeharness_posture`；`posture.failOn` 加载门 | `posture/` | failOn 命中 = 任何接缝注册前抛错（拒绝加载=完全没生效） |
| 巡检 5 项 + 通知 | `safeharness_patrol`；`patrol.windowMinutes/factor/minCount`、`patrol.notify`（凭据永不回显） | `patrol/`、`notify/`、`panel/patrol-runner.ts` | 飞书/钉钉/企微/OneBot/generic |
| 每轮 token 预算 | `budget.maxTokensPerTurn` | `budget.ts` | 插件独有（内核无此模块） |
| 会话元数据索引 | `sessions.json` | `state.ts` | 只存显示字段（sessionId/workspace/标题/时间）；tmp+rename、750ms 合并、损坏忽略 |
| 斜杠命令 / 工具 | `safeharness_status`、`_posture`、`_audit_query`、`_patrol`、`_draft_rule`；`/safeharness …` | `surface/tools.ts`、`surface/commands.ts`、`surface/prompt.ts` | 宿主工具面 |
| invariant companion | 独立入口包 | `invariant.ts` | 观察插件健康，与插件同进程 |

### 1.6 面板（浏览器半 `client/` + 宿主半 `panel/`）

- 路由全部挂 `/safeharness` 前缀：**POST-only**（其他方法 405 + `Allow: POST`，栅栏先于方法判断）、loopback Host（`net.isIP()===4`，**不用 `127.` 前缀**——DNS rebinding）、同源 Origin、body ≤16KiB、设置写入 **revision CAS**。代码：`panel/route.ts`（栅栏与端点）+ `panel/settings.ts`（CAS、逐字段合并、日志零回显）。
- 设置卡片：防护面开关 / 语义评审 / 工具与结果检测 / 列表与匹配 / 只读配置 / 巡检 / 自定义模型（三协议，Key 只进凭据服务）。协议字段在 `panel/protocol.ts`（`PanelSettingsValue/Patch`）。
- 规则页：起草 → 写入并重载 → 快照与回滚。
- 客户端注册三个宿主槽位：`settings.plugins.tab` + `plugins.bundle.config` + `plugins.row.config`（入口问题的修复史见 1.9.2/1.9.3 CHANGELOG）。

### 1.7 与宿主的边界（如实告知，别写成"已防护"）

shell 内二次命令、工具体执行后的副作用、网络副作用、技能正文、模型推理流（reasoning-delta）、MCP server 自身、更早第三方监听器的拦截——**不在覆盖范围**。插件顺序只有 prepend 最佳努力 + guard 单调兜底，没有绝对第一。侦察命令（whoami 等）不拦是明确决策。完整清单：MANUAL §11（26 条）。

---

## 2. 代码阅读路线

> 原则：**测试文件是行为规范**。读到任何"为什么"，先看对应 `tests/*.test.ts` 的断言，再看 CHANGELOG 那一版的动机段。

### 第 1 天：一次调用怎么被拦（主干链）

1. `src/index.ts` 的 `apply()`（920 行，全文件读完）——启动顺序：配置解析 → 规则加载 → 引擎 → 账本 → 运行时 → **加载时姿态门（failOn 命中在任何接缝注册前抛错）** → service → 接缝注册 → 工具/命令/面板/巡检。注意 `session/event` 与 `loader/volatile-update` 两个附加监听。
2. `src/config.ts`（1062 行）——`SafeHarnessConfig` schema + `resolveConfig()` 的 preset 展开。改任何配置面之前先看这里：**volatile / non-volatile 决定面板能不能热改它**。
3. `src/runtime.ts` + `src/service.ts`——运行时对象与对外 service 形状（`DENIAL_TEXT` / `TOOL_DENIAL_TEXT` 通用话术在这）。
4. `src/hooks/input.ts`（257 行）——**最短一条完整链**：pre-step → 归一化 → 规则 → judge → deny/改写。读它时对照 `tests/` 里的输入归一化与 judge 用例。
5. `src/engine/rules.ts`（962 行）——loader：三层装配（packaged < dir < inline，同名覆盖、同层重名报错）、compileRule、ReDoS 形状门、`validateRuleCandidate`。这是规则系统的心脏。
6. `src/audit/ledger.ts` + `audit/types.ts`——怎么写、怎么链、`AUDIT_KINDS` 单一来源（1.9.1 的教训：kind 白名单分叉会"写进了却查不到"）。

**第 1 天自测**：能不看代码说出"一条用户消息从进入到被拒，经过哪几个函数、账本记了哪几条、为什么拒绝话术不点名规则"。

### 第 1 周：全部检测面与工具/输出链

7. `src/hooks/tools.ts`（273 行）——pre-execute（waterfall）+ post-execute + result 三接缝的职责差异。
8. `src/engine/tool.ts`（994 行）——工具名/标签/glob、参数体积、SQL 扫描、描述符扫描、轨迹阈值、熵阈值。最大最密的检测文件，慢慢读。
9. `src/engine/sql.ts`、`engine/pii.ts`、`engine/normalize.ts`、`engine/types.ts`——四个小而独立的检测器；`pii.ts` 注意正则长度上界的注释（二次回溯实测教训）。
10. `src/hooks/llm.ts`（621 行）——输出面最难的一个：流缓冲（enforce-buffer）、**凭据流内脱敏的尾部窗口与跨 delta 重写**（1.15.1）、judge 触发、`block-end` 权威文本。改这里前先读 `tests/credential-leak.test.ts` 与 1.15.1 CHANGELOG 全文。
11. `src/judge/client.ts`——评审 prompt、超时、JSON 解析、状态码拆分（`timeout/empty/bad_json/invalid/error`）。
12. `src/hooks/approval.ts` + `src/budget.ts` + `src/state.ts`——三个小模块收尾。

**第 1 周自测**：能画出"模型回答里出现一条 key"时，结果面/输出面/流内脱敏各自在哪一步兜住、账本分别记什么。

### 第 2 周起：面板、规则运维、宿主集成

13. `src/panel/route.ts`——栅栏（loopback/Origin/POST-only/16KiB）与每个端点。**安全敏感度最高**，改前读 `tests/panel-route.test.ts`（含 DNS rebinding 回归）。
14. `src/panel/settings.ts`——`op: read/save/probe/add-provider/delete-provider`、revision CAS、逐字段合并、两存储一次提交的 provider 流程。
15. `src/panel/rules-write.ts` + `panel/rules-history.ts`——写路径信任根：白名单、试编译、原子写、快照/回滚。
16. `src/surface/commands.ts` + `surface/tools.ts` + `util/packaged.ts`——命令/工具面；`packagedRulesDir()` 收口一处（1.15.0 教训：相对跳 점手写两份会"重载读 A、校验读 B"）。
17. `src/patrol/` + `src/posture/` + `src/notify/`——运维面（凭据永不回显）。
18. `src/client/index.tsx` + `client/panel.tsx`——浏览器半：三槽位注册、五标签常驻挂载（D36：条件渲染丢草稿）、构建走 `scripts/build-client.mjs`（esbuild → `lib/client.js`）。
19. `src/engine/sidecar.ts` + `sidecar-engine.ts`——可选 Python 输入引擎（默认不启用；读即可，别当主路径）。

### 随时对照

- 配置 → MANUAL §4（权威）；预设语义 → MANUAL §5；边界 → MANUAL §11。
- 内核对齐状态 → `docs/plan-2026-11-18.md` §1 对照表（哪些"已对齐"、哪些"宿主托管"、哪些"明确不移植"及理由）。
- 逐版动机 → CHANGELOG 对应版本段。

---

## 3. 修改纪律（红线清单，违反=返工）

1. **内核对齐**：新检测能力先查 `plan-2026-11-18.md` §1——内核没有的不做；内核有的按内核口径移植，差异点写进 MANUAL §4/§11。
2. **零回显**：任何新账本字段/日志/错误消息，先问"这里面有没有内容、路径、凭据"。只有哈希/长度/代码/配置名可以出去。
3. **fail 方向**：判定的 fail-open/fail-closed 语义是配置化的（默认看 preset），不许在代码里偷偷翻转；hardened 必须真 fail-closed。
4. **测试账本只增不减**：当前 **67 文件 / 1062 用例**是下限（1.20.0 起；_2026-11-25 实测全绿_）。新行为必须带用例；修 bug 先写复现用例。`tests/perf.test.ts` 有 p99 门（5ms），正则改动必须加对抗用例（1.15.1 教训：无界前缀 = 全套卡死数分钟）；**新加的 perf 用例规模要克制**（见 §5 最后一行）。
5. **面板写入**：走 revision CAS；`tools`/`results`/`approval`/`rules`/`patrol` 各自对象合并，不与同面 `mode` 互相覆盖；非法值**一个字节都不写**。客户端 dirty 判定见 §4 P0（1.15.2 已修，改之前先读 `tests/settings-form.test.ts` 与 `tests/panel-settings.test.tsx`）。
6. **宿主版本门**：`PINNED_VERSIONS` / `PREVIOUSLY_VERIFIED_VERSIONS` 两表**只加不删**；删表项 = 宣布不再支持该宿主，需单独发版说明。
7. **发布**：流程照 `docs/handoff-2026-11-23.md` §4.2（worktree + **必须走 `scripts/publish-public.mjs`**、leak 检查、公开树测试口径、tag 不重写）。`docs/` 目录不入公开树。**不要手工 robocopy 同步**——1.15.2 就是这样把攻击语料泄漏到公开仓的。
8. **写文档/注释别带凭据样例**（`key = "真实形状"`）：1.15.1 起三面都会拦，读者会看不到那段文字。用占位符形状。
9. **本机构建**：pnpm 是坏的（全局 packageManager 冲突），用 `node node_modules/typescript/bin/tsc`、`node node_modules/vitest/vitest.mjs` 直调；构建三步 + `npm pack`（handoff §14 有完整命令）。

---

## 4. 当前任务清单（接手即干，按优先级）

> **优先级已重排（2026-11-25）**：下面 P0/P1/P1.6/P1.7/P1.8 是**已完成的历史**，
> 保留是为了让接手的人知道「为什么现在长这样」。**真正要干的是本节的
> §4.1「P0（新）」两项**，以及 `handoff-2026-11-24.md` §12.1。

### P0 — 1.15.2 面板保存回归热修（**已完成，2026-11-20**）

**现象**（历史）：1.10.0–1.15.1 期间面板设置**零次成功保存**（账本 `invariant_probe / panel_settings` 最后一条成功记录停在 2026-11-17 v1.9.0）。根因不在服务端（手工同接口 `{"op":"save"}` 可写），而在客户端 `buildPatch`：`nonNegativeNumber` 把上界 `8` 硬编码，1.13.0 起巡检默认值 10 落在界外，**默认表单即非法**，任何字段都存不下去。

**已做**（细节见 CHANGELOG 1.15.2）：
1. `buildPatch` / `baselineOf` 抽成可导出纯函数 + 纯逻辑单测 `tests/settings-form.test.ts`（8 条）。
2. jsdom 真挂载单测 `tests/panel-settings.test.tsx`（5 条）：控件 → dirty → 点保存真发出 `{expectedRevision, judge:{scope}}`。
3. 非法值原因移进保存条内、按钮禁用带 `title`、`dirty` 判据含 `invalid`。
4. **真机验收已完成**：账本 `seq 13907 / ts 2026-11-20T03:11:09Z / plugin_version 1.15.2 / reason_code panel_settings / state settings_saved`。

### P1 — 1.16.0 工具参数形状规则（**已完成，2026-11-20**）

内核 `constrain.py` 的 argument-schema 那一半已落地：新增 `tools.argSchemas` + `engine/argschema.ts`，六种原语（`pattern` / `enum` / `minBytes` / `maxBytes` / `pathPrefix` / `urlScheme` / `commandAllowlist`），命中即 `unauthorized_tool_argument`；编译失败的条目只丢自己并在姿态报 `arg_schema_invalid`。MANUAL 能力对照表已把 `constrain.py` 改「已对齐（参数 schema 部分）」，§4.11 是用户文档，§11 第 23 条写边界，`tests/arg-schema.test.ts` 39 条钉行为。

**没做的（下一版的候选，不是欠账）**：面板编辑 `argSchemas` 仍是只读（要复刻一套列表校验，照 `denyTools` 那套）；不支持 `items` / `required` / `additionalProperties`（宿主自己的入参校验负责那一层，插件再引一套等于给出两个答案）。

### P1.6 — 1.16.1 凭据规则精度修复（**已完成并已装，2026-11-20**）

`credential_assignment` 不再把插件自己的源码当密钥：源码里的调用赋值、测试夹具的模板占位、插件自己的 `[REDACTED…]` 占位符都不再命中；引号字面量、裸字面量、真令牌仍命中（`tests/credential-precision.test.ts` 8 条两侧都钉）。同批把「结果面 `block` 对写工具是事后告警、重试会二次执行」写进 MANUAL §11.25 / §4.10 / §12。

**部署状态**：1.16.2 已发（主仓 `4cc1c05` / 公开仓 `58ee786` + tag `v1.16.2`）、已装进 desktop profile、**已重启生效**（2026-11-23 15:28，账本 `plugin_loaded` `seq 17645 / 1.16.2`）。姿态第 1 项因此从假 `OK` 变成真 `WARN`。下次升级仍然要**完全退出 DSH 桌面版（含托盘）再启动**，否则进程里还是旧版本。

### P1.5 — 判官"空回答"（**已结案，2026-11-25**）

> **⚠ 本节的历史结论已被推翻，原文保留在下，读结论直接看这段。**
>
> 原文说「正文越短越容易空回，长正文则超时」，据此建议「换一条对短 prompt 稳定的
> 判官路由」。**换路由这一步做对了，但当时的归因是错的。**
>
> 2026-11-25 全量取证（79 条 `empty`，见 `docs/verification-2026-11-25.md`）：
>
> | 原结论 | 实测 |
> |---|---|
> | 「`usage_output` 上千，预算被思考吃光」 | 只有 **25/79（32%）** 超过旧预算 2048 |
> | 「短正文想很久」 | `judge_ms` p50 **810 ms**、p90 1196 ms、**没有一条 > 4 s** |
> | 「要换一条稳定路由」 | ✅ 对：`2026-11-24T02:36:05Z` 换成 `od-ds` 后 **`empty` 归零** |
> | （未提）| 同版本 1.16.3 前后对比：切换前 6 次 6 空 → 切换后 6 次 4 ok **0 空** |
>
> **1.19.0 的「预算 4096 + 空回答重试」不是这个问题的解**：全账本 `attempts=2`
> **0 条**，重试路径至今零覆盖。它可以留着当兜底，**别再为它加预算**。

**原文（2026-11-20，保留供追溯）**：真实账本里 19 条 `judge_status: empty`：模型调用了、token 也计费（`usage_output` 中位数 690，最大 11579），但一个 `text-delta` 都没吐。按状态分组看相关性很清楚——`ok` 组正文中位数 275 字符，`empty` 组只有 **90** 字符（最小 18），`timeout` 组 3861 字符：**正文越短越容易空回，长正文则超时**。行为本身是对的（空回答记 `unavailable`，不是 `allow`）。下一步是换一条对短 prompt 稳定的判官路由，或给 `scope` 加一档"只审长回答"，两者都要更多样本再定。细节与不这么改的理由写在 MANUAL §11 第 24 条。

### P1.7 — 1.16.2 姿态沙箱假 OK（**已完成，2026-11-23**）

`sandbox_danger_full_access` 过去问的是 `sandboxPolicy.resolve()`（**不带 session**），拿到的是部署默认值，与任何真实会话无关；2026-11-23 本机实测：会话实际跑在 `danger-full-access`，姿态却报 `OK / "sandbox mode is workspace-write"`，`hardened` 的这道加载门禁因此等于不存在。1.16.2 改为「部署默认 ∪ 所有已观察会话里最宽的那个」，读不到模式的会话按 WARN 计；**只有默认值、一条会话都没观察到时是 `SKIP`**（加载门禁跑在任何接缝接线之前，那一刻必然只有默认值——在这里报 OK 就是同一个假 OK 换个位置）；LRU 淘汰掉的会话仍以最宽模式/未知计数计入，读不到的默认值也算未知。新增 `src/hooks/sandbox.ts`，采集点在 `agent/pre-step` / `tools/pre-execute` / `approval/request` 与会话的 `sandbox/mode` 事件。测试 `tests/sandbox-observe.test.ts` 17 条 + `tests/posture.test.ts` 3 条回归。**口径变成 61 文件 / 958 用例。**

**边界（已写进 MANUAL §11 第 26 条）**：只能为插件见过的会话作答；加载前就存在、此后无事件的会话不在观测范围内。

> 该版测试口径已过期：现在（1.20.0）是 **67 文件 / 1062 用例**，见 §3 第 4 条。

### P1.8 — 1.16.2 `argSchemas` 两处欠账（**已完成，2026-11-23**）

1. **`pathPrefix` 对相对路径 fail-open**：`pathSegments()` 滤掉开头的空段，`/workspace` 被编成 `"workspace"`，于是 `workspace/a`、`./workspace/a` 都算"在 `/workspace` 下"。现在按 **（根, 段）** 比较：相对前缀在编译期被拒，相对值在判定期被拒，`C:\work\ws` 与 `/work/ws` 互不相容，`C:ws` 不算绝对，UNC 以 `//server/share` 为根。`tests/arg-schema.test.ts` +5 条。
2. **"只认第一条匹配的 schema"文档与代码相反**：代码一直是 AND，文档/注释写的是 first-match。统一到 AND（更严），补"第一条通过、第二条拒绝"的用例——这是原用例集的唯一盲区。

### P2 — 其余

`docs/handoff-2026-11-18.md` §16（剩余工作）与 `docs/plan-2026-11-18.md` §2/§3 的收尾项；环境项（真实 IM webhook 投递、真实 `approval: ask` 人工点击）需要部署侧配合。**明确不做**（不要提案）：记忆/embedding、租户、PG 审计 sink、工具网关回执与重放、管理面受控变更、进化闸门、OS 沙箱实现、外部智能体监督器、面板写 packaged `rules/`、重写已发布 tag。

### P0（2026-11-25，**1.20.0 已完成**）— 账本度量失真与输入面拒答

**两项都已在 1.20.0 处置**（下面每条前面的 ✅ 是现状）。证据与复算方法见 `docs/verification-2026-11-25.md`。

1. ✅ **`output_reviewed.metrics` 被判官覆盖**（同文 §5）——**1.20.0 已修**，判官的测量改为 `judge_*` 前缀。下面是原始取证，保留是因为**历史账本按新口径读会得到不同答案**：`src/hooks/llm.ts:476` 是
   `metrics: { ...metrics, ...outcome.metrics }`，判官的 `duration_ms` / `chars` /
   `truncated` 覆盖了主流自己写的值。账本铁证（09:45 快照）：154 条判官行里 **64 条
   `duration_ms < review_ms`**（未覆盖时物理不可能），以及 1.6.0 那条
   `chars=3861 / prompt_chars=4096`（3861 = 旧上限 4096 − 指令 230 − 分隔符 5）。
   **不改判定行为，但所有基于账本的长度/时长度量都不可信。**
2. ✅ **输入面与输出面共享 6 秒判官预算**（同文 §6）——**1.20.0 已给旋钮** `input.judgeTimeoutMs`（volatile，默认 `0` = 沿用输出面）。「一次失败就拒整轮」的语义**没有改**，那是策略问题：`src/hooks/input.ts:164-167` 把
   `output.judge.maxChars` / `output.judge.timeoutMs` 直接喂给输入判官；输入面的失败语义
   是 `judgeFailClosed` → **整轮拒答**。
   真机已发生一次（`seq=21364`，102 字符消息，6003 ms 超时，deny）。
   建议给 `input.judge.timeoutMs` 独立预算，或收窄 `judgeFailClosed` 的适用范围。

**1.20.0 实际怎么修的**（两条都带了用例）：

- 第 1 条：`judge/client.ts` 新增 `judgeLedgerMetrics()`，给判官的每个键加 `judge_` 前缀；
  输出面（`hooks/llm.ts`）与输入面（`hooks/input.ts`）**共用同一个函数**，避免两个面各自漂移。
  **保留而非丢弃**判官的数字：它是判官成本与送审内容的唯一证据。
  用例 `tests/ledger-metric-namespace.test.ts`（8 条），含「`judge.maxChars` 小于回答长度时
  `chars` 仍为全长」——那是旧缺陷最直观的投影。
- 第 2 条：新增 volatile `input.judgeTimeoutMs`。`resolveConfig` 里只解析一次
  `output.judge.timeoutMs` 再复用它做回退，所以坏值只报一次错。
  用例：`tests/config.test.ts` +4、`tests/input-judge.test.ts` +3（含 400 ms vs 20 ms 真计时）、
  `tests/panel-settings.test.ts` +3、`tests/settings-form.test.ts` +2、
  `tests/settings-surface.test.ts` 的 volatile 精确列表 +1 项（**不改这个列表测试会红**）。

---

## 5. 常见坑速查（历史事故浓缩，全量版在 handoff §12–§15）

| 坑 | 一句话 |
|---|---|
| 规则加了没生效 | loader fail-loud：任一文件错 → 整次失败保留旧集；先 `/safeharness rules check` |
| YAML 正则写法 | 单引号（双引号会解码 `\s`）；`iu` 编译，别写 `(?i)` |
| 同一插件两处配置 | profile patch 里 insert 块与按 id 覆盖块并存，改配置两处都看 |
| ReDoS 门拒规则 | 无界嵌套量词 `((a+)+)` 被拒是设计（输入面同步执行）；有界嵌套放行；交替爆炸 `(a|aa)+` 不在启发式内，靠评审 |
| 面板改了"没生效" | 先看是不是 P0 回归（§4）；再确认字段 volatile 与否（只读卡片上的字段只能改 patch） |
| 读 lockfile/含凭据文档被拦 | `results` 面按形状拦是特性；SRI 前缀已豁免；写文档用占位符 |
| perf 测试偶发挂 | 满载 p99 抖动（5.2ms > 5ms），单独重跑通过即可 |
| 测试口径 | 本机 **67 文件 / 1062 用例**（1.20.0；1.19.0 是 66 / 1042）≥ 公开树口径（每版 CHANGELOG 记录），新增用例不减少 |
| **审批桥是死路径** | 本机 `permission` 预设 `defaultPreset: danger-full-access` → `approval: never`，全账本 `approval_*` **0 条**。想验 `approval.mode: policy`，**必须先切 `workspace-write` + `ask`**，否则永远测不出来 |
| **账本里的 `chars` / `duration_ms` 曾经不可信** | **1.20.0 已修**。1.20.0 之前的账本里，跑过判官的行上这两个字段是**判官**的；之后它们永远是这一侧的。判官的数字挪到了 `judge_chars` / `judge_duration_ms`。**跨版本对比必须以 1.20.0 为界** |
| **判官空回答已不是问题** | 2026-11-24T02:36Z 换路由后归零；1.19.0 的重试至今 0 触发。别再拿"空回答"当待办（`verification-2026-11-25.md`） |
| **"本轮运行失败 / 400 empty_message_content"** | **不是插件拦的**。宿主的「重试本轮」会往历史里追加一条 `content: []` 的 user 消息，严格校验的端点拒绝整条请求，**之后每轮都失败**。会话救不回来，**新开一个**，别连点重试。取证见 `incident-2026-11-25.md` |
| perf 门怎么跑 | 1.16.2 起 `vitest.config.ts` 拆成 `unit` / `perf` 两个 project，perf 单文件串行；`npx vitest run` 自动两个都跑。手工只跑单元用例用 `--project unit` |
| perf 用例写得太大 | 1.16.0 踩过：400×5 次 × 64 KiB 的新用例分配约 128 MB，把 GC 停顿推给它**上面几行**的 `scanToolResult` 预算（全量 4 次里 3 次失败；未改动的树 1/4）。预算用例要小、要放在最后，别干扰邻居 |

---

*本文由主项目 Agent 于 2026-11-20 基于代码树、CHANGELOG（1.9.5–1.16.0）、plan 与 handoff 交叉核对写成；同日两次更新：1.15.2 收口（版本/用例数/P0 状态）与 1.16.0 落地（参数形状规则、判官空回答取证、perf 用例规模教训）。发现与代码不符时，以代码为准并把差异修进本文。*

*2026-11-25 更新（1.20.0）：测试口径 → 67/1062；两个 P0 标为已完成并换成"实际怎么修的"；「账本 chars 不可信」改为历史坑、判官 P1.5 结案（改写为"路由问题"并保留原文）、新增 §4 P0（metrics 覆盖 + 输入面超时拒答）、§5 新增三条坑（审批死路径 / 账本 chars 与 duration_ms 不可信 / 空回答已结案）、文档分工表加入 `verification-2026-11-25.md`。*
