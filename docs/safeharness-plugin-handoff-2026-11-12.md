# DSH SafeHarness 插件交接文档（2026-11-12）

> 读者：**没有本会话上下文的新对话 / 新模型 / 新智能体**。
> 目标：读完这一份能接手开发、验证、发布，不需要再问原作者。
> 本文是**当前状态的唯一入口**；历史细节与 1.0–1.7 的踩坑记录见
> [`safeharness-plugin-handoff-2026-11-11.md`](safeharness-plugin-handoff-2026-11-11.md)（旧文，状态已过时，但坑清单仍有参考价值）。
> 内部文档，**不要提交到公开仓库**（公开仓库只发布 `plugins/dsh-safeharness` 的可发布子树）。

---

## 0. 一句话现状

`F:\AgentSecurity\Upear\plugins\dsh-safeharness` 里是一个 **DSH（DeepSeek Harness）profile 级 Cordis 安全插件** `@upear/dsh-safeharness`，把 SafeHarness 的安全语义（输入拦截、工具管控、结果守卫、输出复核/语义评审、审批桥、NDJSON 哈希链账本、姿态自检、巡检/通知、规则起草）装进 DSH 的执行生命周期。

当前版本 **1.8.1**（2026-11-12）。M0–M5 全部完成；1.8.0 增加自定义模型与账本导出，1.8.1 收紧高熵误报并**在桌面 profile 打开 `results.mode: enforce`**：含 `password=` / `sk-…` 的工具结果会在进入模型前被整条替换（已真机验证）。桌面 profile 已于 19:02 重启并运行 1.8.1；若窗口里仍是旧版本，完全退出（含托盘）后按 §9 升级。

剩余没有代码缺口，只有两个**环境验证**：真实飞书/钉钉/企业微信 webhook 投递（用户无法提供 webhook）和真实人工审批（需要 `approval: ask` 预设 + 人工点击）。这两项不影响代码收尾，部署时补验即可。

---

## 1. 30 秒速览

| 项 | 值 |
|---|---|
| 插件包 | `F:\AgentSecurity\Upear\plugins\dsh-safeharness`（包名 `@upear/dsh-safeharness`） |
| 当前版本 | `1.8.1`（`package.json` / `src/version.ts` / README 三处一致，`tests/version.test.ts` 会断言） |
| 宿主 | DSH `0.2.2-rc.1`；CLI `D:\dsh\resources\runtime\cli\bin\dsh.cmd`；桌面应用在 `D:\dsh` |
| 桌面端插件 | 桌面 profile 已指向 `upear-dsh-safeharness-1.8.1.tgz`；`desktop/node_modules/@upear/dsh-safeharness/package.json` 版本 1.8.1；应用 19:02 重启，`results.mode: enforce` |
| 桌面安装脚本 | `C:\Users\xiaojue\.dsh\plugin-tarballs\install-safeharness-desktop.cmd`（已指向 1.8.1；运行前必须完全退出 DSH，包括托盘） |
| 公开仓库 | `https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh`（remote 名 **`dsh`**），`main` = **`0062f4f`**，tag **`v1.8.1`**（tag 对象 `350b6c7...`） |
| 本地仓库 | `F:\AgentSecurity\Upear`，`main` 含 1.8.1 修复提交 `1fa45a6`（其后还有本文档提交）；`github` 备份远端已同步 main 与 v1.8.1 标签 |
| 测试 | 本机 **41 文件 / 697 用例**全绿；公开树 **38 文件 / 679**（676 pass + 3 skip）；CI 口径 **37 / 671**（668 + 3，另剔除 `tests/perf.test.ts`） |
| tarball | `dist/upear-dsh-safeharness-1.8.1.tgz`，318,953 B，sha256 `6071F100735B8262F5BED99EC47BA3C5A5595E8101DE5D09BBDD775B7909C61C` |
| 证据 | `plugins/dsh-safeharness/evidence/`（内部，gitignore，不提交；1.8.0 见 `1.8.0-provider-export.md` 与两张截图，1.8.1 见 `1.8.1-results-enforce.md`） |
| 计划 | `docs/plan-dsh-safeharness-plugin-2026-11-10.md`（任务卡 §9、决策/风险 §12；1.8.0 见 §12.19，1.8.1 见 §12.20） |
| 公开 README | 插件 README 的 §4.7（面板）、§4.8（顺序/覆盖/评审模型）是给用户的正式说明 |

---

## 2. 它是什么 / 不是什么

**是**：

- 一个 **profile 级 Cordis 插件**。在 profile 的 `cordis.patch.yml` 里用 `insert:` 挂载后，接管 DSH 的执行接缝。
- TypeScript 重写，**运行时零第三方依赖**（`dependencies: {}`）。
- 安全判定 + 证据 + 运维面的一体化：输入、工具调用、工具结果、模型输出、审批、预算、账本、姿态、巡检、规则起草、面板。

**不是**：

- 不是 Agent 预设（preset），不附带 `agent.cordis.yml`。
- 不 patch DSH 源码、不改宿主 bundle。
- 不是 Python 侧实现的打包；Python 输入引擎只是可选 sidecar（`engine.kind: sidecar`）。
- 不是外挂进程；judge/起草都走宿主自己的 `ctx.llm`。
- 不能保证“绝对最先执行”（见 §8）。

