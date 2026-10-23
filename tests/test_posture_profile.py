"""Profile baseline behaviour: --profile loading, deviations, strict/gate data.

P2.1. In-process only, mirroring test_posture_check.py house style: direct
``collect_findings`` calls for finding-level assertions, ``main([...])``
return values for exit-code assertions, ``capsys`` for output/leak checks,
``tmp_path`` + ``SAFEHARNESS_POSTURE_PROFILES_DIR`` for custom profiles.
"""

from __future__ import annotations

import json

import pytest

from safeharness.posture_check import FAIL, OK, WARN, GUARD_FLAGS, collect_findings, main
from safeharness.posture_profile import (
    PROFILES_DIR_ENV,
    TAG_PROFILE_BASELINE,
    ProfileError,
    load_posture_profile,
)

GUARD = "SAFEHARNESS_MCP_POLICY_GUARD"
DEMO_KEY = "SAFEHARNESS_DEMO_SIGNING_KEY"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    seen = set()
    for finding in collect_findings({}):
        seen.update(finding.envs)
    seen.add(PROFILES_DIR_ENV)
    for name in seen:
        monkeypatch.delenv(name, raising=False)


def _write_profile(tmp_path, name: str, payload: dict):
    base = tmp_path / "profiles"
    base.mkdir(exist_ok=True)
    (base / f"{name}.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return base


def _deviations(findings):
    return [f for f in findings if f.tag == TAG_PROFILE_BASELINE]


def test_demo_profile_is_pure_passthrough():
    env = {GUARD: "1", DEMO_KEY: "x" * 40}
    plain = collect_findings(env)
    demo = collect_findings(env, profile=load_posture_profile("demo"))
    assert [f.to_dict() for f in demo] == [f.to_dict() for f in plain]


def test_hardened_deviation_appended_when_guard_off():
    findings = collect_findings({}, profile=load_posture_profile("hardened"))
    original = [f for f in findings if f.tag != TAG_PROFILE_BASELINE and GUARD in f.envs]
    assert original and original[0].severity == WARN
    deviating = [f for f in _deviations(findings) if f.envs == (GUARD,)]
    assert deviating and deviating[0].severity == FAIL
    assert "基线要求 OK" in deviating[0].message and "实测 WARN" in deviating[0].message


def test_hardened_compliant_env_has_no_deviations():
    env = {name: "1" for name, _, _ in GUARD_FLAGS}
    env[DEMO_KEY] = "x" * 40
    findings = collect_findings(env, profile=load_posture_profile("hardened"))
    assert _deviations(findings) == []


def test_baseline_allows_warn_when_expected_warn(tmp_path, monkeypatch):
    base = _write_profile(tmp_path, "warn-ok", {"name": "warn-ok", "expect": {GUARD: "WARN"}})
    monkeypatch.setenv(PROFILES_DIR_ENV, str(base))
    findings = collect_findings({}, profile=load_posture_profile("warn-ok"))
    assert _deviations(findings) == []


def test_baseline_satisfied_when_env_has_no_finding(tmp_path, monkeypatch):
    """Silence satisfies: e.g. signing material set correctly emits no finding."""
    base = _write_profile(
        tmp_path, "quiet", {"name": "quiet", "expect": {"SAFEHARNESS_DEMO_SIGNING_KEY": "OK"}}
    )
    monkeypatch.setenv(PROFILES_DIR_ENV, str(base))
    env = {"SAFEHARNESS_DEMO_SIGNING_KEY": "x" * 40}
    findings = collect_findings(env, profile=load_posture_profile("quiet"))
    assert _deviations(findings) == []


def test_original_findings_never_mutated():
    env = {DEMO_KEY: "x" * 40}
    plain = collect_findings(env)
    profiled = collect_findings(env, profile=load_posture_profile("hardened"))
    assert len(profiled) > len(plain)
    assert [f.to_dict() for f in profiled[: len(plain)]] == [f.to_dict() for f in plain]


def test_packaged_trio_loads():
    demo = load_posture_profile("demo")
    hardened = load_posture_profile("hardened")
    production = load_posture_profile("production")
    assert demo["expect"] == {} and not demo["gate"] and not demo["strict"]
    assert hardened["name"] == "hardened" and hardened["expect"]
    assert production["strict"] and production["gate"]
    assert set(production["secrets"].values()) <= {"demoSigningKey", "coordinationAdminKey"}


def test_unknown_name_raises_with_search_dir():
    with pytest.raises(ProfileError) as excinfo:
        load_posture_profile("no-such-profile")
    assert "查找目录" in str(excinfo.value)


def test_malformed_json_raises(tmp_path, monkeypatch):
    base = tmp_path / "profiles"
    base.mkdir()
    (base / "broken.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setenv(PROFILES_DIR_ENV, str(base))
    with pytest.raises(ProfileError, match="读取或解析失败"):
        load_posture_profile("broken")


def test_unknown_schema_key_rejected(tmp_path, monkeypatch):
    base = _write_profile(tmp_path, "extra", {"name": "extra", "surprise": True})
    monkeypatch.setenv(PROFILES_DIR_ENV, str(base))
    with pytest.raises(ProfileError, match="未知键"):
        load_posture_profile("extra")


def test_name_mismatch_rejected(tmp_path, monkeypatch):
    base = _write_profile(tmp_path, "outer", {"name": "inner"})
    monkeypatch.setenv(PROFILES_DIR_ENV, str(base))
    with pytest.raises(ProfileError, match="不一致"):
        load_posture_profile("outer")


def test_profiles_dir_override_replaces_package_dir(tmp_path, monkeypatch):
    base = _write_profile(tmp_path, "solo", {"name": "solo"})
    monkeypatch.setenv(PROFILES_DIR_ENV, str(base))
    assert load_posture_profile("solo")["name"] == "solo"
    with pytest.raises(ProfileError):
        load_posture_profile("demo")


def test_main_profile_deviation_exit_1():
    assert main(["--profile", "hardened"]) == 1


def test_main_profile_compliant_exit_0(monkeypatch):
    for name, _, _ in GUARD_FLAGS:
        monkeypatch.setenv(name, "1")
    monkeypatch.setenv(DEMO_KEY, "x" * 40)
    assert main(["--profile", "hardened"]) == 0


def test_main_unknown_profile_exit_2(capsys):
    assert main(["--profile", "no-such-profile"]) == 2
    assert "no-such-profile" in capsys.readouterr().err


def test_main_json_reports_profile_field(capsys):
    assert main(["--format", "json", "--profile", "demo"]) == 0
    summary = json.loads(capsys.readouterr().out)["summary"]
    assert summary["profile"] == "demo"
    assert main(["--format", "json"]) == 0
    summary = json.loads(capsys.readouterr().out)["summary"]
    assert summary["profile"] is None


def test_profile_strict_implies_strict_semantics(tmp_path, monkeypatch):
    base = _write_profile(tmp_path, "strictdemo", {"name": "strictdemo", "strict": True})
    monkeypatch.setenv(PROFILES_DIR_ENV, str(base))
    monkeypatch.setenv(GUARD, "1")  # one guard on; the rest stay off → warns, no fails
    assert main(["--profile", "strictdemo"]) == 1


def test_deviation_report_leaks_no_secret_values(monkeypatch, capsys):
    monkeypatch.setenv(DEMO_KEY, "sk-blev-secret-sentinel")
    assert main(["--format", "text", "--profile", "hardened"]) == 1
    out = capsys.readouterr().out
    assert "sk-blev" not in out
    assert "sentinel" not in out
