# @upear/dsh-safeharness

DeepSeek Harness（DSH）的智能体安全插件：把 SafeHarness 的安全语义装进 DSH 的执行生命周期——输入防线、工具调用管控、工具结果守卫、输出复查、语义 judge、审批桥、审计账本、姿态自检与外部巡检，全部以一个 **profile 级 Cordis 插件包** 交付。

> 版本 `1.0.0-rc.4` · 宿主 DSH `0.2.2-rc.1` · Node ≥ 24 · 运行时零第三方依赖 · Apache-2.0

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
        全程 ──► NDJSON 哈希链账本 ◄── 姿态自检（9 项）· 外部巡检（5 项）· 预算护栏
```

| 接缝 | 能力 | 拦截语义 |
|---|---|---|
| `agent/pre-step` | 用户输入注入检测：`rules/inform.yaml` 的 20 条中英文规则（prompt injection / instruction override / identity impersonation / hidden command），critical 规则直接 deny；超长输入截断后匹配并记 WARN | `{kind:'reject'}` 或放行 |
| `tools/pre-execute` | 工具名 glob 的 `denyTools` / `askTools`、语义标签 `denyTags`、参数字节上限、参数内 SQL 结构判定（`DROP`/`DELETE`/`INTO OUTFILE` 等）、轨迹链规则（工具 A → 工具 B，限 `max_gap`） | allow / deny / ask |
| `ctx.tools.guard()` | 与 pre-execute 同源的**同步**判定；不能 await、不碰 IO，异常一律 deny | `string \| undefined`（返回即拒绝原因） |
| `tools/post-execute` | 工具结果守卫：凭据形态（私钥/API key/高熵令牌）、注入标记（如工具结果里伪造的指令）、被拒重试压力；命中可整条替换或阻断 | accept / block |
| `tools/result` | 只读观察工具结果，写账本，不改变结果 | — |
| `llm/stream` | 输出复查：结构化复核 + 可选语义 judge（走宿主 `ctx.llm`）。`warn` 只记账；`enforce-buffer` 会缓冲整条回答后决定回放或替换 | 透传 / 替换 |
| `approval/request` | 审批桥粗粒度判定：`allowOnce` 一次性授予 → 复用 deny 列表 → 其余 delegate；`delegate` 也写审计对，供巡检对账 | 授予 / 拒绝 / 委托 |
| 系统提示词 | 在工具引导区（`order: 190`）注入 ≤300 字符的部署约束条款，**不含**规则正文、数量、阈值 | — |
| 只读工具 / 命令 | 4 个 `safeharness_*` 工具 + `/safeharness` 命令，供模型与操作者自查 | — |
| 姿态 / 巡检 | 加载时姿态门禁（可配 `failOn`）、5 项外部巡检与退出码（0/1/2）、可选多通道通知（飞书 / 钉钉 / 企业微信 / OneBot / 通用 webhook） | 拒绝加载 / FAIL |
| 预算 | 每轮 `input+output` token 累计，越限只记一条 `budget_exceeded`（不拦截） | — |

### 2.1 输入防线

- 规则来自 `rules/inform.yaml`，与 Python 侧 `_DEFAULT_PATTERNS` 逐条同源（20 条，正则文本逐字移植，`iu` 标志）。
- 严重度：critical（纯指令覆盖）可 deny；high 只记录。
- 输入超长（默认 60000 字符）先截断再匹配；截断本身记 WARN，不单独拒绝。
- 拒绝话术是固定的一句通用说明，不回显命中内容；被拒输入不会进入模型历史。

### 2.2 工具执行面

- `denyTools` / `askTools` 只支持 `*` 通配，大小写不敏感；`denyTags` 使用语义标签（`shell` / `network` / `file-write` 等），可用 `tools.tagOverrides` 覆盖工具名→标签映射。
- 参数扫描有**节点数与字符数预算**，遇到循环引用/超深结构不会爆栈，直接 fail-closed deny。
- SQL 判定是结构判定：危险关键字、批处理、导出子句；`SELECT 1; SELECT 2` 不算危险。
- 轨迹链规则默认 3 条（例如"先读凭据再外联"一类组合）；链规则只认工具名正则或标签，不依赖操作者额外配置。
- 同步 guard 是最后一道内联兜底：pre-execute 是异步的，guard 是同步的；两者都对结果写账本。

### 2.3 输出面与语义 judge

- `output.mode: warn`：只记录 `output_reviewed`，不改回答。
- `output.mode: enforce-buffer`：缓冲整条回答后再决定回放还是替换——**代价是牺牲流式**，首字延迟等于整条生成时间；受 `bufferTimeoutMs`（默认 15000）与 `bufferMaxChars`（默认 512000）约束，超限**降级为透传**并在账本记 `labels.buffer=timeout|max_chars`，不会静默吞回答。
- 可选 judge（默认关闭）：通过宿主 `ctx.llm` 做一次结构化复核，`scope: flagged` 只复核已被结构化规则命中的回答（省成本），`always` 每答必审。judge 不可用/超时/坏 JSON 时按预设降级：`hardened` 拒绝输出，`observe`/`balanced` 记 WARN 放行。judge 自己的模型调用带内部标记，**不会被再次复核**（递归防护）；只有 tool_calls、没有文本的回答不送 judge。

### 2.4 审计、姿态、巡检、预算

- **审计**：单行 JSON、哈希链（`prev_sha256`）、按字段名脱敏、按大小轮转；只存哈希与长度，不存原文（详见 §6）。
- **姿态**（9 项）：`sandbox_danger_full_access`、`approval_never`、`hmr_enabled`、`rules_loaded`、`ledger_writable`、`ledger_chain_ok`、`output_guard_off`、`judge_unavailable`、`plugin_version_mismatch`。`posture.failOn` 里的 code 一旦 FAIL，`apply()` 抛错拒绝加载。
- **巡检**（5 项）：`audit_rate`（拒绝速率异常）、`health_probe`（GET 探针）、`config_drift`（与上次姿态报告对比）、`ledger_reconcile`（`tool_asked` vs `approval_decided` 对账）、`notify`（可选，多个通道）。退出码 `0` 干净、`1` 有 FAIL、`2` 巡检自身出错；巡检函数**从不抛异常**。
- **预算**：`budget.maxTokensPerTurn > 0` 时按轮累计，越限只 warn（一个回合只记一条）。

---

## 3. 快速开始

### 3.1 前置

| 依赖 | 要求 | 说明 |
|---|---|---|
| DSH | `0.2.2-rc.1` | 桌面应用自带 CLI：Windows 在 `<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd`，其它平台同理 |
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
pnpm build            # tsc -> lib/
pnpm test             # 477 个用例（23 个文件）

# 产出可分发的 tarball
pnpm pack --pack-destination ./dist
# -> dist/upear-dsh-safeharness-1.0.0-rc.4.tgz（lib + rules + README + LICENSE）
```

