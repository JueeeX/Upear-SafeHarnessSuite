# SafeHarness for DeepSeek Harness

> 版本 `1.21.0` · 宿主 DSH `0.2.2-rc.5`（兼容 `0.2.2-rc.3`）· Node ≥ 24 · 运行时零第三方依赖 · Apache-2.0

DSH 的智能体安全插件：输入防线、工具调用管控、工具结果守卫（凭据 / 注入 / PII）、输出复查、语义 judge、审批桥、审计账本、姿态自检与外部巡检，以一个 profile 级 Cordis 插件包交付。

**安装**（装完即挂载）：`& $dsh plugin --profile <profile> add "file:<path>\upear-dsh-safeharness-1.21.0.tgz"`
**面板**：插件 → `@upear/dsh-safeharness` —— 概览 / 事件 / 规则 / 巡检 / 设置

**完整文档（GitHub）**

- 手册：https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh/blob/main/MANUAL.md
- 变更：https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh/blob/main/CHANGELOG.md
- 示例 patch：https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh/tree/main/examples

**安全边界**：插件运行在 DSH 进程内，能停用它的操作者也能绕过它；账本只保证「脱敏且可校验完整」，不保证「不可删除」。详见手册 §11。