---

## 3. 架构（从 `src/index.ts` 的 `apply()` 读起）

### 3.1 启动顺序（实际代码）

1. 解析/校验配置：`Config`（schemastery）→ `resolveConfig()` 展开 preset（`observe` / `balanced` / `hardened`），产出 `ResolvedConfig`。
2. 加载规则集：`tryLoadRuleSet()`（packaged `rules/` + 操作者 `rules.dir` + inline），带 loader 门；失败保留旧集或按配置拒绝加载。
3. 建输入引擎：内置 engine（`src/engine/*`）或可选 Python sidecar（`src/engine/sidecar*`）。
4. 建账本：`createLedger()`（NDJSON、sha256 链、脱敏）。
5. 建运行时：`createRuntime()` + `SessionStateStore`（本进程会话状态 + 持久化元数据索引）。
6. 宿主 surface probe + **加载时姿态门**（`enforceLoadTimePosture`）。若 `posture.failOn` 命中，**在任何 seam 注册前**抛错，保证“拒绝加载”意味着本插件完全没生效。
7. `ctx.provide(SAFEHARNESS_SERVICE)`（供 invariant companion 观察）。
8. 注册 seam：`agent/pre-step`、`tools/pre-execute`、`ctx.tools.guard`、`tools/post-execute`、`tools/result`、`llm/stream`、`approval/request`。
9. 注册 system prompt 片段、斜杠命令（`/safeharness ...`）、工具（`safeharness_status` / `safeharness_posture` / `safeharness_audit_query` / `safeharness_patrol` / `safeharness_draft_rule`）。
10. 注册面板宿主半（`/safeharness` 路由，需要 `webServer`）、巡检 runner/scheduler、规则目录 watch。
11. 卸载时：flush 会话索引、停 sidecar、关账本。

### 3.2 五个安全面

| 面 | 接缝 | 行为 |
|---|---|---|
| 输入 | `agent/pre-step` | 20 条中英注入规则 + 危险 SQL 结构判定；按预设 deny/warn；拒绝话术不泄漏规则 |
| 工具调用 | `tools/pre-execute`（异步、可 ask/deny）+ `ctx.tools.guard`（同步、无 IO、单调） | 工具名/标签策略、参数预算、危险 SQL、调用链轨迹；异步 + 同步双保险 |
| 工具结果 | `tools/post-execute`（可 block）+ `tools/result`（纯观察） | 凭据形态、注入标记、被拒重试压力；结果 hash/长度落账 |
| 模型输出 | `llm/stream` | 结构规则复检 + 可选语义 judge；`warn` 记账透传，`enforce-buffer` 缓冲替换 |
| 审批 | `approval/request` | 一次性授予 → 复用 deny 列表 → 其余委派宿主；policy 模式按插件策略裁决 |

辅助：`budget`（每轮 token 预算）、`audit`（账本）、`posture`（10 项自检）、`patrol`（5 项巡检 + 多通道通知）、`draft`（规则起草，不落盘）、`surface`（命令/工具/提示词）、`panel`（Web 面板）。

### 3.3 关键目录

```
plugins/dsh-safeharness/
├─ src/
│  ├─ index.ts                 apply()、启动顺序、热更新、面板/巡检接线
│  ├─ runtime.ts               Runtime、DENIAL_TEXT/TOOL_DENIAL_TEXT 等通用话术
│  ├─ config.ts                Config schema、preset 展开、ResolvedConfig
│  ├─ state.ts                 SessionStateStore（trail/计数 + sessions.json 持久化）
│  ├─ budget.ts                每轮 token 预算
│  ├─ invariant.ts             invariant companion 入口
│  ├─ service.ts               对外 service 形状
│  ├─ version.ts               版本号（与 package.json 同步）
│  ├─ audit/                   ledger.ts / paths.ts / redact.ts / types.ts
│  ├─ engine/                  内置规则引擎：rules/tool/input/sql/types，sidecar 可选
│  ├─ hooks/                   context.ts / input.ts / tools.ts / llm.ts / approval.ts
│  ├─ judge/                   judge/client.ts：语义评审 prompt、超时、JSON 解析
│  ├─ draft/                   rule.ts：LLM 起草规则（返回 YAML，不应用）
│  ├─ panel/                   protocol.ts / status.ts / route.ts / settings.ts /
│  │                           schedule.ts / patrol-runner.ts
│  ├─ patrol/                  5 项巡检、通知、报告
│  ├─ posture/                 10 项姿态检查
│  ├─ notify/                  飞书/钉钉/企微/OneBot/generic 通道
│  ├─ surface/                 commands / tools / prompt
│  └─ client/                  panel.tsx + index.tsx（esbuild → lib/client.js）
├─ rules/                      packaged inform/chains YAML（20 规则 + 3 链）
├─ scripts/                    build-client / clean / link-dsh / publish-public /
│                              fake-openai / session-dump / safeharness_sidecar.py
├─ tests/                      41 个文件 / 697 用例
├─ README.md / CHANGELOG.md
└─ evidence/                   本机证据（gitignore）
```