`link-dsh.mjs` 默认从 `$DSH_HOME`（默认 `~/.dsh`）的 `profiles/node_modules` 找宿主包；如果你的 DSH 是桌面版，可显式指定：

```powershell
$env:DSH_NODE_MODULES = 'C:\Program Files\<DSH>\resources\app.asar.unpacked\node_modules'
node scripts/link-dsh.mjs
```

### 3.3 安装到 profile

```powershell
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'   # 或 PATH 里的 dsh
& $dsh plugin --profile <profile> add "file:$PWD\dist\upear-dsh-safeharness-1.0.0-rc.4.tgz"
```

开发期也可以直接从目录装（pnpm 会把包**复制**进 profile，不是软链）：

```powershell
& $dsh plugin --profile <profile> add 'file:<本仓库绝对路径>'
```

### 3.4 启用（patch 层）

编辑 `$DSH_HOME\profiles\<profile>\cordis.patch.yml`，**追加**（注意 `insert:`——只有 `id:` 的条目是"覆盖已有条目"，不会新增插件）：

```yaml
- insert:
    - id: safeharness
      name: "@upear/dsh-safeharness"
      config:
        preset: balanced          # observe | balanced | hardened
        audit:
          dir: ""                 # 空 = $DSH_HOME/safeharness/audit
```

推荐的"不变量"配套（评估/加固环境建议启用）：

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

配置从 profile patch 的 entry `config` 传入，同时注册为 settings 命名空间 `safeharness`（设置变更即时重编译规则；审计目录变更需重启，日志会说明）。

```yaml
config:
  preset: balanced                        # observe | balanced | hardened
  rules: { dir: "", watch: true, inline: [] }
  input: { mode: enforce, maxChars: 60000 }
  tools:
    mode: enforce
    denyTools: ["bash", "pwsh"]           # 工具名 glob（只支持 *）
    askTools: ["mcp_*"]
    denyTags: ["network"]
    maxArgsBytes: 65536
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
```

字段要点：

