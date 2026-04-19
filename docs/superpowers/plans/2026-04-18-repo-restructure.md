# Repo Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all active code from `newpoc/` subdirectory to flat root dirs (`backend/`, `frontend/`, `agent/`, `tests/`), delete dead v1 code, update all `newpoc.backend.*` imports, and leave the repo clean for both humans and coding agents.

**Architecture:** Pure filesystem/config rename — no logic changes. Use `git mv` throughout so `git log --follow` preserves history on every file. Delete v1 dirs (`backend/` and `agent/` at root) before moving v2 dirs into place.

**Tech Stack:** git, Python (uv/ruff/vulture), TypeScript (tsc), pytest

---

## File Structure

**Files created:**
- `README.md` — GitHub-facing project overview
- `CLAUDE.md` (root) — promoted + updated from `newpoc/CLAUDE.md`

**Files deleted:**
- `backend/` (root) — dead v1 code
- `agent/` (root) — dead v1 code
- `newpoc/test_pipeline.py` — ad-hoc script
- `ONBOARD.md` — replaced by README.md
- `cardheroagentpoc.txt` — superseded by docs/
- `CLAUDE.md` (old root v1)

**Files moved (git mv):**
- `newpoc/backend/` → `backend/`
- `newpoc/lab/` → `frontend/`
- `newpoc/agent/` → `agent/`
- `newpoc/tests/` → merged into `tests/`
- `newpoc/CLAUDE.md` → `CLAUDE.md`

**Files modified:**
- `backend/database.py` — import `newpoc.backend.config` → `backend.config`
- `backend/main.py` — 6 import lines updated
- `backend/monitor.py` — 2 import lines updated
- `backend/sentiment.py` — 1 import line updated
- `backend/seed.py` — 1 import line updated
- `backend/integrations/collectr.py` — 1 import line updated
- `tests/conftest.py` (was newpoc/tests) — 2 import lines updated
- `tests/test_api.py` (was newpoc/tests) — 10 import lines updated
- `tests/test_push_notifications.py` (already at root) — 2 import lines updated
- `pyproject.toml` — add pytest testpaths
- `Dockerfile` — update COPY + CMD paths
- `.gitignore` — update `newpoc/`-prefixed paths
- `CLAUDE.md` (new root) — all path references updated

---

## Task 1: Delete Dead V1 Code

**Files:**
- Delete: `backend/` (root v1)
- Delete: `agent/` (root v1)
- Delete: `ONBOARD.md`
- Delete: `cardheroagentpoc.txt`
- Delete: `CLAUDE.md` (root v1 — note: different from `newpoc/CLAUDE.md`)
- Delete: `newpoc/test_pipeline.py`

- [ ] **Step 1: Verify v1 dirs are truly dead (no unique content)**

```bash
ls backend/    # should show v1 files — confirm none are used
ls agent/      # same
diff <(ls backend/) <(ls newpoc/backend/) || true
```
Expected: v1 backend/ has fewer files than newpoc/backend/ — these are the superseded originals.

- [ ] **Step 2: Delete v1 root dirs and loose files**

```bash
cd /Users/gurnoornatt/CsProjs/personalProjects/cardAgentPOC
git rm -r backend/ agent/
git rm ONBOARD.md cardheroagentpoc.txt CLAUDE.md
git rm newpoc/test_pipeline.py
```
Expected: All `git rm` calls exit 0.

- [ ] **Step 3: Commit the deletions**

```bash
git commit -m "chore: delete dead v1 code and loose docs"
```

---

## Task 2: Move Active Directories with git mv

**Files:**
- Move: `newpoc/backend/` → `backend/`
- Move: `newpoc/lab/` → `frontend/`
- Move: `newpoc/agent/` → `agent/`

- [ ] **Step 1: Move backend**

```bash
git mv newpoc/backend backend
```
Expected: exits 0, no conflict (v1 `backend/` is already deleted).

- [ ] **Step 2: Move lab → frontend**

