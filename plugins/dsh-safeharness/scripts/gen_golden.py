#!/usr/bin/env python
"""Generate the golden-judgement fixture by CALLING the Python SafeHarness engine.

Read-only over ``tools/agentprobe/suites/*.json``: the corpus is never modified and no
attack text is ever written to the fixture or to stdout — the fixture stores only
``sha256``, the character count and the two booleans (plus a reason code).

What the golden values are (see ``evidence/api-digest-python.md`` §1.3/§2/§4):

* ``inform_matched``  — ``InformPolicy._sanitize_value(text)[1]``; the pure-regex
  prompt-injection verdict (the judge is never consulted, so this is deterministic).
* ``sql_dangerous``   — ``inspect_sql(text).dangerous``; structural SQL analysis.

Run (Windows, the interpreter the digest pinned):

    $env:PYTHONPATH = 'F:\\AgentSecurity\\Upear\\src;F:\\AgentSecurity\\Upear'
    $env:PYTHONIOENCODING = 'utf-8'
    & C:\\Users\\xiaojue\\AppData\\Local\\SUMC\\product-demo\\venv\\Scripts\\python.exe `
        -X utf8 scripts\\gen_golden.py

The output is deterministic apart from ``generated_at_utc``: run with ``--check`` to
regenerate in memory and diff against the file on disk (exit 1 on drift).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import platform
import pathlib
import sys
from typing import Any, Iterator

# scripts/gen_golden.py -> <plugin> -> <repo>
PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parents[1]

DEFAULT_CORPUS_DIR = REPO_ROOT / "tools" / "agentprobe" / "suites"
DEFAULT_OUT = PLUGIN_ROOT / "tests" / "fixtures" / "golden.json"

#: The Python-side code emitted by ``InformPolicy.evaluate`` when a pattern matches.
INFORM_MATCHED_CODE = "prompt_injection_detected"


def _ensure_import_path() -> None:
    """Make ``import safeharness`` work even without a preset PYTHONPATH."""
    for candidate in (REPO_ROOT / "src", REPO_ROOT):
        entry = str(candidate)
        if entry not in sys.path:
            sys.path.insert(0, entry)


def _load_inform_policy() -> tuple[Any, str]:
    """Return ``(policy, engine_note)`` using the most deterministic entry point available.

    Preference order:

    1. ``safeharness.policies.inform.build_inform_policy`` — the location named by the
       task spec (some revisions re-exported the builder from ``inform``).
    2. ``safeharness.policies.rules_loader.build_inform_policy`` — the real framework
       construction point, called with an **empty environ dict** so a developer's
       ``SAFEHARNESS_INFORM_RULES_DIR`` / runtime rules cannot perturb the fixture.
    3. ``core.safeharness_inform.platform_inform_policy`` — the SUMC platform wrapper;
       needs ``SUMC/src/backend`` on ``sys.path`` and reads the real environment, so it
       is the last resort and the rules-dir env var is blanked for the call.
    """
    # 1. spec-named home
    try:
        from safeharness.policies.inform import (  # type: ignore[attr-defined]
            build_inform_policy as builder,
        )
    except ImportError:
        builder = None

    if builder is not None:
        policy = builder(environ={})
        return policy, (
            "safeharness.policies.inform.build_inform_policy(environ={}); "
            "built-in patterns only, no YAML/runtime rules"
        )

    # 2. framework construction point
    try:
        from safeharness.policies.rules_loader import (
            build_inform_policy as builder,
        )
    except ImportError:
        builder = None

    if builder is not None:
        policy = builder(environ={})
        return policy, (
            "safeharness.policies.rules_loader.build_inform_policy(environ={}); "
            "built-in patterns only, no YAML/runtime rules"
        )

    # 3. SUMC platform wrapper (optional cross-check)
    sys.path.insert(0, str(REPO_ROOT / "SUMC" / "src" / "backend"))
    try:
        from core.safeharness_inform import platform_inform_policy
    except ImportError as exc:  # pragma: no cover - environment specific
        raise SystemExit(
            "cannot build InformPolicy: neither "
            "safeharness.policies.inform.build_inform_policy, "
            "safeharness.policies.rules_loader.build_inform_policy, nor "
            "core.safeharness_inform.platform_inform_policy is importable "
            f"(last error: {exc!r})"
        ) from exc

    saved = os.environ.pop("SAFEHARNESS_INFORM_RULES_DIR", None)
    try:
        policy = platform_inform_policy()
    finally:
        if saved is not None:
            os.environ["SAFEHARNESS_INFORM_RULES_DIR"] = saved
    return policy, (
        "core.safeharness_inform.platform_inform_policy(); "
        "SUMC wrapper, SAFEHARNESS_INFORM_RULES_DIR blanked for the call"
    )


def _check_policy(policy: Any) -> int:
    """Validate the surface the golden generator depends on; return the pattern count."""
    sanitiser = getattr(policy, "_sanitize_value", None)
    if not callable(sanitiser):
        raise SystemExit(
            "policy object has no callable _sanitize_value; not an InformPolicy: "
            f"{type(policy).__name__}"
        )
    patterns = getattr(policy, "_patterns", ())
    try:
        return len(patterns)
    except TypeError:  # pragma: no cover - defensive
        return -1


def _iter_corpus(corpus_dir: pathlib.Path) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    """Yield ``(suite_name, attacks)`` for every ``*.json`` corpus file, sorted by name."""
    paths = sorted(corpus_dir.glob("*.json"))
    if not paths:
        raise SystemExit(f"corpus directory has no *.json suites: {corpus_dir}")
    seen: set[str] = set()
    for path in paths:
        raw = path.read_bytes()
        # utf-8-sig is BOM-safe; the corpus has no BOM today (§4) but tolerate one.
        try:
            doc = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SystemExit(f"cannot parse corpus file {path.name}: {exc}") from exc
        if not isinstance(doc, dict):
            raise SystemExit(f"corpus file {path.name}: top level is not an object")
        name = doc.get("name")
        attacks = doc.get("attacks")
        if not isinstance(name, str) or not name:
            raise SystemExit(f"corpus file {path.name}: missing string 'name'")
        if name in seen:
            raise SystemExit(f"duplicate suite name {name!r} (file {path.name})")
        seen.add(name)
        if not isinstance(attacks, list) or not attacks:
            raise SystemExit(f"corpus file {path.name}: missing non-empty 'attacks' list")
        yield name, attacks


def _text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def build_fixture(corpus_dir: pathlib.Path) -> tuple[dict[str, Any], dict[str, list[int]]]:
    """Call the Python engine over the corpus and return ``(fixture, per-suite stats)``.

    ``stats`` maps suite name -> ``[attacks, inform_matched, sql_dangerous]``.
    """
    _ensure_import_path()
    from safeharness.policies.sql_guard import inspect_sql

    policy, engine_note = _load_inform_policy()
    pattern_count = _check_policy(policy)
    if pattern_count != 20:  # informational: the fixture pins whatever was measured
        print(
            f"warning: policy has {pattern_count} patterns (digest measured 20); "
            "the fixture records the measured behaviour, re-validate before trusting it",
            file=sys.stderr,
        )

    suites: list[dict[str, Any]] = []
    stats: dict[str, list[int]] = {}
    seen_ids: set[tuple[str, str]] = set()

    for suite_name, attacks in _iter_corpus(corpus_dir):
        entries: list[dict[str, Any]] = []
        inform_hits = 0
        sql_hits = 0
        for position, attack in enumerate(attacks):
            if not isinstance(attack, dict):
                raise SystemExit(f"{suite_name}[{position}]: attack is not an object")
            attack_id = attack.get("id")
            text = attack.get("text")
            if not isinstance(attack_id, str) or not attack_id:
                raise SystemExit(f"{suite_name}[{position}]: missing string 'id'")
            if not isinstance(text, str):
                raise SystemExit(f"{suite_name}/{attack_id}: missing string 'text'")
            key = (suite_name, attack_id)
            if key in seen_ids:
                raise SystemExit(f"duplicate attack id {suite_name}/{attack_id}")
            seen_ids.add(key)

            # (cleaned, pattern_matched, changed) — `changed` is NFKC-only, not a verdict.
            _cleaned, matched, _changed = policy._sanitize_value(text)
            inform_matched = bool(matched)

            verdict = inspect_sql(text)
            sql_dangerous = bool(verdict.dangerous)
            # SQL reason code wins; otherwise the inform code; otherwise unknown.
            reason_code = verdict.reason_code or (
                INFORM_MATCHED_CODE if inform_matched else None
            )

            if inform_matched:
                inform_hits += 1
            if sql_dangerous:
                sql_hits += 1

            entries.append(
                {
                    # No attack text here, by construction: hash + length + verdicts only.
                    "id": attack_id,
                    "text_sha256": _text_sha256(text),
                    "text_chars": len(text),
                    "inform_matched": inform_matched,
                    "sql_dangerous": sql_dangerous,
                    "reason_code": reason_code,
                }
            )

        suites.append({"suite": suite_name, "attacks": entries})
        stats[suite_name] = [len(entries), inform_hits, sql_hits]

    fixture: dict[str, Any] = {
        "generated_at_utc": _dt.datetime.now(_dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "python": platform.python_version(),
        "engine_note": f"{engine_note}; {pattern_count} compiled patterns",
        "suites": suites,
    }
    return fixture, stats


def _dump(fixture: dict[str, Any]) -> bytes:
    """Canonical fixture bytes: sorted keys, 2-space indent, UTF-8 without BOM."""
    return (json.dumps(fixture, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )


def _assert_no_text_leak(blob: bytes, corpus_dir: pathlib.Path) -> None:
    """Fail if any attack text (or a distinctive long slice) made it into the fixture."""
    haystack = blob.decode("utf-8")
    for _suite_name, attacks in _iter_corpus(corpus_dir):
        for attack in attacks:
            text = attack["text"]
            if len(text) >= 12 and text in haystack:
                raise SystemExit(
                    f"refusing to write fixture: attack text present for {attack['id']}"
                )


def _compare(existing: dict[str, Any], fresh: dict[str, Any]) -> list[str]:
    """Structural diff that ignores ``generated_at_utc``; returns problem strings."""
    problems: list[str] = []
    for key in ("python", "engine_note"):
        if existing.get(key) != fresh.get(key):
            problems.append(
                f"{key}: fixture={existing.get(key)!r} recomputed={fresh.get(key)!r}"
            )
    old_suites = existing.get("suites")
    new_suites = fresh.get("suites")
    if not isinstance(old_suites, list) or not isinstance(new_suites, list):
        problems.append("suites: missing or not a list in one of the files")
        return problems
    old_by_name = {
        s.get("suite"): s.get("attacks")
        for s in old_suites
        if isinstance(s, dict)
    }
    new_by_name = {
        s.get("suite"): s.get("attacks")
        for s in new_suites
        if isinstance(s, dict)
    }
    if sorted(old_by_name) != sorted(new_by_name):
        problems.append(
            f"suites differ: fixture={sorted(old_by_name)} recomputed={sorted(new_by_name)}"
        )
        return problems
    for suite_name, old_attacks in old_by_name.items():
        new_attacks = new_by_name[suite_name]
        if not isinstance(old_attacks, list) or not isinstance(new_attacks, list):
            problems.append(f"{suite_name}: attacks is not a list")
            continue
        if len(old_attacks) != len(new_attacks):
            problems.append(
                f"{suite_name}: {len(old_attacks)} fixture attacks vs "
                f"{len(new_attacks)} recomputed"
            )
            continue
        for old, new in zip(old_attacks, new_attacks):
            if old != new:
                ident = old.get("id") if isinstance(old, dict) else "?"
                problems.append(
                    f"{suite_name}/{ident}: fixture={old!r} recomputed={new!r}"
                )
    return problems


def _print_summary(
    fixture: dict[str, Any],
    stats: dict[str, list[int]],
    corpus_dir: pathlib.Path,
    out: pathlib.Path,
    blob: bytes,
) -> None:
    total_attacks = sum(v[0] for v in stats.values())
    total_inform = sum(v[1] for v in stats.values())
    total_sql = sum(v[2] for v in stats.values())
    print(f"python: {fixture['python']}")
    print(f"engine: {fixture['engine_note']}")
    print(f"corpus: {corpus_dir}")
    print(f"out: {out}")
    print(f"suites: {len(stats)}  attacks: {total_attacks}")
    for suite_name in sorted(stats):
        count, inform_hits, sql_hits = stats[suite_name]
        print(
            f"  {suite_name}: n={count} inform_matched={inform_hits} "
            f"sql_dangerous={sql_hits}"
        )
    print(
        f"  TOTAL: n={total_attacks} inform_matched={total_inform} "
        f"sql_dangerous={total_sql}"
    )
    print(f"fixture: {len(blob)} bytes  sha256={hashlib.sha256(blob).hexdigest()}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate the Python-engine golden fixture for the TS port."
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help=f"output JSON path (default: {DEFAULT_OUT})",
    )
    parser.add_argument(
        "--corpus-dir",
        default=str(DEFAULT_CORPUS_DIR),
        help=f"agentprobe suite directory (default: {DEFAULT_CORPUS_DIR})",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="recompute in memory and diff against --out (ignores generated_at_utc); "
        "writes nothing, exits 1 on drift",
    )
    args = parser.parse_args(argv)

    corpus_dir = pathlib.Path(args.corpus_dir)
    if not corpus_dir.is_dir():
        raise SystemExit(f"corpus directory not found: {corpus_dir}")
    out = pathlib.Path(args.out)

    fixture, stats = build_fixture(corpus_dir)
    blob = _dump(fixture)
    _assert_no_text_leak(blob, corpus_dir)

    if args.check:
        if not out.is_file():
            print(f"check: fixture missing: {out}", file=sys.stderr)
            return 1
        existing = json.loads(out.read_bytes().decode("utf-8"))
        problems = _compare(existing, fixture)
        if problems:
            print("check: DRIFT", file=sys.stderr)
            for problem in problems:
                print(f"  - {problem}", file=sys.stderr)
            return 1
        print(f"check: OK — {out} matches a fresh engine run (generated_at ignored)")
        _print_summary(fixture, stats, corpus_dir, out, out.read_bytes())
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    _print_summary(fixture, stats, corpus_dir, out, blob)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
