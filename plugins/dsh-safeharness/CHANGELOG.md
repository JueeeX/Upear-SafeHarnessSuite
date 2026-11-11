# 变更记录

版本遵循 semver。`1.0.0-rc.1` 起配置字段名冻结；`1.0.0` 起为正式版，新增字段只增不改名。
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
