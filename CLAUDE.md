# CardHero Last-Mile Engine — POC

## System Overview

A three-layer system that hunts PSA-graded Pokémon card deals on eBay:

```
Watchman (Python poller)
    │ scrapes eBay FixedPrice listings
    │ runs 4-gate waterfall filter
    ▼
Conductor (FastAPI + SQLite)          ←── /evaluate endpoint
    │ budget circuit breaker
    │ GO / NO_GO decision
    ▼
Last-Mile Agent (Node.js / Stagehand + Browserbase)
    │ navigates to eBay listing in cloud browser
    │ extracts PSA cert number + price
    │ verifies cert prefix + price lock
    │ proceeds to checkout confirmation (credential-masked)
    │ saves screenshot + DOM snapshot to receipts/
    ▼
Conductor /agent/result endpoint
    └─ updates Deal status → BOUGHT or REJECTED
       creates AuditLog row
```

**Core principle:** Zero AI in financial decisions. The LLM only reads pages and acts on them. The Conductor enforces all guardrails deterministically.

---

## Quick Start

**Prerequisites:** Python ≥3.12, Node ≥20.19.0, uv installed (`curl -LsSf https://astral.sh/uv/install.sh | sh`)

```bash
# 1. Clone / enter project
cd cardAgentPOC

# 2. Copy env template and fill in credentials
cp .env.example .env
# Edit .env with real BROWSERBASE_API_KEY, GOOGLE_API_KEY, EBAY_USERNAME, EBAY_PASSWORD

# 3. Install Python dependencies
uv sync

# 4. Seed the database with mock data
uv run python -m backend.seed
# Expected output: [seed] Done. 7 want_list items | 6 portfolio items | 10 deals (2 with audit logs).

# 5. Terminal 1 — Start the Conductor
uv run uvicorn backend.main:app --reload

# 6. Terminal 2 — Start the Watchman
uv run python -m backend.monitor

# 7. Terminal 3 — Manually trigger the agent for a specific deal
cd agent && npm install
npx ts-node checkout.ts '{"deal_id":6,"url":"https://www.ebay.com/itm/402819374650","max_allowed_price":350.00,"expected_cert_prefix":"POKE"}'
```

---

## Database Schema

**File:** `backend/db/cardhero.db` (SQLite, auto-created on first run)

### `want_list`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| name | TEXT | e.g. "Charizard ex" |
| grade | TEXT | e.g. "PSA 10" |
| max_price | REAL | Absolute ceiling including tax + shipping |
| cert_prefix | TEXT | Expected PSA cert prefix, e.g. "POKE" |
| target_id | TEXT | eBay search term anchor |
| set_name | TEXT | e.g. "Obsidian Flames" |
| year | INTEGER | |
| is_active | BOOLEAN | Soft disable without deleting |
| created_at | DATETIME | |

### `portfolio`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| name | TEXT | |
| grade | TEXT | |
| purchase_price | REAL | |
| current_value | REAL | Mark-to-market estimate |
| cert_number | TEXT UNIQUE | e.g. "POKE-48291033" |
| purchase_date | DATE | |
| set_name | TEXT | |
| year | INTEGER | |
| notes | TEXT | Human notes |

### `deals`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| want_list_id | INTEGER FK | → want_list.id |
| url | TEXT | Full eBay listing URL |
| price | REAL | Listed price |
| shipping | REAL | |
| tax_estimate | REAL | price × TAX_RATE |
| landed_cost | REAL | price + shipping + tax |
| **status** | TEXT | `PENDING` → `ANALYZING` → `BOUGHT` or `REJECTED` |
| watchman_score | REAL | 0.0–1.0 composite quality score |
| seller_username | TEXT | |
| seller_rating | REAL | e.g. 99.8 |
| seller_feedback_count | INTEGER | |
| ebay_item_id | TEXT | Extracted from URL |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### `audit_log`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| deal_id | INTEGER FK UNIQUE | → deals.id |
| agent_extraction_json | TEXT | Raw JSON from stagehand.extract() |
| screenshot_path | TEXT | e.g. "receipts/deal_7_2024-03-27T09-15-00.png" |
| dom_snapshot_path | TEXT | |
| verified_cert | TEXT | Cert number the agent found |
| price_locked | REAL | Price the agent saw on the page |
| session_id | TEXT | Browserbase session ID |
| created_at | DATETIME | |

---

## Waterfall Filter Logic (`backend/monitor.py`)

4 sequential gates — any failure short-circuits to the next listing:

```
Gate 1 — Title Sanitization
  Any of these in title (case-insensitive) → SKIP:
  "proxy", "reprint", "digital", "read", "custom", "fake", "lot"

Gate 2 — Math Gate (Landed Cost)
  landed_cost = price + shipping + (price × TAX_RATE)
  if landed_cost > want_item.max_price → SKIP

Gate 3 — Seller Rating
  if seller_rating < 98.0 → SKIP

Gate 4 — Seller Feedback Count
  if seller_feedback_count < 100 → SKIP

PASS → calculate watchman_score → POST to /evaluate
```