- `input.maxChars`：超长文本截断后匹配（只记 WARN）。
- `tools.mode: warn`：判定与记录照常，但不拦截。
- `results.blockOn`：只在 `results.mode: enforce` 时生效；命中即整条结果被替换（内容替换是保密边界，所以作用于整条结果）。
- `output.mode: enforce-buffer`：牺牲流式，首字延迟 = 整条生成时间；超时/超长降级为透传并留痕。
- `output.judge`：不自建 HTTP 客户端，走宿主 `ctx.llm`；不可用时按预设降级（hardened 拒绝输出）。
- `approval.mode: policy`：只做粗粒度判定；`approval/request` 不携带工具参数，**不要**把它当第二套策略引擎。`allowOnce` 与 deny 列表同时命中时**授予优先**（部署方不要同时写两边）。
- `posture.failOn`：列出的 code 一旦 FAIL 即拒绝加载（建议只在 hardened 开启）。
- `patrol.notify`：0..N 个通知通道（见 §4.2）；通道 URL、签名 secret、bearer token 都按凭据处理，永不打印、永不入账本；通知正文只有 `Upear SafeHarness: N FAIL / M WARN`。旧的 `patrol.feishuWebhook` 仍可用，等价于一条 `feishu` 通道。
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
| 姿态门禁 `failOn` | 空 | 空（只报告） | `sandbox_danger_full_access` / `approval_never` / `hmr_enabled` / `plugin_version_mismatch` |
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
| 插件被停用 | 无保护（外部巡检兜底） | 同 | 同 |
| DSH 版本不匹配 | WARN | WARN | 拒绝加载 |

总原则：**执行面任何未知/异常 → deny；观察面任何异常 → 记录并继续**。绝不"出错即放行"。

---

## 6. 审计账本与隐私

默认路径 `$DSH_HOME/safeharness/audit/ledger.ndjson`（可用 `audit.dir` 改）。单行 JSON，哈希链：

```json
{"v":1,"ts":"2026-11-11T01:47:20.963Z","seq":1,"kind":"plugin_loaded","decision":"ok",
 "preset":"observe","ruleset_hash":"d53dedc1…","plugin_version":"1.0.0-rc.4",
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
| `safeharness_posture` | 立即跑姿态检查（9 个 code，FAIL/WARN/OK/SKIP） |
| `safeharness_patrol` | 立即跑巡检（5 项），返回 findings、summary 与退出码 0/1/2 |
| `safeharness_audit_query` | 读账本尾部（已脱敏），按 session/decision/kind 过滤，上限 500 条 |

命令：`/safeharness status | posture | rules | audit [n] | patrol [check…] | judge [probe]`。命令输出不进模型历史；`patrol` 首行是退出码；`judge` 不带参数只看路由与 `llm` 服务是否就绪，`judge probe` 才会真打一次模型（只回报 status/verdict/耗时，不打印任何内容或凭据）。

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
| 策略中心热生效 | settings 命名空间 + `rules.watch` | 已移植；**无** UI 与人工闸门 |
| 多智能体 FSM / 租户隔离 / MCP 守卫 / 前端 | — | **不移植**（属于平台侧，与本插件职责无关） |

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
│  ├─ hooks/            DSH 事件薄层：input / tools / llm / approval / context
│  ├─ judge/            语义 judge 内核（零依赖，超时/坏 JSON/空回答处理）
│  ├─ patrol/           外部巡检（5 项，永不抛异常）
│  ├─ posture/          姿态检查（9 项）
│  ├─ audit/            账本：NDJSON 哈希链、脱敏、轮转、路径解析
│  ├─ surface/          只读工具、命令、系统提示词条款
│  ├─ budget.ts         每轮 token 预算
│  ├─ invariant.ts      不变量 companion 入口（./invariant）
│  ├─ runtime.ts        运行时状态与共享话术
│  └─ version.ts        版本（与 package.json 同步，测试锁定）
├─ rules/               inform.yaml（20 条）+ chains.yaml（3 条）
├─ examples/            cordis.patch.example.yml / cordis.patch.judge.example.yml / cordis.patch.notify.example.yml
├─ scripts/             构建/诊断/假模型（fake-openai.mjs 等）
├─ tests/               477 个用例（23 个文件）
└─ package.json         engines.dsh 是唯一兼容门；dependencies 为空
```

设计约束（为什么代码长这样）：

1. **判定与 IO 分离**：`src/engine` 是纯函数，输入文本 → 判定，便于测试与移植；`hooks` 只做 DSH 事件签名到纯函数的转换。
2. **装配顺序**：配置 → judge/LLM 门禁 → 规则 → 账本 → 运行时 → 宿主面探测 + `plugin_loaded` + 姿态门禁 → 提供服务 → 注册各面 → 工具/命令/设置 → 规则监听。硬门禁在**注册任何监听器之前**执行，拒绝加载时不留半装配。
3. **fail-closed**：执行面任何异常/未知状态 → deny；观察面异常 → 记录并继续。
4. **零运行时依赖**：只用 Node 内置模块；`@deepseek-ai/*` 全部是 optional peer，由宿主提供。
5. **同步 guard**：`ctx.tools.guard()` 的判定必须是同步、无 IO、有界的，异常即 deny。

