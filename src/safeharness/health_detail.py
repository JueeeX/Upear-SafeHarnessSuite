"""Shared env helpers for the optional health detail fields (P3.1).

``SAFEHARNESS_HEALTH_DETAIL=1`` makes the process health surfaces report a
per-component ``components`` map. Default off: responses stay byte-identical
to the pre-P3.1 shape. Read per call (no import-time freeze) so a deployment
flips it without code changes.
"""

from __future__ import annotations

import os

ENV_HEALTH_DETAIL = "SAFEHARNESS_HEALTH_DETAIL"


def health_detail_enabled() -> bool:
    return (os.environ.get(ENV_HEALTH_DETAIL) or "").strip().lower() in ("1", "true", "yes")