### 3.4 面板（1.8.0）

五个标签：**概览 / 事件 / 规则 / 巡检 / 设置**。浏览器半是 `lib/client.js`（预构建 CJS 闭包工厂），通过 `ctx.slots.inject('settings.plugins.tab', …)` 注册；只用平台 seed 的 `react`，不 import 任何 DSH client 包。

宿主半路由（全部挂在 `/safeharness` 前缀，全部 POST-only、loopback Host + 同源 Origin 栅栏、body ≤ 16 KiB）：

| 端点 | 作用 | 关键约束 |
|---|---|---|
| `POST /safeharness/status` | 一次面板载荷（计数/模式/会话/规则/事件/定时/评审） | 只读投影，不含内容 |
| `POST /safeharness/patrol` | 跑一次巡检 | 单飞 + 手动 5 秒冷却，写 `patrol_report` |
| `POST /safeharness/draft` | AI 起草候选规则 | `draft.enabled`、描述 ≤ 2000、单飞，返回 YAML，不落盘 |
| `POST /safeharness/schedule` | 开/关定时巡检 | 5–1440 整数分钟，状态写 `$DSH_HOME/safeharness/panel-state.json` |
| `POST /safeharness/reload-rules` | 重读 rules 目录 | loader 门失败保留旧集 |
| `POST /safeharness/settings` | `op: read / save / probe / add-provider / delete-provider` | 见 §6 |
| `POST /safeharness/export` | 导出账本片段 | `limit` 1–500，返回脱敏 NDJSON 文本，宿主不落盘 |

面板**不是第二个真相源**：四个计数是“本进程”计数（重启归零）；事件来自账本尾部；会话来自“持久化元数据索引 ∪ 账本事件”。面板明确区分“本进程 / 历史”。

### 3.5 会话元数据索引（1.7.0）

`SessionStateStore` 把显示元数据写到 `$DSH_HOME/safeharness/sessions.json`：

- 字段只有 `sessionId / workspace / createdAt / title / touchedAt`；
- **不存**计数、trail、prompt、工具参数、模型输出；
- tmp+rename 原子写、750ms 合并、损坏文件忽略、卸载时 flush；
- 启动恢复为 `historical: true` 行，供面板工作区/对话筛选；第一次真实活动后转 live；
- 标题来自宿主 `sessionTitle` 服务（`ctx.get('sessionTitle').get(session)?.title`），在三个 hook + `session/event` 采集，latest-wins，只用于显示。

---

## 4. 配置、预设、评审模型、自定义模型

### 4.1 预设

`preset` 只是默认值集合，字段可逐项覆盖。典型值：

| 维度 | observe | balanced（默认） | hardened |
|---|---|---|---|
| 输入 | warn | deny | deny |
| 工具 pre-execute | warn | deny | deny |
| 同步 guard | 空转 | 硬规则 deny | deny |
| 结果 | warn | warn/enforce 按配置 | enforce |
| 输出 | warn | warn | enforce-buffer |
| 审批 | delegate | delegate | policy |
| 账本 required | false | true | true |

配置在 profile 的 `cordis.patch.yml` 的 `insert:` 块里，例如：

```yaml
- insert:
    - id: safeharness
      name: "@upear/dsh-safeharness"
      config:
        preset: balanced
        output:
          judge:
            enabled: true
            scope: flagged
            provider: liao
            model: gpt-6-luna
            timeoutMs: 6000
```

**桌面 profile 当前**（`C:\Users\xiaojue\.dsh\profiles\desktop\cordis.patch.yml`）就是 balanced + judge enabled / liao / gpt-6-luna / timeout 6000。**开发 profile `safeharness-dev`** 是 observe，另有一条历史遗留的 override（judge 关闭、路由空、timeout 4000），无害；不要把它当生产配置。

### 4.2 语义评审 judge（三个东西别混）

| 名称 | 用途 | 模型 | 说明 |
|---|---|---|---|
| 语义评审 judge | 审**模型输出**（额外一次模型调用） | `output.judge.provider/model`；本机桌面 `liao/gpt-6-luna` | `enabled` 且输出有文本；`scope: flagged` 只审结构规则命中的输出，`always` 审全部；不可用时按预设降级（hardened fail-closed） |
| Python sidecar | 异步**输入**判定（规则集同源） | **不用模型** | `engine.kind: sidecar`；本机未启用 |
| 规则起草 | 自然语言 → 候选 YAML | `draft.provider/model`，留空回落 judge 路由 | 面板/命令触发，单飞；草稿不写入不启用 |

### 4.3 自定义模型（1.8.0）

设置页“自定义模型”支持 pi-ai 的**手写路由**，三种协议：

- `openai-completions`
- `openai-responses`
- `anthropic-messages`

字段：路由名（`[a-z][a-z0-9-]{1,39}`）、显示名、协议、Base URL、API Key、模型 ID/显示名、可选“添加后设为评审模型”。

**写入路径**：