---

## 10. 开发与测试

```bash
pnpm install          # 宿主包已作为 devDependencies 固定版本，构建/测试不再需要本机装 DSH
pnpm build            # tsc -> lib/
pnpm test             # vitest：26 个文件 / 521 个用例（内部含黄金语料；不含语料的公开克隆为 23 文件 / 504 用例 = 501 pass + 3 skip）
pnpm typecheck        # tsc --noEmit
node scripts/link-dsh.mjs --check   # 可选：把类型解析对齐到本机 DSH 安装的宿主副本
```

- **可独立构建**：`@deepseek-ai/cordis`、`schemastery`、`dsh-*` 等宿主包在 `devDependencies` 里按精确版本固定（npm 上已发布）；运行时它们仍由 DSH 进程提供，插件自身零运行时依赖。
- **`dsh-invariants` 只用于编译**：它没有 `0.2.x` 发布线，因此 `peerDependencies` 与 `devDependencies` 固定为 `0.1.0-rc.8`（类型来源）；运行期用的是宿主 `ctx.invariants` 服务，不 import 该包。
- **CI**：`.github/workflows/ci.yml` 在干净 runner 上跑 `pnpm install && pnpm build && pnpm test`（跳过对机器抖动敏感的 `tests/perf.test.ts`，性能预算在本机 `pnpm test` 里照常执行）。

- **测试分布**：输入/工具/SQL/规则、五个钩子、账本与脱敏、姿态、巡检、预算、审批桥、judge、失败矩阵、性能预算、以及真实 DSH 会话的假模型回放（`scripts/fake-openai.mjs`）。
- **Python↔TS 黄金一致性**：20 条 inform 规则与 SQL 判定在内部语料上 30/30 一致（内部验证，语料与 fixture 属内部资产，**不随本仓库分发**；因此 `pnpm test` 中的 3 个用例在缺少语料时跳过）。
- **本地假模型全链路**（无需真实 Key）：`scripts/fake-openai.mjs` 是 OpenAI Chat Completions 兼容的 SSE 服务器，可脚本化 text / 工具调用 / 并行工具 / Code Mode / 500 / 长挂起 / judge 判决等场景；请求日志只记 sha256 与长度，不记 prompt 与 Key。
- `scripts/session-dump.mjs` 只读解析 DSH 的 `.jsonl.zstd` 会话日志（多帧 zstd），用于本机排查；会话日志含真实对话内容，**只用于本机诊断，不要提交或贴到 issue**。

---

## 11. 已知限制

