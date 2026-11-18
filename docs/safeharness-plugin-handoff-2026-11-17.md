# DSH SafeHarness 插件交接文档（2026-11-17；桌面 1.9.1 已装，1.9.1 已发布）

> 读者：**没有任何上下文的后续对话 / 新模型 / 新智能体 / 新同事**。
> 目标：只读这一份，就能接手开发、验证、发布、答疑；不需要再问原作者。
> 本文是**当前状态的唯一入口**。历史细节与 1.0–1.7 的踩坑记录见
> [`safeharness-plugin-handoff-2026-11-11.md`](safeharness-plugin-handoff-2026-11-11.md)（旧文，状态已过时，坑清单仍有参考价值）；
> 上一版入口是 [`safeharness-plugin-handoff-2026-11-12.md`](safeharness-plugin-handoff-2026-11-12.md)（1.8.2 基线，本文已取代它）。
> 内部文档，**不要提交到公开仓库**（公开仓库只发布 `plugins/dsh-safeharness` 的可发布子树）。

> **本轮增量（2026-11-17，1.8.4 + 1.9.0 + 1.9.1，均已发布并装到桌面）**
>
> - **1.8.4 加固**：面板**全端点 POST-only**（其他方法 405 + `Allow: POST`，栅栏先于方法判断）、自定义路由**两存储一次提交**（索引写失败回滚路由与凭据）+ 引用守卫覆盖 `defaultProvider` 等 + `providerConfigurable` 与实际写路径统一、设置写入 **revision CAS**（`settings_conflict`）、面板 settings 日志零回显、**SRI 摘要豁免**（读 `pnpm-lock.yaml` 不再被结果面整条替换）。决策 D58–D61，证据 `evidence/1.8.4-hardening.md`。
> - **1.9.0 规则落地**：面板「写入并重载」——只写 `rules.dir`、文件名白名单、默认不覆盖、写前用真实 loader 试编译、原子写、账本只记元数据；`rules.dir` 热改后 watcher/重载跟随实时配置。决策 D62（取代 D37 后半段），见 §5.6。
>
> > - **1.9.1 账本种类单一来源**：`safeharness_audit_query` 此前拒绝 `kind: "rules_written"`（联合类型不可枚举，工具侧另维护一份数组）；改成 `AUDIT_KINDS as const` 派生后，桌面 1.9.1 上已能直接回查 seq 9269。见 §12.25。
>
> 桌面已是 **1.9.1**（2026-11-17 16:28 重启生效，`plugin_loaded` seq 9423；写入链路在 1.9.0 时已端到端验证：写入 20→21、账本 `rules_written` 无正文、删文件后 watcher 回到 20）。**1.9.1 已发布**：公开 `main = 1cddce1`、tag `v1.9.1`、CI `ci` = passing。

---

## 0. 一句话现状

`F:\AgentSecurity\Upear\plugins\dsh-safeharness` 是一个 **DSH（DeepSeek Harness）profile 级 Cordis 安全插件** `@upear/dsh-safeharness`，把 SafeHarness 的安全语义（输入拦截、工具管控、结果守卫、输出复核/语义评审、审批桥、NDJSON 哈希链账本、姿态自检、巡检/通知、规则起草、Web 面板）装进 DSH 的执行生命周期。

当前**已发布版本 1.9.1**（公开仓库 `main = 1cddce1`、tag `v1.9.1`，CI `ci` = passing）；**桌面已装 1.9.1**（2026-11-17 16:28 重启后生效，`plugin_loaded` seq **9423**：`version = 1.9.1`、20 规则 / 3 链、启动 7 ms；姿态 0 FAIL / 0 WARN / 9 OK / 1 SKIP；`safeharness_audit_query { kind: "rules_written" }` 修复后可直接回查 seq 9269）；**1.9.1 已发布**（公开 `main = 1cddce1`、tag `v1.9.1`、CI passing）。宿主 `0.2.2-rc.3`、8/8 接缝、`input/tools/results = enforce`、`output = warn`、`approval = delegate`。

**本地 main 已推进到 1.9.2**（1.8.4 加固 + 1.9.0 规则写入 + 1.9.1 账本种类单一来源 + 1.9.2 组合包形态），**1.9.1 于 2026-11-17 16:33 发布**；公开仓库 `main` = `1cddce1`、tag `v1.9.1`。1.9.2 尚未发布。<br>没有已知的“加载即失效”缺口。剩余的是**环境项**（真实 webhook、真实人工审批）、一个产品决策项（输出面 `enforce`，§12.1-6），以及 1.9.2 的桌面安装与重启（面板入口依赖它）。

---

## 1. 30 秒速览

