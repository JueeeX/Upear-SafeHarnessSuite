"""Deployment patrol — one-shot traffic-light report for scheduled ops (P3.1).

Three checks in a single report, designed to be run by an OS scheduler
(Windows Task Scheduler / cron) against a live deployment:

1. ``posture`` — the M11 posture scan (optional ``--profile`` baseline), over
   the process environment or an ``--env-file`` snapshot.
2. ``audit-rate`` — DENY/blocked window counts against preceding baseline
   windows, read read-only from the framework audit table (``audit_records``)
   and/or the platform audit table (``safeharness_audit``). Missing files or
   tables are skipped, never failures.
3. ``health`` — plain GET probes of the deployment's HTTP surfaces. Any HTTP
   answer (including 401/403, which prove the process is alive and enforcing
   auth) counts as up; only timeouts/connection errors/5xx count as down.

Exit codes mirror posture_check: 0 = clean (skips included), 1 = any FAIL
(with ``--strict``: any WARN), 2 = the patrol itself failed to run.

Notify: when ``SAFEHARNESS_PATROL_FEISHU_WEBHOOK`` is set and the report is
not clean, a content-free text message (check names + counts only — no
payloads, no paths, no key material) is POSTed to the Feishu custom-bot
webhook. ``--notify-always`` sends the all-clear too.

    python -m safeharness.deploy_patrol [--format text|json] [--env-file PATH]
        [--profile NAME] [--strict] [--notify-always]
        [--audit-db PATH ...] [--health-url URL ...]
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from safeharness.posture_check import FAIL, OK, WARN, collect_findings
from safeharness.posture_check import _parse_env_file

SKIP = "SKIP"

ENV_FEISHU_WEBHOOK = "SAFEHARNESS_PATROL_FEISHU_WEBHOOK"
ENV_AUDIT_DB = "SAFEHARNESS_AUDIT_DB"
ENV_DATABASE_URL = "DATABASE_URL"
ENV_WINDOW_MINUTES = "SAFEHARNESS_PATROL_AUDIT_WINDOW_MINUTES"
ENV_BASELINE_WINDOWS = "SAFEHARNESS_PATROL_AUDIT_BASELINE_WINDOWS"
ENV_FACTOR = "SAFEHARNESS_PATROL_AUDIT_FACTOR"
ENV_MIN_COUNT = "SAFEHARNESS_PATROL_AUDIT_MIN_COUNT"
ENV_HEALTH_URLS = "SAFEHARNESS_PATROL_HEALTH_URLS"

_AUDIT_TABLES = (
    # (table, timestamp expression, deny predicate, recency order)
    ("audit_records", "occurred_at", "outcome = 'deny'", "audit_id"),
    ("safeharness_audit", "COALESCE(occurred_at, written_at)", "decision_disposition = 'deny'", "id"),
)


def _env_int(env: dict[str, str], name: str, default: int) -> int:
    try:
        return int((env.get(name) or "").strip() or default)
    except ValueError:
        return default


def _env_float(env: dict[str, str], name: str, default: float) -> float:
    try:
        return float((env.get(name) or "").strip() or default)
    except ValueError:
        return default


def default_audit_dbs(env: dict[str, str]) -> list[str]:
    paths: list[str] = []
    explicit = (env.get(ENV_AUDIT_DB) or "").strip()
    if explicit:
        paths.append(explicit)
    database_url = (env.get(ENV_DATABASE_URL) or "").strip()
    if database_url.startswith("sqlite:///") and not database_url.startswith("sqlite:///:memory:"):
        candidate = Path(database_url[len("sqlite:///"):]).parent / "safeharness_audit.db"
        paths.append(str(candidate))
    seen: set[str] = set()
    return [p for p in paths if not (p in seen or seen.add(p))]


def _parse_timestamp(text: str) -> datetime | None:
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


def audit_rate_findings(
    env: dict[str, str], db_paths: list[str]
) -> list[dict]:
    """Count DENY rows per time window; anomaly = recent window far above baseline.

    Purely read-only (``mode=ro``). A window anomaly needs BOTH the factor
    ratio and the absolute floor so a quiet deployment's first blocked probe
    does not page anyone.
    """
    window_minutes = max(1, _env_int(env, ENV_WINDOW_MINUTES, 10))
    baseline_windows = max(1, _env_int(env, ENV_BASELINE_WINDOWS, 6))
    factor = max(1.0, _env_float(env, ENV_FACTOR, 5.0))
    min_count = max(0, _env_int(env, ENV_MIN_COUNT, 10))

    now = datetime.now(timezone.utc)
    recent_start = now - timedelta(minutes=window_minutes)
    span_start = recent_start - timedelta(minutes=window_minutes * baseline_windows)

    out: list[dict] = []
    for db_path in db_paths:
        if not Path(db_path).is_file():
            out.append(_patrol_finding(SKIP, f"audit-rate:{db_path}", "审计库不存在 —— 跳过"))
            continue
        try:
            with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
                tables = {
                    row[0]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                for table, ts_expr, deny_pred, order_col in _AUDIT_TABLES:
                    if table not in tables:
                        out.append(
                            _patrol_finding(SKIP, f"audit-rate:{Path(db_path).name}#{table}", "表不存在 —— 跳过")
                        )
                        continue
                    name = f"audit-rate:{Path(db_path).name}#{table}"
                    try:
                        rows = conn.execute(
                            f"SELECT {ts_expr} FROM {table} WHERE {deny_pred} "
                            f"ORDER BY {order_col} DESC LIMIT 20000"
                        ).fetchall()
                    except sqlite3.Error as exc:
                        out.append(_patrol_finding(WARN, name, f"查询失败（{exc}）—— 跳过"))
                        continue
                    recent = baseline_total = 0
                    for (text,) in rows:
                        ts = _parse_timestamp(str(text))
                        if ts is None:
                            continue
                        if ts > recent_start:
                            recent += 1
                        elif ts > span_start:
                            baseline_total += 1
                    baseline_avg = baseline_total / baseline_windows
                    threshold = max(min_count, factor * baseline_avg)
                    if recent >= threshold and (recent > 0 or min_count == 0):
                        out.append(
                            _patrol_finding(
                                FAIL,
                                name,
                                f"近 {window_minutes} 分钟 DENY 计数 {recent} 超阈值"
                                f"（基线均值 {baseline_avg:.1f}/窗 ×{factor}，下限 {min_count}）",
                            )
                        )
                    else:
                        out.append(
                            _patrol_finding(
                                OK,
                                name,
                                f"近 {window_minutes} 分钟 DENY 计数 {recent}"
                                f"（基线均值 {baseline_avg:.1f}/窗）",
                            )
                        )
        except sqlite3.Error as exc:
            out.append(_patrol_finding(WARN, f"audit-rate:{db_path}", f"库打开失败（{exc}）—— 跳过"))
    return out


def health_probe_findings(env: dict[str, str], urls: list[str]) -> list[dict]:
    out: list[dict] = []
    for url in urls:
        name = f"health:{url}"
        try:
            request = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(request, timeout=5) as resp:
                code = resp.status
        except urllib.error.HTTPError as exc:
            code = exc.code
        except Exception as exc:
            out.append(_patrol_finding(FAIL, name, f"不可达（{type(exc).__name__}）"))
            continue
        if 500 <= code < 600:
            out.append(_patrol_finding(FAIL, name, f"HTTP {code}"))
        else:
            out.append(_patrol_finding(OK, name, f"HTTP {code}（存活）"))
    return out


def _patrol_finding(severity: str, name: str, detail: str) -> dict:
    return {"severity": severity, "check": name, "detail": detail}


def _notify_feishu(webhook: str, text: str) -> None:
    payload = json.dumps({"msg_type": "text", "content": {"text": text}}).encode("utf-8")
    request = urllib.request.Request(
        webhook,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as resp:
        resp.read()


def _render(findings: list[dict]) -> str:
    lines = []
    for finding in findings:
        lines.append(f"[{finding['severity']}] {finding['check']} —— {finding['detail']}")
    counts = {sev: sum(1 for f in findings if f["severity"] == sev) for sev in (FAIL, WARN, OK, SKIP)}
    lines.append(
        f"汇总：{counts[FAIL]} FAIL / {counts[WARN]} WARN / {counts[OK]} OK / {counts[SKIP]} SKIP"
    )
    return "\n".join(lines)


def collect_patrol_findings(
    env: dict[str, str],
    *,
    profile=None,
    audit_dbs: list[str] | None = None,
    health_urls: list[str] | None = None,
    skip_posture: bool = False,
    skip_audit: bool = False,
    skip_health: bool = False,
) -> list[dict]:
    findings: list[dict] = []
    if not skip_posture:
        for finding in collect_findings(env, profile=profile):
            name = "posture:" + ",".join(finding.envs) if finding.envs else "posture"
            findings.append(_patrol_finding(finding.severity, name, finding.message))
    if not skip_audit:
        findings.extend(audit_rate_findings(env, audit_dbs if audit_dbs is not None else []))
    if not skip_health:
        findings.extend(health_probe_findings(env, health_urls or []))
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m safeharness.deploy_patrol",
        description="定时巡检三合一：姿态 + 审计速率 + 健康探针。绝不打印密钥值与 payload 内容。",
    )
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--env-file", default=None, help="从 KEY=VALUE 文件读快照（默认读进程环境）")
    parser.add_argument("--profile", default=None, help="姿态基线 Profile（同 posture_check --profile）")
    parser.add_argument("--strict", action="store_true", help="WARN 也计入失败（退出码 1）")
    parser.add_argument("--audit-db", action="append", default=None, help="审计库路径（可重复；默认取 env）")
    parser.add_argument("--health-url", action="append", default=None, help="健康探针 URL（可重复；默认取 env）")
    parser.add_argument("--skip-posture", action="store_true")
    parser.add_argument("--skip-audit", action="store_true")
    parser.add_argument("--skip-health", action="store_true")
    parser.add_argument("--notify-always", action="store_true", help="全清也发通知（默认仅异常时发）")
    args = parser.parse_args(argv)

    env = dict(os.environ)
    if args.env_file:
        try:
            env = _parse_env_file(args.env_file)
        except OSError as exc:
            print(f"safeharness-deploy-patrol: 无法读取 env 文件：{exc}", file=sys.stderr)
            return 2

    profile = None
    if args.profile:
        from safeharness.posture_profile import ProfileError, load_posture_profile

        try:
            profile = load_posture_profile(args.profile)
        except ProfileError as exc:
            print(f"safeharness-deploy-patrol: {exc}", file=sys.stderr)
            return 2

    audit_dbs = args.audit_db
    if audit_dbs is None:
        audit_dbs = default_audit_dbs(env)
    health_urls = args.health_url
    if health_urls is None:
        health_urls = [u.strip() for u in (env.get(ENV_HEALTH_URLS) or "").split(",") if u.strip()]

    findings = collect_patrol_findings(
        env,
        profile=profile,
        audit_dbs=audit_dbs,
        health_urls=health_urls,
        skip_posture=args.skip_posture,
        skip_audit=args.skip_audit,
        skip_health=args.skip_health,
    )

    fails = sum(1 for f in findings if f["severity"] == FAIL)
    warns = sum(1 for f in findings if f["severity"] == WARN)
    strict = args.strict or bool(profile and profile.get("strict"))

    if args.format == "json":
        print(json.dumps({"findings": findings, "summary": {"fail": fails, "warn": warns}}, ensure_ascii=False, indent=2))
    else:
        print(_render(findings))

    not_clean = bool(fails or (strict and warns))
    if not_clean or args.notify_always:
        webhook = (env.get(ENV_FEISHU_WEBHOOK) or "").strip()
        if webhook:
            text = (
                f"Upear deploy patrol: {fails} FAIL / {warns} WARN"
                + ("" if not_clean else "（全清，--notify-always）")
            )
            try:
                _notify_feishu(webhook, text)
            except Exception as exc:
                print(f"safeharness-deploy-patrol: 通知发送失败：{type(exc).__name__}", file=sys.stderr)

    if fails:
        return 1
    if strict and warns:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