```bash
git mv newpoc/lab frontend
```
Expected: exits 0.

- [ ] **Step 3: Move agent**

```bash
git mv newpoc/agent agent
```
Expected: exits 0, no conflict (v1 `agent/` is already deleted).

- [ ] **Step 4: Commit the moves**

```bash
git commit -m "chore: promote newpoc/ subdirs to root (backend/, frontend/, agent/)"
```

---

## Task 3: Merge Tests Directory

**Files:**
- Modify: `tests/` (root — already has test_push_notifications.py)
- Move: `newpoc/tests/conftest.py` → `tests/conftest.py`
- Move: `newpoc/tests/test_api.py` → `tests/test_api.py`
- Move: `newpoc/tests/__init__.py` → `tests/__init__.py` (if not already exists)

- [ ] **Step 1: Check what's already in root tests/**

```bash
ls tests/
ls newpoc/tests/
```
Expected: `tests/` has `test_push_notifications.py`. `newpoc/tests/` has `__init__.py`, `conftest.py`, `test_api.py`.

- [ ] **Step 2: Move test files**

```bash
git mv newpoc/tests/conftest.py tests/conftest.py
git mv newpoc/tests/test_api.py tests/test_api.py
# Only move __init__.py if tests/ doesn't already have one
[ -f tests/__init__.py ] || git mv newpoc/tests/__init__.py tests/__init__.py
```
Expected: all exit 0.

- [ ] **Step 3: Move newpoc/CLAUDE.md to root and clean up**

```bash
git mv newpoc/CLAUDE.md CLAUDE.md
```
Expected: exits 0. (newpoc/ should now be empty except for __init__.py and __pycache__)

- [ ] **Step 4: Delete newpoc/ remnants**