**Watchman Score Formula** (0.0–1.0):
```
score = (1 - price/max_price)         × 0.50   # price headroom
      + ((seller_rating - 98) / 2)    × 0.30   # seller quality
      + min(feedback_count / 1000, 1) × 0.10   # seller experience
      + (0.10 if shipping == 0 else 0)          # free shipping bonus
```

---

## `/evaluate` Decision Tree (`backend/main.py`)

```
POST /evaluate  {want_list_id, url, price, shipping, seller_username, seller_rating, seller_feedback_count, watchman_score}
    │
    ├─ WantList item exists + is_active? ──No──→ 404
    │
    ├─ landed_cost > max_price? ──────────Yes──→ NO_GO: "over_max_price"
    │
    ├─ landed_cost > budget_remaining? ───Yes──→ NO_GO: "daily_budget_exceeded"
    │   (budget_remaining = DAILY_SPEND_LIMIT - sum of today's BOUGHT landed_costs)
    │
    ├─ URL already in non-REJECTED deals? Yes──→ NO_GO: "duplicate_listing"
    │
    └─ All clear ──────────────────────────────→ GO
        Creates Deal row with status=ANALYZING
        Returns deal_id to caller
```

---

## Stagehand v3 — Credential Masking

**Package:** `@browserbasehq/stagehand@^3.2.0`
**Node requirement:** ≥20.19.0

```typescript
// Constructor — model is a plain string, keys read from env automatically
const stagehand = new Stagehand({
  env: "BROWSERBASE",
  model: "google/gemini-2.5-flash",
  // reads: BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, GOOGLE_API_KEY
});
await stagehand.init();
const page = stagehand.page; // Playwright Page object

// Credential masking — variables{} values NEVER sent to LLM
// Stagehand substitutes them into DOM interactions only
await stagehand.act({
  action: "type %password% into the password field",
  variables: { password: process.env.EBAY_PASSWORD! },
});

// Structured extraction with Zod
const data = await stagehand.extract({
  instruction: "extract the PSA cert number and price",
  schema: z.object({ cert_number: z.string(), price: z.number() }),
});
```

---

## Key File Index

```
backend/
  database.py   → SQLAlchemy ORM models + engine singleton + init_db() + get_db()
  main.py       → FastAPI Conductor: /evaluate, /agent/result, /deals, /portfolio, /health
  monitor.py    → Watchman: build_ebay_url → scrape_listings → run_waterfall → post_to_conductor → trigger_agent
  seed.py       → Idempotent DB seeder: run before first start
  seeds/
    want_list.json  → 7 PSA graded card targets
    history.json    → 6 portfolio cards + 10 historical deals (mock data)

agent/
  checkout.ts   → Last-Mile agent: Stagehand init → extract → cert guard → price guard → login → checkout → screenshot → /agent/result

receipts/       → Screenshot + DOM snapshots output (created by agent)
.env.example    → Copy to .env, fill in real credentials
pyproject.toml  → uv-managed Python project (fastapi, sqlalchemy, etc.)
```

---

## Security Invariants

These must never be changed without understanding the implications:

1. **LLM never sees credentials.** Stagehand's `variables: { key: value }` pattern substitutes values into DOM interactions only — the LLM receives `%password%` as a token, not the actual string.

2. **Price lock before any act().** In `checkout.ts`, the price guard (Step 3) executes before any `stagehand.act()` call. The agent cannot proceed to checkout with an incorrect price.

3. **Ephemeral Browserbase sessions.** `stagehand.init()` creates a new isolated session each run. No cookies or history persist. `stagehand.close()` always called in the `finally` block.

4. **Conductor enforces budget, not agent.** The agent has no access to the daily spend limit or budget logic — it only acts on the specific URL and price it was given. The Conductor rejects deals before the agent is triggered.

5. **No PII in DB.** The AuditLog stores the agent's extraction JSON and Browserbase session ID — no payment info, no full billing address.

---

## API Reference (Quick)

```bash
GET  /health                     # system status + daily spend
GET  /want-list                  # all active want list items (7)
GET  /portfolio                  # all portfolio cards + unrealized P&L
GET  /deals?status=PENDING       # filter deals by status
GET  /deals/{id}                 # single deal + audit log
PATCH /deals/{id}/status         # {"status": "REJECTED"}
POST /evaluate                   # watchman → conductor handoff
POST /agent/result               # agent → conductor callback
```

---

## Debugging

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `422 Unprocessable Entity` on `/evaluate` | `want_list_id` doesn't exist | Run `uv run python -m backend.seed` first |
| Watchman scrapes 0 listings | eBay updated their HTML selectors | Update `s-item__wrapper` selectors in `monitor.py` |
| Agent crashes on `stagehand.init()` | Missing env vars | Verify `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `GOOGLE_API_KEY` in `.env` |
| `Error: Node version X is not supported` | Node too old | Upgrade to Node ≥20.19.0 |
| `/agent/result` 404 | Wrong `deal_id` | Check the deal was created: `GET /deals?status=ANALYZING` |
| `ts-node: command not found` | npm deps missing | Run `cd agent && npm install` |
