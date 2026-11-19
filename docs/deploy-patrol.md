# deploy_patrol 部署巡检（P3.1 内部文档）

`python -m safeharness.deploy_patrol` —— 姿态 + 审计速率 + 健康探针三合一定时巡检。
exit 0 清 / 1 异常 / 2 自身错误。绝不上报密钥值与 payload 内容。

## 常用命令

```powershell
# 全检（姿态用进程 env；审计库自动猜 SAFEHARNESS_AUDIT_DB / DATABASE_URL 同目录）
$py -m safeharness.deploy_patrol --format json

# 部署 env 快照驱动（推荐：与部署同源）
$py -m safeharness.deploy_patrol --env-file C:\deploy\upear.env

# 指定健康探针与审计库
$py -m safeharness.deploy_patrol --health-url http://127.0.0.1:3001/ready `
    --health-url http://127.0.0.1:38308/health `
    --audit-db D:\data\safeharness_audit.db
```

## 关键 env（全有默认）

| env | 默认 | 说明 |
|---|---|---|
| `SAFEHARNESS_PATROL_FEISHU_WEBHOOK` | 未设 | 飞书自定义机器人 webhook；设了且异常才发（`--notify-always` 全清也发） |
| `SAFEHARNESS_PATROL_HEALTH_URLS` | 空 | 逗号分隔探针 URL（也可 `--health-url` 重复给） |
| `SAFEHARNESS_PATROL_AUDIT_WINDOW_MINUTES` | 10 | 近窗长度 |
| `SAFEHARNESS_PATROL_AUDIT_BASELINE_WINDOWS` | 6 | 基线窗数 |
| `SAFEHARNESS_PATROL_AUDIT_FACTOR` | 5.0 | 异常倍率 |
| `SAFEHARNESS_PATROL_AUDIT_MIN_COUNT` | 10 | 绝对下限（双条件防误报） |

## Windows 计划任务样板（每 15 分钟）

```powershell
$action  = New-ScheduledTaskAction -Execute 'C:\path\python.exe' `
    -Argument '-m safeharness.deploy_patrol --env-file C:\deploy\upear.env' `
    -WorkingDirectory 'F:\AgentSecurity\Upear'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'Upear-DeployPatrol' -Action $action -Trigger $trigger
```

## 检查口径

- **posture**：复用 M11 `collect_findings`（可 `--profile` 基线）；FAIL/WARN 照姿态语义
- **audit-rate**：只读 `mode=ro` 打开审计库；框架表 `audit_records`（outcome='deny'）+ 平台表
  `safeharness_audit`（decision_disposition='deny'）；近窗计数 ≥ max(下限, 倍率×基线均值) → FAIL；
  库/表缺失 → SKIP 不算失败
- **health**：任意 HTTP 响应（含 401/403，证明进程活且在鉴权）= 存活；超时/拒连/5xx = FAIL