```bash
git rm -r newpoc/
```
Expected: removes `newpoc/__init__.py` and any remaining empty dirs.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore: merge newpoc/tests/ into tests/, promote CLAUDE.md, delete newpoc/"
```

---

## Task 4: Update Python Imports — Backend Files

**Files:**
- Modify: `backend/database.py`
- Modify: `backend/main.py`
- Modify: `backend/monitor.py`
- Modify: `backend/sentiment.py`
- Modify: `backend/seed.py`
- Modify: `backend/integrations/collectr.py`

- [ ] **Step 1: Update backend/database.py**

Change line:
```python
from newpoc.backend.config import DATABASE_URL, DB_DIR
```
To:
```python
from backend.config import DATABASE_URL, DB_DIR
```

- [ ] **Step 2: Update backend/monitor.py**

Change:
```python
from newpoc.backend.config import (
```
To:
```python
from backend.config import (
```

And:
```python
from newpoc.backend.database import SessionLocal, SystemMeta, WantList, init_db
```
To:
```python
from backend.database import SessionLocal, SystemMeta, WantList, init_db
```

- [ ] **Step 3: Update backend/sentiment.py**

Change:
```python
    from newpoc.backend.config import REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT
```
To:
```python
    from backend.config import REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT
```

- [ ] **Step 4: Update backend/seed.py**

Change:
```python
from newpoc.backend.database import (
```
To:
```python
from backend.database import (
```

- [ ] **Step 5: Update backend/integrations/collectr.py**

Change:
```python
from newpoc.backend.database import SessionLocal, WantList
```
To:
```python
from backend.database import SessionLocal, WantList
```

- [ ] **Step 6: Update backend/main.py (6 occurrences)**

Change all 6 occurrences:
```python
from newpoc.backend.config import (     →   from backend.config import (
from newpoc.backend.database import (   →   from backend.database import (
from newpoc.backend.sentiment import    →   from backend.sentiment import
from newpoc.backend.monitor import _scrape_listings_apify   →   from backend.monitor import _scrape_listings_apify
from newpoc.backend.monitor import WantListProxy   →   from backend.monitor import WantListProxy
from newpoc.backend.integrations.collectr import start_collectr_job   →   from backend.integrations.collectr import start_collectr_job
from newpoc.backend.integrations.collectr import get_job   →   from backend.integrations.collectr import get_job
```

Use sed for safety:
```bash
sed -i '' 's/from newpoc\.backend\./from backend./g' backend/main.py backend/database.py backend/monitor.py backend/sentiment.py backend/seed.py backend/integrations/collectr.py
```
Expected: 0 remaining `newpoc.backend` in any of these files.

Verify:
```bash
grep -r "newpoc" backend/ --include="*.py"
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add backend/
git commit -m "fix: update Python imports newpoc.backend.* → backend.*"
```

---

## Task 5: Update Python Imports — Test Files

**Files:**
- Modify: `tests/conftest.py`
- Modify: `tests/test_api.py`
- Modify: `tests/test_push_notifications.py`

- [ ] **Step 1: Bulk-replace newpoc imports in all test files**

```bash
sed -i '' 's/from newpoc\.backend\./from backend./g' tests/conftest.py tests/test_api.py tests/test_push_notifications.py
sed -i '' 's/patch("newpoc\.backend\./patch("backend./g' tests/test_push_notifications.py
```

- [ ] **Step 2: Fix comment in test_api.py**

The file has a comment `Run:  uv run pytest newpoc/tests/ -v` — update it:
```bash
sed -i '' 's|uv run pytest newpoc/tests/|uv run pytest tests/|g' tests/test_api.py
```

- [ ] **Step 3: Verify no newpoc references remain in tests**

```bash
grep -r "newpoc" tests/ --include="*.py"
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "fix: update test imports newpoc.backend.* → backend.*"
```

---

## Task 6: Update pyproject.toml, Dockerfile, .gitignore

**Files:**
- Modify: `pyproject.toml`
- Modify: `Dockerfile`
- Modify: `.gitignore`

- [ ] **Step 1: Update pyproject.toml — add pytest testpaths**

Add at end of `pyproject.toml`:
```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```
The `.` pythonpath means `backend/` at root is importable as `backend`.

- [ ] **Step 2: Update Dockerfile**

Change:
```dockerfile
COPY newpoc/agent/package.json newpoc/agent/
RUN cd newpoc/agent && npm install --include=dev
```
To:
```dockerfile
COPY agent/package.json agent/
RUN cd agent && npm install --include=dev
```

Change CMD:
```dockerfile
CMD uv run python -m newpoc.backend.seed && uv run uvicorn newpoc.backend.main:app --host 0.0.0.0 --port ${PORT:-8001}
```
To:
```dockerfile
CMD uv run python -m backend.seed && uv run uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8001}
```

- [ ] **Step 3: Update .gitignore**

Change:
```
newpoc/backend/db/
```
To:
```
backend/db/
```

Change:
```
newpoc/agent/dist/
newpoc/lab/dist/
```
To:
```
agent/dist/
frontend/dist/
```

Change:
```
newpoc/receipts/
```
To:
```
receipts/
```

Remove `node_modules/` generic line if present (already covered by frontend/node_modules/ path) — actually keep it as a catch-all. Just remove the `newpoc/`-prefixed versions.

Also add:
```
frontend/node_modules/
```

- [ ] **Step 4: Verify .gitignore looks correct**

```bash
cat .gitignore
```
Expected: no `newpoc/` prefixes anywhere.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml Dockerfile .gitignore
git commit -m "chore: update pyproject.toml testpaths, Dockerfile CMD + COPY paths, .gitignore"
```

---

## Task 7: Update CLAUDE.md and Write README.md

**Files:**
- Modify: `CLAUDE.md` (just moved from newpoc/CLAUDE.md)
- Create: `README.md`

- [ ] **Step 1: Update all path references in CLAUDE.md**

```bash
sed -i '' 's|newpoc/backend/|backend/|g' CLAUDE.md
sed -i '' 's|newpoc/lab/|frontend/|g' CLAUDE.md
sed -i '' 's|newpoc/agent/|agent/|g' CLAUDE.md
sed -i '' 's|newpoc/\.env|.env|g' CLAUDE.md
sed -i '' 's|newpoc/tests/|tests/|g' CLAUDE.md
sed -i '' 's|newpoc\.backend\.|backend.|g' CLAUDE.md
sed -i '' 's|newpoc/receipts/|receipts/|g' CLAUDE.md
```

- [ ] **Step 2: Update the monorepo layout block in CLAUDE.md**

Find and replace the `## Monorepo Layout` section. It currently shows:
```
newpoc/
  backend/
  agent/
  lab/
  receipts/
  .env
  .env.example
```

Replace with:
```
backend/        ← Python/FastAPI: Conductor + Watchman + Sentiment
agent/          ← Node.js/Stagehand: Last-Mile checkout agent
frontend/       ← CardHero Lab dashboard (metrics + A/B testing)
receipts/       ← Screenshots + DOM snapshots from agent runs
tests/          ← All tests (pytest)
.env            ← Copy from .env.example, fill in real credentials
.env.example    ← Env template
```

Edit `CLAUDE.md` manually to replace the monorepo layout block.

- [ ] **Step 3: Verify no newpoc references remain in CLAUDE.md**

```bash
grep -n "newpoc" CLAUDE.md
```
Expected: no output.

- [ ] **Step 4: Write README.md**

Create `README.md` at repo root with this content:

```markdown
# CardHero Agent POC

A three-layer deterministic system that hunts PSA-graded Pokémon card deals on eBay and executes purchases autonomously.

## How It Works

```
Watchman (Python poller) → scrapes eBay, runs 4-gate waterfall filter
Conductor (FastAPI + SQLite) → budget circuit breaker, GO / NO_GO decision
Last-Mile Agent (Node.js / Stagehand + Browserbase) → navigates listing, verifies cert, checks out
```

Zero AI in financial decisions. The LLM only reads pages. The Conductor enforces all guardrails deterministically.

## Repo Layout

| Directory | What it is |
|-----------|-----------|
| `backend/` | FastAPI Conductor + SQLAlchemy models + Watchman poller |
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

See [CLAUDE.md](CLAUDE.md) for the full architecture, database schema, decision trees, and debugging guide.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update CLAUDE.md paths, write README.md"
```

---

## Task 8: Quality Gates

- [ ] **Step 1: Run ruff on backend/**

```bash
uv run ruff check backend/
```
Expected: `All checks passed!`

If failures: run `uv run ruff check backend/ --fix` to auto-fix, then re-check.

- [ ] **Step 2: Run vulture on backend/**

```bash
uv run vulture backend/ --min-confidence 80
```
Expected: no output (or only known false positives from FastAPI/SQLAlchemy decorators).

- [ ] **Step 3: Run TypeScript check on frontend/**

```bash
cd frontend && npx tsc --noEmit
```
Expected: exits 0 with no errors.

- [ ] **Step 4: Run pytest**

```bash
uv run pytest tests/ -v
```
Expected: all tests pass. If any fail with `ModuleNotFoundError: No module named 'newpoc'` — go back and fix the remaining import in that file.

- [ ] **Step 5: Smoke-test the backend starts**

```bash
uv run uvicorn backend.main:app --port 8002 &
sleep 3
curl -s http://localhost:8001/health | python3 -m json.tool
kill %1 2>/dev/null || true
```
Expected: JSON response from /health (using the already-running instance on 8001).

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git status  # review before committing
git commit -m "fix: quality gate fixes post-restructure"
```

---

## Task 9: Push to GitHub

- [ ] **Step 1: Final status check**

```bash
git log --oneline -8
git status
```
Expected: clean working tree, 7-8 commits visible.

- [ ] **Step 2: Push**

```bash
git push origin main
```
Expected: pushed cleanly. GitHub repo now shows `backend/`, `frontend/`, `agent/`, `tests/` at root — no `newpoc/`.