| 项 | 值 |
|---|---|
| 插件包 | `F:\AgentSecurity\Upear\plugins\dsh-safeharness`（包名 `@upear/dsh-safeharness`） |
| 当前版本 | **本地 = `1.9.2`（组合包形态，未发布）**；桌面 = `1.9.1`（待装 1.9.2 并重启）；已发布 = `1.9.1`（`1cddce1` / tag `v1.9.1`；`package.json` / `src/version.ts` / README 三处一致，`tests/version.test.ts` 断言） |
| 宿主 | DSH `0.2.2-rc.3`（桌面已升级）；CLI `D:\dsh\resources\runtime\cli\bin\dsh.cmd`；桌面应用 `D:\dsh`；Node `v25.8.2` |
| 桌面端插件 | **已装 1.9.2、已重启生效**（`profiles/desktop/node_modules/@upear/dsh-safeharness` = 1.9.2；`plugin_loaded.version = 1.9.2`，姿态 0 FAIL；`dsh.profile.bundles` 含 `@upear/dsh-safeharness`，profile patch 只剩按 id 的覆盖） |
| 桌面 profile 依赖 | `file:C:/Users/xiaojue/.dsh/plugin-tarballs/upear-dsh-safeharness-1.9.2.tgz` |
| 桌面安装脚本 | `C:\Users\xiaojue\.dsh\plugin-tarballs\install-safeharness-desktop.cmd`（`TGZ=` 已指向 **1.9.2**，tarball 已复制；但 1.9.2 起推荐用 GUI「添加插件」装——那才会写进 profile 的 bundle 清单，见 §11.17） |
| 公开仓库 | `https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh`（remote 名 **`dsh`**），`main` = **`896034f`**（release 1.9.2），tag **`v1.9.2`**（tag 对象 `5aa7dfb…`），**CI `ci` = passing**；2026-11-17 20:12 推送（直连 443 时通时断，用 `-c http.version=HTTP/1.1` 过的） |
| 本地仓库 | `F:\AgentSecurity\Upear`，`main` = **1.9.2**（`git log -1`；前序 `6394ee5`/`a50a816` 1.9.2 验证文档 / `99f7905` 1.9.2 代码 / `668c4c7` 安装迁移文档 / `8b26eff` 入口缺口 / `1203d9c` 1.9.1 验证 / `e22e404` 1.9.0 / `d5c3487` 1.8.4）；`github` 备份远端 main = **`a50a816`**（+ 本条文档提交），`v1.9.2` 标签已同步 |
| 测试 | 1.9.2 本机 **45 文件 / 751 用例**；公开树与 CI 口径在发布时重算（1.9.1 公开树为 41 / 726+3） |
| tarball | 已发布 `dist/upear-dsh-safeharness-1.9.1.tgz`（337,700 B）；本地 **`dist/upear-dsh-safeharness-1.9.2.tgz`，338,908 B（137 文件，含 `cordis.patch.yml`），sha256 `24007725B2EBFE2C5F65C7A1EBBB097A82C5CE9FE672AE8382B842CA9B1F07FF`**（未发布、未装桌面；已复制到 `plugin-tarballs\`） |
| 账本 | `C:\Users\xiaojue\.dsh\safeharness\audit\ledger.ndjson`（NDJSON、sha256 链、零回显；当前约 6.3 MB、seq 8300+） |
| 证据 | `plugins/dsh-safeharness/evidence/`（内部，gitignore；1.8.3 见 `1.8.3-draft-diagnostics.md`，1.8.4 见 `1.8.4-hardening.md`，1.9.0 见 `1.9.0-rule-write.md`，1.9.1 见 `1.9.1-audit-query-kind.md`，1.9.2 见 `1.9.2-bundle.md`） |
| 计划 | `docs/plan-dsh-safeharness-plugin-2026-11-10.md`（1.8.0 §12.19、1.8.1 §12.20、1.8.2 §12.21、1.8.3 §12.22、1.8.4 §12.23、1.9.0 §12.24、1.9.1 §12.25） |
| 公开 README | 插件 README 的 §4.7（面板）、§4.8（顺序/覆盖/评审模型）是给用户的正式说明 |

**2026-11-17 当天实测状态**（`safeharness_status` + `safeharness_posture`）：

- `version: 1.9.1`，`preset: balanced`，`rulesetHash: d53dedc1652b594a…`，`ruleCount: 20`，`chainCount: 3`，`uptimeMs ≈ 817 000`（≈13.6 min），`sessions: 15`，`judge = liao / gpt-6-luna`
- `modes`：`input: enforce` / `tools: enforce` / `results: enforce` / `output: warn` / `approval: delegate`
- 账本 `plugin_loaded`（seq **9423**，`2026-11-17T08:28:00Z`）`version = 1.9.1`、宿主全部 `0.2.2-rc.3`、`startup_ms: 7`；`ledger.records = 96` 是本进程追加计数，`ledger_chain_ok` 由姿态确认
- 姿态：**0 FAIL / 0 WARN / 9 OK / 1 SKIP**（`approval_never` 仍 SKIP，需带会话复跑；其余全 OK：`sandbox_*`、`rules_loaded` 20、`ledger_writable`、`ledger_chain_ok`、`output_guard_off`、`judge_unavailable`、`plugin_version_mismatch`、`engine_sidecar_unavailable`）
- 1.9.1 修复的活体验证：`safeharness_audit_query { kind: "rules_written" }` 返回 seq **9269**（`file` / `mode: create` / `bytes: 202` / `rules: 21` / `chains: 3`，**无规则正文**）

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
- 不是外挂进程；judge / 起草都走宿主自己的 `ctx.llm`。
- 不能保证“绝对最先执行”（见 §6.3）。

---

## 3. 架构

### 3.1 启动顺序（按 `src/index.ts` 的 `apply()` 实际代码）

1. 解析/校验配置：`Config`（schemastery）→ `resolveConfig()` 展开 preset（`observe` / `balanced` / `hardened`），产出 `ResolvedConfig`。
2. 加载规则集：`tryLoadRuleSet()`（packaged `rules/` + 操作者 `rules.dir` + `rules.inline`），带 loader 门；失败时 observe 降级为空集并告警，balanced/hardened 拒绝加载。
3. 建输入引擎：内置 engine（`src/engine/*`）或可选 Python sidecar（`src/engine/sidecar*`）。
4. 建账本：`createLedger()`（NDJSON、sha256 链、脱敏）。
5. 建运行时：`createRuntime()` + `SessionStateStore`（本进程会话状态 + 持久化元数据索引）。
6. 宿主 surface probe + **加载时姿态门**（`enforceLoadTimePosture`）：`posture.failOn` 命中即在**任何 seam 注册前**抛错，保证“拒绝加载”意味着插件完全没生效。
7. `ctx.provide(SAFEHARNESS_SERVICE)`（供 invariant companion 观察）。
8. 注册 seam：`agent/pre-step`、`tools/pre-execute`、`ctx.tools.guard`、`tools/post-execute`、`tools/result`、`llm/stream`、`approval/request`。
9. 注册 system prompt 片段、斜杠命令（`/safeharness …`）、工具（`safeharness_status` / `safeharness_posture` / `safeharness_audit_query` / `safeharness_patrol` / `safeharness_draft_rule`）。
10. 注册面板宿主半（`/safeharness` 路由，需要 `webServer`）、巡检 runner/scheduler、规则目录 watch。
11. 卸载时：flush 会话索引、停 sidecar、关账本。

### 3.2 五个安全面

| 面 | 接缝 | 行为 |
|---|---|---|
| 输入 | `agent/pre-step` | 20 条中英注入规则 + 危险 SQL 结构判定；按模式 deny/warn；拒绝话术不泄漏规则 |
| 工具调用 | `tools/pre-execute`（异步，可 ask/deny）+ `ctx.tools.guard`（同步、无 IO、单调） | 工具名/标签策略、参数体积、危险 SQL、调用链轨迹；异步 + 同步双保险 |
| 工具结果 | `tools/post-execute`（可 block）+ `tools/result`（纯观察） | 凭据形态、注入标记、被拒重试压力；结果 hash/长度落账 |
| 模型输出 | `llm/stream` | 结构规则复检 + 可选语义 judge；`warn` 记账透传，`enforce-buffer` 缓冲替换 |
| 审批 | `approval/request` | 一次性授予 → 复用 deny 列表 → 其余委派宿主；policy 模式按插件策略裁决 |

辅助模块：`budget`（每轮 token 预算）、`audit`（账本）、`posture`（10 项自检）、`patrol`（5 项巡检 + 多通道通知）、`draft`（规则起草，不落盘）、`surface`（命令/工具/提示词）、`panel`（Web 面板）。

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
├─ tests/                      41 个文件 / 709 用例
├─ README.md / CHANGELOG.md
└─ evidence/                   本机证据（gitignore）
```

### 3.4 面板（1.8.0 起，1.7.0 重做）

五个标签：**概览 / 事件 / 规则 / 巡检 / 设置**。浏览器半是 `lib/client.js`（预构建 CJS 闭包工厂），通过 `ctx.slots.inject('settings.plugins.tab', …)` 注册；只用平台 seed 的 `react`，不 import 任何 DSH client 包。所有标签常驻挂载（非当前标签 `display:none`），避免切页丢草稿/筛选/巡检结果。

> **入口前提（2026-11-17 补）**：`settings.plugins.tab` 的宿主是「插件」页里的**插件条目页**。桌面 profile 目前没把本插件登记成 profile 选中的 bundle，所以条目页不存在、标签无处渲染——见 §11.17。

宿主半路由（全部挂在 `/safeharness` 前缀，全部 POST-only、loopback Host + 同源 Origin 栅栏、body ≤ 16 KiB）：

| 端点 | 作用 | 关键约束 |
|---|---|---|
| `POST /safeharness/status` | 一次面板载荷（计数/模式/会话/规则/事件/定时/评审） | 只读投影，不含内容 |
| `POST /safeharness/patrol` | 跑一次巡检 | 单飞 + 手动 5 秒冷却，写 `patrol_report` |
| `POST /safeharness/draft` | AI 起草候选规则 | `draft.enabled`、描述 ≤ 2000、单飞，返回 YAML，不落盘 |
| `POST /safeharness/schedule` | 开/关定时巡检 | 5–1440 整数分钟，状态写 `$DSH_HOME/safeharness/panel-state.json` |
| `POST /safeharness/reload-rules` | 重读 rules 目录 | loader 门失败保留旧集 |
| `POST /safeharness/settings` | `op: read / save / probe / add-provider / delete-provider` | 见 §4.4 |
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

`preset` 只是默认值集合，字段可逐项覆盖：

| 维度 | observe | balanced（默认） | hardened |
|---|---|---|---|
| 输入 | warn | deny | deny |
| 工具 pre-execute | warn | deny | deny |
| 同步 guard | 空转 | 硬规则 deny | deny |
| 结果 | warn | warn（`blockOn: credential_leak` 仍拦） | enforce |
| 输出 | warn | warn | warn（可配 enforce-buffer） |
| 审批 | delegate | delegate | policy |
| 账本 required | false | true | true |
| `posture.failOn` | 空 | 空 | 4 个可达 code |

配置写在 profile 的 `cordis.patch.yml` 的 `insert:` 块里。

### 4.2 桌面 profile 的实际配置（`C:\Users\xiaojue\.dsh\profiles\desktop\cordis.patch.yml` 尾部）

```yaml
- insert:
    - id: safeharness
      name: "@upear/dsh-safeharness"
      config:
        preset: balanced
        results:
          mode: enforce
        output:
          judge:
            enabled: true
            scope: flagged
            provider: liao
            model: gpt-6-luna
            timeoutMs: 6000
        rules:
          dir: 'C:\Users\xiaojue\.dsh\safeharness\rules'
    - id: invariants
      name: "@deepseek-ai/dsh-invariants"
    - id: safeharness-invariant
      name: "@upear/dsh-safeharness/invariant"
- id: safeharness
  name: "@upear/dsh-safeharness"
  config:
    preset: balanced
    results:
      mode: enforce
    output:
      judge:
        enabled: true
        scope: flagged
        provider: liao
        model: gpt-6-luna
        timeoutMs: 6000
    rules:
      dir: 'C:\Users\xiaojue\.dsh\safeharness\rules'
    draft:
      provider: liao
      model: deepseek-v4.1-flash-1017
```

注意两点：

- 同一个插件有 **insert 块 + id 覆盖块** 两处配置，实际生效的是二者合并（后者覆盖前者）。改配置时两处都要看，否则会出现“改了没生效”。
- **2026-11-17 起两处都配了 `rules.dir`**（`C:\Users\xiaojue\.dsh\safeharness\rules`，目录已建）：操作者规则目录不再是空的，热监视也从安装包 `rules/` 换到该目录；1.9.0 装上桌面后，面板「写入并重载」就写到这里（升级不丢规则）。改完这两处后 profile watcher 会热 reconcile，桌面实测**无需重启**即生效（`rulesDir` 已变）。

**开发 profile `safeharness-dev`** 是 observe，另有一条历史遗留 override（judge 关闭、路由空、timeout 4000），无害；不要把它当生产配置。

### 4.3 语义评审 judge（三个东西别混）

| 名称 | 用途 | 模型 | 说明 |
|---|---|---|---|
| 语义评审 judge | 审**模型输出**（额外一次模型调用） | `output.judge.provider/model`；桌面 `liao/gpt-6-luna` | `enabled` 且输出有文本；`scope: flagged` 只审结构规则命中的输出，`always` 审全部；不可用时按预设降级（hardened fail-closed） |
| Python sidecar | 异步**输入**判定（规则集同源） | **不用模型** | `engine.kind: sidecar`；本机未启用 |
| 规则起草 | 自然语言 → 候选 YAML | `draft.provider/model`，留空回落 judge 路由；桌面 `liao/deepseek-v4.1-flash-1017` | 面板/命令/工具触发，单飞；草稿不写入不启用 |

### 4.4 自定义模型（1.8.0）

设置页“自定义模型”支持 pi-ai 的**手写路由**，三种协议：`openai-completions` / `openai-responses` / `anthropic-messages`。

字段：路由名（`[a-z][a-z0-9-]{1,39}`）、显示名、协议、Base URL、API Key、模型 ID/显示名、可选“添加后设为评审模型”。

**写入路径**：

1. Key 经 loopback POST 一次 → `ctx.credentials.set('SAFEHARNESS_<ID>_API_KEY', key)` → `$DSH_HOME/.credentials.yaml`。
2. 路由写 `llm-pi-ai` 的 `providers.<id>`（整段 `providers` 是 `.volatile()`），经宿主 `settings` 服务写 `cordis.patch.yml` → loader 热更新。YAML 里只有**引用名**，例如：

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        api: openai-completions
        baseURL: https://api.example.com/v1
        apiKeyEnv: <你的环境变量名>     # 引用名，不是 Key 本身
        displayName: My Gateway
        models:
          - id: my-model
            name: My Model
```

3. 插件自有 `$DSH_HOME/safeharness/providers.json` 只记录本面板添加的路由（id/显示名/协议/URL/模型/凭据引用名/时间），**不存 Key**。
4. 删除：若该路由仍被 judge/draft 使用 → `provider_in_use`，先改路由再删；删除时 `settings.mutate` unset `providers.<id>` + `credentials.unset`。
5. 添加失败会回滚刚写入的凭据；Key 不回显、不进账本/日志/错误消息。

**边界**：Bedrock（SigV4）、Vertex（project/location/ADC）、Azure（部署环境 + api-version）、Codex（OAuth）需要各自环境与签名，无法用一个 URL + Key 表达，面板不提供；Ollama/vLLM/OpenAI 兼容网关/Anthropic 兼容端点可用。

### 4.5 设置写入路径

- judge/draft：`settings.update('safeharness', {output:{judge:{…}}, draft:{…}})`。
- provider：`settings.update('llm-pi-ai', {providers:{<id>:{…}}})`。
- 两者都经 `configEditor.edit` → `cordis.patch.yml` → loader reconcile → 本插件 `loader/volatile-update` → `applyHotConfig`。
- **只接受 volatile 字段**；`providers` 整段 volatile，judge/draft 字段 volatile。
- 设置服务/凭据服务不存在，或找不到可编辑 entry → 页面只读并说明原因。
- `save` 目前**不带 expectedRevision**（last-writer-wins）；并发编辑可能覆盖，后续可加 CAS（§12）。

---

## 5. 规则系统（创建 / 落地 / 验证）

这是操作者最常问、也最容易踩坑的部分，单列一节。**当前设计：面板能起草，但落地必须人工写文件。**

### 5.1 两种规则

| 类型 | 拦什么 | 关键字段 |
|---|---|---|
| `rules:`（inform / 文本规则） | 用户输入、工具**结果**、模型输出 | `name` `pattern` `severity` `category` `action: deny` `reason` |
| `chain_rules:`（轨迹规则） | **工具调用序列**（A 之后 N 步内出现 B） | `name` `first` `then`（或 `first_tags`/`then_tags`，≤16 个）`max_gap` `severity` `category` `reason` |

要点：

- `action` 在 v1 只能是 `deny`；`severity` ∈ `critical|high|medium|low|info`。
- 正则统一以 `iu` 编译（大小写不敏感），**不要写 `(?i)`**，也不要写 Python-only 语法，否则整次加载失败。
- `pattern` 必须用**单引号**：YAML 双引号会解码 `\s`、`\u`，正则就废了。
- `max_gap`: 整数 ≥ 0；`0` 表示“不限距离”，`N` 表示两次调用之间最多隔 N 次。
- `category` 影响**结果面是否真的阻断**：`results.blockOn` 默认只有 `credential_leak`，所以 `category: credential_leak` 的规则在结果面会真拦，其它 category 在结果面只记 warn。

### 5.2 规则文件长什么样

一个文件里 `rules:` 和 `chain_rules:` 可以共存（也接受裸列表、单条 mapping）：

```yaml
rules:
  - name: operator_test_marker
    pattern: 'SH-OPERATOR-TEST-9C4M'
    severity: high
    category: instruction-override
    action: deny
    reason: 'operator test marker'

chain_rules:
  - name: operator_fetch_then_execute
    first: '(?:^|_)(?:web_fetch|fetch|download|http_get)(?:_|$)'
    then: '(?:^|_)(?:pwsh|bash|shell|exec|execute|run|spawn)(?:_|$)'
    max_gap: 1
    severity: high
    category: trajectory_chain
    reason: 'downloaded content followed immediately by local execution'
```

### 5.3 三条创建路径

| 路径 | 做法 | 是否自动生效 |
|---|---|---|
| **AI 起草** | 面板「规则」页填描述 → 返回候选 YAML；或工具 `safeharness_draft_rule` | 否；**1.9.0 起**可在面板点「写入并重载」落到 `rules.dir`（人确认，见 §5.6） |
| **手写 YAML 文件** | 放进 `rules.dir`；未配置时放进**安装包 `rules/`** | 是，`rules.watch` 默认开 |
| **`rules.inline`** | 写进 profile 配置 | 重启后生效 |

**加载优先级**：`inline` > `rules.dir` > packaged `rules/`；同名是**覆盖**（不是重复）；**同一层内**重名直接报错。loader 是 fail-loud 的：只要有一个文件写错，**整次加载失败**、保留旧规则集（日志 warn，面板条数不变）——这正是“文件加了但没生效”的头号原因。

### 5.4 落到哪里（当前桌面：已配 `rules.dir`）

**2026-11-17 起**桌面 profile 已配 `rules.dir: 'C:\Users\xiaojue\.dsh\safeharness\rules'`（两处配置都加了，目录已建），所以 `installRuleWatch` 监视的是这个**操作者目录**，不是安装包：

```
C:\Users\xiaojue\.dsh\safeharness\rules\
```

改完 patch 后 profile watcher 会热 reconcile：桌面实测 `POST /safeharness/status` 的 `rulesDir` 立即变为该路径、`ruleCount` 仍是 20（目录为空）。之后往该目录放文件即热更新，**升级不丢**。

历史（1.8.3 及之前，未配 `rules.dir` 时）：`installRuleWatch` 监视的是**安装包自带目录** `...\node_modules\@upear\dsh-safeharness\rules\`。**2026-11-17 实测**：往该目录放一个 `zz-operator-probe.yaml`（1 条规则），2 秒内 `ruleCount` 20 → 21、`rulesetHash` 从 `d53dedc1…` 变为 `455a42cc…`，账本新增 `rules_reloaded`（`labels.trigger: watch`、`metrics.rule_count: 21`、seq **8335**、`plugin_version: 1.8.3`）；删除文件后 2 秒内回到 20 条与原 hash。**这条路不需要重启**，但升级会覆盖该目录——这正是现在改成 `rules.dir` 的原因。

```yaml
# cordis.patch.yml 的 safeharness config 里（insert 块与 id 覆盖块两处都要加）
rules:
  dir: 'C:\Users\xiaojue\.dsh\safeharness\rules'
```

**1.9.0 起**：配好 `rules.dir` 后，面板「规则 → AI 起草」多出「写入并重载」按钮（见 §5.6）；没配时按钮会直接说明原因，不会假装能写。`rules.dir` 在运行中改变时，面板重载与文件 watcher 现在都跟随实时配置（watcher 会迁移到新目录；此前只认加载期目录，热改后静默失效）。

### 5.5 怎么验证规则生效（三层证据，缺一层就可能自欺）

1. **加载层**：`safeharness_status` 的 `ruleCount` / `chainCount` / `rulesetHash`；面板「规则」页条数与来源（`packaged/…yaml`、`dir/…yaml`、`inline`）；账本 `rules_reloaded`（`trigger: watch` 或 `reason_code: panel_reload`）。
2. **行为层**：触发后——
   - 输入面：整轮被拒（`input: enforce`），界面显示通用“触发平台安全策略”话术；
   - 工具面：该次调用返回通用“该操作不被平台安全策略允许（SafeHarness 安全插件）”，回合继续；
   - 结果面：模型拿到的是“该工具结果被平台安全策略拦截…”（只有 `blockOn` 命中的 category 才真拦）。
3. **证据层**：账本 `input_denied` / `tool_denied` / `tool_result_flagged` 记录里的 `rule_ids` 就是命中的规则名。拒绝话术**故意不点名规则**（防止攻击者试探），所以判定“是哪条”只能看账本：面板「事件」页、`safeharness_audit_query`，或直接读 NDJSON。

**反向对照**：再发一句近似但不匹配的话，账本应出现 `input_checked` + `decision: allow`。一条规则只能证明“拦得住”，对照才能证明“没误伤”。

### 5.6 面板“写入并重载”（1.9.0，D62）

2026-11-17 用户明确提出的体验问题是：起草出来的 YAML 要人肉去 `node_modules` 粘贴。最初（D37）的答案是“干脆不提供写路径”；**1.9.0 改成“提供一条只有人能触发的受限写路径”**：

> 规则集是插件的信任根。让“任何能发 HTTP 的一方”写规则，等于让攻击者一步关掉自己的护栏；但让“坐在浏览器前、能点按钮的操作者”写 `rules.dir` 并没有扩大攻击面——那人本来就有磁盘权限。

实现（`src/panel/rules-write.ts` + `engine/rules.ts` 的 `validateRuleCandidate`）：

1. **只写 `rules.dir`**：未配置 / 非绝对路径 / 解析后落在安装包 `rules/` 内 → 拒绝（`rules_dir_unconfigured` / `rules_dir_not_absolute` / `rules_dir_packaged`）；
2. **文件名白名单** `^[a-z0-9][a-z0-9._-]{0,63}\.ya?ml$`，拒绝分隔符、`..`、盘符、前导点、Windows 设备名（`filename_invalid`）；正文 ≤ 12 000 字符；
3. **同名默认拒绝**（`rule_exists`），前端必须再点一次「覆盖并重载」；
4. **写前真实 loader 试编译**：`validateRuleCandidate` 与加载共用 `assembleRuleSet`，候选按“替换自身”参与合并（覆盖不会与自己的旧规则重名）→ 失败返回 problems、**一个字节都不落盘**（`rule_content_invalid`）；
5. **原子写**：同目录 `tmp`（不带 `.yaml` 后缀，watcher 读不到半截文件）+ rename；成功写账本 `rules_written`（文件名/字节数/规则数/链数，**不记内容**），然后热重载；重载失败保留旧集合、返回 `reloaded: false` 并写 `invariant_probe`；
6. **端点** `POST /safeharness/write-rule`，只有 loopback + 同源栅栏；**模型侧没有任何写规则的工具**（`safeharness_draft_rule` 只产文本）。

代价与限制：仍要先配 `rules.dir`（当前桌面还没配，见 §5.4）；起草的语义质量仍要靠人看（§5.7 第 6 条）。

### 5.7 规则系统的已知限制

1. **inform 规则不扫工具参数**。`bash`/`pwsh` 的命令字符串**不会**被 `pattern` 规则检查；工具调用面只有 `denyTools` / `denyTags` / 危险 SQL / chain 四类。要拦“命令文本”只能靠 chain 或工具名单。
2. **chain 规则依赖工具名**，不是语义；`first`/`then` 写错工具名就永不命中。`tools.trajectory` 必须为 true（默认 true）。
3. **输入面 deny 会中断整轮**，pattern 写太宽会打断正常对话。
4. **结果面只看 `blockOn`**：balanced 默认只拦 `credential_leak`。
5. **升级覆盖 packaged `rules/`**：临时规则可以放那里，长期规则要配 `rules.dir`。
6. **写入按钮依赖 `rules.dir`**：没配置就只能复制粘贴；写入本身只保证“能加载、不破坏规则集”，不保证规则语义对（模型写的正则仍可能过宽/过窄）。

---

## 6. 安全模型与不变量

### 6.1 零回显（zero-echo）

账本/日志/错误消息/finding/面板载荷**只允许出现哈希、长度、代码、配置名**；不允许：prompt / 用户原文、工具参数原文、工具结果原文、模型输出原文、webhook URL / token / API Key、凭据。

例外（明确、仅显示、不落账）：会话标题与 workspace 写入 `sessions.json`（只用于面板辨识，不进账本、不进模型上下文）；自定义模型的 Key 只进凭据服务、profile 只留引用名。

面板载荷投影字段：`ts/kind/decision/reason_code/tool/severity/category/rule_ids/args_sha256 前缀/短 session id/项目/标题/numeric counts`。规则清单是操作者自己写的规则模式，不属于回显。

### 6.2 面板栅栏

- 每个端点都检查 Host 是 loopback（`localhost` / 127.0.0.0/8 的 IPv4 字面量 / `[::1]`）；判定用 `net.isIP() === 4`，**不能用 `127.` 字符串前缀**（否则 `127.0.0.1.attacker.example` 会通过，DNS rebinding 可打全部写端点）。`sec-fetch-site: cross-site` 直接拒；有 Origin 时必须与 Host 完全同源。
- 所有写动作 POST-only；body ≤ 16 KiB；draft 描述 ≤ 2000；schedule 5–1440；export 1–500。
- 面板不可用（headless profile 无 webServer、客户端未构建）时插件照常加载。

### 6.3 顺序（没有插件优先级）

DSH 0.2.2 **没有数值优先级**。顺序只有：

- 同一事件监听器的注册序；`ctx.on(…, {prepend:true})` 是 `unshift`，**后 prepend 者更靠前**；
- `tools.guard` 按 scope 分层、单调不可撤销，但只在 pre-execute=allow 且审批之后执行；
- `tools/pre-execute` 是 waterfall：更早的监听器不调 `next()` 就不会执行我们；调了也能丢弃我们的 deny 改写为 allow。

1.7.0 起四个安全关键接缝（`tools/pre-execute`、`agent/pre-step`、`llm/stream`、`approval/request`）都用 `{prepend:true}`，同时保留 `ctx.tools.guard` 作为**单调兜底**。对外口径只能是“prepend 最佳努力 + guard 单调兜底”，不能承诺“绝对第一”。详见 `docs/1.7.0-notes-q4-q5.md` 与 README §4.8。

### 6.4 工具覆盖与终点

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

## 7. 构建、测试、打包

**pnpm 在本机是坏的**：`C:\Users\xiaojue\package.json` 里有 `"packageManager": "yarn"`，pnpm 会拒绝运行。不要试图修全局，直接用 node 调本地二进制：

```powershell
cd F:\AgentSecurity\Upear\plugins\dsh-safeharness

# 类型检查
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.client.json

# 全量测试（本机 41 文件 / 709 用例）
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

`lib/` 是**构建产物**，被 `.gitignore` 忽略；公开仓库不提交 `lib/`，但 tarball 包含。公开树测试口径 38 / 691（688 pass + 3 skip）；CI 剔除 `tests/perf.test.ts` → 37 / 683（680 pass + 3 skip）。`perf.test.ts` 在满载全量跑时可能偶发 p99 抖动（实测出现过 5.256ms > 5ms；单独重跑 1.184ms 通过），单独重跑通过即可。

测试重点：

- `tests/panel.test.ts` 面板载荷投影；
- `tests/panel-route.test.ts` 栅栏（含 DNS rebinding 回归）、每个端点闸门、导出、起草状态码映射；
- `tests/panel-settings.test.ts` judge/draft 设置、自定义 provider 添加/删除/校验、Key 不泄漏、CRLF 拒绝；
- `tests/state.test.ts` 会话状态 + `sessions.json` 持久化；
- `tests/client-bundle.test.ts` 浏览器半契约；
- `tests/rules.test.ts` / `tests/tool.test.ts` 规则加载门与结果扫描形态闸门；
- `tests/sidecar*` / `golden` / `acceptance-m2` / `perf` 等内部语料/性能门。

---

## 8. 发布流程（插件独立发版）

### 8.1 仓库与远端

| remote | 地址 | 用途 |
|---|---|---|
| `dsh` | `https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh.git` | 插件公开仓库（发布目标） |
| `github` | `https://github.com/JueeeX/Upear-SafeHarnessSuite.git` | Upear 仓库备份（同步 main + tag） |
| `origin` | `https://github.com/liu-yang-maker/SafeHarness.git` | **上游，绝不要 push** |
| `gitcode` | `git@gitcode.com:Jue_Xiao/Upear.git` | 另一个远端，本流程不使用 |

### 8.2 标准步骤（1.8.3 与 1.9.1 实际执行过）

1. 本地 `main` 提交功能 + 文档；工作树只留其他会话的 `docs/deploy-patrol.md`、`outputs/`、`src/version.ts`（**不要 add/删**）。
2. `git fetch dsh main`；从 `dsh/main` 建发布 worktree：

```powershell
git worktree add -b release/1.8.4 C:\Users\xiaojue\.codex\worktrees\sh-public-184 dsh/main
```

3. 发布脚本（target = **公开仓库根目录**，不是 `plugins/...`）：

```powershell
cd F:\AgentSecurity\Upear\plugins\dsh-safeharness
node scripts/publish-public.mjs --target C:\Users\xiaojue\.codex\worktrees\sh-public-184
```

它会复制 112 个文件、跳过 8 个内部资产（tests 内部语料等）。

4. 在 worktree 里建 node_modules junction 后构建/测试：

```powershell
cmd /c mklink /J C:\Users\xiaojue\.codex\worktrees\sh-public-184\node_modules F:\AgentSecurity\Upear\plugins\dsh-safeharness\node_modules
cd C:\Users\xiaojue\.codex\worktrees\sh-public-184
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node scripts/build-client.mjs
node node_modules/vitest/vitest.mjs run
```

5. **删除 worktree 里的 `lib/`**，再跑 leak 检查：

```powershell
Remove-Item lib -Recurse -Force
node scripts/publish-public.mjs --target <worktree> --check   # 期望 leaks: 0
```

6. `git add -A`（会吸收 CRLF 归一化，可能显示很多文件改动，这是正常的），commit，push：

```powershell
git add -A
git commit -F <message-file>
git push dsh HEAD:main
git tag -a v1.8.4 -m "dsh-safeharness 1.8.4"
git push dsh v1.8.4
```

7. 回主仓：`git push github main`、`git push github v1.8.4`；更新交接文档里的公开 commit/tag；commit/push 文档。
8. 清理 worktree（先删 node_modules junction）：

```powershell
cmd /c rmdir <worktree>\node_modules
git worktree remove <worktree> --force
```

9. 打 tarball、复制到 `C:\Users\xiaojue\.dsh\plugin-tarballs\`、更新 `install-safeharness-desktop.cmd` 里的 `TGZ=`。

**坑**：

- 发布脚本 `--target` 一定要指公开仓库根；指到 `plugins/dsh-safeharness` 会把内容复制到错误层级。
- leak 检查会把 worktree 里的 `lib/` 当内部资产；提交前删掉。
- 本地主仓**不要 `git add -A`**（会吞其他会话文件）。
- 删 `tools/` 目录前先确认 `tools/agentprobe` 是 tracked；误删后 `git restore --source=HEAD -- tools`。
- CRLF 警告很多，不要手工修；`git add -A` 后 diff 会归一化。
- 公开仓库 tag 对象和本地 tag 共享；在主仓 push tag 即可。
- 本机 `api.github.com` 匿名访问会被代理出口 IP 限流（403）；要看 CI 就抓 workflow badge（`.../actions/workflows/ci.yml/badge.svg?branch=main`，绿=passing），或网页上看。
- GitHub push 偶发 `Connection was reset` / timeout：加 `-c http.version=HTTP/1.1` 重试通常能过。
- **已发布的 tag 不要重写**；修复只发新版本。

**2026-11-17 1.9.1 发布（已执行，16:33 完成）**：直连 `github.com:443` 仍不通（DNS 正常、TCP 443 被墙、系统代理 `ProxyEnable=0`），但本机 `127.0.0.1:7897`（Clash 端口）在监听——给 git 加一条 `http.proxy` / `https.proxy` 指向它就通了（`ls-remote` 先验，再推）。公开树在 `C:\Users\xiaojue\.codex\worktrees\sh-public-191`（分支 `release/1.9.1`）：

- `publish-public.mjs --target <worktree>` 刷新 → 116 文件、跳过 8 个内部资产（重跑是幂等的：83 条 CRLF 差异、4 个新文件）；
- junction `node_modules` → 主仓；`tsc -p tsconfig.json --noEmit` = 0；`build-client.mjs` 成功；`vitest run` = **41 文件 / 726 passed + 3 skipped**；
- 删 `lib/` 后 `--check` → **leaks: 0**；`git add -A` → **23 文件 / +1811 −161**（其余是 CRLF 归一化）→ commit `1cddce1`；
- `git push dsh HEAD:main` → `57efcc9..1cddce1`；`git tag -a v1.9.1`（对象 `61124be…`）→ `git push dsh v1.9.1`；
- 主仓 `git push github main` → `99a9956..1203d9c`、`git push github v1.9.1`；
- 远端核对：`dsh` `main = 1cddce1`、tag `= 61124be`；`github` `main = 1203d9c`、tag 同步；`ci` badge = **passing**。

**本次新坑（下次照做）**：直连 GitHub 挂着时先看 `Test-NetConnection github.com -Port 443` 与注册表 `Internet Settings` 的 `ProxyServer`，有本机代理端口就直接给 git 加 `http.proxy` 参数，别去改全局配置。

---

## 9. 真实宿主验证（开发/面板）

### 9.1 启动 dev host

```powershell
& 'D:\dsh\resources\runtime\cli\bin\dsh.cmd' --profile safeharness-dev --no-open --port 61557
```

不要加 `web` 位置参数（会报 “too many arguments”）。等待输出：

```
dsh web: http://127.0.0.1:61557/?token=…
```

### 9.2 无头 Edge + CDP

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

### 9.3 常用面板检查

- 概览：版本、模式、规则数、账本可写、判官可用；
- 规则：条数、来源、搜索、重载按钮、起草（描述 → 候选 YAML）；
- 事件：四重筛选 + 搜索 + 展开详情（`rule_ids` 在详情里）；
- 巡检：跑一次、定时开关；
- 设置：judge/draft 路由、自定义模型、probe。

### 9.4 清理（每次真机验证后必做）

- 停止 dev host、headless Edge、fake server；
- 删除 `C:\Users\xiaojue\.dsh\safeharness\panel-state.json`（如果验证时开过定时巡检，否则桌面端会继承定时）；
- 检查 dev profile 没有留下的测试路由/凭据引用（`shp-fake` / `fake-local` / `SAFEHARNESS_*`）；
- `sessions.json` 可以保留（用户自己的会话元数据），`providers.json` 若为空可保留或删除；
- 不要留下 `lib/` 之外的文件改动。

---

## 10. 桌面端现状与升级

- 已装 **1.9.1**（2026-11-17 16:28 重启生效）：`desktop/node_modules/@upear/dsh-safeharness/package.json` = 1.9.1；profile 依赖 = `file:…/upear-dsh-safeharness-1.9.1.tgz`；账本 `plugin_loaded` **seq 9423**（`version 1.9.1`、宿主全 rc.3、20 规则 / 3 链、`startup_ms 7`）。
- **1.9.1 已发布**：公开 `main = 1cddce1`、tag `v1.9.1`（tag 对象 `61124be…`），CI `ci` badge = passing；备份远端 `github` `main = 1203d9c`、tag 已同步。
- 桌面 profile 的 `rules.dir` 已配好（`C:\Users\xiaojue\.dsh\safeharness\rules`，目录已建）。**1.9.0 装机后端到端验证**：面板写 `operator-desktop-probe.yaml` → 规则 20 → 21、`rules_written` seq **9269**（file/mode/bytes/rules，**无内容**）；同名再写 → `rule_exists`；删除文件后 watcher 2 秒内回到 20 条（`rules_reloaded` seq **9328**，`trigger: watch`）。测试文件已删除，目录为空；1.9.1 上 `safeharness_audit_query { kind: "rules_written" }` 可直接回查 seq 9269。
- `safeharness_status`：`version 1.9.1`、`host 0.2.2-rc.3`、8/8 接缝、`input/tools/results = enforce`、`output = warn`、`approval = delegate`、judge `liao/gpt-6-luna` 可用。
- 姿态：**0 FAIL / 0 WARN / 9 OK / 1 SKIP**；`plugin_version_mismatch` 已随 rc.3 钉版清掉（1.8.2 时代是 WARN）。

**重装/升级步骤**（以后每次发版同样适用）：完全退出 DSH（含托盘）→ 双击 `install-safeharness-desktop.cmd`（确认 `TGZ=` 指向新 tarball）→ 重启 → 用 `safeharness_status` 的 `version` 与账本 `plugin_loaded.version` 双向确认。

**1.8.2 双向复验（已做过一次，1.8.3 后建议再跑）**：① 用 `read` 读 `src/config.ts` 的 `secret`/`accessToken` 声明**不再**被结果层替换；② 读含假凭据的临时文件仍返回拦截回执（账本 `tool_result_flagged`，`credential_assignment` + `credential_openai_key`；1.8.2 时是 seq 7902）。

**结果层强制拦截的代价**：任何含真实凭据形态的工具结果（测试 fixture、文档示例、`.credentials.yaml`）都会被整条替换；读本插件源码/普通配置不再被拦（1.8.2 的 D53）。开发插件请用 `safeharness-dev`（observe），否则你自己读文档也可能被拦（本文档在 1.8.3 上实测过：含凭据赋值样例的段落会被整条替换，写作时已规避）。

---

## 11. 已知限制 / 未验证（诚实清单）

1. **真实 IM 投递未验证**：飞书/钉钉/企微/OneBot/generic 的 payload 与发送路径有单测；用户暂时无法提供 webhook。部署时在 `patrol.notify` 配好后跑 `/safeharness patrol` 或面板巡检即可验证；失败会在 finding/日志里体现，不会静默。
2. **真实人工审批未验证**：需要 `approval: ask` 的权限预设 + 人工点击；当前桌面/开发 profile 是 `approval: never`。审批桥的 delegate/policy 逻辑有单测。
3. **插件顺序没有绝对保证**：见 §6.3。
4. **工具内部不覆盖**：shell 内二次命令、子进程、网络副作用、技能正文、模型推理流、MCP server 自身、工具体执行后的副作用。
5. **自定义模型只支持三种协议**；Bedrock/Vertex/Azure/Codex 不支持手写路由。
6. **设置写入有 revision CAS（1.8.4）**：面板把读到的 `revision` 作为 `expectedRevision` 回传，宿主拒绝过期写入并映射为 `settings_conflict`；宿主 `describe()` 不暴露 revision 的旧构建退化为 last-writer-wins。
7. **`llm-pi-ai` 被 home patch / `--patch` overlay 覆盖时**，`settings.update('llm-pi-ai')` 可能被宿主拒绝（teammate 在 overlay profile 实测到）；正常 profile 可用。添加自定义模型失败时不会破坏现有配置。
8. **面板动作有限**：**1.9.0 起可写 `rules.dir` 下的一个规则文件**（人确认，见 §5.6；绝不写 packaged `rules/`）、不做通用调度、不提供 provider 编辑（只能添加/删除同名重建）；导出只在浏览器端保存。
9. **CI 状态**：本机 `api.github.com` 匿名访问被代理出口 IP 限流（403），改读 workflow badge 确认 `ci` = **passing**（`main`，2026-11-17 16:40）；具体 run 列表仍建议在网页上看一眼。
10. **结果层强制拦截的代价（1.8.2 收窄，1.8.4 再放行 SRI）**：`credential_assignment` 不再把 `apiKey: z.string()`、`token: process.env.X` 这类声明当凭据；含真实凭据形态的结果仍会被整条替换。输出层仍是 `warn`，若把结果层关掉，模型仍可能把密钥写进回答。1.8.4 起 `sha1-` / `sha256-` / `sha384-` / `sha512-` 前缀的 SRI 摘要豁免熵检测，读 `pnpm-lock.yaml` 不再被整条拦截；无前缀的同类令牌仍会命中。
11. **侦察命令不单独拦截**：`whoami` / `hostname` / `ipconfig` / `systeminfo` / `net user` 这类身份与环境侦察不在结果扫描的形态里（只认凭据与注入标记），工具面也没有命令级分类；单条属低危，但在不可信内容诱导下是外发前奏，且没有“侦察→外发”的链式规则。**用户 2026-11-12 明确不做**命令级 recon 分类与 egress 收紧（D51）。
12. **面板/provider 的 P1 缺口已关闭（1.8.4）**：① `addProvider` 索引写失败现在回滚路由与凭据并返回 `provider_index_failed`；② 删除守卫扫描 `llm-pi-ai` 里所有引用（含 `defaultProvider`）；③ `providerConfigurable` 要求 `update` 与 `mutate` 都存在；④ 全端点 POST-only、方法违规 405 + `Allow: POST`（栅栏先于方法判断）；⑤ 面板 settings 日志只记错误名/机器码/长度。仍存在的相关限制：面板不写规则文件（§5.6 / D57）、不做通用调度、不提供 provider 编辑（只能删除后重建）。
13. **宿主已是 0.2.2-rc.3**：1.8.3 运行时 `PINNED_VERSIONS` = rc.3（构建期类型仍为 rc.1）；`engines.dsh` 仍是 `>=0.2.2-rc.1 <0.3.0`，rc.1/rc.2 主机仍可安装但会看到 `plugin_version_mismatch` WARN。
14. **发布状态**：1.8.2（`6684ee4` / `v1.8.2`）、1.8.3（`57efcc9` / `v1.8.3`）、1.9.1（`1cddce1` / `v1.9.1`）、**1.9.2（`896034f` / `v1.9.2`，CI passing）** 均已发布；`github` 备份已同步到 `a50a816`。公开树是**每个版本的完整快照**（1.9.2 含 1.8.4 / 1.9.0 / 1.9.1 / 1.9.2 四轮改动），公开侧测试口径 **42 文件 / 723 passed + 10 skipped**。
15. **规则起草依赖模型路由的延迟**：1.8.3 已把超时放宽到 60s、输出上限 2048，并把失败原因拆开显示；但起草仍是一次真实模型调用（实测 5.8s / 6.1s / **18.9s**），没有自动重试，也不会回退到本地启发式。失败时看面板提示或账本 `invariant_probe`（`reason_code: panel_draft`，`labels.status` 为 `timeout` / `empty` / `bad_json` / `invalid` / `error`）。
16. **规则落地已进面板（1.9.0）**：面板「规则」页填文件名 → 确认 → 写 `rules.dir` 下的一个文件并热重载，见 §5.6；仍不支持在面板里编辑已有文件的正文、不支持删除文件（删除请直接用文件系统，watcher 会自动回落）、不写 packaged `rules/`。
17. **【2026-11-17 新发现，P0 UX 缺口】桌面 app 里点不到面板**：用真实登录 cookie 驱动 headless Edge 打开桌面 GUI（`GET /` = 200）后确认——侧栏「插件」页只有 **已安装 / 发现** 两个标签，内容为「内置插件配置」+「实验性插件」，**没有「已安装插件」分组、也没有 SafeHarness 行**，整页 HTML 里 `/safeharness/i` 不命中。
    - 但客户端半边是加载了的：`window.__DSH_BOOT__` 里能找到 safeharness 条目（插件 `package.json` 的 `dsh.client` 注入 `dsh-client-runtime` / `dsh-client-connection` 已生效）。
    - 根因：插件是**手改 `profiles/desktop/package.json` 的 dependencies + `cordis.patch.yml`** 装进去的；而桌面 profile 由 Electron 独占管理（`dsh plugin --profile desktop …` 与 `--dump-config` 都被拒：*profile is managed exclusively by the Electron application*），其 `dsh.profile.bundles` 只有 6 个官方 bundle。按宿主文档（ui-settings-plugins）：第三方配置页要么挂在 `plugins.item`（官方）、要么按 `plugins.bundle.config`（以 bundle 包名为键）渲染，「没有组合包 patch 的依赖不是插件，除非 profile 选中了它才会带异常标签列出」——我们不属于任何一种，于是宿主根本没有可挂 `settings.plugins.tab` 的条目页。
    - 影响：**HTTP 面板端全通、写入链路照常工作**，但用户在桌面 GUI 里没有入口点开它；历史上所有面板截图都来自 `dsh web` 起的 dev/web profile，桌面装机验证一直只用 `safeharness_status` / curl。
    - 待办（需产品决策）：把插件改成「profile 选中」的条目（GUI「添加插件」流程，或手工在 `dsh.profile.bundles` 加 `@upear/dsh-safeharness`）后重启，再看是否出现条目页与标签；或维持现状，把面板定位成 dev/web profile 的能力。
    - **2026-11-17 17:45–17:52 试过 GUI「添加插件」两次，都失败**（用真实 cookie 驱动 headless Edge 点完整个流程）：
      ① 直接装 `file:…upear-dsh-safeharness-1.9.1.tgz` → pnpm 输出 `Already up to date`（依赖里本来就有一模一样的 spec/版本），宿主报 *无法从依赖变更中确定安装了哪一个包*；
      ② 先把 profile `package.json` 的依赖删掉再装 → pnpm 确实 `+ @upear/dsh-safeharness file:…1.9.1.tgz`，宿主仍判失败并把清单回滚成 `{}`。
      结论：**不是流程问题，是打包缺件**——宿主文档明确：*"A bundle is a package whose `package.json` declares `dsh.bundle.patch`"*（官方包写法：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`）。我们的包只有 `dsh.client`，永远进不了 bundle 清单。
      现场已恢复：`package.json` 从 `.bak-sh191b` 还原（依赖指向 1.9.1 tarball）、`node_modules` 仍是 1.9.1、lockfile 完好；`safeharness_status` = 1.9.1 / 20 规则 / 8/8 接缝 / 0 失败。备份文件保留：`profiles/desktop/{package.json,cordis.patch.yml,pnpm-lock.yaml,pnpm-workspace.yaml}.bak-sh191b`。
    - **1.9.2 计划（拿到面板截图的唯一正路）**：① 包内加 `cordis.patch.yml`（insert 本插件条目，等价于当前 profile 里那几条手工 patch）；② `package.json` 加 `dsh.bundle.patch`；③ 重新打包（版本 1.9.2）；④ GUI「添加插件」装 1.9.2 → 清单出现 SafeHarness 条目；⑤ 删掉 profile `cordis.patch.yml` 里的手工 insert（只留按 id 的 config 覆盖），避免双份加载；⑥ 重启 → 插件页出现条目页与五标签 → 用同一套 headless Edge 截图。
    - **状态：①②③④⑤⑥ 全部完成，唯独"面板标签"这一眼还没看到（2026-11-17 19:25 重启后）**：`safeharness_status` = **1.9.2**、姿态 0 FAIL；GUI「插件」页出现 **「已安装插件 → `@upear/dsh-safeharness`」**（详情页 *1 运行中 / 1.9.2*），浏览器也确实以 200 拉取并执行了 `@upear/dsh-safeharness/client.js`；但插件页标签栏仍只有「已安装 / 发现」。
    - **✅ 已解决（1.9.2 + 真机确认，2026-11-17 20:03）**：用户在桌面窗口打开「设置 → 内置插件」，`SafeHarness` 标签渲染成功——规则列表（`inform_19` 与三条 chain）、「AI 起草规则 · 已启用 · 描述上限 500 字」卡片（textarea / 类型下拉 / 起草按钮 / `0 / 500` 计数）、页脚 `读取于 … 20:03:12` 全部在位。截图：`evidence/1.9.2-panel-rules-draft.png`（面板）与 `evidence/1.9.2-plugin-detail.png`（插件页 v1.9.2 + 卸载 + 启用开关）。
    - **修复要点回顾**：`dsh.profile.bundles` → 包内 `cordis.patch.yml`（1.9.2 新增）让宿主给它准备了条目页，`settings.plugins.tab` 的五个标签才有地方挂。
    - **为什么 headless 到不了**（留档）：桌面端设置是 Electron 原生对话框，页面 DOM 里没有“设置”入口，headless 只能跑到插件页；标签渲染必须由真机窗口确认。

---

## 12. 下一步建议

### 12.1 1.9.0 候选（按优先级）

1. ~~**面板「写入并重载」规则按钮（用户明确要求）**~~ **已完成（1.9.0，D62）**：只写 `rules.dir`、文件名白名单、默认不覆盖、写前真实 loader 试编译、原子写、`rules_written` 只记元数据、写完热重载。实现见 §5.6。
2. ~~**provider 双写回滚 + 删除守卫**~~ **已完成（1.8.4，D59）**：`addProvider` 索引写失败回滚路由与凭据；删除检查全部引用（含 `defaultProvider`）；`providerConfigurable` 与实际写路径统一。
3. ~~**settings CAS**~~ **已完成（1.8.4，D60）**：`save` 带 `expectedRevision`，冲突映射 `settings_conflict`。
4. ~~**`status` 收紧**~~ **已完成（1.8.4，D58）**：全端点 POST-only、错误方法 405、栅栏先于方法判断；面板 logger 已脱敏。
5. ~~**SRI 前缀豁免**~~ **已完成（1.8.4，D61）**：`^sha(?:1|256|384|512)-` 跳过熵检测，读 lockfile 不再被拦。
6. **输出面凭据规则 + `output: enforce`**（产品决策）：当前 `results` 只保护“结果→模型”，不保护“模型→用户”；开启前评估误报与流式代价。
6b. ~~**【P0】让桌面 GUI 里能点开面板**~~ **已完成（1.9.2，真机确认）**：包里补 `dsh.bundle.patch` + `cordis.patch.yml`，GUI「添加插件」装 1.9.2、`dsh.profile.bundles` 登记、重启后「设置 → 内置插件 → SafeHarness」渲染出规则页（截图 `evidence/1.9.2-panel-rules-draft.png`）。细节见 §11.17。
7. ~~**`rules.dir` 默认化**~~ **已完成（2026-11-17）**：桌面 profile 两处块都配了 `C:\Users\xiaojue\.dsh\safeharness\rules`，目录已建，重启后生效（面板载荷 `rulesDir` 已显示该路径）。
8. ~~**`rules.dir` 热改后 watcher/面板重载跟随运行时目录**~~ **已完成（1.9.0）**：面板重载与 watcher 都读实时配置，watcher 随目录迁移。

### 12.2 环境项（需要用户配合）

- 真实 webhook（飞书/钉钉/企微）→ 配 `patrol.notify` 跑一次巡检；
- 真实 `approval: ask` 权限预设 + 人工点击 → 走一遍 delegate / policy 分支。

### 12.3 不做（已决策）

- 命令级 recon 分类、`denyTags: ['egress']`、网络面收紧（D51）；
- 面板写 packaged `rules/`（永远不做；写 `rules.dir` 是 12.1 的方案）；
- 重写已发布 tag。

---

## 13. 关键决策（当前有效）

| # | 决策 | 原因 |
|---|---|---|
| D36 | 面板标签全部挂载（非当前 `display:none`） | 条件渲染会丢草稿/筛选/巡检结果 |
| D37 | AI 起草只返回草稿，不写规则文件 | 面板写规则 = 新增可被同源脚本利用的写路径；草稿 + 人审 + loader 门是折中。**1.9.0 由 D62 取代**：写路径存在，但只由人触发 |
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
| D50 | 高熵启发式加形状闸门（混合大小写+数字、非纯 hex、非 Windows 路径） | 只改“什么算候选令牌”，不改“多随机才算秘密”；让 `results: enforce` 可用 |
| D51 | `whoami` 等侦察命令不单独拦截；不做命令级 recon 分类、不收紧 egress | 单条低危且拦截会误伤排障；代价是“侦察→外发”组合不在防护面内（§11.11） |
| D52 | 面板 Host 栅栏用 `net.isIP() === 4` + 127/8，不用 `127.` 前缀 | 前缀会把 `127.0.0.1.attacker.example` 当成 loopback → DNS rebinding 可打全部写端点 |
| D53 | `credential_assignment` 排除类型/引用表达式（`z.string()`、`process.env.X`、`a.b`），保留真实赋值 | `results: enforce` 下读源码/配置不能被拦；真实密钥仍由引号/前缀/熵命中 |
| D54 | `config_drift` 先读历史 `posture_report` 再跑当前姿态 | `runPosture` 会立刻写一条新报告，后读会拿到“自己刚写的”而永远 OK |
| D55 | hardened 只 gate 可达的 code；`approval_never` 移出默认 `failOn`，`hmr_enabled` 改判 FAIL | 无 session 时 approval 永远 SKIP，不可达门禁比漏报更危险；HMR 在 hardened 必须真的拒绝加载 |
| D56 | 起草失败按状态返回独立 code，并写 `invariant_probe`；默认超时 60s、输出 2048 | 原先所有失败都显示“路由不可用”，掩盖了 timeout/empty/bad_json；实测起草耗时 6–19s |
| D57 | **规则落地保持人审**；面板“写入并重载”按钮 1.9.0 已实现（D62），只写 `rules.dir`、不写 packaged | 规则集是信任根，模型不能自改护栏；同时承认当前手工粘贴体验差（§5.6） |
| D58 | **面板全端点 POST-only**（含只读 `status`），方法违规返回 405 + `Allow: POST`，且栅栏先于方法判断 | GET 是导航/预取/`<img>`/CSRF 能触发的请求；200 信封会让代理或测试把拒绝当载荷；未受信 Host 不应问出方法规则 |
| D59 | **自定义路由两存储一次提交**：索引写失败回滚路由与凭据；删除扫描 pi-ai 全段引用；`providerConfigurable` 要求 `update`+`mutate` 都在 | 配置与面板索引必须一致，否则出现“配置里有、面板删不掉”的孤儿路由或必然失败的按钮 |
| D60 | **设置写入带 revision CAS**；冲突映射 `settings_conflict`；宿主不暴露 revision 时不传第三参 | 宿主 `describe().revision` + `update/mutate(…, expectedRevision)` 本来就支持；last-writer-wins 会静默覆盖并发编辑 |
| D61 | **SRI 摘要豁免熵检测**（`^sha(?:1\|256\|384\|512)-`），阈值不变 | SRI 是对公开字节的完整性校验，不是凭据；读 lockfile 属日常操作，不该被 `results: enforce` 整条替换 |
| D62 | **面板可写一个规则文件，但只写 `rules.dir`、只由人触发**：文件名白名单、默认不覆盖、写前用真实 loader 试编译、原子写、账本只记元数据 | 取代 D37 的后半段：规则集是信任根，写路径必须窄且由人发起；模型侧仍不提供任何写规则工具 |

---

## 14. 第一天接手清单（按顺序执行）

1. **读**：本文 §0–§12；需要历史细节再读旧 handoff 与 README §4.7/§4.8。
2. **核环境**：`$env:DSH_HOME`（默认 `C:\Users\xiaojue\.dsh`）、`D:\dsh\resources\runtime\cli\bin\dsh.cmd --version`、Node `v25.8.2`、Python（仅 sidecar 需要）。
3. **核仓库**：`git -C F:\AgentSecurity\Upear status --short`（当前基线只有其他会话的 `docs/deploy-patrol.md`、`outputs/`、`src/version.ts`）；`git log --oneline -3` 应看到 1.9.1 的提交（`a875a45`、`1203d9c` 及后续文档提交）；`git remote -v` 确认 `dsh` / `github`，**不要碰 `origin`**。
4. **核发布**：`git ls-remote dsh refs/heads/main refs/tags/v1.9.1` 应分别指向 `1cddce1…` 与 tag 对象 `61124be…`；`v1.8.3`（`57efcc9`）、`v1.8.2`（`6684ee4`）仍保留。GitHub 直连不通时加本机代理（§8.2 末尾）。
5. **构建/测试**：按 §7 跑 tsc + vitest，期望 **747 passed**（1.9.1；perf 抖动时单独重跑，实测满载偶发 5.19ms > 5ms，单独重跑 1.2ms 通过）。
6. **看运行态**：调 `safeharness_status` / `safeharness_posture`，确认版本 = **1.9.1**、20 规则 + 3 链、0 FAIL、`plugin_version_mismatch` OK。
7. **看账本**：`C:\Users\xiaojue\.dsh\safeharness\audit\ledger.ndjson` 尾部，或 `safeharness_audit_query`；确认 `plugin_loaded.version` 与当前版本一致、`rulesetHash` 存在。
8. **做一次只读 smoke**：设置 → 内置插件 → SafeHarness，截一张概览/设置图；不要开定时巡检。
9. **试一次规则落地**（1.9.0 起）：面板「规则 → AI 起草」→「写入并重载」→ 看 `ruleCount` 变化与账本 `rules_written` / `rules_reloaded` → 触发一次 → 在账本看 `rule_ids` → 删除文件并确认回到原条数。
10. **清理**：按 §9.4；删 `panel-state.json`，确认无测试 provider/凭据残留。

---

## 15. 常见问题（FAQ）

**Q：面板里“工作区/对话”还是选不了？**
A：先看 `$DSH_HOME/safeharness/sessions.json` 是否存在、是否有历史会话；面板选项来自它 ∪ 账本事件。如果没有历史行，重启一次宿主并产生一条真实会话。

**Q：拒绝消息“该操作不被平台安全策略允许（SafeHarness 安全插件）”是谁的？**
A：卡片 UI 是 DSH 自带；这句话是本插件 `TOOL_DENIAL_TEXT`。要确认是谁拦的、哪条规则，看账本 `tool_denied` 的 `rule_ids` 或面板事件。

**Q：为什么 judge 没运行？**
A：`output.judge.enabled` 是否为 true、输出是否有文本、`scope` 是否只审已标记输出、模型路由是否可用。`/safeharness judge probe` 可以打一次真实调用；账本 `output_reviewed` 里 `judge_status` 会说明 `skipped_empty` / `skipped_recursion` / `ok` / `timeout`。

**Q：起草报“起草超时/空回复/非 JSON”怎么办？**
A：1.8.3 已把原因拆开。超时 → 模型路由慢（可调 `draft.timeoutMs` 或换模型）；空回复 → 调大 `draft.maxTokens` 或换非推理模型；非 JSON → 换模型；`invalid` → 生成的规则没过 loader 门，换个说法或手动改字段名。

**Q：我加了规则文件，为什么没生效？**
A：三个可能：① loader 是 fail-loud，任意一个文件写错 → **整次加载失败**、保留旧集（看日志 warn，条数不变）；② 文件不在被监视的目录（当前是安装包 `rules/` 或你配的 `rules.dir`）；③ 触发了但输入面没命中（inform 规则不扫工具参数，见 §5.7）。

**Q：能不能让起草结果一键生效？**
A：1.9.0 起可以：面板「规则 → AI 起草」→「写入并重载」。前提是 profile 里配了**绝对路径**的 `rules.dir`；同名文件需要再确认一次覆盖；loader 校验不过则不落盘。模型侧仍然没有对应工具（D62）。

**Q：自定义模型添加失败？**
A：看错误码：`provider_exists`（重名）、`provider_in_use`（删除时仍被使用）、`provider_unavailable`（无 settings/credentials 服务或找不到 llm-pi-ai entry）、`settings_invalid`（URL/协议/Key/模型不合法）、`settings_write_failed`（宿主拒绝写，可能是 overlay/home patch 覆盖）。Key 不会回显。

**Q：发布后桌面没更新？**
A：确认完全退出（托盘）→ 脚本 → 重启；检查 `desktop/package.json` 依赖与 `node_modules` 版本；看账本 `plugin_loaded.version`。

**Q：可以提交 `lib/` 吗？**
A：不可以；`lib/` 是构建产物、被 gitignore。tarball 会包含。

**Q：能改 `src/safeharness`（Python 参考实现）吗？**
A：不能；它是只读参考。插件是独立 TS 重写。`SUMC/`、`examples/` 同样只读。

---

## 16. 附录：证据与提交

| 内容 | 位置 |
|---|---|
| 1.9.1 状态 | **已发布、桌面已装并活体验证**：`AUDIT_KINDS` 单一来源修复（`safeharness_audit_query` 此前不接受 `rules_written`），公开 `main = 1cddce1`、tag `v1.9.1`（`61124be…`）、CI `ci` = passing；桌面 `plugin_loaded` seq 9423 起为 1.9.1，`kind: "rules_written"` 查询返回 seq 9269。证据 `plugins/dsh-safeharness/evidence/1.9.1-audit-query-kind.md`；tarball 337,700 B，sha256 `D9CF4A5DCA334C675B54E3E3EE98A8CBE40F0FB6A6DFF1945B8EC2F8DD0DEA6E` |
| 1.9.0 状态 | **桌面已装并验证**（写入 20→21、`rules_written` seq 9269、watcher 回落 seq 9328）；见 §5.6、决策 D62、plan §12.24、证据 `plugins/dsh-safeharness/evidence/1.9.0-rule-write.md`；1.9.1 的公开树一并包含 |
| 1.8.4 状态 | **随 1.9.1 公开**（公开树 = 1.9.1 全量快照）；改动与验收见 `docs/plan-dsh-safeharness-plugin-2026-11-10.md` §12.23，决策 D58–D61，证据 `plugins/dsh-safeharness/evidence/1.8.4-hardening.md`；本地 tarball 327,369 B，sha256 `FF483A911A98733A599F87B05B540C6D81E730BC29B760B7EC05D04E438EB0DC` |
| 1.8.3 证据 | `plugins/dsh-safeharness/evidence/1.8.3-draft-diagnostics.md`（根因、实测耗时、修复与测试） |
| 1.8.2 证据 | `plugins/dsh-safeharness/evidence/1.8.2-audit-fixes.md`（四类 P0 修复、测试、桌面双向复验） |
| 1.8.1 证据 | `plugins/dsh-safeharness/evidence/1.8.1-results-enforce.md`（含前后账本对照与真机验证） |
| 1.8.0 证据 / 截图 | `evidence/1.8.0-provider-export.md`、`evidence/1.8.0-panel-settings-providers.png`、`evidence/1.8.0-panel-export.png` |
| 1.7.0 / 1.6.0 | `evidence/1.7.0-panel-workbench.md`、`evidence/1.6.0-panel-workbench.md` |
| 研究笔记 | `docs/1.7.0-notes-q4-q5.md`（顺序/覆盖/judge 模型） |
| 计划 | `docs/plan-dsh-safeharness-plugin-2026-11-10.md` §12.19–§12.23 |
| 旧交接 | `docs/safeharness-plugin-handoff-2026-11-11.md`（历史坑与早期决策）、`…-2026-11-12.md`（1.8.2 基线） |
| 1.9.1 本地提交 | `a875a45`（枚举单一来源）、`1203d9c`（1.9.0 桌面验证 + 1.9.1 发布预演文档），以及本条文档提交 |
| 1.9.2 公开提交 | `896034f`，tag `v1.9.2`（tag 对象 `5aa7dfb…`）；`ci` badge = passing；公开树 42 文件 / 723 passed + 10 skipped |
| 1.9.1 公开提交 | `1cddce1`，tag `v1.9.1`（tag 对象 `61124be…`）；`ci` badge = passing |
| 1.8.3 本地提交 | `8e60d74`（起草诊断 + 默认值）、`99a9956`（发布文档） |
| 1.8.3 公开提交 | `57efcc9`，tag `v1.8.3`（tag 对象 `3d567a7…`） |
| 1.8.3 tarball | 321,683 B，sha256 `D77E41D487C92031C16B049DCA4F2EB54FF11F8C5B3A0438779730683163320B` |
| 1.8.2 本地/公开 | `c875ee7` / `903b918` / `e23066b` / `698bd27`；公开 `6684ee4`，tag `v1.8.2`（`50a65f6…`） |
| 1.8.2 tarball | 320,850 B，sha256 `6274E5B860669ADE67243FB6B6456C849DC853B02A85BCA43965EFE695886E9C` |
| 1.8.1 公开 | `0062f4f`，tag `v1.8.1`（`350b6c7…`） |
| 1.8.0 公开 | `0b66794`，tag `v1.8.0`（`708539e…`） |

**安全纪律（每次改代码/证据/文档前重温）**：

- 账本/日志/错误/finding 只许哈希与长度；
- 假模型用哨兵 Key（`sk-fake-sentinel`），不用真实 Key；
- 真实凭据只在 `$DSH_HOME/.credentials.yaml`，插件只填 provider/model 路由；
- `evidence/` 不入库；
- 提交前 `git status` 自查，别把其他会话的文件带进来；
- 写文档时别把 `key/secret/token = 真值` 这类样例写进去——1.8.3 的结果层会把它当凭据整条拦截，读者（包括后续 agent）将看不到那段文字（本文已规避）。

---

## 17. 2026-11-18 — 1.9.3 → 1.10.0 收口（面板可见性 + 安全开关）

**背景**：1.9.2 让包成为组合包后，「插件」页有条目页但正文只有 README；面板挂在设置标签页里，用户点插件看不到功能。

| 版本 | 改动 | 状态 |
|---|---|---|
| 1.9.3 | 浏览器半侧新增 `plugins.bundle.config`（key=包名）与 `plugins.row.config`（key=`@upear/dsh-safeharness#safeharness`），`view: 'page'` 渲染五标签工作台；设置标签页保留 | 已真机确认：工作台出现在条目页 README **之后** |
| 1.9.4 | 完整手册移到包根 `MANUAL.md`（章节号不变），`README.md` 收成 22 行门面，`MANUAL.md` 进 `files` 与发布白名单 | 已安装确认 |
| 1.9.5 | README 再收短（16 行，只留简介/安装/面板入口/三条 GitHub 绝对链接）；新增 `plugins.detail.actions` 页头「完整文档」按钮，按 `subject.pkg.name` 只在本包页面渲染，`target="_blank"` 打开 MANUAL | 已安装确认（按钮真机点击待验） |
| 1.10.0 | 设置页新增「防护面」开关：五面（输入/工具/结果/输出/审批桥）逐面 `mode` 下拉，保存走 `op: save`（`surfaces` 合并进同一个 `output`，revision CAS，审计只记 `surfaces: changed`）；概览四卡从等高网格改两列瀑布（`columns: 2` + `break-inside: avoid`，<700px 单列） | 已真机确认（1.10.0 状态：八个接缝 true、20 规则 / 3 链） |
| 1.11.0 | 输入面与内核对齐：**归一化 + MODIFY**（NFKC / 零宽 / HTML 注释，`input.normalize` 默认开；清洗后放行以清洗文本进入模型）；**输入语义评审**（`input.judge: off/flagged/always`，默认 flagged；`input.judgeFailClosed` 默认 false，hardened 预设自动 true；复用 `output.judge` 路由；`block` → `input_judge_blocked`，无结论 + fail-closed → `input_judge_unavailable`，结构已拒时不调用）；面板「防护面」卡片加三档/两开关 | 已安装，**待重启验证**；公开仓 `b059801` / tag `v1.11.0`；47 文件 / 767 用例 |
| 1.12.0 | 检测面 P1 与内核对齐：**SQL 表白名单**（`tools.sql.allowedTables`，空=不限制，非白名单表 → `unauthorized_sql_table`）；**工具描述符扫描**（`tools.descriptorScan: off/warn/enforce`，扫 name+description ≤8 KiB，warn 每会话每工具一次 `tool_descriptor_flagged`，enforce 逐次拒 `tool_descriptor_injection`）；**轨迹阈值**（`repeatedAttemptThreshold` 连续失败、`entropyThreshold`+`entropyMinLength` 参数熵，默认 0=关）；**PII 10 类**（`results.pii`/`piiClasses`，内核 `memory/sanitizer.py` 同名类别，`pii` 进 `blockOn` 白名单）；面板新增「工具与结果检测」卡片（`toolDetection`/`pii` 读写） | 51 文件 / 821 用例；待打包安装 + 重启验证 |

**宿主约束（重要，别再试）**：插件详情页的「包文档」是**纯 Markdown**——raw HTML（`<details>` 折叠、HTML 图片/布局）被丢弃，相对链接不可点，只有绝对 URL 可点。所以"页内展开完整 README"做不到；长文只能放外部链接 + 页头按钮。

**公开仓**：`dsh` `main = 47baecc`、tag `v1.10.0`（`45f2ef0…`）；`MANUAL.md` / `README.md` 的 raw URL 均 200（此前 GitHub 404 已修）。发布方式：主仓 `git worktree add <dir> dsh/main` → `publish-public.mjs --target <dir>` → **先 `git config core.autocrlf false` + `git config core.eol lf`**，否则 79 个文件全是 CRLF 假 diff（`git add -A` 后只剩 14 个真实改动）。

**测试**：45 文件 / 756 用例全过（1.9.4 起新增 README 行数与 MANUAL 链接回归；1.10.0 新增逐面保存/未知 mode 拒绝两条）。tarball `1.10.0` = 342,654 B / 138 文件。

**下一步计划**：见 `docs/plan-next-2026-11-18.md`（插件维护 + 主项目 Upear 的 P0/P1 清账）。