1. **运行期宿主包版本以 host 实际解析为准**：本机实测插件的 `@deepseek-ai/*` 裸导入会解析到 DSH bundle 内的副本（`dsh-tools`/`dsh-settings`/`cordis`/`schemastery` 为 `0.2.2-rc.1` / `4.1.0` / `3.19.0`），而不是 profile 里的构建期副本。因此本包不 import 任何可能漂移的具名导出；`safeharness_status.host` 会显示实际解析来源（`app-bundle` / `profile` / `mixed`）。
2. **兼容门只有一个**：`engines.dsh: ">=0.2.2-rc.1 <0.3.0"`。存在该字段时 DSH 只按它判断，不再逐条比对 peer 版本。
3. **安装形态决定改代码后的动作**：pnpm 默认把包复制进 profile（`file:` / tarball），改代码后需 `remove` + `add`；`link:` 安装则直接指向源码。**HMR 重载已在 `link:` 安装 + 非空 `hmr.root` 下实测**：连续两次改 `lib/` 都触发重挂载，`plugin_loaded` → `posture_report ok` → `invariant_probe seams=…,guard,…` 全部重现（内部证据，未随仓库分发）。注意重挂载有约 15–30 ms 的空窗，且生产部署应当关闭 HMR（`hardened` 的 `hmr_enabled` 姿态门禁会直接拒绝加载）。
4. **`enforce-buffer` 的代价**：牺牲流式；超过 `bufferTimeoutMs`/`bufferMaxChars` 会降级为透传（记账但不拦截）。完全停滞的流由宿主超时负责。
5. **语义 judge 是"附加信号"不是"误报消除器"**：它能拦住结构化规则漏掉的语义风险，但**不会**把已命中的回答改判为通过；临界误报要靠自定义规则或后续面解决。
6. **审批桥 `policy` 只能粗粒度**：`approval/request` 不携带工具参数；`allowOnce` 与 `denyTools/denyTags` 同时命中时**授予优先**（不要同时写两边）。真实人工批准路径未做端到端验证。
7. **姿态 `approval_never`**：没有 session 时无法读取全局默认审批策略，会报 SKIP 而不是 OK。
8. **巡检对账是近似的**：用自家账本的 `tool_asked` vs `approval_decided`（不解析 DSH session log），偏差 >10% 才 WARN。
9. **Code Mode（PTC 执行器）**：0.2.2-rc.1 已移除 `tools.mode`；Code Mode = 启用 `tool-executor-ptc` 并停用 `tool-executor-native`（每个 scope 只能有一个执行器）。子调用会经过 `tools/pre-execute` 并被拒绝；注意 Windows 上 `bash` 工具不存在，场景用 `pwsh`。
10. **hardened 的版本门**：`hardened.posture.failOn` 含 `plugin_version_mismatch`，严格比对插件运行期真正依赖的 `cordis`/`schemastery`/`dsh-tools`。**注意**：`1.0.0-rc.1` 修复了"schemastery 把缺失数组物化成 `[]` 从而废掉预设表"的问题；更早版本在真实 host 上 hardened 门禁实际未生效，升级后请复核。
11. **`/safeharness patrol` 的 UI 触发未验证**：headless 一次性会话没有命令通道，只有处理器单测；`safeharness_patrol` 工具已在真实 host 跑通。`/safeharness judge probe` 同理：处理器与 judge 路由都有测试，但"在桌面端输入框里敲一次"这一步没有自动化。
12. **通知通道**：飞书 / 钉钉 / 企业微信 / OneBot / 通用五种信封已实现，每种都有 payload 单测，并有一次本地真实 HTTP 五通道联调（`tests/notify.test.ts`）；飞书的完整投递路径另有真实 HTTP 验证（本地 sink，内部证据未随仓库分发）。**真实飞书 / 钉钉 / 企业微信机器人未联调**（都需要真实 webhook URL；钉钉的加签逻辑已按官方算法单测）。
13. **高熵令牌启发式的已知误报**：≥40 字符、≥3.5 bits/char 的"令牌"（含长路径片段，如 `@scope/pkg-name/lib/entry`）会被判为 `credential_high_entropy`。`balanced` 只记 WARN；`hardened` 会整条阻断工具结果 → 用 `results.blockOn: []` 或 `results.mode: warn` 缓解（规则文本需与 Python 侧保持一致，不单独改）。
14. **输出面目前只覆盖回答**：不覆盖 compaction / session-title 等内部 LLM 调用（judge 请求本身有递归防护，但内部调用不送审）。
15. **judge 的 URL/Key 属于宿主配置，不属于插件配置**：插件只携带 `provider`/`model` 路由，Key 由 DSH 凭据层按 `apiKeyEnv` 引用解析，插件既不读也不打印。换端点 = 改 profile 的 `llm-pi-ai.providers`，不需要改插件。
16. **真实模型冒烟只做过一次最小会话**：用真实 OpenAI 兼容端点（`gpt-6-luna`）跑通一轮 observe：`usage_input=29280 / usage_output=26`、judge `status=ok`（`judge_ms=7319`）。不同供应商在工具调用形态、流式分片、usage 上报上的差异仍需各自冒烟；`/safeharness judge probe` 就是为此准备的自检入口。

---

## 12. 安全边界与许可

**边界**：

- 本插件运行在 DSH 进程内，与模型、工具共享同一运行时。**能停用插件的操作者也能绕过它**；这是 DSH "无特权核心" 的固有属性。生产部署请把"插件是否加载、账本是否连续、巡检是否通过"当作**外部可观测事实**，而不是信任插件自证。
- 账本只保证"记录脱敏且可校验完整"，不保证"记录不可删除"——删除账本文件本身就是一种可被巡检发现的信号。
- 语义 judge 依赖宿主模型路由；judge 不可用时按预设降级，`hardened` 选择拒绝输出而不是放行。

**密钥纪律**：配置里的 webhook / token 永不打印、永不写账本；账本只存哈希与长度；假模型脚本使用哨兵 key（`sk-fake-sentinel`），不是真实凭据。

**许可**：本包 Apache-2.0（见 [`LICENSE`](LICENSE)）。所依赖的 DSH 官方包为 MIT；本仓库不打包、不修改 DSH 代码。本仓库**不包含** Upear 平台后端、Python 安全框架、前端以及内部攻击语料。
