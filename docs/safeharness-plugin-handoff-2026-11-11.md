# 交接文档：DSH SafeHarness 插件（2026-11-11）

> 读者：**没有任何上下文**的新对话 / 新模型 / 新智能体。
> 目标：读完这一份，你能继续开发、验证、发布，不需要再问原作者。
> 内部文档，**不要提交到公开仓库**（见 §4.3）。

---

## 0. 一句话现状

我们在 `F:\AgentSecurity\Upear\plugins\dsh-safeharness` 里做了一个 **DSH（DeepSeek Harness）profile 级 Cordis 安全插件** `@upear/dsh-safeharness`，它把 SafeHarness 的安全语义（输入拦截、工具管控、结果守卫、输出复核、审计账本、姿态自检、巡检、通知、规则起草）装进 DSH 的执行生命周期。当前版本 **1.1.1**，桌面端已在跑；公开仓库 `main` = `8cd0088`（1.1.1）。计划内 M0–M4 全部完成、M5 的 T5.2（LLM 辅助规则起草）完成，**T5.1（Python sidecar）只完成第 1 步（进程边界/传输，仅本地提交，未发布）**，T5.3（客户端 UI 面板）未开始。

---

## 1. 30 秒速览

| 项 | 值 |
|---|---|
| 插件包 | `F:\AgentSecurity\Upear\plugins\dsh-safeharness`（包名 `@upear/dsh-safeharness`） |
| 当前版本 | `1.1.1`（`package.json` / `src/version.ts` / README 三处一致，`tests/acceptance-m4.test.ts` 会断言） |
| 宿主 | DSH `0.2.2-rc.1`，CLI = `D:\dsh\resources\runtime\cli\bin\dsh.cmd` |
| 桌面端插件 | 已装 `1.1.1`（profile `desktop`，tarball 安装），会话在跑，judge 路由 `liao/gpt-6-luna` |
| 公开仓库 | `https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh`（git remote 名 **`dsh`**），`main` = `8cd0088`，tags `v1.0.0-rc.1…rc.4`、`v1.0.0`、`v1.1.0`、`v1.1.1` |
| 本地仓库 | `F:\AgentSecurity\Upear`，`main` = `89b1289`（**比公开仓库多一个未发布 commit**：T5.1 第 1 步 sidecar 传输层） |
| 测试 | 本地 `pnpm test` = **28 文件 / 564 用例**全绿；公开克隆 25 文件 / 538（其中 3 例缺内部语料会 skip）；CI 剔除 perf → 24 文件 / 530（527 pass + 3 skip） |
| 内部计划 | `docs/plan-dsh-safeharness-plugin-2026-11-10.md`（94 KB，任务卡 §9 + 风险/决策 §12，**必须随进展更新**） |
| 证据 | `plugins/dsh-safeharness/evidence/`（内部，gitignore，绝不入库） |
| 下一步 | T5.1 第 2 步（Python sidecar 脚本 + 引擎异步化 + 配置开关），详见 §11 |

---

## 2. 环境硬事实（都在本机实测过）

