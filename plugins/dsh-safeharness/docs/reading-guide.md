# dsh-safeharness 插件开发引导：功能表与代码阅读路线（2026-11-20）

> 读者：接手本插件开发的人。假设会 TypeScript、了解 Cordis 事件模型，但没读过本仓库。
> 本文只回答两个问题：**有什么功能、功能在哪个文件**，以及**代码按什么顺序读**。
>
> 与既有文档的分工（互相引用，不重复）：
>
> | 文档 | 回答的问题 |
> |---|---|
> | `docs/handoff-2026-11-18.md` | 现状、环境、runbook、发布流程、坑清单（**接手先读它 §1–§4**） |
> | `docs/plan-2026-11-18.md` | 内核能力对照表、移植计划、剩余任务（§16 前后的热修与 1.16.0） |
> | `MANUAL.md` | 面向使用者的权威配置手册（§4 配置 / §5 预设 / §11 已知限制） |
> | `CHANGELOG.md` | 逐版变更与理由（每版"为什么这么改"都在） |
> | **本文** | 功能 → 代码位置的功能表；按天推进的代码阅读路线 |

---

## 0. 30 秒坐标

- **是什么**：`@upear/dsh-safeharness`，DSH（DeepSeek Harness）的 profile 级 Cordis 插件（组合包形态），把 SafeHarness 内核的安全语义装进 DSH 的执行生命周期。TypeScript，**运行时零第三方依赖**，不 patch 宿主、不改内核（`src/safeharness/**` 是 Python 内核，插件不 import 它）。
- **当前版本**：1.16.1（60 个测试文件 / 932 用例全绿）。宿主 DSH 桌面 `0.2.2-rc.5`，版本门两表同时接受 `rc.3`。
- **核心原则（改代码前默念）**：插件是内核的应用，不凌驾于内核——只移植内核**已实现**的能力；宿主已托管的（审批对话框、工具执行、OS 沙箱）不重造；内核没有的（记忆/租户/PG sink/网关回执/管理面/进化闸门）一律不做。
- **第一大纪律：零回显**。账本/日志/错误消息/面板载荷只许出现哈希、长度、代码、配置名。凭据只在 `~/.dsh/.credentials.yaml`，profile 里只存 `apiKeyEnv` 引用名。

---

## 1. 功能表（功能 → 接缝/配置 → 代码 → 文档锚点）

### 1.1 五道防护面（判定主干）

| 面 | 接缝 | 行为 | 关键配置 | 代码 | 备注 |
|---|---|---|---|---|---|
| 输入 | `agent/pre-step`（`hooks/input.ts`） | deny / 归一化改写放行 / 输入面 judge | `input.mode`、`input.normalize`、`input.judge: off/flagged/always`、`input.judgeFailClosed`、`input.maxChars` | `hooks/input.ts` + `engine/input.ts` | 1.11.0 起：NFKC + 零宽/HTML 注释清洗（内核 MODIFY 语义）；judge 默认 fail-open，`hardened` 预设强制 fail-closed |
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
| 姿态自检 10 项 | `safeharness_posture`；`posture.failOn` 加载门 | `posture/` | failOn 命中 = 任何接缝注册前抛错（拒绝加载=完全没生效） |
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