1. Key 经 loopback POST 一次 → `ctx.credentials.set('SAFEHARNESS_<ID>_API_KEY', key)` → `$DSH_HOME/.credentials.yaml`。
2. 路由写 `llm-pi-ai` 的 `providers.<id>`（整段 `providers` 是 `.volatile()`），经宿主 `settings` 服务写 `cordis.patch.yml` → loader 热更新：

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        api: openai-completions
        baseURL: https://api.example.com/v1
        apiKeyEnv: SAFEHARNESS_MY_GATEWAY_API_KEY   # 引用名，不是 Key
        displayName: My Gateway
        models:
          - id: my-model
            name: My Model
```

3. 插件自有 `$DSH_HOME/safeharness/providers.json` 只记录本面板添加的路由（id/显示名/协议/URL/模型/凭据引用名/时间），**不存 Key**。
4. 删除：若该路由仍被 judge/draft 使用 → `provider_in_use`，先改路由再删；删除时 `settings.mutate` unset `providers.<id>` + `credentials.unset`。
5. 添加失败会回滚刚写入的凭据；Key 不回显、不进账本/日志/错误消息。

**边界**：Bedrock（SigV4）、Vertex（project/location/ADC）、Azure（部署环境 + api-version）、Codex（OAuth）需要各自环境与签名，无法用一个 URL + Key 表达，面板不提供；Ollama/vLLM/OpenAI 兼容网关/Anthropic 兼容端点可以用。

### 4.4 设置写入路径

- judge/draft：`settings.update('safeharness', {output:{judge:{...}}, draft:{...}})`。
- provider：`settings.update('llm-pi-ai', {providers:{<id>:{...}}})`。
- 两者都经 `configEditor.edit` → `cordis.patch.yml` → loader reconcile → 本插件 `loader/volatile-update` → `applyHotConfig`。
- **只接受 volatile 字段**；`providers` 整段 volatile，judge/draft 字段 volatile。
- 设置服务/凭据服务不存在，或找不到可编辑 entry → 页面只读并说明原因。
- `save` 目前**不带 expectedRevision**（last-writer-wins）；并发编辑可能覆盖，后续可加 CAS（见 §12）。

---

## 5. 安全模型与不变量

### 5.1 零回显（zero-echo）

账本/日志/错误消息/finding **只允许出现哈希、长度、代码、配置名**；不允许：

- prompt / 用户原文；
- 工具参数原文 / 工具结果原文；
- 模型输出原文；
- webhook URL / token / API Key；
- 凭据。

面板载荷同样只投影：`ts/kind/decision/reason_code/tool/severity/category/rule_ids/args_sha256 前缀/短 session id/项目/标题/numeric counts`。规则清单是操作者自己写的规则模式，不属于回显。

例外（明确、仅显示、不落账）：会话标题、workspace/createdAt 写入 `sessions.json`；它们只用于面板辨识，不进账本、不进模型上下文。自定义模型的 Key 只进凭据服务、只留引用名。

### 5.2 面板栅栏

- 每个端点都检查 Host 是 loopback（`localhost` / `127.*` / `[::1]`），`sec-fetch-site: cross-site` 直接拒；有 Origin 时必须与 Host 完全同源。
- 所有写动作 POST-only，避免导航/`<img>` 触发。
- body ≤ 16 KiB；draft 描述 ≤ 2000；schedule 5–1440；export 1–500；settings 字段独立范围。
- 面板不可用（headless profile 无 webServer、客户端未构建）时插件照常加载。

### 5.3 顺序（没有插件优先级）

DSH 0.2.2 **没有数值优先级**。顺序只有：

- 同一事件监听器的注册序；`ctx.on(..., {prepend:true})` 是 `unshift`，**后 prepend 者更靠前**；
- `tools.guard` 按 scope 分层、单调不可撤销，但只在 pre-execute=allow 且审批之后执行；
- `tools/pre-execute` 是 waterfall：更早的监听器不调 `next()` 就不会执行我们；调了也能丢弃我们的 deny 改写为 allow。

1.7.0 起四个安全关键接缝（`tools/pre-execute`、`agent/pre-step`、`llm/stream`、`approval/request`）都用 `{prepend:true}`，同时保留 `ctx.tools.guard` 作为**单调兜底**。文档口径只能是“prepend 最佳努力 + guard 单调兜底”，不能承诺“绝对第一”。详见 `docs/1.7.0-notes-q4-q5.md` 与 README §4.8。

### 5.4 工具覆盖与终点

**覆盖**：所有经 `ctx.tools` 的调用都过同一条 `tools/pre-execute`：内置工具、MCP、技能、子代理、工作流/PTC。根 ctx 的监听器能收到子 agent scope 的事件。

**不在“已防护”范围**（必须如实告诉用户）：

- shell 命令内部再启动的子进程/二次命令；
- 工具的网络副作用；
- 技能正文（宿主按本地可信内容加载）；
- 模型推理流（`reasoning-delta` 不审）；
- MCP server 自身行为；
- 工具体开始执行之后的副作用；
- 更早的第三方监听器直接拦截/改写返回值。

---

## 6. 构建、测试、打包

**pnpm 在本机是坏的**：`C:\Users\xiaojue\package.json` 里有 `"packageManager": "yarn"`，pnpm 会拒绝运行。不要试图修全局，直接用 node 调本地二进制：

```powershell
cd F:\AgentSecurity\Upear\plugins\dsh-safeharness

