"""P3.1 red-light trio: gated health detail + deploy_patrol checks.

House style: in-process, direct application-level calls for health detail,
main([...]) return values for patrol exit codes, tmp sqlite for audit-rate
seeding, ThreadingHTTPServer for probe/webhook targets, monkeypatch for env.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from safeharness.communication.service import AgentCommunicationApplication
from safeharness.deploy_patrol import (
    FAIL,
    OK,
    SKIP,
    audit_rate_findings,
    collect_patrol_findings,
    default_audit_dbs,
    health_probe_findings,
    main,
)
from safeharness.gateway.service import ToolGatewayApplication, ToolRegistry
from safeharness.health_detail import ENV_HEALTH_DETAIL


def _detail_env(monkeypatch, value: str = "1") -> None:
    if value is None:
        monkeypatch.delenv(ENV_HEALTH_DETAIL, raising=False)
    else:
        monkeypatch.setenv(ENV_HEALTH_DETAIL, value)


class _FakeStore:
    def __init__(self, ok: bool = True) -> None:
        self.ok = ok

    async def health(self) -> bool:
        return self.ok


class _FakeControlPlane:
    def __init__(self, state_store=None) -> None:
        self.state_store = state_store


class _FakeStateStore:
    def __init__(self, ok: bool = True) -> None:
        self.ok = ok

    def health(self) -> bool:
        return self.ok


class _FakeAuditSink:
    def __init__(self, ok: bool = True) -> None:
        self.ok = ok

    async def health(self) -> bool:
        return self.ok


def _comm_application(store, control_plane) -> AgentCommunicationApplication:
    return AgentCommunicationApplication(control_plane=control_plane, store=store)


def _tool_application(audit_sink=None, readiness=()) -> ToolGatewayApplication:
    return ToolGatewayApplication(
        registry=ToolRegistry(),
        capability_gateway=object(),
        audit_sink=audit_sink,
        readiness_checks=readiness,
    )


def test_communication_health_default_has_no_components(monkeypatch):
    _detail_env(monkeypatch, None)
    app = _comm_application(_FakeStore(), _FakeControlPlane(_FakeStateStore()))
    status, payload = asyncio.run(app.health())
    assert status == 200
    assert "components" not in payload
    assert payload["status"] == "ready"


def test_communication_health_detail_lists_components(monkeypatch):
    _detail_env(monkeypatch, "1")
    app = _comm_application(
        _FakeStore(),
        _FakeControlPlane(_FakeStateStore()),
    )
    status, payload = asyncio.run(app.health())
    assert status == 200
    assert payload["components"] == {"message_store": True, "state_store": True}


def test_communication_health_store_failure_still_not_ready(monkeypatch):
    _detail_env(monkeypatch, "1")
    app = _comm_application(_FakeStore(ok=False), _FakeControlPlane())
    status, payload = asyncio.run(app.health())
    assert status == 503
    assert payload["ok"] is False


def test_tool_gateway_health_default_has_no_components(monkeypatch):
    _detail_env(monkeypatch, None)
    app = _tool_application(audit_sink=_FakeAuditSink(), readiness=[lambda: True])
    status, payload = asyncio.run(app.health())
    assert status == 200
    assert "components" not in payload


def test_tool_gateway_health_detail_reports_components(monkeypatch):
    _detail_env(monkeypatch, "1")
    app = _tool_application(audit_sink=_FakeAuditSink(), readiness=[lambda: True, lambda: "yes"])
    status, payload = asyncio.run(app.health())
    assert status == 200
    assert payload["components"] == {
        "readiness_0": True,
        "readiness_1": True,
        "receipt_verifier": False,
        "audit_sink": True,
    }


def test_admin_ui_health_endpoint(monkeypatch):
    from safeharness.admin_ui import AdminUISettings, create_admin_ui_server

    _detail_env(monkeypatch, None)
    server = create_admin_ui_server(AdminUISettings(), host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/health"
        with urllib.request.urlopen(url, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
        assert response.status == 200
        assert payload == {"ok": True, "service": "safeharness-admin-ui", "upstream_configured": False}
    finally:
        server.shutdown()
        thread.join(timeout=3)


def _seed_audit_db(path: Path, recent: int, baseline: int, now: datetime) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE audit_records (audit_id INTEGER PRIMARY KEY, occurred_at TEXT, outcome TEXT)"
        )
        conn.execute(
            "CREATE TABLE safeharness_audit (id INTEGER PRIMARY KEY, occurred_at TEXT, written_at TEXT, decision_disposition TEXT)"
        )

        def iso(minutes_ago: float) -> str:
            return (now - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")

        for index in range(recent):
            conn.execute(
                "INSERT INTO audit_records (occurred_at, outcome) VALUES (?, 'deny')",
                (iso(1 + index * 0.1),),
            )
        for index in range(baseline):
            conn.execute(
                "INSERT INTO safeharness_audit (written_at, decision_disposition) VALUES (?, 'deny')",
                (iso(15 + index * 8),),
            )
        conn.execute(
            "INSERT INTO audit_records (occurred_at, outcome) VALUES (?, 'allow')",
            (iso(0.5),),
        )


_PATROL_ENV = {
    "SAFEHARNESS_PATROL_AUDIT_WINDOW_MINUTES": "10",
    "SAFEHARNESS_PATROL_AUDIT_BASELINE_WINDOWS": "6",
    "SAFEHARNESS_PATROL_AUDIT_FACTOR": "1",
    "SAFEHARNESS_PATROL_AUDIT_MIN_COUNT": "3",
}


def test_audit_rate_clean_and_anomaly(tmp_path):
    now = datetime.now(timezone.utc)
    clean_db = tmp_path / "clean.db"
    _seed_audit_db(clean_db, recent=1, baseline=2, now=now)
    findings = audit_rate_findings(_PATROL_ENV, [str(clean_db)])
    by_table = {f["check"].split("#")[-1]: f for f in findings}
    assert by_table["audit_records"]["severity"] == OK
    assert "计数 1" in by_table["audit_records"]["detail"]

    loud_db = tmp_path / "loud.db"
    _seed_audit_db(loud_db, recent=5, baseline=2, now=now)
    findings = audit_rate_findings(_PATROL_ENV, [str(loud_db)])
    by_table = {f["check"].split("#")[-1]: f for f in findings}
    assert by_table["audit_records"]["severity"] == FAIL
    assert by_table["safeharness_audit"]["severity"] == OK


def test_audit_rate_missing_file_is_skip(tmp_path):
    findings = audit_rate_findings(_PATROL_ENV, [str(tmp_path / "absent.db")])
    assert findings and findings[0]["severity"] == SKIP


def test_audit_rate_missing_table_is_skip(tmp_path):
    db = tmp_path / "other.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE unrelated (x INTEGER)")
    findings = audit_rate_findings(_PATROL_ENV, [str(db)])
    assert findings and all(f["severity"] == SKIP for f in findings)


def test_default_audit_dbs_from_env():
    env = {
        "SAFEHARNESS_AUDIT_DB": "F:/tmp/one.db",
        "DATABASE_URL": "sqlite:///F:/tmp/data/sumc.db",
    }
    result = default_audit_dbs(env)
    assert result[0] == "F:/tmp/one.db"
    assert Path(result[1]) == Path("F:/tmp/data/safeharness_audit.db")
    assert default_audit_dbs({"DATABASE_URL": "sqlite:///:memory:"}) == []


class _ProbeHandler(BaseHTTPRequestHandler):
    status_code = 200

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        self.send_response(self.status_code)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args) -> None:  # silence
        pass


def _running_probe_server(status_code: int):
    handler = type("Handler", (_ProbeHandler,), {"status_code": status_code})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/health"


def test_health_probes_up_down_and_auth_required():
    server200, url200 = _running_probe_server(200)
    server500, url500 = _running_probe_server(500)
    try:
        findings = health_probe_findings({}, [url200, url500])
        assert findings[0]["severity"] == OK and "200" in findings[0]["detail"]
        assert findings[1]["severity"] == FAIL and "500" in findings[1]["detail"]

        dead = health_probe_findings({}, ["http://127.0.0.1:1/nope"])
        assert dead[0]["severity"] == FAIL

        auth_server, auth_url = _running_probe_server(401)
        try:
            findings = health_probe_findings({}, [auth_url])
            assert findings[0]["severity"] == OK
        finally:
            auth_server.shutdown()
    finally:
        server200.shutdown()
        server500.shutdown()


def test_collect_patrol_maps_posture_findings(monkeypatch):
    monkeypatch.delenv("SAFEHARNESS_PROTECTED_CHAT_ENABLED", raising=False)
    findings = collect_patrol_findings(
        {}, audit_dbs=[], health_urls=[], skip_audit=True, skip_health=True
    )
    assert findings
    assert all(f["check"].startswith("posture:") for f in findings)
    assert {f["severity"] for f in findings} <= {"OK", "WARN", "FAIL"}


class _WebhookHandler(BaseHTTPRequestHandler):
    bodies: list[bytes] = []

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length", "0"))
        self.bodies.append(self.rfile.read(length))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args) -> None:  # silence
        pass


def test_main_patrol_notifies_webhook_on_anomaly(tmp_path, capsys):
    now = datetime.now(timezone.utc)
    loud_db = tmp_path / "loud.db"
    _seed_audit_db(loud_db, recent=5, baseline=2, now=now)

    webhook = ThreadingHTTPServer(("127.0.0.1", 0), _WebhookHandler)
    webhook.bodies = _WebhookHandler.bodies = []
    thread = threading.Thread(target=webhook.serve_forever, daemon=True)
    thread.start()
    try:
        thresholds = {
            "SAFEHARNESS_PATROL_AUDIT_WINDOW_MINUTES": "10",
            "SAFEHARNESS_PATROL_AUDIT_BASELINE_WINDOWS": "6",
            "SAFEHARNESS_PATROL_AUDIT_FACTOR": "1",
            "SAFEHARNESS_PATROL_AUDIT_MIN_COUNT": "3",
        }
        lines = [f"SAFEHARNESS_AUDIT_DB={loud_db}"]
        lines += [f"{key}={value}" for key, value in thresholds.items()]
        lines.append(f"SAFEHARNESS_PATROL_FEISHU_WEBHOOK=http://127.0.0.1:{webhook.server_address[1]}/hook")
        env_file = tmp_path / "patrol.env"
        env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
        code = main(["--env-file", str(env_file), "--skip-posture", "--skip-health", "--format", "json"])
        assert code == 1
        report = json.loads(capsys.readouterr().out)
        assert report["summary"]["fail"] >= 1
        assert webhook.bodies, "webhook must receive the anomaly notification"
        text = json.loads(webhook.bodies[0].decode("utf-8"))
        assert text["msg_type"] == "text"
        assert "FAIL" in text["content"]["text"]
        assert "deny" not in text["content"]["text"].lower() or "计数" in text["content"]["text"]
    finally:
        webhook.shutdown()
        thread.join(timeout=3)


def test_main_patrol_clean_is_exit_zero_and_silent(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("SAFEHARNESS_PATROL_FEISHU_WEBHOOK", raising=False)
    clean_db = tmp_path / "clean.db"
    _seed_audit_db(clean_db, recent=1, baseline=2, now=datetime.now(timezone.utc))
    code = main(
        [
            "--audit-db",
            str(clean_db),
            "--skip-posture",
            "--skip-health",
        ]
    )
    assert code == 0
    out = capsys.readouterr().out
    assert "0 FAIL" in out
