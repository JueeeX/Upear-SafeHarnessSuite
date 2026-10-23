"""Posture check CLI — advisory, read-only, never prints secret values.

Contract: exit 0 clean/warn-only, 1 on any FAIL (with --strict: any WARN),
2 on its own operational errors; --env-file swaps the snapshot; every output
line names env vars and states, never contents.
"""

from __future__ import annotations

import json

from safeharness import posture_check
from safeharness.posture_check import FAIL, OK, WARN, collect_findings, main

SECRET = "s3cret-value-must-never-appear-anywhere-0123456789"


def _clean_env(monkeypatch):
    """Strip every env the checker looks at so tests start from a blank slate."""
    for finding in collect_findings({}):
        for name in finding.envs:
            monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("SAFEHARNESS_DEMO_SIGNING_KEY", raising=False)
    monkeypatch.delenv("MEM0_EMBED_API_KEY", raising=False)


def test_blank_snapshot_has_no_fail_only_warnings(monkeypatch, capsys):
    _clean_env(monkeypatch)
    findings = collect_findings({})
    assert all(f.severity in (WARN, OK) for f in findings)
    assert any(f.envs == ("SAFEHARNESS_PROTECTED_CHAT_ENABLED",) and f.severity == WARN for f in findings)


def test_guard_on_yields_ok(monkeypatch):
    _clean_env(monkeypatch)
    findings = collect_findings({"SAFEHARNESS_PROTECTED_CHAT_ENABLED": "1"})
    match = [f for f in findings if f.envs == ("SAFEHARNESS_PROTECTED_CHAT_ENABLED",)]
    assert match and match[0].severity == OK


def test_gateway_pair_half_set_is_fail(monkeypatch):
    _clean_env(monkeypatch)
    findings = collect_findings({"SAFEHARNESS_TOOL_GATEWAY_URL": "http://127.0.0.1:38310"})
    match = [f for f in findings if "SAFEHARNESS_TOOL_GATEWAY_API_KEY" in f.envs]
    assert match and match[0].severity == FAIL


def test_gateway_pair_complete_is_ok(monkeypatch):
    _clean_env(monkeypatch)
    findings = collect_findings(
        {
            "SAFEHARNESS_TOOL_GATEWAY_URL": "http://127.0.0.1:38310",
            "SAFEHARNESS_TOOL_GATEWAY_API_KEY": "a" * 32,
        }
    )
    match = [f for f in findings if f.envs == ("SAFEHARNESS_TOOL_GATEWAY_URL", "SAFEHARNESS_TOOL_GATEWAY_API_KEY")]
    assert match and match[0].severity == OK


def test_hmac_mode_without_signing_key_is_fail():
    findings = collect_findings({"SAFEHARNESS_ENFORCEMENT_RECEIPT_MODE": "hmac"})
    match = [f for f in findings if "SAFEHARNESS_ENFORCEMENT_RECEIPT_SIGNING_KEY" in f.envs]
    assert match and match[0].severity == FAIL


def test_short_secret_is_fail_and_value_never_printed(monkeypatch, capsys):
    _clean_env(monkeypatch)
    monkeypatch.setenv("SAFEHARNESS_TOOL_GATEWAY_API_KEY", "short")
    assert main([]) == 1
    out = capsys.readouterr().out
    assert "short" not in out
    assert "SAFEHARNESS_TOOL_GATEWAY_API_KEY" in out
    match = [f for f in collect_findings({"SAFEHARNESS_TOOL_GATEWAY_API_KEY": "short"}) if f.severity == FAIL]
    assert match


def test_long_secret_never_leaks_into_output(monkeypatch, capsys):
    _clean_env(monkeypatch)
    monkeypatch.setenv("SAFEHARNESS_TOOL_GATEWAY_API_KEY", SECRET)
    monkeypatch.setenv("SAFEHARNESS_TOOL_GATEWAY_URL", "http://127.0.0.1:38310")
    assert main([]) == 0
    assert SECRET not in capsys.readouterr().out


