# @upear/dsh-safeharness

> 完整手册。包根目录的 [README.md](README.md) 是给插件页与 npm 用的简短门面；本文保留原全文，章节号不变（`README §4.7` 一类引用都指向这里）。

DeepSeek Harness（DSH）的智能体安全插件：把 SafeHarness 的安全语义装进 DSH 的执行生命周期——输入防线、工具调用管控、工具结果守卫、输出复查、语义 judge、审批桥、审计账本、姿态自检与外部巡检，全部以一个 **profile 级 Cordis 插件包** 交付。

> 版本 `1.19.0` · 宿主 DSH `0.2.2-rc.5`（兼容 `0.2.2-rc.3`）· Node ≥ 24 · 运行时零第三方依赖 · Apache-2.0 · 变更历史见 [CHANGELOG.md](CHANGELOG.md)

- [1. 这是什么（以及不是什么）](#1-这是什么以及不是什么)
- [2. 安全能力](#2-安全能力)
- [3. 快速开始](#3-快速开始)
- [4. 配置](#4-配置)
- [5. 预设与失败语义](#5-预设与失败语义)
- [6. 审计账本与隐私](#6-审计账本与隐私)
- [7. 运维面：工具与命令](#7-运维面工具与命令)
- [8. 与其它仓库的关系](#8-与其它仓库的关系)
- [9. 架构与目录](#9-架构与目录)
- [10. 开发与测试](#10-开发与测试)
- [11. 已知限制](#11-已知限制)
- [12. 安全边界与许可](#12-安全边界与许可)

---

## 1. 这是什么（以及不是什么）

**是**：一个装进 DSH profile 的插件。DSH 用 Cordis 组织插件，一个 profile 的插件清单在 `package.json` 的 `dsh.profile.bundles` 与 `cordis.patch.yml` 里；本包在 `cordis.patch.yml` 中以 `insert:` 方式挂载后，直接接管 DSH 的五个执行接缝（见 §2），把安全判定放在模型与工具之间。

**不是**：

- **不是 Agent 预设（preset）**。DSH 的 Agent 预设是配置文件，本包是可执行插件；本仓库不附带任何 `agent.cordis.yml`。
- **不是对 DSH 的修改**。不 patch DSH 源码、不改宿主 bundle，只使用公开的 Cordis 事件与 `ctx.tools.guard()`。
- **不是 Python 侧实现的打包**。本包是独立的 TypeScript 重写，运行时不依赖 Python、不启动子进程、不发额外网络请求（语义 judge 走宿主自己的 `ctx.llm`）。
- **不承诺"不可绕过"**。DSH 是"无特权核心"的插件化运行时：**插件可被停用、可被替换**。本插件承诺的是"**每步可观测 + 执行面 fail-closed + 插件外巡检兜底**"，而不是内核级强制。

---

## 2. 安全能力

插件把 SafeHarness 的四层模型（信息输入 → 决策推理 → 动作执行 → 监督审计）映射到 DSH 的真实接缝上。**所有判定结果都写入审计账本；执行面任何未知/异常一律 deny。**

```
用户输入 ──► agent/pre-step ──────────► 输入防线（20 条注入规则，deny/warn）
                    │
                    ▼
             模型推理 ──► llm/stream ────► 输出复查（结构化命中 + 可选语义 judge）
                    │
                    ▼
         工具调用 ──► tools/pre-execute ─► 工具策略（deny/ask、参数、SQL、轨迹链）
                    │   ctx.tools.guard ──► 同步兜底（不能 await，异常即 deny）
                    ▼
             工具结果 ──► tools/post-execute ► 结果守卫（凭据/注入标记，可阻断）
                    │   tools/result ──────► 只读观察 + 账本
                    ▼
             审批请求 ──► approval/request ► 审批桥（allowOnce / deny / delegate）
                    │
                    ▼
        全程 ──► NDJSON 哈希链账本 ◄── 姿态自检（11 项）· 外部巡检（5 项）· 预算护栏
```

| 接缝 | 能力 | 拦截语义 |
|---|---|---|
| `agent/pre-step` | 用户输入注入检测：`rules/inform.yaml` 的 20 条中英文规则（prompt injection / instruction override / identity impersonation / hidden command），critical 规则直接 deny；超长输入截断后匹配并记 WARN | `{kind:'reject'}` 或放行 |
| `tools/pre-execute` | 工具名 glob 的 `denyTools` / `askTools`、语义标签 `denyTags`、参数字节上限、参数内 SQL 结构判定（1.2.2 起只扫**执行面**工具，见 §4.6；`DROP`/`DELETE`/`INTO OUTFILE` 等）、轨迹链规则（工具 A → 工具 B，限 `max_gap`） | allow / deny / ask |
| `ctx.tools.guard()` | 与 pre-execute 同源的**同步**判定；不能 await、不碰 IO，异常一律 deny | `string \| undefined`（返回即拒绝原因） |
| `tools/post-execute` | 工具结果守卫：凭据形态（私钥/API key/高熵令牌）、注入标记（如工具结果里伪造的指令）、被拒重试压力；命中可整条替换或阻断 | accept / block |
| `tools/result` | 只读观察工具结果，写账本，不改变结果 | — |
| `llm/stream` | 输出复查：结构化复核 + 凭据扫描（1.15.1 起）+ 可选语义 judge（走宿主 `ctx.llm`）。`warn` 记账**并把凭据形态值在流里替换为 `[REDACTED:credential]`**；`enforce-buffer` 会缓冲整条回答后决定回放或替换 | 透传（已脱敏）/ 替换 |
| `approval/request` | 审批桥粗粒度判定：`allowOnce` 一次性授予 → 复用 deny 列表 → 其余 delegate；`delegate` 也写审计对，供巡检对账 | 授予 / 拒绝 / 委托 |
| 系统提示词 | 在工具引导区（`order: 190`）注入 ≤300 字符的部署约束条款，**不含**规则正文、数量、阈值 | — |
| 只读工具 / 命令 | 4 个 `safeharness_*` 工具 + `/safeharness` 命令，供模型与操作者自查 | — |
| Web 面板（1.3.0 起，1.8.0 自定义模型 + 导出） | 插件 → `SafeHarness` 条目页 → 五个标签：**概览**（本进程计数、防护面胶囊、评审状态、会话列表、规则/账本/账本片段导出）、**事件**（工作区/对话标题/类别/结论四重筛选 + 搜索 + 20 条分页）、**规则**（规则与链清单、搜索、AI 起草、重新加载规则）、**巡检**（手动两步确认 + 5–1440 分钟定时）、**设置**（语义评审与起草路由、模型目录、自定义模型 URL/Key/协议、连接测试、经宿主 settings 服务写入）。工作区/对话选项跨重启保留（`sessions.json` 元数据索引 + 账本会话并集）；标题来自宿主 `sessionTitle` 服务，只用于显示。全部 POST-only、有单飞/冷却/body 上限；数据走宿主 `webServer` 私有路由（loopback + 同源栅栏）。见 §4.7 / §4.8 | — |
| 姿态 / 巡检 | 加载时姿态门禁（可配 `failOn`）、5 项外部巡检与退出码（0/1/2）、可选多通道通知（飞书 / 钉钉 / 企业微信 / OneBot / 通用 webhook） | 拒绝加载 / FAIL |
| 预算 | 每轮 `input+output` token 累计，越限只记一条 `budget_exceeded`（不拦截） | — |

### 2.1 输入防线

- 规则来自 `rules/inform.yaml`，与 Python 侧 `_DEFAULT_PATTERNS` 逐条同源（20 条，正则文本逐字移植，`iu` 标志）。
- 严重度：critical（纯指令覆盖）可 deny；high 只记录。
- 输入超长（默认 60000 字符）先截断再匹配；截断本身记 WARN，不单独拒绝。
- 拒绝话术是固定的一句通用说明，不回显命中内容；被拒输入不会进入模型历史。
- **归一化（1.11.0）**：匹配前先去零宽字符与 HTML 注释、再 NFKC 折叠，所以 `ig\u200Bnore`、全角 `ＩＧＮＯＲＥ` 与明文命中同一批规则；清洗后放行的回合以清洗文本进入模型（详见 §4.9）。
- **输入语义评审（1.11.0）**：`input.judge: flagged`（默认）时，结构规则命中但未拒绝的回合额外做一次模型复核；`block` 直接拒，无结论按 `input.judgeFailClosed` 处理（详见 §4.9）。

### 2.2 工具执行面

- `denyTools` / `askTools` 只支持 `*` 通配，大小写不敏感；`denyTags` 使用语义标签（`shell` / `network` / `file-write` 等），可用 `tools.tagOverrides` 覆盖工具名→标签映射。
- 参数扫描有**节点数与字符数预算**，遇到循环引用/超深结构不会爆栈，直接 fail-closed deny。
- SQL 判定是结构判定：危险关键字、批处理、导出子句；`SELECT 1; SELECT 2` 不算危险。
- **SQL 判定只作用于能执行它的工具**（1.2.2，R42）：`db_query` / `pwsh` / `bash` / `mcp__postgres_query` 这类"执行面"工具照旧扫；`write` / `edit` / `apply_patch` / `read` 这类只落文本的工具不再因为**引用**一条破坏性语句被拒（写文档、写测试夹具、写迁移脚本都需要引用）。无法识别的工具名仍按旧规则扫描（fail-closed）；`tools.sqlScan: all` 可一键回到 1.2.1 语义。详见 §4.6。
- 轨迹链规则默认 3 条（例如"先读凭据再外联"一类组合）；链规则只认工具名正则或标签，不依赖操作者额外配置。
- **SQL 表白名单（1.12.0）**：`tools.sql.allowedTables` 非空时，被扫描参数里的每个表引用都必须命中白名单（`public.users` 按裸表名 `users` 匹配），否则 `unauthorized_sql_table`；破坏性语句仍先按危险 SQL 拒绝。
- **工具描述符扫描（1.12.0）**：`tools.descriptorScan`（默认 `warn`）用注入规则扫工具自身的 name/description；`warn` 每会话每工具记一次 `tool_descriptor_flagged`，`enforce` 每次调用都拒。
- **轨迹阈值（1.12.0）**：`tools.repeatedAttemptThreshold`（同一工具连续失败达到阈值即拒，成功清零）与 `tools.entropyThreshold` + `entropyMinLength`（长字符串参数的 Shannon 熵越界即拒），两者默认 0 = 关闭。
- **PII 10 类（1.12.0）**：`results.pii`（默认开）把内核 `memory/sanitizer.py` 的十条正则用于工具结果，产出 `pii` 类别事件；默认只告警，拦截需把 `pii` 加进 `results.blockOn`。详见 §4.10。
- 同步 guard 是最后一道内联兜底：pre-execute 是异步的，guard 是同步的；两者都对结果写账本。

### 2.3 输出面与语义 judge

- `output.mode: warn`：记录 `output_reviewed`，并且**在流里脱敏凭据**（1.15.1）。普通文本逐字透传；`sk-`、`Bearer`、私钥头、`api_key: "…"` 这类赋值、以及 40 字符以上高熵令牌会被替换成 `[REDACTED:credential]`。为了让**跨 delta 拆分**的密钥也能匹配，流会保留 `REDACT_TAIL_CHARS`（256）个字符的窗口——代价是首字延迟约这几百字符，普通文本内容不变。账本记 `labels.redacted=credential` 与 `metrics.redacted_count`。
- `output.mode: enforce-buffer`：缓冲整条回答后再决定回放还是替换——**代价是牺牲流式**，首字延迟等于整条生成时间；受 `bufferTimeoutMs`（默认 15000）与 `bufferMaxChars`（默认 512000）约束，超限**降级为透传**并在账本记 `labels.buffer=timeout|max_chars`，不会静默吞回答。命中凭据或规则命中时整条替换为固定拒绝话术。
- **judge 预算与空回答重试（1.19.0）**：单次调用预算 4096 token（原来 2048——实测思考模型会把 2048 全花在思考上，`response_chars=0` 而 `usage_output` 上千）。若首次返回**完全没有文本**，用 8192 预算重试一次，并在指令后追加「立刻只回 JSON」；成功后账本记 `labels.attempts=2`。**`bad_json` 与 `timeout` 不重试**（再问一次不会让 JSON 可解析，deadline 也已花光），重试**不会越过操作者设定的 deadline**。
- 可选 judge（默认关闭）：通过宿主 `ctx.llm` 做一次结构化复核，`scope: flagged` 只复核已被结构化规则命中的回答（省成本），`always` 每答必审。judge 不可用/超时/坏 JSON 时按预设降级：`hardened` 拒绝输出，`observe`/`balanced` 记 WARN 放行。judge 自己的模型调用带内部标记，**不会被再次复核**（递归防护）；只有 tool_calls、没有文本的回答不送 judge。

### 2.4 审计、姿态、巡检、预算

- **审计**：单行 JSON、哈希链（`prev_sha256`）、按字段名脱敏、按大小轮转；只存哈希与长度，不存原文（详见 §6）。
- **姿态**（11 项）：`sandbox_danger_full_access`、`approval_never`、`hmr_enabled`、`rules_loaded`、`ledger_writable`、`ledger_chain_ok`、`output_guard_off`、`judge_unavailable`、`plugin_version_mismatch`、`engine_sidecar_unavailable`、`arg_schema_invalid`。`posture.failOn` 里的 code 一旦 FAIL，`apply()` 抛错拒绝加载。`arg_schema_invalid` 只报 WARN，默认不进 `failOn`（一个可选 schema 的笔误不该拒绝加载，理由见 §4.11）。**`sandbox_danger_full_access` 判定的是"实际在跑的会话"**：DSH 按会话解析沙箱模式，1.16.2 起这一项取部署默认与所有已观察会话中最宽的那个，读不到模式的会话按 WARN 计（详见 §5.2）。**`hmr_enabled` 判的是"有没有一条启用的 HMR 行"**：1.16.3 起读 `entry.options.name` 并匹配 `cordis-plugin-hmr`（1.16.2 及以前读的是不存在的 `entry.name`、匹配的是从未存在过的 `dsh-hmr`，所以这一项对任何部署都恒报 "not composed"）；读不到 loader 时记 SKIP，**不猜成"没启用"**——`hardened` 的 `failOn` 只认 FAIL，猜错就是静默放行（详见 §5.3）。
- **巡检**（5 项）：`audit_rate`（拒绝速率异常）、`health_probe`（GET 探针）、`config_drift`（与上次姿态报告对比）、`ledger_reconcile`（`tool_asked` vs `approval_decided` 对账）、`notify`（可选，多个通道）。退出码 `0` 干净、`1` 有 FAIL、`2` 巡检自身出错；巡检函数**从不抛异常**。
- **预算**：`budget.maxTokensPerTurn > 0` 时按轮累计，越限只 warn（一个回合只记一条）。

---

## 3. 快速开始

### 3.1 前置

| 依赖 | 要求 | 说明 |
|---|---|---|
| DSH | `0.2.2-rc.5`（兼容 `0.2.2-rc.3`） | 桌面应用自带 CLI：Windows 在 `<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd`，其它平台同理 |
| Node | ≥ 24 | 构建与测试；宿主机自带 24.21.0 |
| pnpm | 9+ | 仅构建期使用 |
| 宿主包 | 由 DSH 安装提供 | `@deepseek-ai/*` **不在公共 npm 上**，构建时用 `scripts/link-dsh.mjs` 链接本地安装 |

### 3.2 构建

```bash
git clone https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh.git
cd JueeeX-Upear-SafeHarnessSuite-dsh

# 把 DSH 安装里的宿主包 junction 到本仓库 node_modules（构建期类型来源）
node scripts/link-dsh.mjs
pnpm install
pnpm build            # 宿主半 tsc → lib/；浏览器半 tsc 类型检查 + esbuild → lib/client.js
pnpm test             # 860 个用例（55 个文件）

# 产出可分发的 tarball
pnpm pack --pack-destination ./dist
# -> dist/upear-dsh-safeharness-<ver>.tgz（lib + rules + cordis.patch.yml + sidecar 脚本 + README + MANUAL + LICENSE）
```

`link-dsh.mjs` 默认从 `$DSH_HOME`（默认 `~/.dsh`）的 `profiles/node_modules` 找宿主包；如果你的 DSH 是桌面版，可显式指定：

```powershell
$env:DSH_NODE_MODULES = 'C:\Program Files\<DSH>\resources\app.asar.unpacked\node_modules'
node scripts/link-dsh.mjs
```

### 3.3 安装到 profile

```powershell
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'   # 或 PATH 里的 dsh
& $dsh plugin --profile <profile> add "file:$PWD\dist\upear-dsh-safeharness-<ver>.tgz"
```

开发期也可以直接从目录装（pnpm 会把包**复制**进 profile，不是软链）：

```powershell
& $dsh plugin --profile <profile> add 'file:<本仓库绝对路径>'
```

> **不要用系统里的 pnpm 去装这个 profile。** profile 的 `node_modules` 必须由 **DSH 自带的那份 pnpm** 创建：桌面版 0.2.2-rc.5 自带 pnpm 11.28.5（store `…\store\v11`）。如果这个目录曾经被另一个主版本的 pnpm（比如系统里的 pnpm 10，store `…\store\v10`）写过，pnpm 会拒绝继续操作并报 `ERR_PNPM_UNEXPECTED_STORE`；安装脚本若先删掉了旧包，就会出现启动错误 `cannot resolve profile bundle "@upear/dsh-safeharness"`。修法是：**删掉 profile 的 `node_modules`，再用 `dsh plugin ... add`（或 `dsh plugin --profile <profile> install`）重装**，让自带的 pnpm 重建。仓库根目录的 `.npmrc` 若设置了 `store-dir`，手动 `pnpm install` 更容易踩这个坑——装 profile 一律走 `dsh` CLI。

**从 1.9.2 起，这个包装好就是"插件"，装完不需要再写 patch。** 包里带 `cordis.patch.yml` 并在 `package.json` 声明了 `dsh.bundle.patch`，所以它是一个 DSH **组合包（bundle）**：安装动作会把它写进 profile 的 `dsh.profile.bundles`，启动时由它自带的 patch 挂载 `safeharness` 这一行，「插件」页里也会出现它自己的条目页。

**1.9.3 起，面板就画在这个条目页的正文里。** 浏览器半侧同时注册宿主声明的三个配置槽：`plugins.bundle.config`（键是包名，渲染在组合包页面的文档之后、行之前）、`plugins.row.config`（键是 `<包名>#<行 id>`，让 `safeharness` 那一行多出「配置」控件）和 `settings.plugins.tab`（设置里的标签页，保留给没有组合包页面的 profile）。所以点进插件看到的就是工作台。

> 宿主把**包文档（README）**画在配置区之前，文档越长工作台越靠下。1.9.4 起包根 README 收成简短门面（完整手册移到 `MANUAL.md`，章节号不变）；1.9.5 起 README 只留简介 + GitHub 绝对链接，并在页头注册「完整文档」按钮（`plugins.detail.actions`）直接打开本手册。页内折叠做不到——宿主的详情文档是**纯 Markdown**：raw HTML 被丢弃、相对链接不可点，所以长文只能放在外部链接里。

> 1.9.1 及更早的包**只有 `dsh.client`、没有 `dsh.bundle.patch`**，只能靠手写 `insert:` 挂载。那种装法功能照常，但宿主不会把它当成组合包，于是插件页没有条目页、**面板在桌面 app 里点不到**（1.9.1 实测发现，见 CHANGELOG 1.9.2）。

### 3.4 启用与覆盖（可选）

**组合包装好后不需要额外配置**，插件用 schema 默认值启动（`preset: balanced`、`input/tools/results = enforce`、`output = warn`、`approval = delegate`）。

要改配置（评审模型、`rules.dir`、模式等），在 `$DSH_HOME\profiles\<profile>\cordis.patch.yml` 里按 **id 覆盖**——注意这里**不要**再写 `insert:` 和 `name:`，否则同一 id 会出现两行：

```yaml
- id: safeharness
  config:
    preset: balanced          # observe | balanced | hardened
    audit:
      dir: ""                 # 空 = $DSH_HOME/safeharness/audit
    rules:
      dir: 'C:\Users\<you>\.dsh\safeharness\rules'   # 面板「写入并重载」的目标目录
```

> 覆盖是**整体替换**该行的 `config`，不是逐键合并：写几个键，其余键就回到 schema 默认值。所以覆盖时把要保留的键都写全。

推荐的"不变量"配套（评估/加固环境建议启用；这两行仍是 `insert:`，因为它们不是本包的组合包行）：

```yaml
- insert:
    - id: invariants
      name: "@deepseek-ai/dsh-invariants"
    - id: safeharness-invariant
      name: "@upear/dsh-safeharness/invariant"
```

仓库里的 [`examples/cordis.patch.example.yml`](examples/cordis.patch.example.yml) 是可直接抄的完整示例。

### 3.5 验证

重启 profile 后：

```powershell
# 1) 账本第一条应为 plugin_loaded
Get-Content "$env:DSH_HOME\safeharness\audit\ledger.ndjson" -Encoding UTF8 | Select-Object -Last 1

# 2) 模型可调用只读工具，应返回 preset、规则 hash、账本健康、各面 mode
#    safeharness_status {}

# 3) 用一条明显的注入话术试输入防线（balanced/hardened 应被拒）
```

> `1.2.2` 已在桌面端（DSH 桌面应用，宿主包走 app-bundle `0.2.2-rc.1`）实测：`safeharness_status` 返回 `version: 1.2.2`、八个接缝全 `true`（含 `settings`）、`engine.kind: builtin`；`safeharness_posture` 无 FAIL。`1.3.0`–`1.8.0` 的面板在同一个 0.2.2 Web 壳里实测：设置 → 内置插件出现 `SafeHarness` 标签页；1.5.0 的事件卡片按结论着色；1.6.0 的四标签、标题下拉、规则清单、AI 起草（真实调用 `liao/gpt-6-luna`）与定时巡检；1.7.0 的五标签、跨重启工作区/对话筛选、评审设置保存与真实 judge probe（`status: ok / 3685ms`）；1.8.0 的自定义模型（本地 fake OpenAI：添加 → 评审路由自动切换 → probe `ok/allow/96ms` → 在用删除被拒 → 清空路由后删除成功）与账本导出（200 条 NDJSON、146,838 B）均实测通过；1.4.0 的巡检按钮跑出 5 项检查并回写 `patrol_report`（详见 §4.7 / §4.8）。桌面升级方式见 §3.6 与仓库外脚本 `install-safeharness-desktop.cmd`。

> `1.9.2` 起改为**组合包（bundle）**安装：包里带 `cordis.patch.yml` 且 `package.json` 声明 `dsh.bundle.patch`，安装动作本身就把插件挂上，宿主「插件」页出现 `SafeHarness` 条目页，面板五个标签从那里点开。此前（≤1.9.1）只能靠手写 `insert:` 挂载——功能正常但宿主不认为它是组合包，**桌面 app 里没有面板入口**（1.9.1 用真实登录 cookie + headless 浏览器实测确认，见 CHANGELOG 1.9.2）。

### 3.6 升级与卸载

```powershell
# 升级：复制式安装，必须 remove + add，不能只覆盖目录
& $dsh plugin --profile <profile> remove '@upear/dsh-safeharness'
& $dsh plugin --profile <profile> add "file:<新版本 tgz>"
# 重启后核对最新 plugin_loaded 的 labels.version

# 卸载
& $dsh plugin --profile <profile> remove '@upear/dsh-safeharness'
# 再从 cordis.patch.yml 删掉对应 insert；账本可保留作证据，也可手动删 $DSH_HOME\safeharness\
```

升级前请保留旧账本：每条记录带 `plugin_version` 与 `ruleset_hash`，账本格式 `v:1` 稳定，新旧版本可混读。

---

## 4. 配置

配置从 profile patch 的 entry `config` 传入。宿主 0.2.2-rc.1 起的设置页会**自动**从插件导出的 `Config` 生成表单：标了 `.volatile()` 的字段可在线改、即时生效（不重挂载），其余字段（`preset`、`engine`、`rules`、`audit`、通知地址等）仍只在 patch 里改——写这些字段会重挂载 entry，坏值由宿主配置编辑器回滚。详见 §4.5。

```yaml
config:
  preset: balanced                        # observe | balanced | hardened
  engine:                                 # 1.2.0：可选 Python 输入引擎（默认 builtin）
    kind: builtin                         # builtin | sidecar
    command: ""                           # sidecar 时的可执行文件，例如 C:/Python314/python.exe
    args: []                              # 例如 ["-u", "…/scripts/safeharness_sidecar.py", "--framework", "…/src"]
    cwd: ""
    timeoutMs: 1500                       # 单次输入判定超时
    startTimeoutMs: 10000                 # 握手超时
  rules: { dir: "", watch: true, inline: [] }
  input: { mode: enforce, maxChars: 60000 }
  tools:
    mode: enforce
    denyTools: ["bash", "pwsh"]           # 工具名 glob（只支持 *）
    askTools: ["mcp_*"]
    denyTags: ["network"]
    maxArgsBytes: 65536
    sqlScan: execution                     # execution（默认）| all：谁被扫危险 SQL，见 §4.6
    trajectory: true
    tagOverrides:                          # 工具名 → 语义标签
      - { pattern: "bash*", tags: [shell] }
      - { pattern: "web_*", tags: [network, egress] }
  results:
    mode: warn
    blockOn: ["credential_leak"]           # 仅 mode: enforce 时生效
  output:
    mode: warn                             # off | warn | enforce-buffer
    bufferTimeoutMs: 15000
    bufferMaxChars: 512000
    judge:
      enabled: false                       # 语义复核，走宿主 ctx.llm
      scope: flagged                       # flagged | always
      provider: ""                         # 例如 "fake" 或真实 provider 路由 id
      model: ""
      maxChars: 12000
      timeoutMs: 4000
  approval: { mode: delegate, allowOnce: [] }
  audit: { format: ndjson, dir: "", redact: true, hashChain: true, required: true, rotateMb: 64 }
  posture: { onLoad: true, failOn: [] }
  patrol:
    windowMinutes: 10
    baselineWindows: 6
    factor: 5
    minCount: 10
    healthUrls: []
    notify:                                 # 0..N 个通道；URL/secret 永不打印、永不写账本
      - { type: dingtalk, webhook: "https://oapi.dingtalk.com/robot/send?access_token=…", secret: "…" }
      - { type: wecom,    webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" }
      - { type: feishu,   webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/…" }
      - { type: onebot,   webhook: "http://127.0.0.1:5700/", groupId: "123456", accessToken: "…" }
      - { type: generic,  webhook: "https://your-bot.example/hook", body: "{\"text\":\"{{text}}\"}" }
    # 兼容旧字段：feishuWebhook: "…"        # 等价于一条 feishu 通道
  budget: { maxTokensPerTurn: 0 }          # 0 = 关闭；>0 时每轮越限记 budget_exceeded
  draft:                                   # LLM 辅助规则起草（只出草稿，永不自动生效）
    enabled: true
    provider: ""                           # 留空 = 复用 output.judge 的路由
    model: ""
    maxChars: 500                          # 描述文本上限（送进模型的字符数）
    timeoutMs: 60000
    maxTokens: 2048
```

字段要点：

- `input.maxChars`：超长文本截断后匹配（只记 WARN）。
- `tools.mode: warn`：判定与记录照常，但不拦截。
- `results.blockOn`：只在 `results.mode: enforce` 时生效；命中即整条结果被替换（内容替换是保密边界，所以作用于整条结果）。
- `output.mode: warn`：记账 + 流内凭据脱敏（1.15.1）；普通文本不改，凭据形态值替换为 `[REDACTED:credential]`，代价是 256 字符的尾部窗口（首字延迟）。
- `output.mode: enforce-buffer`：牺牲流式，首字延迟 = 整条生成时间；超时/超长降级为透传并留痕；命中凭据/规则时整条替换。
- `output.judge`：不自建 HTTP 客户端，走宿主 `ctx.llm`；不可用时按预设降级（hardened 拒绝输出）。
- `approval.mode: policy`：只做粗粒度判定；`approval/request` 不携带工具参数，**不要**把它当第二套策略引擎。`allowOnce` 与 deny 列表同时命中时**授予优先**（部署方不要同时写两边）。
- `posture.failOn`：列出的 code 一旦 FAIL 即拒绝加载（建议只在 hardened 开启）。
- `patrol.notify`：0..N 个通知通道（见 §4.2）；通道 URL、签名 secret、bearer token 都按凭据处理，永不打印、永不入账本；通知正文只有 `Upear SafeHarness: N FAIL / M WARN`。旧的 `patrol.feishuWebhook` 仍可用，等价于一条 `feishu` 通道。
- `draft`：LLM 辅助规则起草（§4.3）。它只发一次辅助模型调用、返回**草稿**，不改规则集、不写文件；`provider`/`model` 留空时复用 `output.judge` 的路由。
- `engine`：可选 Python 输入引擎（§4.4）。缺省 `builtin` 就是 1.1.x 的行为；`sidecar` 只接管输入面，工具面/结果面/输出面仍是内置引擎。
- 优先级：显式字段 > 预设 > 基础默认；`resolveConfig` 输出深冻结。

### 4.1 语义 judge 的模型 URL 与 Key 怎么填

`output.judge` 不自建 HTTP 客户端，它通过宿主的 `ctx.llm` 发一次 Chat 调用。因此 **URL 与 Key 不写在插件配置里**，而是填在 DSH 的模型服务商（provider）配置里；插件只填 `provider` + `model` 两个路由字段。

**A. 复用聊天模型（最省事）**：桌面端 **设置 → 模型**（Settings → Models）里已经配好的服务商直接可用，插件里把 `output.judge.provider` / `model` 填成该服务商 id 与模型 id 即可。

**B. 给 judge 单开一条服务商（推荐：用便宜/快的模型，独立配额）**：在桌面端 **设置 → 模型** 里新增一条路由并填 `base URL` 与 `key`（设置页会把 key 写进凭据库，不覆盖 profile），然后在插件里把 `output.judge.provider` / `model` 指向它。

如果坚持手写 profile patch，给 `@deepseek-ai/dsh-llm-pi-ai` 增加一项：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      judge:                                  # ← 这个名字就是插件里的 judge.provider
        api: openai-completions               # 非内置目录的路由需要显式协议
        baseURL: https://your-endpoint.example/v1
        apiKeyEnv: SAFEHARNESS_JUDGE_API_KEY  # 只写"引用名"，不写 Key 本身
        models:
          - id: your-model-id
            name: your-model-id
```

> ⚠️ patch 条目的 `config` 是**整段替换**，不是深合并：实测只手写 `judge` 会让原来的 `liao` 等 provider 从合成树里消失，主对话模型随之不可用。手写 patch 时**必须把已有 providers 一起抄进来**；只想新增路由就用设置页。


Key 本身放在下面任一位置，**永远不要写进 `cordis.patch.yml`、仓库或账本**：

| 方式 | 位置 | 说明 |
|---|---|---|
| 凭据库（推荐） | `$DSH_HOME/.credentials.yaml`（权限 0600） | 一行 `SAFEHARNESS_JUDGE_API_KEY: sk-…`；设置页写入的 Key 也落在这里 |
| 进程环境变量 | `SAFEHARNESS_JUDGE_API_KEY=…` | 启动前设置，优先级最高，本次运行有效 |
| `.env` | `$DSH_HOME/.env` 或项目根 `.env` | 与 DSH 其它模型 Key 的放置方式一致 |

插件侧只需要：

```yaml
output:
  judge:
    enabled: true
    scope: flagged              # 只复核已被结构化规则命中的回答，省成本
    provider: judge             # ← 上面 providers 里的名字
    model: your-model-id
    maxChars: 12000
    timeoutMs: 6000
```

填完先自检，再开拦截：

```text
/safeharness judge            # 只看路由与 llm 服务是否就绪，不打模型、不花钱
/safeharness judge probe      # 真打一次（一句 canary），只打印 status/verdict/耗时，不打印任何内容
```

`probe` 走的就是输出守卫将来要走的同一条路由，所以 `status=ok` 表示 URL、Key、模型 id 三者都通。失败时按状态给出原因：`status=error`（路由/凭据问题，宿主会报 `MISSING_CREDENTIAL` 或连接失败）、`status=timeout`、`status=bad_json`（模型没按 JSON 回答）、`status=unavailable`（这个 profile 没装 `llm` 服务）。

失败语义不变：`observe`/`balanced` 记 WARN 放行；`hardened` 在 judge 不可用时**拒绝输出**，并且 `enabled: true` 却没填 `provider`/`model` 会直接拒绝加载。离线演示可把 `baseURL` 指向本仓库的假模型（`node scripts/fake-openai.mjs`，Key 填占位符），零成本跑通同一条链路。

### 4.2 通知通道（飞书 / 钉钉 / 企业微信 / OneBot / 通用）

巡检只在**报告不干净**（有 FAIL 或 WARN）时发通知，正文固定是计数句 `Upear SafeHarness: N FAIL / M WARN`，可以同时配多个通道。

| `type` | 请求体 | 额外字段 |
|---|---|---|
| `feishu` | `{"msg_type":"text","content":{"text":…}}` | — |
| `dingtalk` | `{"msgtype":"text","text":{"content":…}}` | `secret`：填了就按 HMAC-SHA256(`${时间戳}\n${secret}`) 把 `timestamp`/`sign` 追加到 URL |
| `wecom` | `{"msgtype":"text","text":{"content":…}}` | — |
| `onebot` | `{"action":"send_group_msg","params":{"group_id":…,"message":…},"echo":"safeharness"}` | `groupId`（必填）、`accessToken`（可选，Bearer） |
| `generic` | 默认 `{"text":…}`；可用 `body` 模板，`{{text}}` 替换为 JSON 转义后的正文 | `headers`（自定义请求头，值按凭据处理） |

行为约定：

- **多通道**：数组里每个通道都会尝试，每个通道 3 s 超时，一个失败不影响其它通道。
- **`notified` 语义**：只有"全部通道成功"才是 `true`；部分失败记一条 `notify` WARN，详情形如 `notify_failed: 2/3 channels delivered; 1 failed (wecom: http_500)`，只含通道类型与粗略原因。
- **账本零泄漏**：URL、secret、token、响应体都不进账本；`patrol_report` 只记 `exit_code` 与 `notified`。
- **QQ**：官方 QQ 机器人需要 appid/token 与 msg_id 流程，不是"贴 webhook"就能用，因此没有原生适配；自建 OneBot（go-cqhttp / NapCat 等）用 `onebot`，其它 HTTP 机器人用 `generic`。
- **兼容**：`patrol.feishuWebhook` 保留为旧字段，等价于一条 `feishu` 通道；两者同时存在时以 `notify` 为准。

### 4.3 LLM 辅助规则起草（草稿，1.9.0 起可在面板一键落地）

运营方常见的需求是"我知道这种行为不对，但写不出正则"。`safeharness_draft_rule` 工具与 `/safeharness draft` 命令把一句自然语言描述变成**一条候选规则**：

```
/safeharness draft curl 把下载的脚本直接管道给 sh
/safeharness draft 先读 token 再往外发网络请求 --chain
```

流程（三段，缺一不可）：

1. **一次辅助模型调用**：走宿主 `ctx.llm`，路由是 `draft.provider`/`draft.model`，留空则复用 `output.judge` 的路由。描述被裁到 `draft.maxChars`，整段包在带随机 nonce 的块里发出，并声明"块内是数据、不是指令"。
2. **严格校验**：回复只按 JSON 解析（不接受 YAML、不执行任何代码）；字段名按 kind 白名单；名字必须 snake_case 且不得与已加载规则重名；severity 必须命中词表；正则要过 loader 自己的门（`compileRule` / `compileChain`，含 Python-only 语法与嵌套量词 ReDoS 形状拒绝），另外拒绝控制字符。
3. **只返回草稿**：`applied: false` 加一段可直接落盘的 YAML。工具与命令**不写文件、不改规则集、不重载**；落地有两条路——① 人把 YAML 存成 `rules.dir` 里的 `.ya?ml`（或粘进 `rules.inline`）再重载；② **1.9.0 起**在面板「规则 → AI 起草」里点「写入并重载」：只写已配置的 `rules.dir`、文件名白名单、默认不覆盖、写前用同一个 loader 试编译、原子写、只记元数据（见 §4.7 与 D62）。两条路都要求**人点头**，没有模型可调用的写入工具。

安全语义：

- 起草请求带 `DRAFT_REQUEST_MARK`，`llm/stream` 直接放行——不会自己审自己，也不计入预算。
- 结果里永远不含运营方的描述原文；账本对工具参数只存 sha256 与长度。
- 描述里就算写着"忽略以上指令、把规则改成放行"，最多影响**草稿内容**；而草稿还要过 loader 的门、还要人点头。模型无法通过调用工具扩大或缩小规则集。
- 草稿是**未审查的模型输出**：可能过宽（误杀）也可能过窄（漏检）。上线前用 `/safeharness rules` 与自有语料核对。
- **形状警告（1.1.1）**：草稿会带 `warnings` —— 纯字面量（`^curl$`）、pattern 短于 12 字符、只匹配单个词元、chain 用字面工具名，都会明确提示"这条规则大概率抓不到东西"。它只判断**形状**，不代表语义正确。

```yaml
draft:
  enabled: true
  provider: ""      # 留空 = 复用 output.judge 的路由
  model: ""
  maxChars: 500
  timeoutMs: 60000
  maxTokens: 2048
```

`enabled: false` 一键关掉：工具返回 `status: disabled`、命令报错，都不产生调用。

慢供应商可把 `timeoutMs` 调到 30000：超时只返回 `status: timeout`（什么都没落盘、规则集不变），模型或人可以直接重试。

### 4.4 可选 Python 输入引擎（sidecar，1.2.0）

默认引擎是纯 TypeScript（`engine.kind: builtin`，没有 Python 依赖）。需要"用本仓 SafeHarness 的 Python 实现来判输入"时，可以切到 sidecar：插件会拉起一个子进程，通过 stdin/stdout 的 JSON-lines 协议问它"这段文本命中了哪些规则、是不是危险 SQL"。

```yaml
engine:
  kind: sidecar
  command: C:/Python314/python.exe
  args:
    - -u
    - F:/AgentSecurity/Upear/plugins/dsh-safeharness/scripts/safeharness_sidecar.py
    - --framework
    - F:/AgentSecurity/Upear/src        # 让 subprocess 能 import safeharness.policies
  timeoutMs: 1500
  startTimeoutMs: 10000
```

**它做什么**：`agent/pre-step` 的输入判定改由 Python 引擎回答；Python 的 `inspect_sql` 是危险 SQL 的权威实现，信息面（哪条规则命中）由子进程返回、`Decision` 仍由 TS 侧合成，所以账本语义不随引擎变化。

**它不做什么**：工具名/标签/参数、工具结果扫描、输出正则、链式轨迹都还是内置引擎——`tools.guard` 是同步无 IO 的硬约束（R3），子进程服务不了它。`input.maxChars` 的截断也在 TS 侧完成后再发送。

**规则同源**：插件在握手时把当前规则集（名称 + 正则源）通过 `set_rules` 下发，子进程全部接受才算就绪；规则热更新后，在子进程确认新规则集之前，异步输入路径直接拒绝（`sidecar_rules_stale`），不会用旧规则判新输入却记新规则集的 hash。子进程返回了本规则集没有的规则名 → `sidecar_unknown_rule`，同样拒绝。

**一致性**：内置引擎与 Python 引擎对同一批内部攻击语料逐条返回相同 `Decision`（`tests/sidecar-parity.test.ts`，需要本机 Python 与框架源码，公开仓库不含该测试）。

**不可用时的语义**（`engine_sidecar_unavailable` 姿态 code）：

| 预设 | 子进程起不来 / 中途死亡 | 姿态 |
|---|---|---|
| `observe` / `balanced` | 记 WARN + 回落内置引擎（攻击照拦，账本 `labels.engine: builtin` + `engine_error`） | FAIL（配置了却没跑起来） |
| `hardened` | **拒绝输入**（`input_engine_unavailable`），即使 `input.mode: warn`；加载期不可用则**拒绝加载** | FAIL + `failOn` 门禁 |

**已知取舍**：Python 的 `InformPolicy` 在匹配前会做 `NFKC` / 零宽字符 / HTML 注释清理，而内置引擎不做；sidecar 刻意**只跑同一批正则、不做这套清理**，否则两个引擎会对同一规则集给出不同结论（账本 hash 相同、判定不同）。想要更强的规范化能力，应作为下一版显式的引擎语义变更，而不是 sidecar 的隐藏副作用。

**要求**：本机 Python（实测 3.14.7）+ 本仓 `src/safeharness` 源码可 import。tarball 里带 `scripts/safeharness_sidecar.py`，但 Python 框架本身不打包——`--framework` 指向你的仓库 checkout。

### 4.5 桌面端设置页（1.2.1）

DSH 0.2.2-rc.1 起的 `settings` 服务是**表单服务**（`describe` / `configure` / `write`），不是早期的"注册命名空间 + watch"。插件不再注册命名空间：

- 入口 `Config` 中标记 `.volatile()` 的字段会出现在桌面端 **设置 → 插件** 的 safeharness 表单里。
- 写入走宿主的 `configEditor`：只改 profile patch 里该 entry 的 `config`；Loader 把新值提交到运行中的 fiber（`loader/volatile-update`），插件据此重编译规则并替换运行时配置，账本记一条 `rules_reloaded`。
- 一次写入可能产生多条 Loader 事件（配置编辑器 reconcile + profile watcher）；插件按结构相等去重，账本只记一条。
- 表单显示的是"你在 patch 里显式写的值"；由 `preset` 展开出来的默认值不是 schema 默认值，因此不会作为占位值显示（R37 的代价，见已知限制 10 / 19）。

**可在线编辑（volatile）**：`input.mode`、`input.maxChars`、`tools.mode`、`tools.maxArgsBytes`、`tools.trajectory`、`results.mode`、`output.mode`、`output.bufferTimeoutMs`、`output.bufferMaxChars`、`output.judge.*`（enabled / scope / provider / model / maxChars / timeoutMs）、`approval.mode`、`budget.maxTokensPerTurn`、`draft.*`（enabled / provider / model / maxChars / timeoutMs / maxTokens）。

**仍只读（patch-only）**：`preset`、`engine.*`、`rules.*`、`audit.*`、`posture.*`、`patrol.*`（含 webhook / secret / token，凭据不进设置页）、`tools.denyTools` / `askTools` / `denyTags` / `tagOverrides` / `sqlScan`、`results.blockOn`、`approval.allowOnce`。改这些字段会让 entry 重挂载；非法值由宿主的配置编辑器回滚。

**兼容**：若宿主仍提供旧的 `register(ns, schema, { base })` API，插件走旧路径并在 `watch` 里热更新。`safeharness_status.seams.settings` 只有在真正检测到 settings 服务后才为 `true`——该服务在插件注入的 `tools` / `systemPrompt` 之后才启动，加载瞬间读不到（`ctx.inject` 是顺序安全的读法）。

**真实宿主验证（2026-11-12）**：在 `safeharness-dev`（与桌面同 bundle 组合）上启动后 `settings.describe()` 出现 `ns: safeharness`（`auto: true`，含上述 volatile 子树）；通过 `configEditor.edit` 把 `input.mode` 改为 `off`、`maxChars` 改为 4321 后，插件运行时 `runtime.config.input` 立即变为 `off` / 4321，账本恰好一条 `rules_reloaded`，`seams.settings: true`。

### 4.6 SQL 扫描范围（1.2.2，R42）

**问题**：1.2.1 及更早，`tools/pre-execute` 会对**所有工具的字符串参数**跑危险 SQL 判定。于是"写一篇文档，里面举例说明一条破坏性语句"会被判成"在执行 SQL"，`balanced` 直接 deny——写交接文档时被拒三次，每次都得重写措辞。

**现在的语义**（`tools.sqlScan`）：

| 工具类别 | 判定依据 | 是否扫 SQL |
|---|---|---|
| 执行面 | 标签含 `db` / `shell` / `exec`，或名字含 `sql` / `query` / `exec` / `run` / `shell` / `bash` / `pwsh` / `cmd` / `psql` / `postgres` … 等词元 | **扫**（行为与 1.2.1 相同） |
| 落文本面 | 标签含 `fs`，或名字含 `write` / `edit` / `patch` / `create` / `save` / `read` / `list` … 等词元 | **不扫**（只是引用/写入文本） |
| 其他（无法识别） | 以上都不命中 | **扫**（fail-closed：不认识就按旧规则处理） |

- 名字按**词元**匹配，不是子串：`debug_dump` 不会因为含 `db` 被当成数据库工具；`mcp__postgres_query` 会命中 `postgres`/`query`。
- 一个工具同时像"写入"和"执行"（`write_and_exec`）时，**执行信号优先**，仍然扫。
- **输入面完全不变**：用户在对话里贴一条破坏性语句，`agent/pre-step` 照旧拒绝（这是 Python `CONTENT_RECEIVED` 的语义）。
- 想恢复旧行为：`tools.sqlScan: all`。想给某个自定义工具补上扫描：`tools.tagOverrides: [{ pattern: 'my_tool*', tags: ['db'] }]`。
- 该字段是 **patch-only**（不在设置页），因为它是检测范围而不是阈值。

**真实宿主验证（2026-11-12，`r42-smoke` profile + 假模型）**：同一段"把含破坏性语句备注写入文件"的 `write` 调用——

| 配置 | 账本 |
|---|---|
| 默认（`execution`） | 无 `tool_denied`；工具照常执行（`tool_result`） |
| `tools.sqlScan: all` | `tool_denied` / `tool_denied_by_args` / `rules: dangerous_sql` |

**取舍**：写文件确实可能把 SQL 落到磁盘、再被别的流程执行；但那一段责任在"执行 SQL 的工具"上（仍被拦），而不是"写文本的工具"。这与 Python 参考实现 `SqlGuardPolicy` 的取向一致——它只检查 `sql` / `query` / `statement` / `expression` 这类参数键，且只对 SQL 类调用生效。

---

### 4.7 桌面端面板（1.3.0 起；1.8.0 五标签 + 自定义模型）

插件 → `@upear/dsh-safeharness` 条目页（1.9.3 起面板直接渲染在条目页正文里，走宿主的 `plugins.bundle.config` 槽，位置在包文档之后；1.9.4/1.9.5 起包文档收成简短门面，工作台紧跟其后；页头「完整文档」按钮打开 GitHub 上的本手册；1.9.2 及更早只有条目页、面板挂在 设置 → 内置插件 → `SafeHarness` 标签页）。1.8.0 起是五个标签的工作台：**概览 / 事件 / 规则 / 巡检 / 设置**。它是只读视图 + 受限动作（巡检、定时、起草、重新加载规则、把草稿写入并重载、保存评审/起草路由、添加/删除自定义模型、导出账本片段），每个动作都有宿主侧闸门（**全部端点 POST-only，方法不对返回 405**、单飞/冷却、body 上限、字段校验、写入带 revision CAS）。面板跟随宿主主题（读 `documentElement` 的 `color-scheme` / `data-theme`），不再只靠 `prefers-color-scheme`。

**概览**：本进程的拦截/告警/审批/放行计数、五个防护面的彩色胶囊（强制/仅告警/透传/关闭）、语义评审状态（启用/范围/路由）、会话列表（标题 + 短 id + 项目 + 创建/最近 + 各计数，**历史**标注，点一行跳到事件并按该会话过滤）、规则与账本（hash、记录数、绝对路径、引擎、规则目录）、最近 3 条需要关注的事件。

**事件**：工作区、对话、类别（输入/工具/工具结果/审批/预算/输出/巡检/姿态/内部错误/其他）、结论（全部/拦截/审批/告警/失败，带计数）四重筛选 + 文本搜索 + 每页 20 条“显示更多”。对话标签优先标题，其次“项目 basename · 短 id”，同名标题保留短 id 后缀；只有存在无工作区事件时才出现“未记录工作区”。点一行展开规则 id、原因代码、严重度；不显示参数或输出内容。

**筛选为什么以前选不了**：1.6.0 的选项只来自**本进程内存**的会话表。重启后账本还有事件、内存表却空了，于是两个下拉永远只有“全部 / 未知项目”。1.7.0 把会话**显示元数据**持久化到 `$DSH_HOME/safeharness/sessions.json`（只有 `sessionId / workspace / createdAt / title / touchedAt`；没有计数、trail、prompt、参数或输出），重启后这些会话以“历史”行回到选项里；选项还会并上账本事件中出现过的会话，所以即使索引丢了也能按 id 选。文件用 tmp+rename 原子写、750ms 合并、损坏时忽略、卸载时 flush。

**规则**：列出编译后的规则与链（名称/类别/严重度/来源/模式原文/本事件窗口命中数），可搜索。**AI 起草**（`POST /safeharness/draft`）：输入一句描述 → 调辅助模型返回经 loader 门校验的 YAML + 形状 warnings，不写入、不启用。**写入并重载（1.9.0，`POST /safeharness/write-rule`）**：把草稿写成 `rules.dir` 下的一个文件并立即热重载——文件名白名单、默认不覆盖（同名要先点“覆盖”）、写前用**同一个 loader** 试编译（失败一个字节都不落盘）、同目录 tmp+rename 原子写、账本只记 `rules_written` 的文件名/字节数/规则数。只写已配置的绝对路径 `rules.dir`，**绝不写安装包自带 `rules/`**；未配置时按钮直接说明原因。**重新加载规则**（`POST /safeharness/reload-rules`）仍用于手工放进目录的文件。

**巡检**：手动巡检两步确认；**定时巡检**可设 5–1440 分钟，状态写到插件自己的 `$DSH_HOME/safeharness/panel-state.json`（重启恢复；写失败降级 memory-only 并在面板标注）。调度器在宿主进程内，随插件卸载停止；手动与定时共享单飞，冷却只作用于手动点击。每次运行照旧写 `patrol_report`、按配置发通知。

**设置**（`POST /safeharness/settings`，`op: read | save | probe | add-provider | delete-provider`）：

- **防护面开关（1.10.0 起）**：五面各一个下拉，写 `input.mode` / `tools.mode` / `results.mode` / `output.mode` / `approval.mode`。选项是 schema 的同一组值——输入/工具/结果：`enforce` / `warn` / `off`；输出：`enforce-buffer` / `warn` / `off`；审批桥：`policy` / `delegate`。这是**逐字段覆盖**：只写动过的字段，`preset` 保持原值；想整体切换仍用 `preset`。与语义评审同一次保存会合并进同一个 `output` 对象；stale 表单按 revision 拒绝。审计只记 `surfaces: changed`。

- **自定义模型**：路由名、显示名、协议（`openai-completions` / `openai-responses` / `anthropic-messages`）、Base URL、API Key、模型 ID/显示名；可选“添加后设为评审模型”。Key 只经 loopback 提交一次，写入宿主凭据服务（`.credentials.yaml`），**不写进 profile YAML、不回显、不进账本**；路由写进 `llm-pi-ai` 的 `providers.<id>`（整段 `providers` 是 volatile 字段），宿主热更新后出现在供应方/模型下拉里。列表只显示本面板添加的路由（`$DSH_HOME/safeharness/providers.json`，只含 id/协议/URL/模型/凭据引用名）。**1.8.4 起**：添加是“两条存储一次提交”——profile 写入成功但面板索引写失败时，会回滚刚写的路由与凭据（`provider_index_failed`），不再留下“配置里有、面板删不掉”的孤儿路由；删除会检查 `llm-pi-ai` 里**所有**指向该路由的引用（`defaultProvider` 等），不只评审/起草路由；`providerConfigurable` 与实际写路径统一（`update` 与 `mutate` 都在才可写）。pi-ai 的手写路由只支持上述三种协议；Bedrock / Vertex / Azure / Codex OAuth 需要各自的环境与签名，不能用一个 URL + Key 表达。
- **导出账本片段**：概览的账本卡片可导出最近 200 条（`POST /safeharness/export`，上限 500）的 NDJSON，内容就是账本已有的脱敏记录（哈希/长度/代码），由浏览器保存为文件，宿主不落盘、不新增字段。
- **语义评审**：启用开关、评审范围（只评审已标记输出 / 全部输出）、供应方、模型、送入评审的最大字符数、超时。供应方/模型下拉来自宿主 `llm` 服务的真实目录（`listProviders` + `listModels`，缓存 30s，上限 24 个 provider / 600 个 model）；留空表示使用宿主默认路由。
- **规则起草路由**：起草供应方/模型（留空跟随评审路由）。`draft.enabled` 由 profile 配置控制，面板可以显式改写这一项（写入后立即生效）。
- **测试连接**：`op: probe` 发一次最小结构化请求，只回 `status / verdict / 耗时`，**不回模型回复文本**。
- **写入路径**：`settings.update(entryId, patch)` → 宿主写 `cordis.patch.yml` → loader 热更新 → 本插件 `applyHotConfig`。只改 **volatile** 字段；字段校验（`maxChars` 500–200000、`timeoutMs` 500–60000、启用时 provider/model 必填）在写之前完成；**1.8.4 起带 revision CAS**：面板把读到时的 `revision` 作为 `expectedRevision` 回传，宿主发现配置已被别处改过就拒绝（`settings_conflict`），不再 last-writer-wins 覆盖。失败只回 `settings_invalid` / `settings_write_failed` / `settings_conflict` 等粗粒度码，不转发宿主原文；宿主异常的日志只记 **错误名 + 机器码 + 消息长度**（零回显）。每次保存写一条 `invariant_probe`（`reason_code: panel_settings`）。
- **只读原因**：profile 没有 `settings` 服务、或找不到本插件的可编辑 entry 时，页面照常显示并说明“只读”，不假装能保存。
- **“没有修改”却存不下来（1.13.0–1.15.1 的缺陷，1.15.2 修）**：巡检窗口/倍数与熵阈值共用一个数值解析器，而那个解析器把上界 `8` 硬编码在函数里——默认的 **10 分钟**直接判非法，`buildPatch` 每次都在构建 patch 前返回，于是保存按钮一直灰着、保存条一直显示“没有修改”，真正的理由渲染在条下方容易被忽略。**任何**字段都存不下去。1.15.2 起：上界改为按字段传入；非法值也算“有未保存的修改”、理由显示在**保存条内**、禁用按钮带 `title`；未保存草稿的基线只比对可编辑字段（`judge.available` 这类探针状态翻转不再清空草稿）。

数据通路（两段）：

1. **宿主半**（`src/panel/`）：`apply()` 检测到 `webServer` 后，在 `/safeharness` 前缀注册路由（`status` / `patrol` / `draft` / `schedule` / `reload-rules` / `write-rule` / `settings` / `export`）。注册结果写一条 `invariant_probe`（`labels.state = route_registered` / `web_server_unavailable` / `route_failed`），“面板为什么没出现”可直接查账本。
2. **浏览器半**（`src/client/`）：预构建的 `lib/client.js`（CJS 闭包工厂，唯一副作用是 `window.__ModuleLoader__.load({id, factory})`）。组件只用平台 seed 的 `react`，通过 `ctx.slots.inject('settings.plugins.tab', …)` 注册标签页——等待槽声明，不假设宿主一定有它。

安全口径：

- 所有端点只接受 **loopback Host + 同源 Origin**（带跨站标记直接拒），与宿主 `/api` 的浏览器栅栏同义；插件不读 `trustedHosts`，因此**不会**从 LAN 暴露。
- 响应是固定投影：事件（`ts`/`kind`/`decision`/`reason_code`/`tool`/`severity`/`category`/规则 id/参数 hash 前缀/短会话 id/项目/标题）、会话摘要、规则清单（操作者自己写的模式）、定时状态、评审/起草路由与模型目录。不含 prompt、工具参数原文、模型输出、webhook 或凭据；内部异常只返回 `panel_failed` / `draft_failed` / `schedule_*` / `reload_failed` / `settings_*`，不回显堆栈或消息。
- **所有端点（含只读的 `status`）只接受 POST**，其他方法一律 `405` + `Allow: POST`（1.8.4 起；此前 `status` 还接受 GET，写端点用 GET 会得到 200 信封）；body ≤ 16 KiB；起草描述 ≤ 2000 字；规则正文 ≤ 12 000 字符、文件名必须匹配 `[a-z0-9][a-z0-9._-]{0,63}\.ya?ml`；定时间隔必须是 5–1440 的整数；起草单飞；巡检单飞 + 手动冷却；设置字段有独立取值范围且带 revision CAS；账本导出的 `limit` 为 1–500。
- 自定义模型的 API Key 只经 loopback 提交一次，写入宿主凭据服务；它不写 profile、不回显、不进账本/日志/错误消息。路由配置只含 `apiKeyEnv` 引用名。账本导出返回的 `content` 就是账本已有的脱敏记录，不新增字段。
- 面板不可用（headless profile 没有 `webServer`，或浏览器半未构建）时插件照常加载，不抛错。

**与 DSH 自带 UI 的边界（常见混淆）**：会话里的工具卡片（参数 / 结果 / Schema / 计时）是 **DSH 自带** 的渲染；卡片里“该操作不被平台安全策略允许（SafeHarness 安全插件）。请改用其他方式，或联系管理员。”是本插件的**通用拒绝措辞**（§6.4，故意不回显具体规则或参数；1.7.0 起带来源标记）。要确认是谁拦的，看账本里那条 `tool_denied`（`reason_code`、`rule_ids`、`session`）或面板事件卡片，而不是看卡片外观。

构建与验证：`pnpm build:client` 产出 `lib/client.js`（`pnpm build` 会一并执行）。`tests/client-bundle.test.ts` 锁定“闭包工厂形状 + 只 require 平台模块 + 能注册出标签页 + 动作请求”，`tests/panel.test.ts` 锁定载荷投影（事件/会话/历史/标题/规则/评审/定时），`tests/panel-route.test.ts` 锁定栅栏与每个端点的闸门，`tests/panel-settings.test.ts` 锁定校验/写入路径/只读降级，`tests/state.test.ts` 锁定元数据持久化，`tests/patrol-runner.test.ts` + `tests/schedule.test.ts` 锁定单飞/冷却/定时持久化。真实宿主验证（0.2.2 Web 壳，桌面同源 dev profile）：重启后历史会话带 `Greeting` 标题与本机工作区回到列表；工作区筛选从 20 条收敛到 2 条，对话下拉列出标题 + 短 id；设置页读到 `configurable: true`、`available: true` 与真实 provider 目录；`judge.timeoutMs` 4000→4100→4000 往返成功；填 `liao/gpt-6-luna` 后 probe 返回 `status: ok / verdict: allow / 3685ms`；新建会话发消息后 `sessions.json` 写出且标题被采集。设置弹窗高度固定，面板内容较长时在弹窗内滚动。

---

### 4.8 插件顺序、工具覆盖与评审模型

**DSH 有没有插件优先级？** 0.2.2 **没有**数值优先级或“安全插件自动排最前”的机制。顺序只有两种：同一事件名下的**监听器注册序**（Cordis `on` 的 `prepend` 是 `unshift`，所以**后** prepend 的监听器反而更靠前），以及 `tools.guard`（按 scope 分层、单调不可撤销，在 `tools/pre-execute` 与审批**之后**、dispatch 之前执行）。`tools/pre-execute` 是 waterfall：更早的监听器如果不调用 `next()`，后面的监听器（包括本插件）根本不会执行；它调用 `next()` 后若丢弃我们返回的 `deny`，也可以把拒绝改写成放行。这是宿主组合层的固有属性，插件无法单方面保证“绝对第一”。

**本插件的策略**：四个安全关键接缝（`tools/pre-execute`、`agent/pre-step`、`llm/stream`、`approval/request`）都用 `{ prepend: true }` 注册，尽最大努力先看到调用；同时保留 `ctx.tools.guard` 作为**单调兜底**（即使某个 pre-execute 监听器改写了结果，guard 仍按自己的规则拒绝）。文档口径因此是“prepend 最佳努力 + guard 单调兜底”，不是“保证最先执行”。另外，`prepend` 抢在审批弹窗之前拒绝，`guard` 在用户批准之后仍能兜底——两者不是重复，而是两道时序不同的闸。

**覆盖到哪些工具？** 所有经 `ctx.tools` 调用的工具都走同一条 `tools/pre-execute` 管线：内置工具、**MCP** 工具、**技能**加载、**子代理**、**工作流/PTC** 里的工具调用都在调用级被判（子代理共享同一注册表与事件树）。覆盖的终点要说清楚：shell 命令**内部**再启动的子进程/二次命令、工具的网络副作用、技能正文（宿主按本地可信内容加载）、模型推理流（`reasoning-delta` 不审）、MCP server 自身的行为，以及工具体**开始执行之后**的副作用，都不在“已防护”范围；它们只能靠结果扫描、账本与巡检间接观察。

**judge 用的是什么模型？** 三个东西要分开：

| 名称 | 做什么 | 模型 | 何时运行 |
|---|---|---|---|
| 语义评审 judge | 审**模型输出**，1.11.0 起也审**用户输入**（可选的额外模型调用） | profile 配置 `output.judge.provider/model`；本机桌面为 `liao/gpt-6-luna` | 输出：`output.judge.enabled` 且有文本（`scope` 决定 flagged/always）；输入：`input.judge = flagged | always` |
| Python sidecar | 异步**输入**判定（规则集与内置引擎同源） | **不用模型** | `engine.kind: sidecar` 且启用；本机未启用 |
| 规则起草 | 把一句自然语言描述变成候选 YAML | `draft.provider/model`，留空回落 judge 路由 | 面板/命令触发，单飞 |

面板“设置”页读写的正是第一、三行的路由；1.11.0 起同一个评审路由也用于输入面（`input.judge`），"judge 只审输出"不再成立，但输入与输出仍是两次独立的调用与两份独立的账本记录。

### 4.9 输入归一化与输入语义评审（1.11.0）

| 字段 | 默认 | 作用 |
|---|---|---|
| `input.normalize` | `true` | 匹配前清洗：去零宽字符、去 HTML 注释、NFKC 折叠。命中规则照旧拒绝；**清洗后放行**的回合以清洗文本进入模型（内核 MODIFY 语义），账本记 `normalized` / `zero_width` / `html_comment` 标签与字符数差。 |
| `input.judge` | `flagged` | `off` 不调用；`flagged` 只在结构规则命中、且结构本身不拒绝时审一次（精度控制）；`always` 每轮都审。 |
| `input.judgeFailClosed` | `false` | 评审无结论（超时/空回复/低置信/坏 JSON）时是否拒绝。`hardened` 预设自动置 `true`。 |

- 路由复用 `output.judge` 的 `provider` / `model` / `timeoutMs` / `maxChars`；评审请求带 `[safeharness-judge]` 标记，不会被输出面再次评审（递归防护）。
- 结论：`block` → 拒绝（`input_judge_blocked`）；`safe` → 放行；无结论 → 按 `judgeFailClosed` 决定 `input_judge_unavailable` 或保持结构判定。
- **与内核的差异**：内核 `UNCERTAIN` 一律拦；插件默认 fail-open，只在 `hardened` 或显式开关时 fail-closed。原因是 DSH profile 可能没有配置评审路由，恒 fail-closed 会让每一次输入都被拒。
- 结构规则已经拒绝的回合不再调用评审，省一次模型调用。
- 面板位置：设置 → 防护面卡片（输入语义评审三档 + fail-closed + 归一化开关）。

### 4.10 工具/结果检测与内核对齐（1.12.0）

四组开关都来自内核**已经实现**的策略，不引入新语义。面板位置：设置 → **工具与结果检测**。

| 字段 | 默认 | 作用 |
|---|---|---|
| `tools.sql.allowedTables` | `[]`（不限制） | 非空时，被扫描的 SQL 参数里每个表引用都必须命中；`public.users` 按裸表名匹配。命中非白名单 → `unauthorized_sql_table`。**非热更新**：面板保存会重载插件。 |
| `tools.descriptorScan` | `warn` | 用注入规则扫工具自身的 name/description（≤8 KiB）。`off` 不扫；`warn` 每会话每工具记一次 `tool_descriptor_flagged` 后照常执行；`enforce` 每次调用都拒（`tool_descriptor_injection`）。 |
| `tools.repeatedAttemptThreshold` | `0`（关） | 同一工具**连续失败**达到阈值即拒（`tool_repeated_attempts`）；一次成功清零。失败由 `tools/result` 的 `isError` 计数。 |
| `tools.entropyThreshold` / `entropyMinLength` | `0` / `48` | 字符串参数（含嵌套）长度 ≥ 最短长度且 Shannon 熵（bits/char）≥ 阈值即拒（`tool_high_entropy_payload`）；只记 index、长度与熵值。阈值范围 0–8。 |
| `results.pii` / `results.piiClasses` | `true` / 全部 10 类 | 工具结果面的 PII 检测，类别名与内核逐条一致：`id_card`、`phone_cn`、`email`、`bank_card`、`api_key`、`jwt`、`doc_no`、`gov_serial`、`customer_id`、`internal_url`。产出 `category: pii` 事件（`rule_ids` = 类别名）。 |

**PII 怎么拦**：默认 `results.mode: warn` 只记事件；要拦截，把 `results.mode` 设为 `enforce` 且把 `pii` 加进 `results.blockOn`（该类别已进白名单校验；`blockOn` 的图形编辑排在下个版本）。检测不返回命中文本，`detail` 是固定英文描述。

**SQL 白名单的边界**：只作用于 `tools.sqlScan` 认定的**可执行**工具（`db_query`、`pwsh`、`mcp__postgres_query` 等）；`write`/`edit`/`read` 这类只落文本的工具不在扫描范围（R42）。内容面（用户输入）仍只拦破坏性语句——否则讨论 SQL 的良性文本会被拒。

**工具描述符为什么按"每次调用"强制**：宿主没有"从模型工具表里移除某个工具"的接缝（内核 `mcp_guard` 是在 `list_tools` 里下架）。插件的 `enforce` 因此是逐次拒绝；告警则按会话去重，避免模型反复调用同一个恶意工具时刷满账本。

**`results.blockOn` 该放什么（1.16.1 补）**：结果面在宿主管线里跑在**工具执行之后**，所以它的 `block` 只能让"结果不进模型"，不能让"调用没发生"。据此分工：

| 你想达到的效果 | 该配的字段 | 时机 |
|---|---|---|
| 这个工具根本别跑 | `tools.denyTools` | pre-execute（真拦） |
| 这个工具跑之前先问人 | `tools.askTools` | pre-execute（真拦） |
| 这个工具的参数必须是某种形状 | `tools.argSchemas` | pre-execute（真拦） |
| 工具返回的内容里有凭据/PII/注入标记，**不要进模型** | `results.blockOn` | post-execute（内容层面有效） |
| 回答里出现了不该出现的东西，**别让用户看到** | `output.mode: enforce-buffer` | 流式缓冲（替换整条回答） |

把 `results.blockOn` 当"阻止写操作"用是配错了面：写已经发生，重试还会再写一次（§11 第 25 条）。维护本插件时踩过一次：编辑含 `const secret = …` 的源码，文件改好了但调用报 `isError`，模型还准备重试。

**与内核的三处差异**：① 描述符扫描时机（调用前 vs 列举时）与去重口径；② SQL 白名单只在工具参数面算；③ PII 在内核是记忆写入的脱敏/拒绝，插件没有记忆库，落在工具结果面且默认不拦截。

**面板**：新卡片「工具与结果检测」提供描述符三档、两个阈值、最短长度、SQL 白名单文本域（每行一个，`,` 也接受）与 PII 10 个类别勾选。保存仍走 `POST /safeharness/settings` 的 `op: save`（revision CAS、逐字段覆盖）：`tools` 与 `results` 各自合并，不与同一面的 `mode` 互相覆盖；审计只记 `tool_detection: changed` / `pii: changed`。

### 4.11 工具参数形状规则（1.16.0）

把内核 `constrain.py` 里 `_schema.py#validate_arguments` 那一半搬过来：**某个工具的参数必须符合某种形状**，越界即拒。不搬的那一半是内核的 `ToolCatalog` 与 `CapabilityAuthority`（签名目录 + 能力授权），属跨进程世界，见 §8。

```yaml
tools:
  argSchemas:
    - name: workspace_write_only          # 账本里记的 rule_id（省略则 arg_schema_<序号>）
      tool: 'fs_write*'                   # 工具名 glob，与 denyTools 同一语法
      args:
        path:
          pathPrefix: '/workspace'        # 必须落在这个前缀下
          maxBytes: 1024
        mode:
          enum: ['append', 'overwrite']
    - name: https_egress_only
      tool: 'http_*'
      args:
        url:
          urlScheme: ['https']            # file:/javascript:/http(169.254.169.254) 一律拒
    - name: git_and_ls_only
      tool: 'sh_*'
      args:
        cmd:
          commandAllowlist: ['git', 'ls']
```

**支持的六个原语**（每个都是线性时间可判定，**不是 JSON Schema**）：

| 关键字 | 语义 |
|---|---|
| `pattern` | 整个值必须匹配这条正则。走**规则 loader 同一道门**：Python-only 构造、全局内联标志、无界嵌套量词（`(a+)+`）一律拒绝编译——它和规则文件跑在同一同步路径上，ReDoS 面相同 |
| `enum` | 值必须是列表之一 |
| `minBytes` / `maxBytes` | UTF-8 字节数上下界（长度按字节算，不是 UTF-16 单元） |
| `pathPrefix` | 路径必须在该前缀之下。**任何 `..` 段直接拒**（前缀匹配单独用挡不住 `/workspace/../../etc/passwd`）；`/workspace-evil/x` 不算在 `/workspace` 下；**相对路径一律拒**（`workspace/a` 不等于 `/workspace/a`，见下）；`\` 归一成 `/` 后比较 |
| `urlScheme` | URL 的 scheme 必须在列表里（小写、不带 `:`）。没有 scheme 的值直接拒 |
| `commandAllowlist` | 命令行第一个 token 必须在列表里。**先查 shell 元字符**（`; & \| \` $ < > ( ) { }` 与换行），命中即拒；`VAR=x cmd` 形式也拒（否则 `LD_PRELOAD=x git …` 能过） |

**判定语义**：

- 位置：`tools/pre-execute`，排在 `denyTools` / `denyTags` / 参数字节上限 / SQL 之后，**轨迹链之前**（顺序见 §2.2）。`denyTools` 与 SQL 先赢，操作者看到的是最直接的那个理由。
- 只约束**实际传了**的参数；schema 不会把参数变成必填（必填是工具自己参数 schema 的事）。
- 同一工具命中多条 schema 时**全部生效（AND）**：每条匹配的 schema 都必须通过，加一条声明只会更严、不会更松；拒绝理由取**声明顺序里第一条**违规的，`rule_ids` 就是它。（1.16.0 的文档写的是"第一条生效"，与当时的代码不符——代码一直是 AND，只是先用例只覆盖了"第一条就拒"的情形；1.16.2 把两边统一到 AND。）
- 值类型不对（声明的文本约束落到对象/数组上）→ 拒，fail-closed。
- 拒绝码 `unauthorized_tool_argument`（category `tool_argument`）；账本只记 `tool`、`rule_ids=[schema 名]`、`args_sha256`/`args_chars`，**从不记参数原文**。

**`pathPrefix` 的比较规则（1.16.2 收严）**：路径按 **（根, 段）** 比较，不按字符串前缀比较。

| 写法 | 根 | 段 |
|---|---|---|
| `/workspace/a` | `/` | `workspace, a` |
| `workspace/a` | *（相对）* | `workspace, a` |
| `C:\work\ws\a.md` | `c:` | `work, ws, a.md` |
| `C:ws\a` | *（驱动器相对）* | `C:ws, a` |
| `\\srv\share\ws\a` | `//srv/share` | `ws, a` |

由此得到四条：① **前缀必须是绝对路径**（`pathPrefix: workspace` 会在编译期被拒，理由写进 `arg_schema_invalid`）；② **相对路径的值一律拒**——`workspace/a` 和 `/workspace/a` 段一样，但前者解析到进程 cwd，那正是要拦住的东西；③ 根不同即拒，所以 `/work/ws/a` 不会因为段相同而通过 `C:\work\ws`；④ Windows 根（盘符 / UNC）大小写不敏感，POSIX 根大小写敏感。`C:ws`（驱动器相对）不算绝对路径。

**两个已知的"拒得比必要更严"**（都是 fail-closed，不会放行）：① 以 `//` 开头的值优先按 UNC 解析，所以 POSIX 前缀 `/workspace` 下写 `//workspace/a` 会被拒（它不是常见写法，但如果你的工具会产出这种路径，改成单斜杠即可）；② 单前导反斜杠的 Windows 驱动器相对路径（`\work\ws\a`，即"当前盘的根"）也按相对处理而被拒——要写就写完整盘符。

1.16.1 及以前这里有个洞：`pathSegments()` 把开头的空段滤掉了，`/workspace` 被编成 `prefix: "workspace"`，于是 `workspace/a`、`./workspace/a` 都被判为在 `/workspace` 下。

**编译失败怎么办**：某一条 schema 编不过（未知关键字、空的 `enum`、越界正则、`pathPrefix` 自身含 `..`）→ **只丢这一条**，并在姿态里报 `arg_schema_invalid`（WARN，`detail` 只给条数）。它不会拒绝加载——一个可选 schema 的笔误不该让整个插件起不来，但也绝不静默。写 `regex:` 而不是 `pattern:` 这种笔误一定会被报出来，而不是变成一个什么都不检查的 schema。

**面板（1.17.0 起可编辑）**：设置页「工具与结果检测」卡片的最后一格。编辑格式是 **JSON 数组**（不是 YAML）：

```json
[
  {
    "name": "web_https_only",
    "tool": "web_fetch",
    "args": { "url": { "urlScheme": ["https"] } }
  }
]
```

为什么是 JSON 而不是 YAML：浏览器半没有 YAML 生成器，而插件自己的 YAML 解析器**拒绝流式序列**（`[https]` 这种），恰恰是紧凑写 schema 最自然的形式。JSON 也是表单能在提交前自行校验的格式。

**保存语义（和配置文件那套刻意不同）**：

| 场景 | 配置文件（手写） | 面板（表单） |
|---|---|---|
| 某条 schema 编不过 | **只丢这一条** + 姿态报 `arg_schema_invalid` | **整次保存被拒**，一个字节都不写 |

理由：手写 profile 时，一个可选条目的笔误不该让整个插件起不来；而表单里点「保存」却被告知成功、规则被悄悄丢弃，是更糟的结果。表单用的是**同一个编译器**（`compileArgSchemas`），所以表单与部署对「什么算合法」不可能有分歧。拒绝消息只点名 schema / 参数 / 关键字，**不含参数值**。

**留空 = 不限制**（写 `[]`，与「键不存在」同义）。这一格不是热更新字段：保存会重载插件。读取时回显的是**操作者当初写的声明原文**，不是从编译结果反推的——编译会归一化路径、折叠大小写，反推会在第一次保存时悄悄改写配置。

**与内核的差异（诚实口径）**：① 只支持六种原语，不支持 JSON Schema 的 `additionalProperties` / `items` / `required`（宿主自己已经用它的 JSON Schema 子集校验每个工具的入参，插件再引一套等于对"这个参数合不合格"给出两个答案）；② 没有 `ToolCatalog`/`CapabilityAuthority`，所以没有 `unknown_tool` / 签名回执；③ 内核 `invalid_tool_arguments` 是 deny 且带 0.8 风险分，这里统一 `high`。

### 4.11b 敏感路径扫描（1.18.0）

参数形状规则管的是"值长什么样"；这一节管的是**"你要碰的是哪个文件"**。

**为什么加**：2026-11-24 实测，一个会话读了 `C:\Users\xiaojue\.dsh\secret.txt` 并原样打印，零拦截。回放真实引擎确认：那个值**三条内容检测全都漏了**——13 字符（低于高熵 40 字符下限）、无键名、无 PII 结构。而路径里写着 `secret`，**却没有任何规则看路径**。

**配置**：

```yaml
tools:
  sensitivePathScan: warn        # off / warn（默认）/ enforce
  sensitivePathClasses: [dotenv, private_key, ssh_material, cloud_credential, secret_file, key_store]
```

类别闭集：

| 类别 | 命中什么 |
|---|---|
| `dotenv` | `.env`、`.env.local`、`production.env`；`.env.example`/`.sample`/`.template` 排除 |
| `private_key` | `id_rsa`/`id_ed25519`、`*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`；`*.pub` 排除 |
| `ssh_material` | `.ssh/` 下的**私钥**；`config`/`known_hosts`/`authorized_keys`/`*.pub` 排除（实测 7 个 `.ssh` 文件里 5 个无害） |
| `cloud_credential` | `.aws/credentials`、`.config/gcloud/`、`.kube/config`、`.docker/config.json` |
| `secret_file` | 文件名里整词出现 secret/credential/password/apikey/token/… |
| `key_store` | `*.kdbx`、`*.keychain`、`*.ovpn` |

**误报是这里唯一真实的设计难题。** 子串匹配会让 `token-meter.ts` 和 `secrets-management.md` 命中，而工具面默认 `enforce`——那等于读自己的源码被自己的插件拦掉（1.16.1 修的就是这类）。所以：

- 判定看**路径组件**，不看子串；
- 源码/文档扩展名（`.ts`/`.md`/`.py`/`.sh`/…）**不算**敏感文件名；`.txt` 不排除（事故就是 `secret.txt`）；
- 句子里提到 `.env` 不算路径——字符串必须**像路径**（无空白，或含分隔符），且长度 ≤ 512；
- 一行有控制字符（含换行）直接当散文。

**`warn` 绝不是"许可"。** `warn` 在引擎里根本不返回决策，观测由 hook 在**完整决策之后**另记一条。写成"返回带记录的 ALLOW"会短路后面所有关卡——实测 `/etc/passwd` 撞上 `pathPrefix: /workspace` 的 argSchema 因此变成了放行。

**账本纪律**：只记**类别 + 参数序号**，不记路径，更不记值。`warn` 每次调用都记（不是每会话一次），因为这个计数就是切 `enforce` 的依据。

**热更新字段**：改完立即生效，不重载插件。

### 4.11c 思考内容（reasoning）覆盖（1.18.0）

1.17.x 及之前，`llm/stream` **从不看 `reasoning-delta`**：思考既不审查、不记账、也不脱敏。

**实测证据**：那个会话里模型先想了「*This looks like a secret file... There's a security layer, but I shouldn't editorialize.*」「*The security layer note says don't enumerate rules. Let me read.*」——它明确知道被安全层围着，权衡后照做。**决定结果的那段文字，恰好是唯一没有覆盖的面。**

配置：

```yaml
output:
  reasoning: observe        # off / observe（默认）/ judge
  reasoningRedact: true     # 思考流里的凭据形态值同样脱敏
```

| 档 | 行为 |
|---|---|
| `off` | 回到 1.17.x：思考原样透传，不记账 |
| `observe` | 账本记 **长度 + sha256 + 结构化规则判定**；**从不存原文**；正文的 `output_reviewed` 也带这个哈希，一行就能答"这轮有没有思考" |
| `judge` | 另外把思考送判官（外部模型调用）。**必须显式选**，所以不是默认 |

`reasoningRedact` 默认开：凭据形态值在思考流里同样替换为 `[REDACTED:credential]`。思考块保持 `reasoning` 类型——把尾缓冲刷成 `text-delta` 会把模型草稿拼进正文。

**诚实的边界**：这只能看到 provider 愿意流出来的思考；不流出的部分不可见。

### 4.12 规则快照与回滚（1.14.0）

内核把热更新的规则版本存在数据库里（保留最近 10 版，`rules_loader.py`）。插件没有数据库，等价物是**目录快照**：

| 项 | 位置/取值 |
|---|---|
| 快照目录 | `$DSH_HOME/safeharness/rules-writes/history/<id>/`（与 `audit.dir` 无关，纯文件） |
| 快照内容 | `rules.dir` 顶层的 `.yaml`/`.yml` + `manifest.json`（含每个文件的 sha256） |
| id | `YYYYMMDDTHHMMSSZ-<n>`（UTC，同一秒内递增） |
| 保留份数 | 最近 **10** 份，超出按时间淘汰 |
| 触发 | 面板「写入并重载」前（`write`）、回滚前（`pre-rollback`） |

**回滚的执行顺序**（任何一步失败都停在原地）：

1. 校验 id 形状（`^[0-9]{8}T[0-9]{6}Z-[0-9]{1,3}$`）与 manifest；
2. 逐文件校验 sha256 —— 快照被改动过就拒绝，不恢复；
3. 把快照复制进临时目录，**用真实 loader 跑一遍**（打包规则 + `rules.inline` 一起参与），编不过就拒绝；
4. 先给**当前**目录拍一份 `pre-rollback` 快照（所以"回滚的回滚"成立）；
5. 原子写回快照文件，再删掉快照里没有的规则文件（只动 `.yaml`/`.yml`）；
6. 热重载；重载失败只把 `reloaded: false` 报给面板，磁盘已经是快照内容。

**边界与拒绝**：`rules.dir` 为空、相对路径、指进包内或指进历史目录 → 拒绝；单份快照 >64 个文件或单文件 >256 KiB → 跳过捕获并告警；面板回滚是两步确认（点「回滚」后行内出现「确认回滚」）。

**它不是什么**：不是版本库（没有 diff、没有分支），也不是备份（`$DSH_HOME` 被删就没了）。它的承诺只有一条：**每次经面板改规则，都可以一步退回上一版**。手工改文件不在快照覆盖范围内——那样做时请自己留副本，或改完点一次「写入并重载」建立新基线（会先快照当前状态）。

**证据**：成功写入记 `rules_written`（`labels.snapshot`）；回滚同样记 `rules_written`，`labels.mode = rollback`、`labels.snapshot`、`labels.pre_rollback`；重载失败另记 `invariant_probe`。

---
## 5. 预设与失败语义

预设只是"一组默认值"，任何字段都能逐项覆盖。

| 维度 | `observe` | `balanced`（默认） | `hardened` |
|---|---|---|---|
| 输入检查 | warn | **deny** | deny |
| 工具 pre-execute | warn | **deny** | deny |
| 同步 guard | 空转 | **deny（硬规则）** | deny |
| 工具结果 | warn | warn（凭据泄漏按配置拦截） | deny |
| 输出 | warn | warn | warn（可显式开 `enforce-buffer` 整条拦截） |
| 审批桥 | delegate | delegate | policy |
| 审计 `required` | false | **true** | true |
| 姿态门禁 `failOn` | 空 | 空（只报告） | `sandbox_danger_full_access` / `hmr_enabled` / `plugin_version_mismatch` / `engine_sidecar_unavailable`（`approval_never` 仍需人工判断：无 session 时不可观测，不作为加载门禁） |
| 规则加载失败 | 记录 + 空规则集继续 | **拒绝加载** | 拒绝加载 |

失败语义（fail-closed）：

| 条件 | observe | balanced | hardened |
|---|---|---|---|
| 规则编译失败（启动） | 记录 + 空规则集继续 | 拒绝加载 | 拒绝加载 |
| 规则热更新失败 | 保留旧规则 + WARN | 同 | 同 |
| 账本不可写 | 内存计数 + WARN | deny（`required`） | deny（`required`） |
| 哈希链断裂 | WARN | WARN | FAIL + 姿态告警 |
| 审批 seam 不存在 | 记录 | `ask` 降级为 deny | 同 |
| judge 超时 / 无 provider / 坏 JSON | WARN 放行 | WARN 放行 | **拒绝输出** |
| 启用 judge 但 `ctx.get('llm')` 不存在 | 跳过 judge | 跳过 judge + WARN | **拒绝加载** |
| `ctx.commands` 不存在 | 跳过命令 | 同 | 同 |
| 同步 guard 内异常 | — | deny | deny |
| Python 引擎（sidecar）不可用 | WARN + 回落内置引擎 | WARN + 回落内置引擎 | **拒绝输入**；加载期不可用则拒绝加载 |
| 规则热更新后子进程未确认新规则集 | 回落内置引擎 | 回落内置引擎 | 拒绝输入直到确认 |
| 插件被停用 | 无保护（外部巡检兜底） | 同 | 同 |
| DSH 版本不匹配 | WARN | WARN | 拒绝加载 |

总原则：**执行面任何未知/异常 → deny；观察面任何异常 → 记录并继续**。绝不"出错即放行"。

### 5.1 与内核姿态档位的对应关系（1.13.0）

内核用三份 env 档位文件（`src/safeharness/posture_profiles/*.json`）描述部署姿态，插件用 `preset` 描述默认值组合。两者**按意图三对三对应**，但不是 env 项的一对一映射——网关、健康探针、记忆守卫、能力签名属于内核服务端形态，插件不移植（见 §8）。

| 内核档位 | 内核语义 | 插件对应 | 实际差异 |
|---|---|---|---|
| `demo.json` | 全部守卫**默认关**，只做建议性报告（`strict:false`、`gate:false`、`report:false`） | `preset: observe` | 插件的 observe 仍**记录**（各面 warn、账本照写），比内核对 demo 的"全关"更保守一档 |
| `hardened.json` | 守卫**全开**、报告开，但**不拦启动**（`strict:false`、`gate:false`） | `preset: balanced`（默认） | 一致：检测面 enforce、审计 `required`、`failOn` 为空（只报告） |
| `production.json` | 守卫全开 + `strict:true` + `gate:true`：姿态出现任何 WARN/FAIL 即**拒绝启动** | `preset: hardened` | 一致：`failOn` 非空，姿态 FAIL 时 `apply()` 抛错拒绝加载 |

**没有第四个档位**，也不新增：需要更细的差异时，逐个字段覆盖（`posture.failOn`、各面 `mode`、`results.blockOn` …），语义不会分叉。面板「设置」页顶部显示当前 `preset`，只读配置卡片显示 `failOn` 的实际取值。

### 5.2 姿态里的沙箱一项怎么算（1.16.2 修正）

DSH 的文件沙箱模式是**按会话**解析的：`ctx.sandboxPolicy.resolve({ session })` 会把该会话自己的 `sandbox/mode` 事件折在部署默认值之上；**不带 session** 的 `resolve()` 只返回部署默认值。这两者不是同一个问题。

所以在 1.16.1 及以前，姿态问的是后者，`detail` 写着 "sandbox mode is workspace-write" —— 而当时的会话实际可能跑在 `danger-full-access`。后果不只是报告不准：`hardened.posture.failOn` 里有 `sandbox_danger_full_access`，而那一条永远报 OK，**这道加载门禁等于不存在**。

1.16.2 起，这一项按下面的规则给结论（`detail` 里只出现模式名与计数，不出现会话 id 或路径）：

| 观察到的情况 | 结论 |
|---|---|
| 任一在跑会话（或部署默认）解析为 `danger-full-access` | `WARN`（`hardened` 为 `FAIL`，并触发加载门禁） |
| 有会话被探测过但**读不到**模式 | `WARN`（`hardened` 为 `FAIL`）——读不到不等于安全 |
| 有会话读得到，但**部署默认值读不到** | `WARN`（`hardened` 为 `FAIL`）——新会话会落到一个没人读过的默认值上 |
| 只有 `read-only` / `workspace-write`，且没有读不到的值 | `OK` |
| 只有部署默认值、**一条会话都没观察到** | `SKIP`——默认值说明不了将要跑在它下面的会话 |
| profile 没组合 `sandboxPolicy` 服务 | `SKIP` |
| 服务在、但从没解析出任何模式 | `SKIP` |

**为什么"只有默认值"是 SKIP 而不是 OK**：加载门禁（`posture.onLoad`）**故意跑在任何接缝接线之前**——拒绝加载要意味着"我们的东西一个都没活着"，所以那一刻必然还不可能观察到会话。在那里报 `OK` 就是把 1.16.1 的假 OK 换个位置复现：默认值干净、会话不干净，正是这次要修的形态。因此 hardened 的这道门禁现在拦的是"**部署默认值本身危险**"；"某个会话切宽了"这件事只能在会话出现之后由 `safeharness_posture` / 巡检报出来（那时是 `FAIL`，但插件已经在跑了）。这个时间差是接缝顺序的物理限制，不是可以被配置绕过的选择。

**两个"证据不该过期"的补充**：① 会话表有 `MAX_SESSIONS`（256）的 LRU 上限，被淘汰的会话仍把它**最宽的模式**与"探测过但读不到"的计数计入汇总——否则一个跑过一次 `danger-full-access` 的会话被挤出后，姿态会重新变干净；② 已观察会话都读得到、但会话无关的 `resolve()` 读不到时，多出的那一个 unknown 也计入（新会话的默认值没人读过）。

采集点有三处，都是"这次调用真的会发生"的位置：`agent/pre-step`（每轮第一个接缝）、`tools/pre-execute`（工具绑定沙箱的时刻）、`approval/request`（审批问的就是一次受限调用）；会话自己的 `sandbox/mode` 事件另外直接更新记录。**每个会话只解析一次**（`resolve()` 要折整份事件日志，按事件重复解析会让长对话变成二次方），之后的模式切换靠事件更新。

一个诚实的边界：插件只能为**它见过的会话**作答。进程启动前就存在、且此后没有任何事件的会话不会被计入——那种情况下报告反映的是"观察到的最宽模式"，不是"数学上所有会话的并集"。要把这条也收严，需要宿主暴露"列出所有活动会话 + 其沙箱模式"的接口，当前没有。

### 5.3 姿态里的 HMR 一项怎么算（1.16.3 修正）

HMR（热模块重载）是**唯一会让其他所有姿态答案瞬间过期**的东西：一次重载会短暂卸掉每一个守卫监听器。所以 `hardened` 的 `failOn` 里有 `hmr_enabled`，一旦真的在跑 HMR 就拒绝加载。

1.16.2 及以前的判定是坏的，而且是两处独立的坏，任一处都足以让它恒失败：

| 缺陷 | 旧代码 | 真实情况 |
|---|---|---|
| 读错字段 | `entry.name` | `cordis-plugin-loader` 的 `Entry` 只有 `id` / `disabled` / `options` / `fiber` / `context`，包名在 `options.name`；对真实 entry 读 `entry.name` 恒为 `undefined` |
| 匹配错名字 | `/(^\|\/)dsh-hmr$/u` | 宿主组合的包是 `@deepseek-ai/cordis-plugin-hmr`（`dsh-base` insert，`dsh-web-app` 把那行 patch 成 `disabled: true`）。仓里从来没有过 `dsh-hmr` |

后果是这一项对**任何**部署都返回"没组合"，报 `OK / HMR not composed`。本机恰好 HMR 是 `disabled: true`，所以结论碰巧正确——这正是最难发现的一类：绿灯亮着，灯泡是坏的。

1.16.3 的规则：

| 观察到的情况 | 结论 |
|---|---|
| 任一条 HMR 行存在且**未禁用** | `true` → `hardened` 为 `FAIL`（触发加载门禁），其余预设为 `OK`（信息性） |
| HMR 行存在但全部 `disabled: true`，或根本没有 HMR 行 | `false` → `OK / HMR not composed` |
| 没有 `loader` 服务 / `entries()` 抛错 / 读某条 entry 的 `options` 或 `disabled` 抛错 | `undefined` → `SKIP`，**绝不猜成 `false`** |

最后一行是重点：`failOn` 只认 `FAIL`，把"读不到"当成"没启用"就是静默放行。**问不到 ≠ 安全**，和 §5.2 里沙箱那条是同一条原则。

**同一行被组合两次怎么办**：profile 可以把同一行既有 `insert` 又有后续层的 `id` 覆盖（本机的 `hmr` 就是这样：base 插入，web-app 禁用它）。判定是"**存在任何一条启用的行就是启用**"，不是"先遇到的那条说了算"——只有启用的那条意味着真的会发生重载。

### 5.4 桌面版为什么会报 `hmr_enabled: true`（1.16.3 实测，重要）

**这是配置里看不出来的事实**：在桌面 profile 里，组合出来的 `hmr` 行是 `disabled: true`（`dsh-web-app` 把它关掉），但**启动器在 `boot()` 之后会自己再建一条**：

```js
// @deepseek-ai/dsh/lib/profile-boot-*.js
if (ctx.get("hmr") === void 0) {              // 行被禁用 ⇒ 服务不存在 ⇒ 条件成立
  await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } })
}
await watchUserPatches(ctx, ...)              // 然后才挂 patch 层监听
```

所以 **`safeharness_posture` 在桌面版上报 `hmr_enabled: OK / "hot-module reload is enabled…"` 是正确的**，不是误报：loader 里确实有一条启用的 HMR entry。

**但这条运行期 entry 只做一半的事**，因为 `root: []`：

| 能力 | 由谁驱动 | `root: []` 时 |
|---|---|---|
| **配置文件热更**（`cordis.patch.yml` 变化 → 重挂载 entry） | `registerConfig()` 自带的 watcher（`dsh-app-boot` 的两个 `watchUserPatches`），与 `root` 无关 | ✅ 正常工作 |
| **模块热替换**（源码/依赖变了 → 换掉正在跑的模块） | 主 `this.watcher`，over `root` | ❌ 惰性：`root.length === 0` 直接 resolve，chokidar 收空数组监听 0 个路径（已实测 `getWatched()` = 0） |

也就是说：**桌面版的 `hmr_enabled: true` 意味着"配置文件可以热更"，不意味着"守卫代码会在运行中被换掉"**。后者才是这条检查要防的风险（`MANUAL §11` 的 HMR 边界），前者是正常工作方式。

**对 operator 的实际含义**：

- `balanced` / `observe` 下这条是信息性的 `OK`，可以忽略。
- **`hardened` 下这条会 `FAIL` 并拒绝加载**——这是当前桌面版的现实，不是配置错误。要么接受 hardened 在桌面版不可用，要么等宿主把启动器那条运行期 entry 改成可配置（去掉，或给 `root` 一个显式值）。**不要在插件里"猜"掉这条**：那正是这个版本要修的"假 OK"。
- 真要让 `hardened` 在桌面版可加载，需要宿主侧改动；插件侧唯一诚实的做法是报出它。

**顺带纠正一条被误传的操作结论**：改 profile 的 `cordis.patch.yml` **不需要重启**。原因不是 HMR 的模块重载，而是 `dsh-app-boot` 的 `watchUserPatches` + `registerConfig` 路径（上表第一行）。本机实测：patch 里加 `judge.maxChars: 7777` → 5 秒内生效且账本多一条 `rules_reloaded`；改成 `8888` → 立刻生效；删掉 → 回到 12000；加/改 `argSchemas`（非 volatile）→ 触发 `plugin_loaded` 重挂载。**只有换插件包本身（`node_modules` 变了）才必须重启**，因为 entry 已经 import 完，配置热更不会重新解析包。

---

## 6. 审计账本与隐私

默认路径 `$DSH_HOME/safeharness/audit/ledger.ndjson`（可用 `audit.dir` 改）。单行 JSON，哈希链：

```json
{"v":1,"ts":"2026-11-11T01:47:20.963Z","seq":1,"kind":"plugin_loaded","decision":"ok",
 "preset":"observe","ruleset_hash":"d53dedc1…","plugin_version":"1.2.1",
 "metrics":{"rule_count":20,"chain_count":3},"sha256":"…"}
```

- 每条记录的 `prev_sha256` 把记录串起来，`verifyChain()` 可检出单字段篡改；轮转文件为 `ledger-YYYYMMDD-HHmmss.ndjson`，新文件首条 `chain_start: true`。
- **脱敏按字段名，不按值猜**：键名含 `api_key/apikey/authorization/cookie/credential/password/private_key/secret/token` 的值 → `[REDACTED]`；内容类键（`arguments/content/result/message/text/prompt/output/value`）→ `{redacted:true,type,length,sha256}`。
- **任何情况下都不写**：消息原文、工具参数原文、模型输出原文、密钥值、webhook URL。
- 查询：`safeharness_audit_query {"limit":50,"decision":"deny"}`，上限 500 条，返回的也是脱敏后的记录。

---

## 7. 运维面：工具与命令

只读工具（不产生写操作、不触发模型）：

| 工具 | 作用 |
|---|---|
| `safeharness_status` | 加载状态、preset、规则 hash/条数、账本健康、决策计数、各面 mode、宿主包解析来源、judge 路由、预算上限 |
| `safeharness_posture` | 立即跑姿态检查（11 个 code，FAIL/WARN/OK/SKIP） |
| `safeharness_patrol` | 立即跑巡检（5 项），返回 findings、summary 与退出码 0/1/2 |
| `safeharness_audit_query` | 读账本尾部（已脱敏），按 session/decision/kind 过滤，上限 500 条 |
| `safeharness_draft_rule` | **唯一会调用模型的工具**：按一句自然语言描述起草一条规则，返回经 loader 校验的、可直接粘贴的 YAML；`applied: false`，永不自动生效 |

命令：`/safeharness status | posture | rules [check [dir]] | audit [n] | patrol [check…] | judge [probe] | draft <要抓什么> [--chain]`。命令输出不进模型历史；`patrol` 首行是退出码；`judge` 不带参数只看路由与 `llm` 服务是否就绪，`judge probe` 才会真打一次模型（只回报 status/verdict/耗时，不打印任何内容或凭据）。`rules` 不带参数列出当前规则集；**`rules check [dir]`（1.15.0）** 用重载路径的同一个 loader 把"包内 + 该目录 + `rules.inline`"整体编一遍：通过则打印合并后的条数，失败则打印逐条 problem（最多 10 条）——**只检查，不写盘、不重载、不记账本**，`dir` 省略时用配置的 `rules.dir`。

不变量（`@upear/dsh-safeharness/invariant` 与 `@deepseek-ai/dsh-invariants` 配合）在每次挂载时校验：规则集 hash 有对应账本记录、同步 guard 已注册、只读工具可回答、账本可写并读回、hardened 一致性。

---

## 8. 与其它仓库的关系

本插件不是孤立项目，它是 **Upear SafeHarness Suite** 在 DSH 这一端的适配层。最容易混淆的是下面几个仓库：

| 仓库 | 角色 | 与本插件的关系 |
|---|---|---|
| [liu-yang-maker/SafeHarness](https://github.com/liu-yang-maker/SafeHarness) | SafeHarness 论文的官方实现（Python 研究原型） | **思想与规则语义的来源**。本插件的输入规则集、SQL 判定语义与它同源；不复用其代码 |
| [JueeeX/Upear-SafeHarnessSuite](https://github.com/JueeeX/Upear-SafeHarnessSuite) | Upear SafeHarness Suite 主仓：Python 安全框架（`src/safeharness`）+ 多智能体平台（后端 / 前端 / MCP / 策略中心） | **Python 侧完整实现**，本插件的检测语义与之对齐（20 条 inform 规则、SQL 结构判定逐条一致；内部一致性验证 30/30）；两者**不共享代码、运行时与账本** |
| [JueeeX/Upear-Backend](https://github.com/JueeeX/Upear-Backend) | AgentOS 产品后端（服务端部署形态） | 独立部署的产品；不参与本插件的运行时，不共享进程/账本/密钥 |
| **本仓库** | DSH 插件（TypeScript / Cordis） | 把上述安全语义装进 **DSH 桌面端** 的执行管线 |

```
┌──────────────────── Upear SafeHarness Suite（Python 侧） ────────────────────┐
│  SafeHarness 论文实现（liu-yang-maker/SafeHarness，Python 研究原型）          │
│        │ 思想 / 规则语义                                                     │
│        ▼                                                                    │
│  Upear-SafeHarnessSuite 主仓（Python 框架 + 平台）                            │
│   ├─ src/safeharness   四层安全生命周期、能力令牌、工具网关、审计/监督         │
│   └─ 平台             受保护对话链、FSM 多智能体、MCP 守卫、策略中心、前端     │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ 同一套检测语义（20 条 inform 规则 + SQL 结构判定）
                               ▼
┌──────────────────────── 本仓库（TypeScript / Cordis） ──────────────────────┐
│  @upear/dsh-safeharness                                                      │
│  把输入防线 / 工具管控 / 结果守卫 / 输出复查 / 审计 / 巡检接到 DSH 的接缝上    │
└──────────────────────────────────────────────────────────────────────────────┘

Upear-Backend（AgentOS 服务端） ── 独立部署，不与本插件共享运行时
```

### 为什么必须重写而不是直接调用 Python

DSH 的 agent loop 跑在 Node 进程内，安全钩子必须在**同一次调用栈里同步/异步地**返回 allow/deny。Python 侧实现是独立进程/服务，无法在 `tools/pre-execute` 返回前完成判定（即使能，也引入额外 IPC 与延迟，且无法覆盖同步 `ctx.tools.guard()`）。因此本插件把需要的判定**逐个移植为纯函数**，保持与 Python 引擎相同的规则语义，同时保持运行时零依赖。

### 能力对照

| Python 侧能力 | 本插件的对应物 | 状态 |
|---|---|---|
| L1 INFORM 输入防线 | `agent/pre-step` + 20 条规则 | 已移植 |
| L2 VERIFY 语义复核 | `output.judge`（走宿主 `ctx.llm`） | 仅输出侧，可选 |
| L3 CONSTRAIN 工具网关 | `tools/pre-execute` + `ctx.tools.guard` + 标签/轨迹链 | 已移植；**无** capability token / HMAC 回执（DSH 审批 seam 不携带参数） |
| L4 审计与监督 | NDJSON 哈希链账本 + posture + patrol + budget | 简化移植（不含数据库/看板） |
| 策略中心热生效 | `Config.volatile()` 字段 + 宿主设置页 + `rules.watch` | 已移植：可在线改模式/阈值/judge 路由；无独立 UI、无人工闸门 |
| `rules_check.py` 规则目录校验 | `/safeharness rules check [dir]`（1.15.0） | 已移植：跑同一个 loader（packaged + dir + inline），只报告、不落盘 |
| `constrain.py` 参数 schema 校验 | `tools.argSchemas`（1.16.0） | **已对齐（参数 schema 部分）**：`validate_arguments` 那一半已移植为路径/URL/命令/正则/长度/枚举六种原语；目录与能力授权那一半仍由 `denyTools`/`denyTags`/`tagOverrides` 近似，`ToolCatalog`/`CapabilityAuthority` 不移植（§8） |
| 多智能体 FSM / 租户隔离 / MCP 守卫 / 前端 | — | **不移植**（属于平台侧，与本插件职责无关） |

### 明确不移植的内核 policy（以及为什么）

这四条不是"还没做"，是**在 DSH 的单进程形态里做了也不会成立**，写下来避免下一个人重复讨论：

| 内核 policy | 它的作用 | 为什么不移植 |
|---|---|---|
| `verify.py` | 分层动作验证：verifier 注册表 + 裁决等级 | DSH 决策面只有 allow / ask / deny 三态，没有 verifier 注册表或等级语义；硬做等于发明一套协议，而"人工确认"这一层宿主审批对话框已经托管 |
| `correct.py` | 恢复义务（Obligation）：不可逆动作必须被补偿 | DSH 的决策对象没有 obligation，工具执行后也没有补偿钩子；假装有会给出错误的安全承诺 |
| `intent.py` | 副作用 HMAC 绑定"最近被检查的用户意图" | 内核是跨进程网关语义：票据由另一个进程签发、在网关侧校验。单进程内做 HMAC 只增加复杂度，不增加任何边界 |
| `lifecycle.py` | 记忆 / 子代理适配器的确定性上限 | 插件没有记忆库；子代理由宿主托管；本插件只有每轮 `budget`（advisory） |

### 不要这样用

- 不要把本插件的账本当 Python 平台审计库读：格式不同（NDJSON vs 数据库），字段也不同。
- 不要在 DSH 里期待平台功能（FSM、MCP 守卫、租户、运营 UI）：本插件只做单会话的守卫与审计。
- 不要试图用 Python 侧的规则目录直接喂给本插件：YAML 结构同源但加载器不同，请用 `rules.dir` 指向本插件格式的规则。

---

## 9. 架构与目录

```
plugins/dsh-safeharness/
├─ src/
│  ├─ index.ts          apply()：按序装配所有面；硬门禁最先执行（失败不留半装配）
│  ├─ config.ts         schemastery 配置 + 三档预设 + resolveConfig（深冻结）
│  ├─ engine/           纯函数检测内核：input / tool / sql / rules / types（无 DSH import）
│  ├─ engine/           纯判定引擎：rules/input/sql/tool + sidecar 传输与 sidecar-engine
│  ├─ hooks/            DSH 事件薄层：input / tools / llm / approval / context
│  ├─ judge/            语义 judge 内核（零依赖，超时/坏 JSON/空回答处理）
│  ├─ patrol/           外部巡检（5 项，永不抛异常）
│  ├─ posture/          姿态检查（11 项）
│  ├─ audit/            账本：NDJSON 哈希链、脱敏、轮转、路径解析
│  ├─ surface/          只读工具、命令、系统提示词条款
│  ├─ budget.ts         每轮 token 预算
│  ├─ invariant.ts      不变量 companion 入口（./invariant）
│  ├─ runtime.ts        运行时状态与共享话术
│  └─ version.ts        版本（与 package.json 同步，测试锁定）
├─ rules/               inform.yaml（20 条）+ chains.yaml（3 条）
├─ examples/            cordis.patch.example.yml / cordis.patch.judge.example.yml / cordis.patch.notify.example.yml / cordis.patch.sidecar.example.yml
├─ panel/               面板宿主半：只读路由 + 浏览器栅栏 + 载荷投影（protocol / status / route）
├─ client/              面板浏览器半（TSX；esbuild 打成 lib/client.js）
├─ scripts/             构建/诊断/假模型（fake-openai.mjs 等）+ safeharness_sidecar.py（可选 Python 引擎）
├─ tsconfig.client.json 浏览器半的类型检查（DOM lib + react-jsx，noEmit）
├─ tests/               1042 个用例（66 个文件，1.19.0）
└─ package.json         engines.dsh 是唯一兼容门；dependencies 为空
```

设计约束（为什么代码长这样）：

1. **判定与 IO 分离**：`src/engine` 是纯函数，输入文本 → 判定，便于测试与移植；`hooks` 只做 DSH 事件签名到纯函数的转换。
2. **装配顺序**：配置 → judge/LLM 门禁 → 规则 → 账本 → 运行时 → 宿主面探测 + `plugin_loaded` + 姿态门禁 → 提供服务 → 注册各面 → 工具/命令/设置面检测 → 规则监听。硬门禁在**注册任何监听器之前**执行，拒绝加载时不留半装配。
3. **fail-closed**：执行面任何异常/未知状态 → deny；观察面异常 → 记录并继续。
4. **零运行时依赖**：只用 Node 内置模块；`@deepseek-ai/*` 全部是 optional peer，由宿主提供。
5. **同步 guard**：`ctx.tools.guard()` 的判定必须是同步、无 IO、有界的，异常即 deny。

---

## 10. 开发与测试

```bash
pnpm install          # 宿主包已作为 devDependencies 固定版本，构建/测试不再需要本机装 DSH
pnpm build            # 宿主半 tsc → lib/；浏览器半 tsc 类型检查 + esbuild → lib/client.js
pnpm test             # vitest：66 个文件 / 1042 个用例（1.19.0；含 golden/sidecar/失败矩阵/面板 jsdom 契约）。公开树按发布过滤掉内部语料/fixture；CI 另剔除 tests/perf.test.ts
pnpm typecheck        # tsc --noEmit
node scripts/link-dsh.mjs --check   # 可选：把类型解析对齐到本机 DSH 安装的宿主副本
```

- **可独立构建**：`@deepseek-ai/cordis`、`schemastery`、`dsh-*` 等宿主包在 `devDependencies` 里按精确版本固定（npm 上已发布）；运行时它们仍由 DSH 进程提供，插件自身零运行时依赖。
- **`dsh-invariants` 只用于编译**：它没有 `0.2.x` 发布线，因此 `peerDependencies` 与 `devDependencies` 固定为 `0.1.0-rc.8`（类型来源）；运行期用的是宿主 `ctx.invariants` 服务，不 import 该包。
- **CI**：`.github/workflows/ci.yml` 在干净 runner 上跑 `pnpm install && pnpm build && pnpm test`（跳过对机器抖动敏感的 `tests/perf.test.ts`，性能预算在本机 `pnpm test` 里照常执行）。
- **公开树发布**：`node scripts/publish-public.mjs --target <worktree>`。哪些文件能发、哪些永远不发，写在脚本的 `PUBLISH_TOP` / `NEVER_PUBLISH` 里（内部语料、golden fixture、`evidence/`、构建产物、tarball 一律拒绝）；`tests/publish-guard.test.ts` 守着这份计划，`--check` 只打印计划、`--check --target <dir>` 只扫目标目录有没有泄漏。

- **测试分布**：输入/工具/SQL/规则、五个钩子、账本与脱敏、姿态、巡检、预算、审批桥、judge、失败矩阵、性能预算、以及真实 DSH 会话的假模型回放（`scripts/fake-openai.mjs`）。
- **Python↔TS 黄金一致性**：20 条 inform 规则与 SQL 判定在内部语料上 30/30 一致（内部验证，语料与 fixture 属内部资产，**不随本仓库分发**；因此 `pnpm test` 中的 3 个用例在缺少语料时跳过）。1.2.0 起另有 sidecar 一致性测试：内置引擎与真实 Python 引擎对同一批语料逐条比对 `Decision`（同样需要内部语料与本机 Python，公开树不包含）。
- **本地假模型全链路**（无需真实 Key）：`scripts/fake-openai.mjs` 是 OpenAI Chat Completions 兼容的 SSE 服务器，可脚本化 text / 工具调用 / 并行工具 / Code Mode / 500 / 长挂起 / judge 判决等场景；请求日志只记 sha256 与长度，不记 prompt 与 Key。
- `scripts/session-dump.mjs` 只读解析 DSH 的 `.jsonl.zstd` 会话日志（多帧 zstd），用于本机排查；会话日志含真实对话内容，**只用于本机诊断，不要提交或贴到 issue**。

---

## 11. 已知限制

1. **运行期宿主包版本以 host 实际解析为准**：本机实测插件的 `@deepseek-ai/*` 裸导入会解析到 DSH bundle 内的副本（`0.2.2-rc.3` 与 `0.2.2-rc.5` 两个桌面版实测 `dsh-tools`/`dsh-settings`/`dsh-*` 均随宿主整体移动，`cordis`/`schemastery` 为 `4.1.0` / `3.19.0`），而不是 profile 里的构建期副本。因此本包不 import 任何可能漂移的具名导出；`safeharness_status.host` 会显示实际解析来源（`app-bundle` / `profile` / `mixed`）。
2. **兼容门有两个，分工不同**：粗门是 `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`（存在该字段时 DSH 只按它判断，不再逐条比对 peer 版本）；细门是运行期验过的版本表——`PINNED_VERSIONS` 记当前钉住的版本，`PREVIOUSLY_VERIFIED_VERSIONS` 记**曾经实测过、仍按原样接受**的旧宿主版本（当前为 `0.2.2-rc.3`）。两个表都没有的版本会被 `plugin_version_mismatch` 判 WARN（balanced）/ FAIL（hardened，默认在 `posture.failOn` 里）。**只加不删**：删一项等于宣布不再支持那个宿主。
3. **安装形态决定改代码后的动作**：pnpm 默认把包复制进 profile（`file:` / tarball），改代码后需 `remove` + `add`；`link:` 安装则直接指向源码。**HMR 重载已在 `link:` 安装 + 非空 `hmr.root` 下实测**：连续两次改 `lib/` 都触发重挂载，`plugin_loaded` → `posture_report ok` → `invariant_probe seams=…,guard,…` 全部重现（内部证据，未随仓库分发）。注意重挂载有约 15–30 ms 的空窗，且生产部署应当关闭 HMR（`hardened` 的 `hmr_enabled` 姿态门禁会直接拒绝加载）。
4. **`enforce-buffer` 的代价**：牺牲流式；超过 `bufferTimeoutMs`/`bufferMaxChars` 会降级为透传（记账但不拦截）。完全停滞的流由宿主超时负责。
5. **语义 judge 是"附加信号"不是"误报消除器"**：它能拦住结构化规则漏掉的语义风险，但**不会**把已命中的回答改判为通过；临界误报要靠自定义规则或后续面解决。
6. **审批桥 `policy` 只能粗粒度**：`approval/request` 不携带工具参数；`allowOnce` 与 `denyTools/denyTags` 同时命中时**授予优先**（不要同时写两边）。真实人工批准路径未做端到端验证。
7. **姿态 `approval_never`**：没有 session 时无法读取全局默认审批策略，会报 SKIP 而不是 OK；因此它不在 `hardened` 的默认 `failOn` 里（门禁永不触发比漏报更危险）。有 session 级探针时仍会 FAIL。
8. **巡检对账是近似的**：用自家账本的 `tool_asked` vs `approval_decided`（不解析 DSH session log），偏差 >10% 才 WARN。
9. **Code Mode（PTC 执行器）**：0.2.2-rc.1 已移除 `tools.mode`；Code Mode = 启用 `tool-executor-ptc` 并停用 `tool-executor-native`（每个 scope 只能有一个执行器）。子调用会经过 `tools/pre-execute` 并被拒绝；注意 Windows 上 `bash` 工具不存在，场景用 `pwsh`。
10. **hardened 的版本门**：`hardened.posture.failOn` 含 `plugin_version_mismatch`，严格比对插件运行期真正依赖的 `cordis`/`schemastery`/`dsh-tools`。当前接受 `0.2.2-rc.5`（钉住）与 `0.2.2-rc.3`（曾实测、仍接受）两个宿主；其它 rc 版本按"未实测"处理。**注意**：`1.0.0-rc.1` 修复了"schemastery 把缺失数组物化成 `[]` 从而废掉预设表"的问题；更早版本在真实 host 上 hardened 门禁实际未生效，升级后请复核。
11. **桌面端命令面**：`/safeharness status` 与 `/safeharness judge probe` 已在桌面端输入框实测（2026-11-11，真实 judge 路由 `liao/gpt-6-luna`，`status=ok verdict=allow duration_ms=4347`）；`/safeharness patrol` 的 UI 触发仍只有处理器单测（`safeharness_patrol` 工具已在真实 host 跑通）。
12. **通知通道**：飞书 / 钉钉 / 企业微信 / OneBot / 通用五种信封已实现，每种都有 payload 单测，并有一次本地真实 HTTP 五通道联调（`tests/notify.test.ts`）；飞书的完整投递路径另有真实 HTTP 验证（本地 sink，内部证据未随仓库分发）。**真实飞书 / 钉钉 / 企业微信机器人投递：待验证**（需要真实 webhook URL / access_token；信封与加签已按官方格式单测，并有本地真实 HTTP 五通道联调）。配好任意一个真实通道后，制造一次 FAIL 巡检即可确认。
13. **高熵令牌启发式（1.8.1 收紧，1.8.4 加 SRI 豁免）**：只有同时含**小写、大写和数字**、**不是纯 hex**、**不是 Windows 路径**（`C:/...` / `file:///C:/...`）、且**不是 `sha1-` / `sha256-` / `sha384-` / `sha512-` 前缀的 SRI 摘要**的 ≥40 字符令牌才参与熵计算。纯十六进制摘要（`safeharness_status` 的 64 位 ruleset 哈希、`safeharness_audit_query` 的 sha256 链哈希、`git log` 的 40 位 commit id）、全小写路径片段（如 `@scope/pkg/lib/entry`）、Node 报错里的 `file:///C:/.../x.mjs`，以及 `pnpm-lock.yaml` 里的 `sha512-<base64>` 完整性摘要都不再误报 `credential_high_entropy`；`results.mode: enforce` 因此不会再拦掉插件自己的诊断结果、也不会把读 lockfile 整条替换。代价：全小写、无前缀的随机串不再由熵启发式兜底（仍可由 `credential_assignment` 等形态规则命中）。旧行为见 §12 R35，新决策见 R50。
14. **输出面目前只覆盖回答**：不覆盖 compaction / session-title 等内部 LLM 调用（judge 请求本身有递归防护，但内部调用不送审）。
15. **judge 的 URL/Key 属于宿主配置，不属于插件配置**：插件只携带 `provider`/`model` 路由，Key 由 DSH 凭据层按 `apiKeyEnv` 引用解析，插件既不读也不打印。换端点 = 改 profile 的 `llm-pi-ai.providers`，不需要改插件。
16. **真实模型冒烟只做过一次最小会话**：用真实 OpenAI 兼容端点（`gpt-6-luna`）跑通一轮 observe：`usage_input=29280 / usage_output=26`、judge `status=ok`（`judge_ms=7319`）。不同供应商在工具调用形态、流式分片、usage 上报上的差异仍需各自冒烟；`/safeharness judge probe` 就是为此准备的自检入口。
17. **规则起草只是"草稿"**：模型给的正则可能过宽（误杀）也可能过窄（漏检），插件只保证"结构与语法能过 loader 门"，不保证语义正确。`1.1.1` 起会对**明显过窄的形状**（纯字面量、短于 12 字符、单词元、chain 字面工具名）给出 `warnings`，但那仍然只是形状判断，最终要靠人看。起草需要一条可用的辅助路由（默认复用 judge 路由）；路由不可用时工具返回 `unavailable`，不会退回本地启发式，也不会静默生成一条看起来能用的规则。**1.9.0 起草稿可在面板一键落地**，但落地的仍是模型写的正则：loader 门只管"能不能加载"，不改变这条限制。
18. **Python sidecar 是可选增强，不是默认路径**：需要本机 Python 与 `src/safeharness` 可 import；只接管输入面，不接管 `tools.guard`（同步无 IO 约束）。规则热更新后到子进程确认前的输入会被拒绝（hardened）或回落内置引擎（observe/balanced）。它刻意不做 Python `InformPolicy` 的 NFKC/零宽清理，以保持与内置引擎判定一致；不做这一点是**显式取舍**，见 §4.4。子进程超时只让当次请求失败、不会自动重启；连续超时会让输入面持续降级，此时应看 `safeharness_status.engine` 与姿态 code。
19. **设置页只显示"显式覆盖"，不显示 preset 展开值**：DSH 设置页的表单值来自 profile patch 的 `config`（以及 schema 默认值）。本插件的预设展开在 `resolveConfig` 里完成，schema 刻意没有默认值（否则会废掉预设，R37），所以 `balanced` 下输入框里 `input.mode` 会是空的，而实际运行值是 `enforce`。改任一字段只会写该字段的覆盖值，不会把 preset 固化下来；这正是"preset 仍可整体切换"的前提。

20. **面板是“可选 UI + 有限动作”，不是第二个真相源**：四个计数是**本进程**计数（重启归零）；事件来自账本尾部，会话来自“持久化元数据索引 ∪ 账本事件”，两者重启后可能对不上——面板把“本进程计数 / 历史会话”分开标注，不做归一；账本轮转后事件列表只显示当前文件里的记录。1.8.0 起面板的动作是：运行巡检（写 `patrol_report`、可能通知）、定时巡检（5–1440 分钟，状态写 `$DSH_HOME/safeharness/panel-state.json`）、AI 起草（一次辅助模型调用，返回草稿，**不写入不启用**）、重新加载规则（重读 rules 目录，失败保留旧规则集）、保存评审/起草路由（经宿主 `settings` 服务写 `cordis.patch.yml` 的 volatile 字段并热更新）、添加/删除自定义模型（写 `llm-pi-ai.providers.<id>`；Key 写宿主凭据服务，不写 profile、不回显、不进账本）、导出账本片段（返回账本已有的脱敏 NDJSON，浏览器保存）。它仍然**不做通用调度**，也不替代 `safeharness_status` 工具；**1.9.0 起它多了一条人发起的写路径**——把草稿写成 `rules.dir` 下的一个文件并热重载（文件名白名单、默认不覆盖、写前 loader 试编译、原子写、账本只记 `rules_written` 的元数据），但**绝不写安装包自带 `rules/`**，也没有模型可调用的对应工具。**会话标题来自宿主 `sessionTitle` 服务**（用户重命名或标题提供方建议），与工作区/创建时间一起写入 `$DSH_HOME/safeharness/sessions.json`（只有 `sessionId / workspace / createdAt / title / touchedAt`，无计数、trail、prompt、参数或输出）；标题只用于面板显示，不进账本、不进模型上下文，取不到时回落“项目 + 短会话 id”。样式跟随宿主主题（读 `documentElement` 的 `color-scheme`/`data-theme`），设置弹窗高度固定，面板内容较长时在弹窗内滚动。`settings.plugins.tab` 是 0.2.2 宿主实测存在的槽；换宿主大版本时先查账本里的 `invariant_probe`，再决定标签页挂到哪。自定义路由只支持 pi-ai 的三种手写协议（OpenAI Completions / OpenAI Responses / Anthropic Messages），Bedrock/Vertex/Azure/Codex 需要各自环境与签名。插件顺序是“prepend 最佳努力 + guard 单调兜底”，不是绝对优先；详见 §4.8。

21. **嵌套量词是加载门，不是风格建议（1.14.2）**：输入面在 `agent/pre-step` 里**同步**跑规则，JS 正则一旦开始回溯就无法中断——一条 `(a+)+` 不是"慢一点"，是**卡死整轮**（Python 侧的旧邮箱正则曾在 256 KiB 上跑 111 s，加长度上界才回到毫秒级）。所以 loader 现在对 `(a+)+` / `(.*)*` / `([a-z]+)*` 这类"组内已有无界量词、组外再套无界量词"的形状**直接拒绝**，`rules.dir` 手写文件与 `rules.inline` 都不例外。它是**形状启发式**：抓不住 `(a|aa)+` 这种交替爆炸，也不拒绝 `(\d{3}){2}` 这种有界嵌套（多项式，不是灾难）。被拒时改写法（拆成两条规则、用字符类、或加锚点/长度上界），不要试图绕过加载门。

22. **凭据检测是"形态"不是"真值"（1.15.1）**：结果面/输出面/流内脱敏用的都是形态正则（`sk-`、`Bearer`、私钥头、`api_key: "…"` 赋值、40+ 字符高熵令牌）。它们覆盖了真实踩到的格式（JSON 引号名、`LLM_API_KEY` 这类长名后缀、跨 delta 拆分），但**不能保证**所有密钥格式：自定义厂商的短 token、被拆成多段拼接的字符串、或者写在自然语言里的片段仍可能漏过。流内脱敏另有 256 字符窗口：比这更长的令牌有极小的概率前半段已经透传。真正的边界是**不要在 prompt/工具结果里出现真实密钥**；检测是兜底，不是许可。2026-11-19 的教训：`"LLM_API_KEY": "…"` 因两个正则细节（`\b` 卡在 `_` 与 `A` 之间、键名后的引号）曾整条漏过，输出面当时也完全没有凭据扫描——三处都已修。

23. **参数形状规则是"形状"不是"授权"（1.16.0）**：`tools.argSchemas` 只回答"这个参数长得对不对"，不回答"这个调用该不该被允许"。所以它**不能**替代内核的 `ToolCatalog` + `CapabilityAuthority`：没有工具签名比对、没有能力票据、没有 `unknown_tool` 判定。它也不做类型系统之外的事——`additionalProperties` / `items` / `required` 这类 JSON Schema 结构不在支持范围内，宿主自己的入参校验负责那一层。另外三条边界：① 只约束**实际出现**的参数（漏传由工具自己拒绝）；② 同一工具命中多条 schema 时**全部生效（AND）**，拒绝理由取声明顺序里第一条违规的（1.16.2 起文档与代码一致，见 §4.11）；③ `pattern` 走的是规则 loader 的同一道 ReDoS 门，但仍然是**你写的正则**——`(a|aa)+` 这种交替爆炸不在启发式覆盖范围内（同 §11 第 21 条）。

24. **语义 judge 会返回"空回答"，而且短正文比长正文更容易（2026-11-20 只读取证）**：`scope: always` 下真实发生的是 `judge_status: empty / reason: empty_model_reply`——模型调用了、token 也计费了（`usage_output` 中位数 690，最大 11579），但**一个 `text-delta` 都没吐**，于是 `response_chars=0`，按失败矩阵降级成 `output_judge_unavailable`（balanced 记账放行，hardened 拒绝）。按账本现有的 30 条真实判官调用分组看：`ok` 组正文中位数 275 字符、prompt 中位数 510；`empty` 组正文中位数 **90** 字符、prompt 中位数 **325**、耗时中位数 **959 ms**；`timeout` 组正文中位数 3861 字符。**相关性很清楚：正文越短越容易空回**（最小的一条正文只有 18 字符），长正文则是另一种失败（超时）。19 条 `empty` 里有 5 条的 `usage_output` 超过了本插件给的 `maxTokens`（2048），说明这些回答把预算花在了**不产生 `text-delta` 的地方**（推理段或供应商侧的路由行为），而不是"回答被截断"。**行为是对的**：空回答被判为 `unavailable` 而不是 `allow`，balanced 只记账、hardened 会拒。**没做的事**：没有为此改动任何代码——把 `reasoning-delta` 也当作回答会改变判定语义（那正是要审的内容与推理过程混在一起），把空回答当 `allow` 则等于放宽；下一步应当是**换一个对短 prompt 稳定的判官路由**，或者给 `scope` 加一档"只审长回答"，两者都要先有更多样本再定。这条写在这里，是为了让下一个人不要把它当成一次偶发抖动。

25. **结果面的 `block` 对写工具是"事后告警"，不是"事前阻断"（1.16.1 写明）**：宿主管线是 `tools/pre-execute` → 工具体真正执行 → `tools/post-execute`。结果面拦下的是一次**已经发生**的调用：插件的 `block` 把结果换成固定话术、把这次调用标成 `isError`，**副作用留在原地**。所以：

    - 对**读类**工具（`read` / `grep` / `glob` / 网络抓取）结果面拦截是**真拦截**：内容不进模型上下文，等于没读到。
    - 对**写类**工具（`edit` / `write` / `apply_patch` / 命令类）结果面拦截**只管通知**：文件已经写了、命令已经跑了。要事前拦住，唯一的位置是 `tools/pre-execute`（`denyTools` / `askTools` / `tools.argSchemas`）。
    - **重试风险**：模型看到"被拦截"会再试一次。写工具第二次执行时，`edit` 的同类替换通常幂等，但 `write` / 追加 / 命令类**不是**——同一段内容可能被写两遍、命令可能跑两次。这是这条边界最贵的地方。

    2026-11-20 真实验证（本仓库维护过程）：编辑 `src/config.ts`（里面有 `const secret = …` 这类字段声明）时，结果里出现了这条规则的形状，`results.mode: enforce` + `blockOn: ['credential_leak']` 直接 block；**文件已经改好了**，模型拿到的却是拒绝话术。同时 `read` / `grep` 同一批文件也返回拒绝文本，"改插件的插件在拦改插件的人"。1.16.1 修的是**误报那一半**（源码声明 / `${…}` 模板占位 / `[REDACTED:credential]` 自身占位不再算凭据）；"结果面对写工具不可撤销"这一半是宿主管线决定的，**改不了，只能写清楚**。

    实践建议：要拦写动作，把工具放进 `tools.askTools` 或给它写 `tools.argSchemas`（都在 pre-execute，真的拦得住）；`results.blockOn` 只用于"内容不该进模型"的场景，别指望它撤销副作用。

26. **沙箱姿态只为"见过的会话"作答（1.16.2）**：`sandbox_danger_full_access` 现在取的是部署默认值与**本进程观察到的所有会话**中最宽的那个（§5.2）。它能抓到"profile 默认是 workspace-write，但这个对话被切到 danger-full-access"，因为采集点是 `agent/pre-step` / `tools/pre-execute` / `approval/request` 三个真实执行点，加上会话自己的 `sandbox/mode` 事件。它抓不到的是：**插件加载之前就已存在、此后没有任何事件**的会话——那种会话没有进过任何一个接缝，插件没有关于它的任何观测。所以这条的准确措辞是"没有观察到宽模式"，而不是"所有会话都受限"。要收严这条，需要宿主提供"列出所有活动会话及其沙箱模式"的接口；当前没有，插件不假装有。另外三点：① 模式读不到的会话按 WARN 计（`hardened` 为 FAIL），**读不到不等于安全**；② **加载那一刻只有默认值可读，这一项是 `SKIP` 而不是 `OK`**——门禁跑在任何接缝接线之前，那是顺序决定的，不是可以配掉的；所以 hardened 的门禁实际拦的是"部署默认值本身危险"，会话切宽只能在会话出现后由 `safeharness_posture` / 巡检报 `FAIL`（此时插件已经在跑）。③ 结构性只读的模型侧展示仍以 `detail` 里的模式名为准，别把 `hardened` 的 FAIL 当成"沙箱已生效"——它是"沙箱确实没生效，所以拒绝加载"。

---

## 12. 安全边界与许可

**边界**：

- 本插件运行在 DSH 进程内，与模型、工具共享同一运行时。**能停用插件的操作者也能绕过它**；这是 DSH "无特权核心" 的固有属性。生产部署请把"插件是否加载、账本是否连续、巡检是否通过"当作**外部可观测事实**，而不是信任插件自证。
- 账本只保证"记录脱敏且可校验完整"，不保证"记录不可删除"——删除账本文件本身就是一种可被巡检发现的信号。
- 语义 judge 依赖宿主模型路由；judge 不可用时按预设降级，`hardened` 选择拒绝输出而不是放行。
- **拦截时机与不可撤销性**（详见 §11 第 25 条）：`agent/pre-step` / `tools/pre-execute` 是**事前**拦截，能真正阻止；`tools/post-execute` 与 `llm/stream` 是**事后**处置，对被拦下的写工具副作用不可撤销。想知道"这个面能不能真拦住"，看接缝在宿主管线里的位置，不要看 `mode` 的名字。

**密钥纪律**：配置里的 webhook / token 永不打印、永不写账本；账本只存哈希与长度；假模型脚本使用哨兵 key（`sk-fake-sentinel`），不是真实凭据。

**许可**：本包 Apache-2.0（见 [`LICENSE`](LICENSE)）。所依赖的 DSH 官方包为 MIT；本仓库不打包、不修改 DSH 代码。本仓库**不包含** Upear 平台后端、Python 安全框架、前端以及内部攻击语料。