# 类型检查
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.client.json

# 全量测试（本机 41 文件 / 697 用例）
node node_modules/vitest/vitest.mjs run
node node_modules/vitest/vitest.mjs run tests/panel-settings.test.ts   # 单文件

# 构建（clean → tsc host → tsc client → esbuild bundle）
node scripts/clean.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/typescript/bin/tsc -p tsconfig.client.json
node scripts/build-client.mjs

# 打包
npm pack --pack-destination dist
```

`lib/` 是**构建产物**，被 `.gitignore` 忽略；公开仓库不提交 `lib/`，但 tarball 包含。公开树测试口径 38 / 679（676 pass + 3 skip）；CI 剔除 `tests/perf.test.ts` → 37 / 671。

测试重点：

- `tests/panel.test.ts` 面板载荷投影；
- `tests/panel-route.test.ts` 栅栏、每个端点闸门、导出；
- `tests/panel-settings.test.ts` judge/draft 设置、自定义 provider 添加/删除/校验、Key 不泄漏；
- `tests/state.test.ts` 会话状态 + `sessions.json` 持久化；
- `tests/client-bundle.test.ts` 浏览器半契约；
- `tests/sidecar*` / `golden` / `acceptance-m2` / `perf` 等内部语料/性能门。

---

## 7. 发布流程（插件独立发版）

### 7.1 仓库与远端

| remote | 地址 | 用途 |
|---|---|---|
| `dsh` | `https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh.git` | 插件公开仓库（发布目标） |
| `github` | `https://github.com/JueeeX/Upear-SafeHarnessSuite.git` | Upear 仓库备份（同步 main + tag） |
| `origin` | `https://github.com/liu-yang-maker/SafeHarness.git` | **上游，绝不要 push** |
| `gitcode` | `git@gitcode.com:Jue_Xiao/Upear.git` | 另一个远端，本流程不使用 |

### 7.2 标准步骤（1.8.0 实际执行过）

1. 本地 `main` 提交功能 + 文档；工作树只留其他会话的 `docs/deploy-patrol.md`、`outputs/`、`src/version.ts`（**不要 add/删**）。
2. `git fetch dsh main`；从 `dsh/main` 建发布 worktree：

```powershell
git worktree add -b release/1.8.0 C:\Users\xiaojue\.codex\worktrees\sh-public-180 dsh/main
```

3. 发布脚本（target = **公开仓库根目录**，不是 `plugins/...`）：

```powershell
cd F:\AgentSecurity\Upear\plugins\dsh-safeharness
node scripts/publish-public.mjs --target C:\Users\xiaojue\.codex\worktrees\sh-public-180
```

它会复制 112 个文件、跳过 8 个内部资产（tests 内部语料等）。

4. 在 worktree 里建 node_modules junction 后构建/测试：

```powershell
cmd /c mklink /J C:\Users\xiaojue\.codex\worktrees\sh-public-180\node_modules F:\AgentSecurity\Upear\plugins\dsh-safeharness\node_modules
cd C:\Users\xiaojue\.codex\worktrees\sh-public-180
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node scripts/build-client.mjs
node node_modules/vitest/vitest.mjs run
```

5. **删除 worktree 里的 `lib/`**（构建产物不是发布内容），再跑 leak 检查：

```powershell
Remove-Item lib -Recurse -Force
node scripts/publish-public.mjs --target <worktree> --check   # 期望 leaks: 0
```

6. `git add -A`（会吸收 CRLF 归一化，可能显示很多文件改动，这是正常的），commit，push：

```powershell
git add -A
git commit -F <message-file>
git push dsh HEAD:main
git tag -a v1.8.0 -m "dsh-safeharness 1.8.0"
git push dsh v1.8.0
```

7. 回主仓：`git push github main`、`git push github v1.8.0`；更新交接文档里的公开 commit/tag；commit/push 文档。
8. 清理 worktree（先删 node_modules junction）：

```powershell
cmd /c rmdir <worktree>\node_modules
git worktree remove <worktree> --force
```

