# Repo Restructure — Design Spec
**Date:** 2026-04-18  
**Status:** Approved

---

## Goal

Restructure the `cardheroagentpoc` repo from its current `newpoc/` subdirectory layout into a clean, flat monorepo that is optimised for coding agents and human readability. Dead v1 code is deleted. All paths, imports, and configs are updated consistently.

---

## Target Structure

```
cardheroagentpoc/
├── backend/              ← FastAPI + SQLAlchemy + Watchman (was newpoc/backend/)
│   ├── __init__.py
│   ├── main.py
│   ├── database.py
│   ├── config.py
│   ├── monitor.py
│   ├── seed.py
│   ├── sentiment.py
│   └── integrations/
│       ├── __init__.py
│       └── collectr.py
├── frontend/             ← React + Vite + Tailwind (was newpoc/lab/)
│   ├── src/
│   ├── public/
│   │   ├── sw.js
│   │   └── favicon.svg
│   ├── index.html
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   └── vercel.json
├── agent/                ← Node.js + Stagehand v3 (was newpoc/agent/)
│   ├── checkout.ts
│   ├── collectr_import.ts
│   ├── package.json
│   ├── pnpm-lock.yaml
│   └── tsconfig.json
├── tests/                ← All tests (merged newpoc/tests/ + root tests/)
│   ├── __init__.py
│   ├── conftest.py
│   ├── test_api.py
│   └── test_push_notifications.py
├── docs/
│   └── superpowers/
│       ├── specs/
│       └── plans/
├── Dockerfile
├── pyproject.toml
├── uv.lock
├── .env.example
├── .gitignore
├── .python-version
├── CLAUDE.md             ← newpoc/CLAUDE.md promoted to root (v2 architecture)
└── README.md             ← New file replacing ONBOARD.md
```

---

## What Gets Deleted

| Path | Reason |
|------|--------|
| `backend/` (root v1) | Dead v1 code — superseded by v2, preserved in git history |
| `agent/` (root v1) | Dead v1 code — superseded by v2, preserved in git history |
| `newpoc/` | Wrapper directory removed; contents promoted to root |
| `CLAUDE.md` (root v1) | Outdated v1 architecture docs |
| `ONBOARD.md` | Replaced by `README.md` |
| `cardheroagentpoc.txt` | Loose spec file — content is superseded by docs/ |
| `newpoc/test_pipeline.py` | Ad-hoc batch runner — move to `tests/` or delete |

---

## What Gets Updated

### 1. Python imports
Every `from newpoc.backend.X import Y` and `import newpoc.backend.X` becomes `from backend.X import Y`.

Files affected:
- `backend/main.py`
- `backend/monitor.py`
- `backend/seed.py`
- `backend/sentiment.py`
- `backend/integrations/collectr.py`
- `tests/conftest.py`
- `tests/test_api.py`
- `tests/test_push_notifications.py`

### 2. `pyproject.toml`
- Update `[tool.pytest.ini_options] testpaths` from `["newpoc/tests"]` to `["tests"]`
- Update any `pythonpath` entries from `["."]` — no change needed since `backend/` at root is importable as `backend`

### 3. `Dockerfile`
```dockerfile
# Before
COPY newpoc/agent/package.json ...
CMD ["sh", "-c", "uv run python -m newpoc.backend.seed && uvicorn newpoc.backend.main:app ..."]

# After  
COPY agent/package.json ...
CMD ["sh", "-c", "uv run python -m backend.seed && uvicorn backend.main:app --host 0.0.0.0 --port 8001"]
```

### 4. `frontend/vite.config.ts`
No change — proxy target `http://localhost:8001` is unchanged.

### 5. `CLAUDE.md` (new root)
Promote `newpoc/CLAUDE.md` to root. Update all path references inside it:
- `newpoc/backend/` → `backend/`
- `newpoc/lab/` → `frontend/`
- `newpoc/agent/` → `agent/`
- `newpoc/.env` → `.env`
- `uv run python -m newpoc.backend.*` → `uv run python -m backend.*`
- `uv run uvicorn newpoc.backend.main:app` → `uv run uvicorn backend.main:app`

### 6. `README.md` (new)
Concise GitHub-facing readme covering:
- What CardHero is (one paragraph)
- Repo layout table (backend / frontend / agent / tests)
- Quick start (5 commands)
- Deployment (Vercel + Railway)
- Link to CLAUDE.md for full architecture

### 7. `.gitignore`
Update any `newpoc/`-prefixed paths:
- `newpoc/backend/db/` → `backend/db/`
- `newpoc/receipts/` → `receipts/`
- `newpoc/agent/dist/` → `agent/dist/`
- `newpoc/lab/dist/` → `frontend/dist/`
- `newpoc/lab/node_modules/` → `frontend/node_modules/`

### 8. `frontend/vercel.json`
No change — Railway URL is hardcoded, not path-dependent.

---

## Git Strategy

Use `git mv` for all moves so git history is preserved on every file. Do **not** `cp` + `rm` — that breaks `git log --follow`.

Order of operations:
1. Delete dead v1 dirs (`backend/` root, `agent/` root) — these have no history worth keeping in diff context
2. `git mv newpoc/backend backend`
3. `git mv newpoc/lab frontend`  
4. `git mv newpoc/agent agent` — will conflict with deleted v1 `agent/`, so delete v1 first
5. Merge `newpoc/tests/` into root `tests/`
6. Move `newpoc/CLAUDE.md` → `CLAUDE.md`
7. Delete `newpoc/` (now empty)
8. Update all imports and configs
9. Write `README.md`
10. Run full quality checks + tests

---

## Quality Gates (must pass before commit)

```bash
uv run ruff check backend/
uv run vulture backend/ --min-confidence 80
cd frontend && npx tsc --noEmit
uv run pytest tests/ -v
uv run uvicorn backend.main:app --port 8001   # starts without error
```

---

## Deployment Impact

| Component | Change required |
|-----------|----------------|
| Vercel | None — `frontend/vercel.json` paths unchanged |
| Railway | Update start command: `uvicorn backend.main:app --host 0.0.0.0 --port 8001` |
| Dockerfile | Update paths and CMD (see above) |

---

## Out of Scope

- Renaming the GitHub repo (`cardheroagentpoc` stays)
- Changing the frontend framework or build tooling
- Any feature changes
- Splitting into multiple git repos
