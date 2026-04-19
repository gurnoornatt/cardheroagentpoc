# CardHero Agent POC

A three-layer deterministic system that hunts PSA-graded Pokémon card deals on eBay and executes purchases autonomously.

## How It Works

```
Watchman (Python poller)
  → scrapes eBay, runs 4-gate waterfall filter (slop, price, seller rating, feedback)
  → fires POST /evaluate for BUY_IT_NOW listings

Conductor (FastAPI + SQLite)
  → IQR math gate, budget circuit breaker, duplicate check
  → GO / NO_GO decision → creates Deal row

Last-Mile Agent (Node.js + Stagehand v3 + Browserbase)
  → navigates listing in cloud browser
  → extracts PSA cert number + verifies price lock
  → proceeds to checkout confirmation
  → saves screenshot + DOM snapshot to receipts/
```

Zero AI in financial decisions. The LLM only reads pages and acts on them. The Conductor enforces all guardrails deterministically.

## Repo Layout

| Directory | What it is |
|-----------|-----------|
| `backend/` | FastAPI Conductor + SQLAlchemy models + Watchman poller + Sentiment |
| `frontend/` | React + Vite + Tailwind dashboard (CardHero Lab) |
| `agent/` | Node.js Stagehand v3 checkout agent |
| `tests/` | pytest test suite |
| `docs/` | Design specs and implementation plans |

## Quick Start

```bash
# 1. Install Python deps
uv sync

# 2. Seed the database
uv run python -m backend.seed

# 3. Start the Conductor (Terminal 1)
uv run uvicorn backend.main:app --reload --port 8001

# 4. Start the Watchman (Terminal 2)
uv run python -m backend.monitor

# 5. Start the Lab dashboard (Terminal 3)
cd frontend && npm install && npm run dev
```

## Tests

```bash
uv run pytest tests/ -v
```

## Deployment

| Service | Platform | Config |
|---------|----------|--------|
| Frontend | Vercel | `frontend/vercel.json` |
| Backend | Railway | Start command: `uvicorn backend.main:app --host 0.0.0.0 --port 8001` |

## Architecture Details

See [CLAUDE.md](CLAUDE.md) for the full architecture reference: database schema, decision trees, Stagehand v3 patterns, anti-detection layer, and debugging guide.
