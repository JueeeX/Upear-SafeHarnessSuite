#!/usr/bin/env python3
"""SafeHarness Python engine sidecar (M5 T5.1, step 2).

Speaks the newline-delimited JSON protocol defined by
``plugins/dsh-safeharness/src/engine/sidecar.ts``:

  request   {"v":1,"id":N,"method":"...","params":{...}}
  response  {"v":1,"id":N,"ok":true,"result":{...}}
            {"v":1,"id":N,"ok":false,"error":{"code":"...","message":"..."}}

Methods
  health          -> {ok, engine, python, rules, sql}
  set_rules       -> {accepted, rejected:[{name, code}]}
  inform_match    -> {rules:[name, ...]}
  inspect_sql     -> {is_sql, dangerous, statement_kinds, ...}
  evaluate_input  -> {rules:[name, ...], sql:{...}}   (what the plugin calls)
  shutdown        -> {ok:true} then exit

Design rules this file must keep:

- **Zero echo.** Error messages are fixed strings. Prompt text, rule patterns and
  the child's environment never appear in a response: the ledger discipline
  ("hashes and lengths only") applies to the engine boundary too.
- **Same rules, not "Python's defaults".** The plugin sends its compiled rule
  sources through ``set_rules`` and the child compiles exactly those, so a
  response is reproducible from the plugin's ruleset hash. Nothing else is
  loaded; the framework's built-in patterns are deliberately NOT added here.
- **Read-only.** No file writes, no network, no credentials.
- **Parity with the TypeScript built-in engine.** Inform matching runs the same
  pattern sources through Python's ``re`` with ``re.IGNORECASE`` on the raw text.
  It deliberately does NOT run ``InformPolicy._structural_clean`` (NFKC /
  zero-width / HTML-comment stripping): the built-in engine does not do that
  either, and a sidecar that silently strips more would make the two engines
  disagree for the same ruleset hash.
- **Dangerous SQL is judged by the canonical implementation**:
  ``safeharness.policies.sql_guard.inspect_sql``.

Usage (the plugin spawns this; run it by hand only to smoke-test):

    set PYTHONPATH=F:\\AgentSecurity\\Upear\\src
    python -u scripts/safeharness_sidecar.py
    {"v":1,"id":1,"method":"health"}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_TEXT_CHARS = 2_000_000

# Fixed, content-free messages. Never interpolate request data into these.
_MSG = {
    "bad_request": "the request is not a valid protocol message",
    "unknown_method": "no such engine method",
    "bad_params": "the request parameters are invalid",
    "engine_error": "the engine failed to evaluate the request",
    "python_framework_missing": "the SafeHarness Python framework is not importable",
    "text_too_long": "the text exceeds the engine input limit",
}

# Installed rule sources: [(name, compiled_regex)]
_RULES: list[tuple[str, "re.Pattern[str]"]] = []

# The canonical SQL inspector from the SafeHarness framework, or None.
_inspect_sql: Any = None


def _load_framework(framework_path: str | None) -> bool:
    """Import the framework's SQL inspector; False means "not available".

    Never raises and never prints a path: the transport only needs to know
    whether the engine is usable, and the plugin reports that as a posture code.
    """
    global _inspect_sql
    if framework_path:
        sys.path.insert(0, framework_path)
    try:
        from safeharness.policies.sql_guard import inspect_sql  # type: ignore[import-not-found]

        _inspect_sql = inspect_sql
        return True
    except Exception:
        _inspect_sql = None
        return False


def _error(request_id: Any, code: str) -> dict[str, Any]:
    return {
        "v": PROTOCOL_VERSION,
        "id": request_id,
        "ok": False,
        "error": {"code": code, "message": _MSG.get(code, _MSG["engine_error"])},
    }


def _ok(request_id: Any, result: Any) -> dict[str, Any]:
    return {"v": PROTOCOL_VERSION, "id": request_id, "ok": True, "result": result}


def _sql_verdict(text: str) -> dict[str, Any]:
    """Run the canonical inspector, or report the framework as absent."""
    if _inspect_sql is None:
        raise RuntimeError("python_framework_missing")
    verdict = _inspect_sql(text)
    return {
        "is_sql": bool(verdict.is_sql),
        "dangerous": bool(verdict.dangerous),
        "statement_kinds": list(verdict.statement_kinds),
        "tables": list(verdict.tables),
        "multi_statement": bool(verdict.multi_statement),
        "reason_code": verdict.reason_code,
        "matched_table": verdict.matched_table,
    }


def _matched_rule_names(text: str) -> list[str]:
    matched = []
    for name, pattern in _RULES:
        try:
            if pattern.search(text):
                matched.append(name)
        except Exception:
            # A pattern that cannot run is a rules problem, not a crash: treat it
            # as "no match" and let the plugin's ruleset stay authoritative.
            continue
    matched.sort()
    return matched


def _handle_set_rules(params: dict[str, Any]) -> dict[str, Any]:
    global _RULES
    incoming = params.get("rules")
    if not isinstance(incoming, list):
        raise ValueError("bad_params")
    accepted: list[tuple[str, "re.Pattern[str]"]] = []
    rejected: list[dict[str, str]] = []
    for item in incoming:
        if not isinstance(item, dict):
            rejected.append({"name": "unknown", "code": "bad_rule"})
            continue
        name = item.get("name")
        source = item.get("pattern")
        if not isinstance(name, str) or name == "":
            rejected.append({"name": "unknown", "code": "bad_rule"})
            continue
        if not isinstance(source, str) or source == "":
            rejected.append({"name": name, "code": "bad_rule"})
            continue
        try:
            accepted.append((name, re.compile(source, re.IGNORECASE)))
        except re.error:
            rejected.append({"name": name, "code": "bad_regex"})
    if rejected:
        # All-or-nothing: a partially installed rule set is a silently weaker
        # engine, which is exactly the failure mode this sidecar must not have.
        _RULES = []
        return {"accepted": 0, "rejected": rejected}
    _RULES = accepted
    return {"accepted": len(accepted), "rejected": []}


def _text_of(params: dict[str, Any]) -> str:
    text = params.get("text")
    if not isinstance(text, str):
        raise ValueError("bad_params")
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError("text_too_long")
    return text


def _dispatch(message: Any) -> dict[str, Any] | None:
    if not isinstance(message, dict):
        return _error(None, "bad_request")
    request_id = message.get("id")
    if not isinstance(request_id, (int, str)):
        return _error(None, "bad_request")
    method = message.get("method")
    params = message.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return _error(request_id, "bad_params")

    # Without the canonical SQL inspector the engine is not usable at all: report
    # it as a failed health check so the plugin's transport refuses to start
    # (fail-closed) instead of running an engine that would never flag SQL.
    if _inspect_sql is None:
        return _error(request_id, "python_framework_missing")

    if method == "health":
        return _ok(request_id, {
            "ok": True,
            "engine": "python",
            "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "rules": len(_RULES),
            "sql": True,
        })

    try:
        if method == "set_rules":
            return _ok(request_id, _handle_set_rules(params))
        if method == "inform_match":
            return _ok(request_id, {"rules": _matched_rule_names(_text_of(params))})
        if method == "inspect_sql":
            return _ok(request_id, _sql_verdict(_text_of(params)))
        if method == "evaluate_input":
            text = _text_of(params)
            return _ok(request_id, {"rules": _matched_rule_names(text), "sql": _sql_verdict(text)})
        if method == "shutdown":
            return _ok(request_id, {"ok": True})
        return _error(request_id, "unknown_method")
    except ValueError as error:
        return _error(request_id, str(error) if str(error) in _MSG else "bad_params")
    except RuntimeError as error:
        return _error(request_id, str(error) if str(error) in _MSG else "engine_error")
    except Exception:
        return _error(request_id, "engine_error")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--framework", default=None, help="path prepended to sys.path (the repo's src/)")
    args, _unknown = parser.parse_known_args(argv)

    _load_framework(args.framework)

    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass

    shutdown = False
    for line in sys.stdin:
        if shutdown:
            break
        if len(line) > MAX_MESSAGE_BYTES:
            sys.stdout.write(json.dumps(_error(None, "bad_request")) + "\n")
            sys.stdout.flush()
            continue
        stripped = line.strip()
        if stripped == "":
            continue
        try:
            message = json.loads(stripped)
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps(_error(None, "bad_request")) + "\n")
            sys.stdout.flush()
            continue
        if isinstance(message, dict) and message.get("method") == "shutdown":
            shutdown = True
        response = _dispatch(message)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
        if shutdown:
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
