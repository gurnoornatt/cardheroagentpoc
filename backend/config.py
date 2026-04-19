"""
Centralized configuration for CardHero v2.

All env vars are loaded here — no other module should call os.getenv or load_dotenv.
.env is always resolved relative to the repo root regardless of cwd.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Always resolves to repo root .env regardless of working directory
_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_ENV_PATH)

# ── Database ───────────────────────────────────────────────────────────────────
DB_DIR = Path(__file__).resolve().parent / "db"
DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    f"sqlite:///{DB_DIR}/cardhero.db",
)

# ── Conductor ──────────────────────────────────────────────────────────────────
DAILY_SPEND_LIMIT: float = float(os.getenv("DAILY_SPEND_LIMIT", "500.00"))
AGENT_BUDGET: float = float(os.getenv("AGENT_BUDGET", "150.00"))
TAX_RATE: float = float(os.getenv("TAX_RATE", "0.09"))
PRICE_TRIGGER_DELTA: float = float(os.getenv("PRICE_TRIGGER_DELTA", "100.00"))
CONDUCTOR_URL: str = os.getenv("CONDUCTOR_URL", "http://localhost:8001")

# ── Watchman ───────────────────────────────────────────────────────────────────
POLL_INTERVAL_SECONDS: int = int(os.getenv("POLL_INTERVAL", "300"))
SELLER_RATING_MIN: float = 98.0
SELLER_FEEDBACK_MIN: int = 100
SLOP_KEYWORDS: frozenset[str] = frozenset(
    {"proxy", "reprint", "digital", "read", "custom", "fake", "lot"}
)

# ── Reddit ─────────────────────────────────────────────────────────────────────
REDDIT_CLIENT_ID: str = os.getenv("REDDIT_CLIENT_ID", "")
REDDIT_CLIENT_SECRET: str = os.getenv("REDDIT_CLIENT_SECRET", "")
REDDIT_USER_AGENT: str = os.getenv("REDDIT_USER_AGENT", "cardhero-watchman/2.0")