shell 内二次命令、工具体执行后的副作用、网络副作用、技能正文、模型推理流（reasoning-delta）、MCP server 自身、更早第三方监听器的拦截——**不在覆盖范围**。插件顺序只有 prepend 最佳努力 + guard 单调兜底，没有绝对第一。侦察命令（whoami 等）不拦是明确决策。完整清单：MANUAL §11（22 条）。

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
4. **测试账本只增不减**：当前 60 文件 / 932 用例是下限。新行为必须带用例；修 bug 先写复现用例。`tests/perf.test.ts` 有 p99 门（5ms），正则改动必须加对抗用例（1.15.1 教训：无界前缀 = 全套卡死数分钟）；**新加的 perf 用例规模要克制**（见 §5 最后一行）。
5. **面板写入**：走 revision CAS；`tools`/`results`/`approval`/`rules`/`patrol` 各自对象合并，不与同面 `mode` 互相覆盖；非法值**一个字节都不写**。客户端 dirty 判定见 §4 P0（1.15.2 已修，改之前先读 `tests/settings-form.test.ts` 与 `tests/panel-settings.test.tsx`）。
6. **宿主版本门**：`PINNED_VERSIONS` / `PREVIOUSLY_VERIFIED_VERSIONS` 两表**只加不删**；删表项 = 宣布不再支持该宿主，需单独发版说明。
7. **发布**：流程照 `docs/handoff-2026-11-18.md` §14（worktree、leak 检查、公开树测试口径、tag 不重写）。`docs/` 目录不入公开树。
8. **写文档/注释别带凭据样例**（`key = "真实形状"`）：1.15.1 起三面都会拦，读者会看不到那段文字。用占位符形状。
9. **本机构建**：pnpm 是坏的（全局 packageManager 冲突），用 `node node_modules/typescript/bin/tsc`、`node node_modules/vitest/vitest.mjs` 直调；构建三步 + `npm pack`（handoff §14 有完整命令）。

---

## 4. 当前任务清单（接手即干，按优先级）

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

**部署状态**：1.16.1 已装进 desktop profile（`backup-1.16.0` / `backup-1.16.1` 备份目录已建），**但宿主进程里跑的还是 1.15.2**——要重启 DSH 桌面版（含托盘退出）才生效。**公开仓 `v1.16.x` 仍未发布**（建议 1.16.0 与 1.16.1 合并成一次 `v1.16.1`）。

### P1.5 — 判官"空回答"（只读取证已完成，**不改代码**）

真实账本里 19 条 `judge_status: empty`：模型调用了、token 也计费（`usage_output` 中位数 690，最大 11579），但一个 `text-delta` 都没吐。按状态分组看相关性很清楚——`ok` 组正文中位数 275 字符，`empty` 组只有 **90** 字符（最小 18），`timeout` 组 3861 字符：**正文越短越容易空回，长正文则超时**。行为本身是对的（空回答记 `unavailable`，不是 `allow`）。下一步是换一条对短 prompt 稳定的判官路由，或给 `scope` 加一档"只审长回答"，两者都要更多样本再定。细节与不这么改的理由写在 MANUAL §11 第 24 条。

### P2 — 其余

`docs/handoff-2026-11-18.md` §16（剩余工作）与 `docs/plan-2026-11-18.md` §2/§3 的收尾项；环境项（真实 IM webhook 投递、真实 `approval: ask` 人工点击）需要部署侧配合。**明确不做**（不要提案）：记忆/embedding、租户、PG 审计 sink、工具网关回执与重放、管理面受控变更、进化闸门、OS 沙箱实现、外部智能体监督器、面板写 packaged `rules/`、重写已发布 tag。

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
| 测试口径 | 本机 60 文件/932 用例 ≥ 公开树口径（每版 CHANGELOG 记录），新增用例不减少 |
| perf 用例写得太大 | 1.16.0 踩过：400×5 次 × 64 KiB 的新用例分配约 128 MB，把 GC 停顿推给它**上面几行**的 `scanToolResult` 预算（全量 4 次里 3 次失败；未改动的树 1/4）。预算用例要小、要放在最后，别干扰邻居 |

---

*本文由主项目 Agent 于 2026-11-20 基于代码树、CHANGELOG（1.9.5–1.16.0）、plan 与 handoff 交叉核对写成；同日两次更新：1.15.2 收口（版本/用例数/P0 状态）与 1.16.0 落地（参数形状规则、判官空回答取证、perf 用例规模教训）。发现与代码不符时，以代码为准并把差异修进本文。*