| 项 | 值 |
|---|---|
| 工作目录 | `F:\AgentSecurity\Upear` |
| `$env:DSH_HOME` | `C:\Users\xiaojue\.dsh` |
| DSH CLI | `D:\dsh\resources\runtime\cli\bin\dsh.cmd`；版本 `0.2.2-rc.1` |
| 桌面端 GUI | 每次重启端口会变（交接时 `http://127.0.0.1:60052`），以运行时 context 为准 |
| Node（系统） | `v25.8.2`（构建/测试用）；宿主自带 `24.21.0`（运行插件用） |
| pnpm | `10.33.0`（系统）；profile 里的安装用宿主自带 `11.28.5` |
| Python | `C:\Python314\python.exe`，`Python 3.14.7`（T5.1 sidecar 会用） |
| 宿主包版本 | `cordis 4.1.0` / `schemastery 3.19.0` / `dsh-* 0.2.2-rc.1`（运行时解析自 app bundle） |
| judge 路由 | provider `liao`，model `gpt-6-luna`；Key 在 `$DSH_HOME/.credentials.yaml`（`apiKeyEnv: LIAO_API_KEY`），**插件不读不打印** |
| 账本 | `C:\Users\xiaojue\.dsh\safeharness\audit\ledger.ndjson`（交接时约 811 行，哈希链） |
| 插件 tarball 仓库 | `C:\Users\xiaojue\.dsh\plugin-tarballs\`（rc.2/rc.3/rc.4/1.0.0/1.1.0/1.1.1 + 安装脚本） |
| git 身份 | `git config user.email` 必须是 `182746526+JueeeX@users.noreply.github.com` |

本机 profile 一览（`C:\Users\xiaojue\.dsh\profiles\`）：

| profile | bundles | 插件安装形态 | 版本 | 用途 |
|---|---|---|---|---|
| `desktop` | web-app 全家桶（Electron 独占管理） | tarball `file:…1.1.1.tgz` | 1.1.1 | 真实桌面端，日常在用 |
| `safeharness-dev` | web-app | `link:` → 源码目录 | — | 开发/HMR 验证 |
| `safeharness-real` | headless | `link:` → 源码目录 | 1.1.1 | 真实模型冒烟（`liao/gpt-6-luna`） |
| `safeharness-ga10` | headless | tarball 1.1.1 | 1.1.1 | 干净 profile 的 tarball 验收 |
| `safeharness-tarball` | headless | 已卸载（rc.1 时代现场） | — | 历史证据 |
| `headless` / `web` | 出厂模板 | — | — | 复制模板 |

---

## 3. 产品是什么、边界在哪

**它做什么**（一个 profile 插件，不是 Agent preset）：

| 面 | 入口 | 行为 |
|---|---|---|
| 输入防线 | `agent/pre-step` | 20 条 inform 规则 + 3 条链，命中即拒；拒绝话术不泄漏规则内容 |
| 工具执行面 | `tools/pre-execute` / `tools.guard`（同步、无 IO）/ `tools/post-execute` / `tools/result` | 工具名/标签策略、危险 SQL、链式轨迹、结果凭据扫描 |
| 输出面 | `llm/stream` | 字符/usage 复核、可选语义 judge、可选 `enforce-buffer`（默认关） |
| 审批桥 | `approval/request` | `policy` 模式一次性授予 / deny 名单，异常一律委托 |
| 账本 | 自建 NDJSON | 哈希链 + 脱敏（只存 sha256 与长度）+ 轮转 + 查询 |
| 姿态 | `posture` | 9 个 code 三态（FAIL/WARN/OK/SKIP），`hardened` 可拿它当加载门禁 |
| 巡检 | patrol | 5 个检查 + 退出码 0/1/2 + 0..N 通道通知（飞书/钉钉/企业微信/OneBot/通用） |
| 预算 | `budget` | 每 turn token 上限，越限只记一次 `budget_exceeded`（不拦截） |
| 规则起草 | 工具 `safeharness_draft_rule` + `/safeharness draft` | 一次辅助模型调用 → 校验后的 YAML 草稿，**永不自动生效** |
| 面 | 5 个工具 / `/safeharness` 命令 / 提示词条款 / 不变量入口 | 见 §6 |

**明确不做**（防止范围失控）：不改 `src/safeharness`、`SUMC/`、`examples/`、前端；不发布 npm（v1 只发 tarball）；不做官方 QQ bot 协议（只支持 OneBot）；v1 不打包 DSH 代码。

**三档预设**：`observe`（warn，不拒）/ `balanced`（出厂：输入与工具 deny，结果与输出 warn）/ `hardened`（全 deny + 姿态门禁 + `failOn` 含 `sandbox_danger_full_access`/`approval_never`/`hmr_enabled`/`plugin_version_mismatch`）。

---

## 4. 仓库与目录

### 4.1 你要打交道的目录

```
F:\AgentSecurity\Upear\
├─ plugins\dsh-safeharness\        # 插件包（本文主角，Apache-2.0）
│  ├─ src\                         # 33 个 TS 模块，~280 KB
│  ├─ tests\                       # 29 个文件（28 个 *.test.ts + corpus.ts）
│  ├─ rules\                       # inform.yaml（20 规则）+ chains.yaml（3 链）
│  ├─ examples\                    # 可直接粘贴的 patch 示例（4 个）
│  ├─ scripts\                     # fake-openai.mjs（假模型）、fake-llm-scenarios.json、link-dsh.mjs、clean.mjs、session-dump.mjs、gen_golden.py(内部)
│  ├─ evidence\                    # 内部证据（gitignore，绝不入库）
│  ├─ README.md                    # 对外文档（44 KB，12 节）
│  ├─ CHANGELOG.md                 # rc.1 → 1.1.1
│  ├─ package.json / tsconfig.json / .npmrc / .gitignore / pnpm-lock.yaml
│  └─ dist\                        # pnpm pack 产物（gitignore）
├─ docs\                           # 仓库文档（公开仓库不含 docs/）
│  ├─ plan-dsh-safeharness-plugin-2026-11-10.md   # 内部计划，任务卡+风险+决策
│  └─ handoff-*.md                 # 历史交接（**已有文件受保护，不要修改**）
└─ src\safeharness\                # Python 安全框架（只读参考，T5.1 sidecar 会调用）
```

### 4.2 git 结构（重要，容易搞错）

- 本地仓库只有一个工作树，remote 有四个：`origin`（上游 SafeHarness，**勿推**）、`github`（老主仓）、`gitcode`、**`dsh`（公开插件仓库，唯一要推的）**。
- 公开仓库是**独立历史**：根目录就是插件包根（`package.json`/`src`/`tests`/`rules`/`README.md`），**没有** `plugins/`、`docs/`、`evidence/`。
- 发布方式（见 §9.4）：从 `dsh/main` 开一个临时 worktree，把插件目录里的**白名单文件**复制过去，commit + push `dsh HEAD:main` + `git push dsh <tag>`。
- 本地 `main` 与 `dsh/main` 不必同步：本地可以带着未发布的开发提交（现在 `89b1289` 就是这种）。

### 4.3 公私边界（硬规则）

**绝不进公开仓库**：`docs/plan-*.md`、`docs/handoff-*.md`、`evidence/`、`lib/`、`dist/`、`*.tgz`、`tests/acceptance-m2.test.ts`、`tests/corpus.ts`、`tests/golden.test.ts`、`tests/fixtures/golden.json`、`tests/fixtures/benign*.json`、`scripts/gen_golden.py`、内部攻击语料、任何本机路径/凭据。

发布白名单（现在的公开树）：`.gitattributes`、`.github/`、`.gitignore`、`.npmrc`、`CHANGELOG.md`、`LICENSE`、`README.md`、`examples/`、`package.json`、`pnpm-lock.yaml`、`rules/`、`scripts/`（除 `gen_golden.py`）、`src/`、`tests/`（除上列内部文件）、`tsconfig.json`。

---

## 5. 里程碑与完成度

计划文件 `docs/plan-dsh-safeharness-plugin-2026-11-10.md` 的 §9 有逐条任务卡（勾选 + 证据行），这里是摘要：

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 环境基线 + 骨架 | ✅ | T0.1–T0.5；证据 `evidence/M0-*.md` |
| M1 观察模式 | ✅ | T1.1–T1.10；黄金判定 30/30 与 Python 一致 |
| M2 执行面 | ✅ | T2.1–T2.7；含 fake-LLM 全链路、失败矩阵 12 行 |
| M3 输出/审批/巡检 | ✅ | T3.1–T3.5；judge、enforce-buffer、巡检、预算 |
| M4 硬化与 RC | ✅ | T4.1–T4.6；hardened 门禁两态、tarball 全链路、兼容矩阵 |
| GA `1.0.0` | ✅ | 版本转正 + CHANGELOG + tarball 验收（21 条账本）+ tag/CI |
| M5 T5.2 规则起草 | ✅ | `1.1.0`；`1.1.1` 加"弱草稿警告" |
| **M5 T5.1 Python sidecar** | **🟡 第 1 步** | 传输层完成、本地 commit `89b1289`、**未发布**；第 2 步见 §11.1 |
| M5 T5.3 客户端 UI 面板 | ❌ 未开始 | 评估见 §11.2 |

**M4 遗留的四个"未验证项"已全部关闭**（2026-11-11）：HMR 重载 ✅、真实模型冒烟 ✅、桌面端命令 UI（`/safeharness status`、`judge probe`、`draft`）✅、跨 turn 预算 ✅。证据在 `evidence/GA-verification.md`、`M5-budget-crossturn.md`。

---

## 6. 代码地图（`plugins/dsh-safeharness/src/`）

| 文件 | 职责 / 关键不变量 |
|---|---|
| `index.ts`（26 KB） | 组合根 `apply()`：配置 → 门禁 → provide → 钩子 → 工具 → 命令 → 设置热更新。**门禁必须在任何 seam 注册之前**（R36） |
| `config.ts`（33 KB） | schemastery `Config` + `resolveConfig`；数组一律 `keepAbsent`（R37：缺数组不能被物化成 `[]`）；错误只报 index/字段名，不回显 webhook |
| `runtime.ts` / `state.ts` / `service.ts` / `invariant.ts` | 运行时聚合、会话轨迹（64/会话、256 LRU）、`safeharness` 服务、`@upear/dsh-safeharness/invariant` 入口 |
| `engine/index.ts` | `SecurityEngine` 实现（同步）；`rulesetHash` 由规则内容哈希 |
| `engine/rules.ts`（30 KB） | 规则装载/校验/编译/哈希；`RULE_REGEX_FLAGS = 'iu'`；拒绝 Python-only 语法 |
| `engine/input.ts` / `engine/sql.ts` / `engine/tool.ts` | inform 匹配、SQL 结构判定（与 Python `inspect_sql` 差分 707/707 一致）、工具名/标签/链式轨迹/结果扫描 |
| `engine/types.ts` | `Decision` / `RawRule` / `RawChainRule` / `RuleLoadError` / 严重级词表 |
| `engine/sidecar.ts`（新，12 KB） | **T5.1 第 1 步**：JSON-lines 子进程传输，fail-closed，零回声（还没接线） |
| `hooks/input.ts` / `hooks/tools.ts` / `hooks/llm.ts`（21 KB）/ `hooks/approval.ts` / `hooks/context.ts` | 五个 seam 的接线；judge 与 draft 的辅助调用都在 `llm.ts`（`createJudgeFor` / `createDrafterFor` / 各种 `*_REQUEST_MARK`） |
| `judge/client.ts` | 语义 judge 纯核心：prompt、超时/中止、JSON 解析、递归防护标记 `JUDGE_REQUEST_MARK` |
| `draft/rule.ts`（23 KB） | 规则起草纯核心：nonce 包装描述、JSON 严格解析、字段白名单、loader 级校验、ReDoS/控制字符拒绝、YAML 渲染、**形状警告** |
| `notify/channels.ts` | 5 种通知信封 + 钉钉加签 + 多通道（每通道 3 s、`notified` 仅全成功、零 URL 泄漏） |
| `patrol/index.ts` | 5 个检查 + 退出码 + 通知汇总 + 对账 |
| `posture/checks.ts` + `report.ts` | 9 个 code 三态 |
| `audit/ledger.ts`（27 KB）/ `redact.ts` / `types.ts` / `paths.ts` | NDJSON 哈希链、脱敏、轮转、查询；`redact` 只留哈希/长度 |
| `surface/tools.ts`（13 KB） | 5 个工具：`safeharness_status` / `_posture` / `_patrol` / `_audit_query` / `_draft_rule` |
| `surface/commands.ts`（13 KB） | `/safeharness status|posture|rules|audit [n]|patrol [check…]|judge [probe]|draft <…> [--chain]` |
| `surface/prompt.ts` | 一条提示词条款（order 190，≤300 字符，不含规则名） |
| `budget.ts` | 每 turn token 计数；`turn` 来自宿主 `agent/pre-step`，一轮只记一条越限 |
| `util/hash.ts` / `util/yaml.ts`（22 KB） | sha256/canonical JSON；自带 YAML 解析器（规则文件用） |
| `version.ts` | `VERSION`，与 `package.json` 同步（`tests/version.test.ts` 断言） |

---

## 7. 关键决策与不变量（改代码前必须遵守）

来自计划 §12 的决策记录（D1–D14）与实测风险（R13–R41），最能咬人的几条：

1. **`tools.guard` 是同步、无 IO 的硬约束**（R3）。任何跨进程/网络/文件操作都不能进这个钩子。
2. **加载门禁顺序**：先 `plugin_loaded`/`posture`，门禁失败就**什么都没装**（R36：该 Cordis 版本下 fiber 失败不回滚已注册监听器）。
3. **schemastery 会把缺失数组物化成 `[]`**，必须用 `keepAbsent`（identity transform），否则预设表在真实 host 上被静默覆盖（R37）。
4. **patch 层的 `config:` 是替换不是深合并**：只写一个 provider 会把其它 provider 全清掉（实测 `--dump-config` 验证过）。
5. **headless bundle 停用了凭据提供方**：真机测试要 overlay `- id: credentials … disabled: false` 才能解析 `LIAO_API_KEY`。
6. **假的 OpenAI 服务器不要用 `[[scenario:…]]` 标记做验收**：headless 每轮会额外发一次"会话标题"请求，标记被它吃掉；用服务端 `--scenario`。
7. **`GenerateOptions.purpose` 是封闭联合**（R17）：辅助调用（judge / draft）的递归防护靠"请求对象上的 symbol 标记 + 深度计数"，不是 `purpose`。
8. **起草/通知/账本的零泄漏纪律**：错误消息、finding、账本都不许出现原文、URL、token；只留哈希与长度。起草请求还带 `DRAFT_REQUEST_MARK` 跳过输出评审与预算。
9. **规则起草永不落地**：`applied: false` 是契约；起草只产出 YAML，生效必须人改 `rules.dir`/`rules.inline` 再重载。
10. **Code Mode（PTC）**：0.2.2-rc.1 已移除 `tools.mode`；要开 Code Mode 是 `tool-executor-native disabled: true` + `tool-executor-ptc disabled: false`；子调用会经过 `tools/pre-execute` 并被拒。
11. **高熵启发式误报**（R35）：长路径片段会被判 `credential_leak`。`balanced` 只 warn；`hardened` 会整条阻断 → 用 `results.blockOn: []` 或 `results.mode: warn`。
12. **热重载的边界**：改 `cordis.patch.yml` 会热重挂载插件（钩子面约 35 ms 生效），但**当前会话的工具清单是每轮快照**，重挂载后那一轮可能短暂 `unknown tool`——等一轮或重启。
13. **危险 SQL 的扫描面很宽**：`evaluateToolCall` 会扫描工具参数的字符串，连"写文档"这种工具的内容也会被扫。写含破坏性 SQL 字面量的文档会被自己的插件拦（误报，见 §12.21）。

---

## 8. 测试与验证

```powershell
cd F:\AgentSecurity\Upear\plugins\dsh-safeharness
pnpm install          # 宿主包已是 devDependencies，干净机器不需要装 DSH
pnpm build            # tsc -> lib/
pnpm test             # 28 文件 / 564 用例（本机全绿）
pnpm exec vitest run tests/sidecar.test.ts     # 单文件
pnpm typecheck        # tsc --noEmit
pnpm pack --pack-destination ./dist            # 产物 upear-dsh-safeharness-<ver>.tgz
```

测试分层（谁覆盖什么）：

| 文件 | 覆盖 |
|---|---|
| `rules/input/sql/tool/robustness` | 引擎判定（含与 Python 的黄金一致性 30/30、SQL 差分 707/707） |
| `hooks/failure-matrix` | 五个 seam + §7 失败语义矩阵逐行 |
| `audit` | 哈希链、篡改检测、脱敏（哨兵断言）、轮转、并发 |
| `posture/patrol/budget/approval/judge/output` | 各面语义 |
| `notify` | 5 种信封 + 钉钉签名 + 多通道 + **真实本地 HTTP 五通道往返** |
| `draft` | 起草核心（34 例）+ 形状警告 + 工具/命令面 |
| `sidecar` | 子进程传输（9 例，假引擎脚本 `tests/helpers/fake-sidecar.mjs`） |
| `fake-llm/surface-m3/acceptance-m4/version/config/presets/settings-reload/state/perf` | 组合根、工具/命令面、验收契约、性能预算 |
| `acceptance-m2` / `golden` / `corpus.ts` / `fixtures/` | **内部资产，不公开**（公开克隆会跳过 3 例） |

性能预算（`tests/perf.test.ts`，本机 p99）：guard < 1 ms、input 60 KB < 5 ms、post-execute 64 KB < 5 ms、输出 128 KB < 20 ms、账本写 < 10 ms。CI 上剔除 perf（抖动敏感）。

---

## 9. 运行手册

### 9.1 桌面端安装 / 升级（需要完全退出 DSH）

```powershell
# 1) 完全退出 DeepSeek Harness（含托盘图标；运行中会 EPERM）
# 2) 双击（或运行）
C:\Users\xiaojue\.dsh\plugin-tarballs\install-safeharness-desktop.cmd
# 脚本做三件事：删旧目录 → dsh plugin --profile desktop add file:<tgz> → 幂等追加 cordis.patch.yml 的 insert 块
# 3) 重新启动 DSH
```

脚本里的 `TGZ` 指向当前版本（现在是 `upear-dsh-safeharness-1.1.1.tgz`）。**发新版后必须同步改这里**（1.1.1 那次就漏改过，导致装进去还是旧版）。

### 9.2 桌面端 patch 的形状（`~\.dsh\profiles\desktop\cordis.patch.yml`）

必须是 `- insert:` 形式（只写 `id:` 是"配置覆盖"不是"挂载"，R22）：

```yaml
- insert:
    - id: safeharness
      name: "@upear/dsh-safeharness"
      config:
        preset: balanced
        output:
          judge: { enabled: true, scope: flagged, provider: liao, model: gpt-6-luna, timeoutMs: 6000 }
    - id: invariants
      name: "@deepseek-ai/dsh-invariants"
    - id: safeharness-invariant
      name: "@upear/dsh-safeharness/invariant"