def test_json_format_parses_and_hides_values(monkeypatch, capsys):
    _clean_env(monkeypatch)
    monkeypatch.setenv("SAFEHARNESS_ENFORCEMENT_RECEIPT_MODE", "hmac")
    monkeypatch.setenv("SAFEHARNESS_ENFORCEMENT_RECEIPT_SIGNING_KEY", "too-short")
    assert main(["--format", "json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["summary"]["fail"] >= 1
    assert SECRET not in json.dumps(payload)
    assert "too-short" not in json.dumps(payload)
    assert all(set(item) == {"severity", "tag", "envs", "message"} for item in payload["findings"])


def test_strict_mode_fails_on_warnings_only(monkeypatch):
    _clean_env(monkeypatch)
    # Blank snapshot: warnings only.
    assert main([]) == 0
    assert main(["--strict"]) == 1


def test_env_file_snapshot(monkeypatch, capsys, tmp_path):
    _clean_env(monkeypatch)
    env_file = tmp_path / "deployment.env"
    env_file.write_text(
        "# comment\n"
        "export SAFEHARNESS_PROTECTED_CHAT_ENABLED='1'\n"
        "SAFEHARNESS_TOOL_GATEWAY_URL=http://127.0.0.1:38310\n"
        "SAFEHARNESS_TOOL_GATEWAY_API_KEY=a-key-that-is-long-enough-32chars!\n",
        encoding="utf-8",
    )
    assert main(["--env-file", str(env_file)]) == 0
    out = capsys.readouterr().out
    assert "[OK] SAFEHARNESS_PROTECTED_CHAT_ENABLED" in out
    # Snapshot isolation: the same scan without the file (process env, unset)
    # still reports the guard as off.
    assert main([]) == 0
    out_live = capsys.readouterr().out
    assert "[WARN] SAFEHARNESS_PROTECTED_CHAT_ENABLED" in out_live


def test_env_file_missing_is_exit_two(capsys, tmp_path):
    assert main(["--env-file", str(tmp_path / "nope.env")]) == 2


def test_demo_signing_fallback_and_placeholder_embed_key():
    findings = collect_findings({"MEM0_EMBED_API_KEY": "sk-placeholder"})
    envs = {name for f in findings for name in f.envs}
    assert "SAFEHARNESS_DEMO_SIGNING_KEY" in envs
    assert "MEM0_EMBED_API_KEY" in envs
    # A real embed key silences the placeholder finding.
    envs2 = {name for f in collect_findings({"MEM0_EMBED_API_KEY": "sk-real"}) for name in f.envs}
    assert "MEM0_EMBED_API_KEY" not in envs2


def test_severities_are_the_defined_three():
    findings = collect_findings({})
    assert {f.severity for f in findings} <= {FAIL, WARN, OK}


def test_bff_pair_uses_runtime_env_names():
    # settings.py consumes SAFEHARNESS_BFF_UI_ACCESS_TOKEN / SAFEHARNESS_BFF_MUTATION_KEY.
    complete = collect_findings(
        {
            "SAFEHARNESS_BFF_ADMIN_UI_URL": "http://127.0.0.1:38308",
            "SAFEHARNESS_BFF_UI_ACCESS_TOKEN": "token-value-at-least-32-chars-long!",
            "SAFEHARNESS_BFF_MUTATION_KEY": "mutation-value-at-least-32-chars-long!",
        }
    )
    bff = [f for f in complete if "SAFEHARNESS_BFF_ADMIN_UI_URL" in f.envs]
    assert bff and bff[0].severity == OK

    incomplete = collect_findings({"SAFEHARNESS_BFF_ADMIN_UI_URL": "http://127.0.0.1:38308"})
    bff = [f for f in incomplete if "SAFEHARNESS_BFF_MUTATION_KEY" in f.envs]
    assert bff and bff[0].severity == FAIL
    assert set(bff[0].envs) == {"SAFEHARNESS_BFF_UI_ACCESS_TOKEN", "SAFEHARNESS_BFF_MUTATION_KEY"}
