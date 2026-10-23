"""Deployment posture profiles — named baselines consumed by posture_check.

A profile is data (JSON under ``safeharness/posture_profiles/``), not code:
it names the env additions a launcher should apply, which launcher-generated
secrets to inject, and the worst acceptable finding severity per env (the
baseline). ``posture_check --profile <name>`` loads it here and appends a
FAIL deviation finding wherever the scanned posture is worse than the
baseline demands. Original findings are never modified — deviations are
purely additive, so a profile can only tighten a report, never whitewash it.

Secret discipline: profile JSON references launcher-side secrets by variable
name only (``secrets`` maps env name → launcher secret name). Values are
generated at launch time and never appear in any profile file or report.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from safeharness.posture_check import FAIL, OK, WARN, Finding

PROFILES_DIR_ENV = "SAFEHARNESS_POSTURE_PROFILES_DIR"
PROFILES_PACKAGE_DIR = Path(__file__).resolve().parent / "posture_profiles"

TAG_PROFILE_BASELINE = "Profile 基线偏离（按基线收紧，env 生效方式随底层项）"

_SCHEMA_KEYS = frozenset(
    {"name", "description", "env", "gateway_env", "secrets", "expect", "strict", "gate", "report"}
)
_BOOL_KEYS = ("strict", "gate", "report")
_MAP_KEYS = ("env", "gateway_env", "secrets", "expect")
_SEVERITY_RANK = {OK: 0, WARN: 1, FAIL: 2}


class ProfileError(Exception):
    """Raised when a posture profile is missing, unreadable, or malformed."""


def profile_dir() -> Path:
    override = (os.environ.get(PROFILES_DIR_ENV) or "").strip()
    return Path(override) if override else PROFILES_PACKAGE_DIR


def load_posture_profile(name: str) -> dict[str, Any]:
    base = profile_dir()
    path = base / f"{name}.json"
    if not path.is_file():
        raise ProfileError(f"Profile '{name}' 不存在（查找目录：{base}）")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProfileError(f"Profile '{name}' 读取或解析失败：{exc}") from exc
    _validate(name, data)
    return data


def _validate(name: str, data: Any) -> None:
    if not isinstance(data, dict):
        raise ProfileError(f"Profile '{name}' 顶层必须是 JSON 对象")
    unknown = sorted(set(data) - _SCHEMA_KEYS)
    if unknown:
        raise ProfileError(f"Profile '{name}' 含未知键：{', '.join(unknown)}")
    if data.get("name") != name:
        raise ProfileError(f"Profile '{name}' 内部 name 字段缺失或不一致（{data.get('name')!r}）")
    if not isinstance(data.get("description", ""), str):
        raise ProfileError(f"Profile '{name}' description 必须是字符串")
    for key in _MAP_KEYS:
        value = data.get(key, {})
        if not isinstance(value, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in value.items()
        ):
            raise ProfileError(f"Profile '{name}' 的 {key} 必须是 字符串→字符串 映射")
    bad_expect = sorted(k for k, v in data.get("expect", {}).items() if v not in (OK, WARN))
    if bad_expect:
        raise ProfileError(
            f"Profile '{name}' expect 值只能是 {OK}/{WARN}：{', '.join(bad_expect)}"
        )
    for key in _BOOL_KEYS:
        if not isinstance(data.get(key, False), bool):
            raise ProfileError(f"Profile '{name}' 的 {key} 必须是布尔值")


def baseline_deviations(findings: list[Finding], profile: dict[str, Any]) -> list[Finding]:
    """Return FAIL findings for every baseline env measured worse than allowed.

    An env with no finding at all satisfies its expectation — the checker
    reports gaps, not perfections (e.g. signing material only surfaces when
    missing or placeholder). Purely additive: the input list is untouched,
    each deviation is a new finding tagged with the baseline tag so the
    original evidence and the profile verdict both stay visible.
    """
    out: list[Finding] = []
    for env_name, allowed in (profile.get("expect") or {}).items():
        related = [f for f in findings if env_name in f.envs]
        if not related:
            continue
        worst = max(related, key=lambda f: _SEVERITY_RANK[f.severity])
        if _SEVERITY_RANK[worst.severity] > _SEVERITY_RANK[allowed]:
            out.append(
                Finding(
                    FAIL,
                    TAG_PROFILE_BASELINE,
                    (env_name,),
                    f"基线要求 {allowed}，实测 {worst.severity} —— {worst.message}",
                )
            )
    return out