```

改这份文件会**热重挂载**插件（不用重启），但注意 §7.12 的工具快照问题。

### 9.3 无头运行（开发/验收/冒烟）

```powershell
$env:FAKE_LLM_KEY='sk-fake-sentinel'
node plugins/dsh-safeharness/scripts/fake-openai.mjs --port 18080 --scenario tool-call-bash
& 'D:\dsh\resources\runtime\cli\bin\dsh.cmd' <profile> --patch <overlay.yml> "your prompt"
# 一次性 headless：位置参数是 profile 名，不是 --profile
```

真实模型冒烟：profile `safeharness-real` + `evidence/ga-real-provider-overlay.yml`（内含真实 provider + `credentials disabled:false`）。

### 9.4 发布一个版本的完整流程（照抄）

1. 改 `package.json`、`src/version.ts`、README 版本号/测试口径、`CHANGELOG.md`；`tests/acceptance-m4.test.ts` 的版本正则要能匹配。
2. `pnpm build && pnpm test` 全绿。
3. `pnpm pack --pack-destination ./dist`，把 tgz 复制到 `C:\Users\xiaojue\.dsh\plugin-tarballs\`。
4. **干净 profile 冷启动验收**（照 §9.3 那套：复制 `headless` 模板 → `dsh plugin add file:<tgz>` → 冷启动 → 看账本 `plugin_loaded plugin_version=<ver>` + `posture ok` + 一次攻击拦截 + 一次 patrol + 卸载后无账本）。
5. 本地 commit（只 add 插件文件 + 计划文档）。
6. 公开仓库发布：
   ```powershell
   cd F:\AgentSecurity\Upear
   git worktree add F:\AgentSecurity\_pub-ga --detach dsh/main
   # 按 §4.3 白名单复制改动文件到 worktree（路径相对 plugin 根）
   git -C F:\AgentSecurity\_pub-ga add -A
   git -C F:\AgentSecurity\_pub-ga commit -m "…"
   git -C F:\AgentSecurity\_pub-ga push dsh HEAD:main
   git -C F:\AgentSecurity\_pub-ga tag -a v<ver> -m "…"; git -C F:\AgentSecurity\_pub-ga push dsh v<ver>
   git worktree remove F:\AgentSecurity\_pub-ga --force
   ```
7. 查 CI（无需 gh）：
   ```powershell
   Invoke-RestMethod -Uri 'https://api.github.com/repos/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh/actions/runs?per_page=1' -Headers @{ 'User-Agent'='dsh-agent' }
   ```
8. 改桌面端安装脚本指向新 tgz，告诉用户"退出 DSH → 双击脚本 → 重启"。

> GitHub Release 附件：`gh` **未登录**，所以一直没建 Release。用户 `gh auth login` 后可 `gh release create v<ver> --notes-file …`，或网页点。

---

## 10. 证据索引（`plugins/dsh-safeharness/evidence/`，内部）

先读这三份，能省很多时间：

| 文件 | 内容 |
|---|---|
| `GA-verification.md`（17 KB） | M4 遗留项收敛：HMR、飞书、真实模型、judge 自检、rc.3/rc.4、**§9 桌面端 1.0.0 命令面实测** |
| `M5-drafting.md` | 规则起草（T5.2）：设计、测试、**1.1.0 的 `^curl$` vs 1.1.1 的真实模型前后对比** |
| `M5-budget-crossturn.md` | 跨 turn 预算：turn 18/19/20 三条记录、为什么没有"同进程连续两轮"、临时配置已还原 |

其他按里程碑：

- `M0-baseline.md` / `M0-skeleton-and-install.md` / `M0-ledger-sample.ndjson`：环境基线、骨架、安装卸载。
- `M1-observe.md`、`T1.1-rules.md`、`T1.2-detectors.md`、`T1.6-ledger.md`、`T1.9-golden.md`：M1 五个任务。
- `M2-execution.md`、`T2.6-failure-matrix.md`、`T2.7-e2e.md`、`T2.7-fake-llm-server.md`：执行面与假模型全链路。
- `M3-output-approval-patrol.md`、`M3-e2e.md`、`T3.1-judge.md`、`T3.3-approval.md`、`T3.4-patrol.md`、`T3.5-budget.md`：M3。
- `M4-hardening.md`、`M4-compat.md`、`GA-tarball-1.0.0.md` + `GA-tarball-1.0.0/`：M4/GA tarball 验收原始账本。
- `M5-sidecar.md`：T5.1 第 1 步设计、测试、**第 2 步任务分解与风险**。
- 各种 `*.ndjson` / `*.log`：原始账本与运行日志（名字对应任务号）。
- overlay 文件：`ga-hmr-overlay.yml`、`ga-feishu-overlay.yml`、`ga-real-provider-overlay.yml`、`m4-*-overlay.yml`、`headless-m3-e2e.patch.yml`。
- 工具：`webhook-sink.mjs`（本地 webhook 接收器）、`desktop-patch.before-budget.yml`（临时改配置前的备份）。

---

## 11. 下一步（按优先级）

### 11.1 T5.1 第 2 步：把 sidecar 接到引擎上（**当前主线**）

第 1 步已完成：`src/engine/sidecar.ts` + `tests/sidecar.test.ts`(9) + `tests/helpers/fake-sidecar.mjs`，本地 commit `89b1289`（**未发布**）。

第 2 步任务卡：

1. **Python 脚本** `scripts/safeharness_sidecar.py`：`PYTHONPATH=<repo>/src` 下 import `safeharness.policies.sql_guard.inspect_sql`、`safeharness.policies.rules_loader.build_inform_policy`；stdin/stdout 跑 sidecar 的 JSON-lines 协议；暴露 `health` / `inspect_sql` / `inform_match`。只读，不改 `src/safeharness`。
2. **引擎异步化**：计划 §6.14 的 `evaluateInput(text): Decision` 是同步的。两种做法：(a) 新增 `evaluateInputAsync`；(b) 让输入面返回 `Decision | Promise<Decision>` 并在 `hooks/input.ts` 里 `await`。**`tools.guard` 保持同步**，sidecar 不服务同步面。
3. **配置开关**：`engine: { kind: 'builtin' | 'sidecar', command?, args?, timeoutMs?, startTimeoutMs? }`，默认 `builtin`（缺省行为完全不变）。sidecar 不可用时的语义要落到计划 §7 矩阵（建议：`balanced` 记 WARN 并回落 `builtin`；`hardened` 拒绝加载——需要落到 `posture` 与 `failOn`）。
4. **一致性测试**：同一批语料在 `builtin` 与 `sidecar`（用假引擎脚本复刻判定）两条路径上结论一致；真实 Python 的对比测试因语料属内部资产，留本机跑（可 `describe.skipIf(python 不可用)`）。
5. **真机冒烟**：`C:\Python314\python.exe -u scripts/safeharness_sidecar.py`，用它判一条破坏性 SQL（例如删整张表那种）与一次 inform 命中；再在 `safeharness-ga10` 里用 sidecar 模式冷启动。
6. 版本 → `1.2.0`；README 增加"可选 Python 引擎"一节（含 `PYTHONPATH`、Python 版本、fail-closed 语义）；CHANGELOG 写清默认仍是 builtin；然后按 §9.4 发布。

### 11.2 T5.3 客户端 UI 面板（未开始，评估过）

DSH 的 UI 插件是"客户端半包"：包要声明 `dsh.client: { inject: [...], platform: 'web' }`、导出 `./client`、用 `tsdown` 打 React 包、通过 `SlotCore`（`@deepseek-ai/dsh-client-ui-slots`）注册到宿主插槽（声明/注入/store/selector 一整套）。参考包：`profiles/node_modules/@deepseek-ai/dsh-client-ui-*`。**无法在无头环境验证**，只能开浏览器看。工作量按天算，建议在 T5.1 完成后作为独立分支做。

### 11.3 计划外的小缺口（1 小时级，见效快）

桌面端 `seams.settings = false`（`ctx.get('settings')` 为空），所以插件配置**只能在 `cordis.patch.yml` 里改**，设置页看不到。要先查清 desktop 组合里为什么没有 settings 服务（`dsh-settings` / `dsh-settings-file` 包都在 profile 里），再决定是插入服务还是换配置入口。

### 11.4 两个仍待验证的部署项

| 项 | 卡点 | 怎么补 |
|---|---|---|
| 真实钉钉 / 企业微信 / 飞书投递 | 用户暂时拿不到 webhook / access_token | 配一条 `patrol.notify`，把 `patrol.healthUrls` 指向关闭端口制造 FAIL，确认群里收到 `Upear SafeHarness: N FAIL / M WARN` |
| 真实人工审批 | 需要切 `workspace-write` 预设（当前 `danger-full-access` + `approval: never`，路径不可达） | 切预设 → `approval.mode: policy` + `askTools` → 分别点同意/拒绝 → 核对账本 `tool_asked`/`approval_decided` |

### 11.5 其他

- GitHub Release 附件（需 `gh auth login`，见 §9.4 注）。
- npm 发布：计划明确 v1 不发（无 `@upear` scope 权限）；tarball + 本地安装即交付形态。

---

## 12. 已知坑与血泪清单（按踩到的频率排序）

**Windows / PowerShell**

1. **`.NET` 静态调用用的是进程 CWD，不是 PowerShell 当前位置**。`[IO.File]::WriteAllText('package.json', …)` 会写到 `F:\AgentSecurity\Upear\package.json`（仓库根）——这个 0 字节文件会让 pnpm 报 `Invalid package.json in ..\..\package.json`，让 `pnpm build/test` 全挂。**永远用绝对路径**；发现仓库根冒出 `package.json`/`tests/acceptance-m4.test.ts` 之类 0 字节文件，删掉即可（已踩过两次）。
2. `Set-Content -Encoding utf8` 会写 **BOM**，DSH 读 manifest/JSON 会报 `Unexpected token '\ufeff'`。用 `[IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`。
3. 中文内容经 `Get-Content` 管道到控制台可能显示乱码，但**文件本身是 UTF-8**；判断编码问题时用 `Get-Content -Raw` 或读字节，别凭控制台输出下结论。
4. `dsh plugin add` 在应用运行时必 EPERM（插件目录被句柄占用）→ 必须完全退出（含托盘）。失败后 profile 可能留下"删不掉的 rules 目录"，重跑脚本即可。

**DSH / Cordis**

5. `dsh --profile desktop --dump-config` 会拒绝：`desktop` 由 Electron 独占管理。要看组合用别的 profile。
6. patch 里**只写 `id:`** 是配置覆盖，不是挂载；新插件必须 `- insert: [...]`。
7. patch 的 `config:` **替换**该 entry 的整个配置，不深合并（尤其 `llm-pi-ai.providers`）。
8. headless 一次性运行：`dsh <profile> "prompt"`，**位置参数是 profile**；`dsh web` 那套参数别混进来。
9. 辅助模型调用（judge/draft）必须带对应 symbol 标记，否则会被自己的 `llm/stream` 评审（递归）。
10. 热重载后当前会话的工具清单是快照，可能有一轮 `unknown tool`（§7.12）。

**假模型 / 验收**

11. `[[scenario:…]]` 会被 headless 的会话标题请求吃掉 → 用 `--scenario`（服务端默认）。
12. Windows 上没有 `bash` 工具，攻击场景用 `pwsh`；Code Mode 子调用同理。

**构建 / 发布**

13. `pnpm install --frozen-lockfile` 在 CI 里必须过：改 `package.json` 的依赖要同步 lock；宿主包都钉在 `devDependencies`（精确版本），`dependencies` 必须保持 `{}`（`tests/acceptance-m4.test.ts` 断言）。
14. `@deepseek-ai/dsh-invariants` **没有 0.2.x 发布线**，钉 `0.1.0-rc.8`（仅编译期）；`@deepseek-ai/dsh-scope` 必须显式进 devDependencies（已发布的 `dsh-tools` 未声明它，干净 runner 会报找不到）。
15. 公开仓库 CI 的成功标准：`pnpm install --frozen-lockfile && pnpm build && vitest run --exclude tests/perf.test.ts`（约 3–5 分钟）。
16. 发布脚本里的 tarball 版本号最容易忘（1.1.1 就漏改过一次，用户装完还是旧版）。
17. 公开仓库的 `pnpm-lock.yaml` 必须一起提交；`dependencies: {}` 不能省。
18. `git worktree remove` 失败时先 `git worktree prune`，别直接删目录。

**协作纪律**

19. `docs/handoff-*.md` **不要修改**（用户明确要求）。本文按 `handoff-YYYY-MM-DD` 的惯例命名，但首次写入被拦，原因不是路径而是内容（见第 22 条），所以另存为 `docs/safeharness-plugin-handoff-2026-11-11.md`。
20. 只推 `dsh` remote；`origin` 是上游 SafeHarness，勿推。
21. 提交前确认 `git config user.email`；不 `reset/checkout/clean`、不删未知文件、不 `git add` 全量（仓库里常驻别的会话的未跟踪文件：`outputs/`、`docs/deploy-patrol.md`、`src/version.ts`）。
22. **写含破坏性 SQL 字面量的文档/文件会被本插件自己拦掉**（`write` 工具的 args 会被 SQL 规则扫到，实测报 `该操作不被平台安全策略允许`；本文第一版就因此被拦）。要么改写措辞，要么临时把 `tools.mode` 调成 `warn`——这是"误报"的一个现实例子（写文档不等于执行 SQL），值得后续把 SQL 扫描面收敛到"代码/命令类参数"。

---

## 13. 安全纪律（写代码/证据/文档时）

- 账本、日志、错误消息、finding **只许出现哈希与长度**；不许出现用户原文、工具参数原文、webhook URL、token、Key。
- 假模型脚本用哨兵 key（`sk-fake-sentinel`），不得来自真实环境变量。
- `evidence/` 只放本机证据，不入库；提交前 `git status` 自查。
- 真实凭据只在 `$DSH_HOME/.credentials.yaml`；插件只填 provider/model 路由。
- 真实模型调用很便宜但**要记账**：目前总共约 5 次（2 次冒烟 + judge probe + 2 次真实起草），每次几厘；`/safeharness judge probe` 也真的会打一次模型。

---

## 14. 新 agent 第一天自检清单

```powershell
cd F:\AgentSecurity\Upear
git log --oneline -3                       # 期望 HEAD=89b1289（含未发布 sidecar 传输）
git rev-parse dsh/main                     # 期望 8cd0088（公开仓 1.1.1）
cd plugins\dsh-safeharness
pnpm build; pnpm test                      # 期望 28 文件 / 564 全绿
Get-Content C:\Users\xiaojue\.dsh\profiles\desktop\node_modules\@upear\dsh-safeharness\package.json | ConvertFrom-Json | % version   # 期望 1.1.1
Get-Content C:\Users\xiaojue\.dsh\safeharness\audit\ledger.ndjson | Measure-Object | % Count   # 约 800+ 行，链连续
```

在跑着的桌面端会话里（插件已加载）可以直接调：

- `safeharness_status`（版本/预设/规则 hash/模式/账本/judge/预算）
- `safeharness_posture`（9 个 code）
- `safeharness_patrol`（5 项 + 退出码）
- `safeharness_audit_query`（账本尾部，已脱敏）
- `safeharness_draft_rule`（起草一条规则，只返回草稿）

用户侧命令：`/safeharness status | posture | rules | audit [n] | patrol [check…] | judge [probe] | draft <要抓什么> [--chain]`。

---

## 15. 关键命令速查

```powershell
$DSH = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd'

# 构建 / 测试 / 打包
cd F:\AgentSecurity\Upear\plugins\dsh-safeharness
pnpm build; pnpm test; pnpm pack --pack-destination ./dist

# 装到某个 profile（应用需退出，仅 desktop 受限）
& $DSH plugin --profile <profile> add "file:C:/Users/xiaojue/.dsh/plugin-tarballs/upear-dsh-safeharness-1.1.1.tgz"
& $DSH plugin --profile <profile> remove @upear/dsh-safeharness

# 无头跑一轮
& $DSH <profile> --patch <overlay.yml> "prompt"

# 假模型
node plugins/dsh-safeharness/scripts/fake-openai.mjs --port 18080 --scenario text|tool-call-bash|tool-call-patrol|...

# 账本
Get-Content C:\Users\xiaojue\.dsh\safeharness\audit\ledger.ndjson -Tail 20

# 公开仓库 CI
Invoke-RestMethod -Uri 'https://api.github.com/repos/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh/actions/runs?per_page=1' -Headers @{ 'User-Agent'='dsh-agent' }
```

---

## 16. 交接时的一句话总结

**插件本身已经 GA（1.0.0）并迭代到 1.1.1、桌面端在跑、公开仓库 CI 全绿；计划内只剩两个可选项——T5.1 的 Python sidecar（第 1 步传输层已完成、未接线）和 T5.3 的客户端 UI 面板（未开始）。** 接着做就从 `evidence/M5-sidecar.md` §3 的六项任务开始；不想做新功能的话，把 §11.3 的设置面缺口和 §11.4 的两个部署验证补掉，这个项目就"收口"了。
