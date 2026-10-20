"""Deployment posture check — read-only advisory scan of SafeHarness env.

Scans one environment snapshot for the posture gaps a production deployment
commonly misses: security guards left at their default-off position, config
pairs where only one half is set, weak or demo-grade signing material, and
rule directories that would fail closed at load time. Purely advisory — the
checker never mutates anything and exit codes only matter to whoever (or
whatever CI) invokes it.

    python -m safeharness.posture_check [--format text|json] [--env-file PATH] [--strict]

Exit codes: 0 = clean or warnings only; 1 = at least one FAIL (with
``--strict``: any warning counts); 2 = the checker itself failed to run.

Secret discipline: values are never read into the report. Findings name env
vars and state (set/unset, length bucket) — never contents. The checker sees
a single snapshot, so cross-process key pairing (backend vs gateway sharing a
value) is out of scope by construction.

Restart semantics are attached to every finding because envs differ in when
they take effect: ``core.config.settings`` freezes its values at import time
(restart the backend), most guard flags are read per call (next request),
component assemblies need their own process restart, and rule directories
need a restart unless ``SAFEHARNESS_INFORM_RULES_WATCH`` is enabled.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass

FAIL = "FAIL"
WARN = "WARN"
OK = "OK"

_TRUTHY = ("1", "true", "yes")


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in _TRUTHY


def _set(value: str | None) -> bool:
    return bool((value or "").strip())


@dataclass(frozen=True)
class Finding:
    severity: str  # FAIL | WARN | OK
    tag: str  # restart semantics, human-facing
    envs: tuple[str, ...]
    message: str

    def to_dict(self) -> dict:
        return {"severity": self.severity, "tag": self.tag, "envs": list(self.envs), "message": self.message}


TAG_RESTART_BACKEND = "改后需重启后端"
TAG_NEXT_REQUEST = "改后下一条请求生效"
TAG_RESTART_PROCESS = "改后需重启对应进程"
TAG_RULES_DIR = "重启后生效；或开启 SAFEHARNESS_INFORM_RULES_WATCH 热加载"

# Default-off guards: (env, what stays unprotected when unset, restart tag).
# ON yields an [OK] line so a clean posture is visible, not just the gaps.
GUARD_FLAGS = (
    ("SAFEHARNESS_PROTECTED_CHAT_ENABLED", "受保护对话链整体旁路（结构防线+语义 Judge 均不生效）", TAG_RESTART_BACKEND),
    ("SAFEHARNESS_MCP_POLICY_GUARD", "主链工具面无 SafeHarness 策略评估（SqlGuard+轨迹三件套不生效）", TAG_NEXT_REQUEST),
    ("SAFEHARNESS_MCP_DESCRIPTOR_ENFORCE", "MCP 工具描述注入扫描仅告警不剔除", TAG_NEXT_REQUEST),
    ("SAFEHARNESS_TOOL_GATEWAY_DESCRIPTOR_ENFORCE", "网关侧工具描述注入扫描仅告警不剔除", TAG_RESTART_PROCESS),
    ("SAFEHARNESS_EXTERNAL_OUTPUT_GUARD", "外部智能体回复无输出侧语义复查", TAG_NEXT_REQUEST),
    ("SAFEHARNESS_EXTERNAL_OUTPUT_ENFORCE", "输出守卫仅 warn 模式（复查不过仍照常返回回复）", TAG_NEXT_REQUEST),
    ("SAFEHARNESS_AUDIT_REDACTION", "审计账本不脱敏（payload 摘要/键名掩码关闭）", TAG_NEXT_REQUEST),
    ("SAFEHARNESS_INFORM_RULES_WATCH", "文件层规则改动需重启才生效", TAG_RULES_DIR),
    ("MEM0_ENABLED", "跨会话长期记忆关闭（外部智能体仅会话窗记忆）", TAG_RESTART_BACKEND),
)

# Secret-class envs the runtime itself enforces >= 32 chars for. Values are
# never printed — only the length bucket on failure.
SECRET_MIN_LENGTHS = (
    "SAFEHARNESS_TOOL_GATEWAY_API_KEY",
    "SAFEHARNESS_TOOL_GATEWAY_CAPABILITY_KEY",
    "SAFEHARNESS_ENFORCEMENT_RECEIPT_SIGNING_KEY",
    "SAFEHARNESS_ADMIN_UI_ADMIN_KEY",
    "SAFEHARNESS_ADMIN_UI_ACCESS_TOKEN",
    "SAFEHARNESS_ADMIN_UI_MUTATION_KEY",
    "SAFEHARNESS_BFF_ADMIN_UI_MUTATION_KEY",
    "SAFEHARNESS_BFF_ADMIN_UI_ACCESS_TOKEN",
)

DEMO_SIGNING_FALLBACK = "local-demo-only-signing-key-change-before-production"


def _check_guards(env: dict[str, str]) -> list[Finding]:
    out: list[Finding] = []
    for name, gap, tag in GUARD_FLAGS:
        if _truthy(env.get(name)):
            out.append(Finding(OK, tag, (name,), "已开启"))
        else:
            out.append(Finding(WARN, tag, (name,), f"未开启 —— {gap}"))
    # ENFORCE without GUARD is a no-op the operator should know about.
    if _truthy(env.get("SAFEHARNESS_EXTERNAL_OUTPUT_ENFORCE")) and not _truthy(
        env.get("SAFEHARNESS_EXTERNAL_OUTPUT_GUARD")
    ):
        out.append(
            Finding(
                WARN,
                TAG_NEXT_REQUEST,
                ("SAFEHARNESS_EXTERNAL_OUTPUT_ENFORCE", "SAFEHARNESS_EXTERNAL_OUTPUT_GUARD"),
                "ENFORCE 已设但 GUARD 未开 —— enforce 需与 guard 同时开启才生效",
            )
        )
    return out


def _check_pair(
    env: dict[str, str],
    first: str,
    second: str,
    *,
    all_missing: Finding,
    half_set: str,
    tag: str,
) -> list[Finding]:
    a, b = env.get(first), env.get(second)
    if not _set(a) and not _set(b):
        return [all_missing]
    if _set(a) and _set(b):
        return [Finding(OK, tag, (first, second), "配置对完整")]
    return [Finding(FAIL, tag, (first, second), half_set)]


def _check_pairs(env: dict[str, str]) -> list[Finding]:
    out: list[Finding] = []
    out.extend(
        _check_pair(
            env,
            "SAFEHARNESS_TOOL_GATEWAY_URL",
            "SAFEHARNESS_TOOL_GATEWAY_API_KEY",
            all_missing=Finding(
                WARN,
                TAG_NEXT_REQUEST,
                ("SAFEHARNESS_TOOL_GATEWAY_URL", "SAFEHARNESS_TOOL_GATEWAY_API_KEY"),
                "网关未配置 —— 网关工具面不挂载：外部智能体退化为纯推理，受保护链回退本地运行时",
            ),
            half_set="网关配置对只设了一半 —— 客户端无法构建，工具面静默不挂载",
            tag=TAG_NEXT_REQUEST,
        )
    )
    out.extend(
        _check_pair(
            env,
            "SAFEHARNESS_COMMUNICATION_GATEWAY_URL",
            "SAFEHARNESS_COMMUNICATION_ADMIN_API_KEY",
            all_missing=Finding(
                WARN,
                TAG_NEXT_REQUEST,
                ("SAFEHARNESS_COMMUNICATION_GATEWAY_URL", "SAFEHARNESS_COMMUNICATION_ADMIN_API_KEY"),
                "通信网关管理面未配置 —— NOC 委托管理不可用",
            ),
            half_set="通信网关配置对只设了一半 —— 调用时将直接报不可用",
            tag=TAG_NEXT_REQUEST,
        )
    )

    mode = (env.get("SAFEHARNESS_ENFORCEMENT_RECEIPT_MODE") or "").strip().lower()
    signing_key = env.get("SAFEHARNESS_ENFORCEMENT_RECEIPT_SIGNING_KEY")
    if mode == "hmac":
        if _set(signing_key):
            out.append(Finding(OK, TAG_RESTART_PROCESS, ("SAFEHARNESS_ENFORCEMENT_RECEIPT_MODE",), "hmac 回执已配钥"))
        else:
            out.append(
                Finding(
                    FAIL,
                    TAG_RESTART_PROCESS,
                    ("SAFEHARNESS_ENFORCEMENT_RECEIPT_MODE", "SAFEHARNESS_ENFORCEMENT_RECEIPT_SIGNING_KEY"),
                    "MODE=hmac 但签名钥未设 —— 网关将拒绝构建，智能体侧工具面不挂载",
                )
            )
    elif mode == "ed25519":
        key_id = _set(env.get("SAFEHARNESS_ENFORCEMENT_RECEIPT_KEY_ID"))
        private = _set(env.get("SAFEHARNESS_ENFORCEMENT_RECEIPT_PRIVATE_KEY_FILE"))
        public = _set(env.get("SAFEHARNESS_ENFORCEMENT_RECEIPT_PUBLIC_KEY_FILE")) or _set(
            env.get("SAFEHARNESS_ENFORCEMENT_RECEIPT_PUBLIC_KEY_FILES")
        )
        if key_id and private and public:
            out.append(Finding(OK, TAG_RESTART_PROCESS, ("SAFEHARNESS_ENFORCEMENT_RECEIPT_MODE",), "ed25519 回执三件套完整"))
        else:
            out.append(
                Finding(
                    FAIL,
                    TAG_RESTART_PROCESS,
                    ("SAFEHARNESS_ENFORCEMENT_RECEIPT_KEY_ID", "SAFEHARNESS_ENFORCEMENT_RECEIPT_PRIVATE_KEY_FILE", "SAFEHARNESS_ENFORCEMENT_RECEIPT_PUBLIC_KEY_FILE"),
                    "ed25519 模式缺组件（需 KEY_ID + PRIVATE_KEY_FILE + PUBLIC_KEY_FILE(S)）",
                )
            )
    elif mode:
        out.append(
            Finding(
                FAIL,
                TAG_RESTART_PROCESS,
                ("SAFEHARNESS_ENFORCEMENT_RECEIPT_MODE",),
                "不支持的回执模式（运行时只认 hmac / ed25519）",
            )
        )
    else:
        out.append(
            Finding(
                WARN,
                TAG_RESTART_PROCESS,
                ("SAFEHARNESS_ENFORCEMENT_RECEIPT_MODE", "SAFEHARNESS_ENFORCEMENT_RECEIPT_SIGNING_KEY"),
                "回执模式未设（默认 hmac 无钥 = 签发/校验返回 None，网关将拒绝构建）",
            )
        )

    upstream = env.get("SAFEHARNESS_ADMIN_UI_UPSTREAM_URL")
    if _set(upstream):
        missing = [
            name
            for name in (
                "SAFEHARNESS_ADMIN_UI_ADMIN_KEY",
                "SAFEHARNESS_ADMIN_UI_ACCESS_TOKEN",
                "SAFEHARNESS_ADMIN_UI_MUTATION_KEY",
            )
            if not _set(env.get(name))
        ]
        if missing:
            out.append(
                Finding(FAIL, TAG_RESTART_PROCESS, tuple(missing), "Admin UI 已配上游但密钥对不完整 —— 管理面变更将失败")
            )
        else:
            out.append(Finding(OK, TAG_RESTART_PROCESS, ("SAFEHARNESS_ADMIN_UI_UPSTREAM_URL",), "Admin UI 配置对完整"))

    bff_url = env.get("SAFEHARNESS_BFF_ADMIN_UI_URL")
    if _set(bff_url):
        missing = [
            name
            for name in ("SAFEHARNESS_BFF_ADMIN_UI_ACCESS_TOKEN", "SAFEHARNESS_BFF_ADMIN_UI_MUTATION_KEY")
            if not _set(env.get(name))
        ]
        if missing:
            out.append(Finding(FAIL, TAG_RESTART_BACKEND, tuple(missing), "BFF 已配 Admin UI 地址但令牌对不完整"))
        else:
            out.append(Finding(OK, TAG_RESTART_BACKEND, ("SAFEHARNESS_BFF_ADMIN_UI_URL",), "BFF→Admin UI 配置对完整"))
    return out


def _check_strength(env: dict[str, str]) -> list[Finding]:
    out: list[Finding] = []
    for name in SECRET_MIN_LENGTHS:
        value = env.get(name)
        if _set(value) and len(value.strip()) < 32:
            out.append(
                Finding(
                    FAIL,
                    TAG_RESTART_PROCESS,
                    (name,),
                    f"密钥强度不足（长度 {len(value.strip())} < 32，运行时自身强制 ≥32）",
                )
            )
    return out


def _check_weak_material(env: dict[str, str]) -> list[Finding]:
    out: list[Finding] = []
    demo_key = env.get("SAFEHARNESS_DEMO_SIGNING_KEY")
    if not _set(demo_key):
        out.append(
            Finding(
                WARN,
                TAG_NEXT_REQUEST,
                ("SAFEHARNESS_DEMO_SIGNING_KEY",),
                "未设 —— 能力签名静默回落硬编码演示材料（生产部署必须设置）",
            )
        )
    embed_key = (env.get("MEM0_EMBED_API_KEY") or "").strip()
    if embed_key == "sk-placeholder":
        out.append(
            Finding(
                WARN,
                TAG_RESTART_BACKEND,
                ("MEM0_EMBED_API_KEY",),
                "仍为占位符值 —— 嵌入供应商未真正配置（mem0 召回闭环不可用）",
            )
        )
    return out


def _check_paths(env: dict[str, str]) -> list[Finding]:
    out: list[Finding] = []
    rules_dir = env.get("SAFEHARNESS_INFORM_RULES_DIR")
    if _set(rules_dir) and not os.path.isdir(rules_dir):
        out.append(
            Finding(
                FAIL,
                TAG_RULES_DIR,
                ("SAFEHARNESS_INFORM_RULES_DIR",),
                "规则目录不存在 —— 运行时加载将 fail-closed（RuleLoadError）",
            )
        )
    elif _set(rules_dir):
        out.append(Finding(OK, TAG_RULES_DIR, ("SAFEHARNESS_INFORM_RULES_DIR",), "规则目录存在"))
    return out


def collect_findings(env: dict[str, str]) -> list[Finding]:
    findings: list[Finding] = []
    findings.extend(_check_guards(env))
    findings.extend(_check_pairs(env))
    findings.extend(_check_strength(env))
    findings.extend(_check_weak_material(env))
    findings.extend(_check_paths(env))
    return findings


def _parse_env_file(path: str) -> dict[str, str]:
    """dotenv-lite: KEY=VALUE lines; comments/blanks/export prefixes ignored."""
    values: dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            if key:
                values[key] = value
    return values


def _render_text(findings: list[Finding]) -> str:
    lines = []
    for finding in findings:
        envs = ",".join(finding.envs)
        lines.append(f"[{finding.severity}] {envs} —— {finding.message} [{finding.tag}]")
    fails = sum(1 for f in findings if f.severity == FAIL)
    warns = sum(1 for f in findings if f.severity == WARN)
    oks = sum(1 for f in findings if f.severity == OK)
    lines.append(f"汇总：{fails} FAIL / {warns} WARN / {oks} OK")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m safeharness.posture_check",
        description="只读建议性检查：扫描 SafeHarness 守卫开关与配置对姿态。绝不打印任何密钥值。",
    )
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--env-file", default=None, help="从 KEY=VALUE 文件读快照（默认读进程环境）")
    parser.add_argument("--strict", action="store_true", help="WARN 也计入失败（退出码 1）")
    args = parser.parse_args(argv)

    try:
        env = _parse_env_file(args.env_file) if args.env_file else dict(os.environ)
    except OSError as exc:
        print(f"safeharness-posture-check: 无法读取 env 文件：{exc}", file=sys.stderr)
        return 2

    findings = collect_findings(env)
    fails = sum(1 for f in findings if f.severity == FAIL)
    warns = sum(1 for f in findings if f.severity == WARN)

    if args.format == "json":
        print(
            json.dumps(
                {
                    "findings": [f.to_dict() for f in findings],
                    "summary": {"fail": fails, "warn": warns, "ok": len(findings) - fails - warns},
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(_render_text(findings))

    if fails:
        return 1
    if args.strict and warns:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