9. 打 tarball、复制到 `C:\Users\xiaojue\.dsh\plugin-tarballs\`、更新 `install-safeharness-desktop.cmd` 里的 `TGZ=` 路径。

**坑**：

- 发布脚本 `--target` 一定要指公开仓库根；指到 `plugins/dsh-safeharness` 会把内容复制到错误层级。
- leak 检查会把 worktree 里的 `lib/` 当内部资产；提交前删掉。
- 本地主仓**不要 `git add -A`**（会吞其他会话文件）。
- 删 `tools/` 目录前先确认 `tools/agentprobe` 是 tracked；误删后 `git restore --source=HEAD -- tools`。
- CRLF 警告很多，不要手工修；`git add -A` 后 diff 会归一化。
- 公开仓库 tag 对象和本地 tag 共享；在主仓 push tag 即可。
- 本机 `api.github.com` 超时，CI runs 状态需要在网页确认。

---

## 8. 真实宿主验证（开发/面板）

### 8.1 启动 dev host

```powershell
& 'D:\dsh\resources\runtime\cli\bin\dsh.cmd' --profile safeharness-dev --no-open --port 61557
```

不要加 `web` 位置参数（会报 “too many arguments”）。等待输出：

```
dsh web: http://127.0.0.1:61557/?token=...
```

### 8.2 无头 Edge + CDP

Edge 路径：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。

```powershell
$ud=Join-Path $env:TEMP 'dsh-cdp-sh'
Start-Process 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList @(
  '--headless=new','--disable-gpu','--remote-debugging-port=9223','--window-size=1500,1900',
  "--user-data-dir=$ud",'--no-first-run','--no-default-browser-check',
  'http://127.0.0.1:61557/?token=<TOKEN>')
