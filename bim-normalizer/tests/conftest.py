"""
pytest fixtures for bim-normalizer's test suite.

Run with (from the bim-normalizer/ directory):
    pip install -r requirements.txt -r requirements-dev.txt
    pytest tests/

config.settings requires PG_HOST/PG_USER/PG_PASS/PG_NAME/SPECKLE_SERVER_URL at
import time (see config/settings.py's _require() calls) — the dummy values
below let any module that transitively imports config.settings load without
a real database or Speckle server. Set before anything else in this file so
collection doesn't fail for test files that reach it indirectly.
"""
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# bim-normalizer/ itself (not tests/) is where chat/, db/, routers/ etc. live
# as top-level packages — put it on sys.path so `from chat.agent import ...`
# resolves regardless of what directory pytest is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SPECKLE_SERVER_URL", "https://example.invalid")
os.environ.setdefault("PG_HOST", "localhost")
os.environ.setdefault("PG_PORT", "5432")
os.environ.setdefault("PG_USER", "test")
os.environ.setdefault("PG_PASS", "test")
os.environ.setdefault("PG_NAME", "test")


@pytest.fixture
def mock_conn():
    """A MagicMock standing in for a psycopg2 connection, with
    `with conn.cursor() as cur:` support wired up — every _execute_tool_impl
    branch uses that context-manager form. Configure
    cur.execute/cur.fetchall/cur.fetchone/cur.description per-test."""
    conn = MagicMock()
    cur = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = False
    return conn