```

CDP 小工具（本机临时脚本，已删除；需要时重建）：

```js
// node tools/cdp.mjs eval "<expr>" / shot <file.png>
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('61557'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
// Runtime.evaluate { expression, awaitPromise: true, returnByValue: true }
// Page.captureScreenshot { format: 'png', captureBeyondViewport: true }
```

打开面板路径：设置（账号菜单 → 设置）→ 内置插件 → SafeHarness。

### 8.3 常用面板检查

```js
// 读取设置（在页面上下文里 fetch，同源）
fetch('/safeharness/settings', { method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({op:'read'}), credentials:'same-origin' }).then(r=>r.json())

// 添加自定义模型（假 OpenAI 或真实端点）
{ op:'add-provider', provider:{ id:'fake-local', api:'openai-completions',
  baseURL:'http://127.0.0.1:18080/v1', apiKey:'<fake-sentinel>',
  model:'fake-model', useForJudge:true } }

// 测试评审路由
{ op:'probe' }

// 导出账本
fetch('/safeharness/export', {... body: JSON.stringify({limit:200})})
```

本机 fake OpenAI 兼容服务器：`node scripts/fake-openai.mjs --port 18080 --quiet`；judge prompt 命中 `[safeharness-judge]` 时返回 allow 场景。用它可以在**不需要真实 Key/外网**的情况下走完添加 → probe → 删除。

### 8.4 清理（每次真机验证后必做）

- 停止 dev host、headless Edge、fake server；
- 删除 `C:\Users\xiaojue\.dsh\safeharness\panel-state.json`（如果验证时开过定时巡检，否则桌面端会继承定时）；
- 检查 dev profile 没有留下的测试路由/凭据引用（`shp-fake` / `fake-local` / `SAFEHARNESS_*`）；
- `sessions.json` 可以保留（用户自己的会话元数据），`providers.json` 若为空可保留或删除；
- 不要留下 `lib/` 之外的文件改动。

---

## 9. 当前桌面端状态与升级

- 桌面 profile 依赖：`file:C:/Users/xiaojue/.dsh/plugin-tarballs/upear-dsh-safeharness-1.8.1.tgz`
- `desktop/node_modules/@upear/dsh-safeharness/package.json` 版本 **1.8.1**
- 桌面应用进程 19:02 启动（安装完成后重启）；`results.mode: enforce` 已生效
- 安装脚本：`C:\Users\xiaojue\.dsh\plugin-tarballs\install-safeharness-desktop.cmd`（TGZ 指向 1.8.1）

**升级/重装**：完全退出 DSH（含托盘）→ 双击脚本 → 重启。若面板/版本没变，检查 `desktop` 的 `package.json` 依赖与 `node_modules` 版本，或看账本 `plugin_loaded` 里的 `version` label。

**结果层强制拦截的代价**：任何含凭据形态的工具结果（测试 fixture、文档示例、`.credentials.yaml`）都会被整条替换，这是预期行为；开发插件请用 `safeharness-dev`（observe）。

---

## 10. 已知限制 / 未验证（诚实清单）

1. **真实 IM 投递未验证**：飞书/钉钉/企微/OneBot/generic 的 payload 与发送路径有单测；用户暂时无法提供 webhook。部署时在 `patrol.notify` 配好后跑 `/safeharness patrol` 或面板巡检即可验证；失败会在 finding/日志里体现，不会静默。
2. **真实人工审批未验证**：需要 `approval: ask` 的权限预设 + 人工点击；当前桌面/开发 profile 是 `approval: never`。审批桥的 delegate/policy 逻辑有单测。
3. **插件顺序没有绝对保证**：见 §5.3；只能 prepend 最佳努力 + guard 兜底。
4. **工具内部不覆盖**：shell 内二次命令、子进程、网络副作用、技能正文、模型推理流、MCP server 自身、工具体执行后的副作用。
5. **自定义模型只支持三种协议**；Bedrock/Vertex/Azure/Codex 不支持手写路由。
6. **settings 写入无 revision CAS**：`save` 是 last-writer-wins；并发面板/设置页可能互相覆盖。
7. **`llm-pi-ai` 被 home patch / `--patch` overlay 覆盖时**，`settings.update('llm-pi-ai')` 可能被宿主拒绝（teammate 在 overlay profile 实测到）；正常 profile 可用。添加自定义模型失败时不会破坏现有配置。
8. **面板动作有限**：不写规则文件、不做通用调度、不提供 provider 编辑（只能添加/删除同名重建）；导出只在浏览器端保存。
9. **CI 状态未在本地读取**（`api.github.com` 超时）；push 成功，runs 需要在网页确认。
10. **结果层强制拦截的代价**：任何含凭据形态的工具结果（含测试 fixture、文档示例、`.credentials.yaml`）都会被整条替换；输出层仍是 `warn`，若把结果层关掉，模型仍可能把密钥写进回答。开发插件时用 `safeharness-dev`（observe）。另外 `pnpm-lock.yaml` 里的 `sha512-…` SRI 摘要也会被判为高熵令牌（1.8.1 尚未为 SRI 前缀加豁免），读 lockfile 会被整条拦截，属已知误报。
11. **旧文档里的“桌面 1.6.0”已过时**：现在是 1.8.1 profile。

---

## 11. 下一步建议（没有必须做的代码项）

按优先级：

1. **确认桌面 1.8.1 面板（并确认 `modes.results=enforce`）**：设置 → 内置插件 → SafeHarness → 自定义模型，用本机 Ollama（`http://127.0.0.1:11434/v1`，协议 openai-completions，Key 随便填）或现有 liao 路由验证添加/删除/probe。
2. **通知自测按钮（可选）**：在巡检页加“发送测试通知”，复用 `notify` 通道，只发一句固定摘要；在没有真实 webhook 时也能验证配置形状与发送路径（不替代真实投递）。
3. **审批演练 harness（可选）**：建一个 `approval: ask` 的 dev profile，用需要审批的工具调用走一遍 delegate/policy，补上“真实人工审批”证据。
4. **真实 webhook 验证**：用户提供飞书/钉钉/企微 webhook 后，配置 `patrol.notify` 并跑一次巡检；这是部署验收项，不是代码项。
5. **provider 编辑/CAS（可选）**：settings 加 expectedRevision 做并发保护；自定义 provider 支持改 URL/模型而不是删除重建。
6. **CI**：在网页确认 v1.8.1 的 runs 绿。

---

## 12. 关键决策（当前有效）

| # | 决策 | 原因 |
|---|---|---|
| D36 | 面板标签全部挂载（非当前 `display:none`） | 条件渲染会丢草稿/筛选/巡检结果 |
| D37 | AI 起草只返回草稿，不写规则文件 | 面板写规则 = 新增可被同源脚本利用的写路径；草稿 + 人审 + loader 门是折中 |
| D38 | 定时状态写插件自有 `panel-state.json`，不写 profile | 定时是 UI 状态，不是安全策略 |
| D39 | 定时器递归 setTimeout + unref + dispose，最小 5 分钟 | 不堆 tick、不拖住宿主、卸载即停 |
| D40 | 冷却只作用手动巡检 | 定时不应被“刚点过按钮”阻止 |
| D41 | 会话元数据索引只存显示字段 | 面板跨重启辨识对话；计数是进程事实，不制造第二真相源 |
| D42 | 索引 tmp+rename、750ms 合并、损坏忽略、卸载 flush | 标题每步都可能变；不能每条事件写盘、不能被坏文件阻止加载 |
| D43 | 评审设置走宿主 `settings` 服务 | 复用宿主校验/热更新/权限，不新建配置存储 |
| D44 | 面板只改 judge/draft 路由等低风险高频项 | preset/audit/tools 模式仍需改 profile |
| D45 | 顺序口径 = prepend 最佳努力 + guard 兜底 | Cordis waterfall 无法承诺绝对第一 |
| D46 | 自定义模型只开放 pi-ai 三种手写协议 | 其他厂商需要环境/签名/OAuth，一个 URL+Key 无法表达 |
| D47 | Key 只进凭据服务，profile 只存引用名；失败回滚 | 避免 Key 进 YAML/账本/日志 |
| D48 | 自定义路由单独记 `providers.json`，只删自己加的，在用拒绝 | 不误删宿主/他人 provider |
| D49 | 导出返回账本原样脱敏记录 | 证据片段不重新投影、不制造第二套字段 |

---

## 13. 第一天接手清单（按顺序执行）

1. **读**：本文 §0–§10；需要历史细节再读旧 handoff 与 README §4.7/§4.8。
2. **核环境**：`$env:DSH_HOME`、`D:\dsh\resources\runtime\cli\bin\dsh.cmd --version`、Node `v25.8.2`、Python（若 sidecar）。
3. **核仓库**：`git -C F:\AgentSecurity\Upear status --short`（应只有其他会话的 `docs/deploy-patrol.md`、`outputs/`、`src/version.ts`）；`git log --oneline -3` 应看到 `1fa45a6` 与随后的文档提交；`git remote -v` 确认 `dsh`/`github`，不要碰 `origin`。
4. **核发布**：`git ls-remote dsh refs/heads/main refs/tags/v1.8.1` 应分别指向 `0062f4f...` 与 tag 对象 `350b6c7...`。
5. **构建/测试**：按 §6 跑 tsc + vitest，期望 697 passed。
6. **起 dev host**：§8.1，打开面板，确认五个标签、版本 1.8.1、设置页读到 `providerConfigurable: true`。
7. **看账本**：`C:\Users\xiaojue\.dsh\safeharness\audit\ledger.ndjson` 尾部，或 `/safeharness audit 20`；确认 `plugin_loaded` 的 `version` 是 1.8.1、`ruleset_hash` 存在。
8. **看桌面**：确认桌面 profile 依赖 1.8.1、应用已重启、`results=enforce`；若没有，按 §9 升级。
9. **做一次只读 smoke**：设置 → 内置插件 → SafeHarness，截一张概览/设置图；不要开定时巡检。
10. **清理**：按 §8.4；删 `panel-state.json`，确认无测试 provider/凭据残留。

---

## 14. 常见问题（FAQ）

**Q：面板里“工作区/对话”还是选不了？**
A：先看 `$DSH_HOME/safeharness/sessions.json` 是否存在、是否有历史会话；面板选项来自它 ∪ 账本事件。如果没有历史行，重启一次宿主并产生一条真实会话。确认版本是 1.7.0+（1.8.1 当前）。

**Q：拒绝消息“该操作不被平台安全策略允许（SafeHarness 安全插件）”是谁的？**
A：卡片 UI 是 DSH 自带；这句话是本插件 `TOOL_DENIAL_TEXT`。要确认是谁拦的，看账本 `tool_denied` 或面板事件。

**Q：为什么 judge 没运行？**
A：`output.judge.enabled` 是否为 true、输出是否有文本、`scope` 是否只审已标记输出、模型路由是否可用。`/safeharness judge probe` 可以打一次真实调用；账本 `output_reviewed` 里 `judge_status` 会说明 `skipped_empty` / `skipped_recursion` / `ok` / `timeout`。

**Q：自定义模型添加失败？**
A：看错误码：`provider_exists`（重名）、`provider_in_use`（删除时仍被使用）、`provider_unavailable`（无 settings/credentials 服务或找不到 llm-pi-ai entry）、`settings_invalid`（URL/协议/Key/模型不合法）、`settings_write_failed`（宿主拒绝写，可能是 overlay/home patch 覆盖）。Key 不会回显。

**Q：发布后桌面没更新？**
A：确认完全退出（托盘）→ 脚本 → 重启；检查 `desktop/package.json` 依赖与 `node_modules` 版本；看账本 `plugin_loaded.version`。

**Q：可以提交 `lib/` 吗？**
A：不可以；`lib/` 是构建产物、被 gitignore。tarball 会包含。

**Q：能改 `src/safeharness`（Python 参考实现）吗？**
A：不能；它是只读参考。插件是独立 TS 重写。`SUMC/`、`examples/` 同样只读。

---

## 15. 附录：证据与提交

| 内容 | 位置 |
|---|---|
| 1.8.0 证据 | `plugins/dsh-safeharness/evidence/1.8.0-provider-export.md` |
| 1.8.0 截图 | `evidence/1.8.0-panel-settings-providers.png`、`evidence/1.8.0-panel-export.png` |
| 1.8.1 证据 | `plugins/dsh-safeharness/evidence/1.8.1-results-enforce.md`（含前后账本对照与真机验证） |
| 1.7.0 证据 | `evidence/1.7.0-panel-workbench.md` + 5 张截图 |
| 1.6.0 证据 | `evidence/1.6.0-panel-workbench.md` + 4 张截图 |
| 研究笔记 | `docs/1.7.0-notes-q4-q5.md`（顺序/覆盖/judge 模型） |
| 计划 | `docs/plan-dsh-safeharness-plugin-2026-11-10.md` §12.19（1.8.0）、§12.20（1.8.1） |
| 旧交接 | `docs/safeharness-plugin-handoff-2026-11-11.md`（历史坑与早期决策） |
| 1.8.0 本地提交 | `bc35d9b`（功能）、`6c68789`（发布记录） |
| 1.8.0 公开提交 | `0b66794`，tag `v1.8.0`（tag 对象 `708539e...`） |
| 1.8.0 tarball | 318,016 B，sha256 `F87C435195190F70D5F4C790BAFCC283485709769C615F9E71CC42C3514E1EA2` |
| 1.8.1 本地提交 | `1fa45a6`（修复） |
| 1.8.1 公开提交 | `0062f4f`，tag `v1.8.1`（tag 对象 `350b6c7...`） |
| 1.8.1 tarball | 318,953 B，sha256 `6071F100735B8262F5BED99EC47BA3C5A5595E8101DE5D09BBDD775B7909C61C` |

**安全纪律（每次改代码/证据/文档前重温）**：

- 账本/日志/错误/finding 只许哈希与长度；
- 假模型用哨兵 Key（`sk-fake-sentinel`），不用真实 Key；
- 真实凭据只在 `$DSH_HOME/.credentials.yaml`，插件只填 provider/model 路由；
- `evidence/` 不入库；
- 提交前 `git status` 自查，别把其他会话的文件带进来。
