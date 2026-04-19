# CardHero "Last-Mile" Engine v2 — The Scalpel

## Monorepo Layout

```
newpoc/
  backend/        ← Python/FastAPI: Conductor + Watchman + Sentiment
    db/           ← SQLite database file (auto-created)
  agent/          ← Node.js/Stagehand: Last-Mile checkout agent
  lab/            ← CardHero Lab dashboard (metrics + A/B testing)
  receipts/       ← Screenshots + DOM snapshots from agent runs
  .env            ← Copy from .env.example, fill in real credentials
  .env.example    ← Env template
```

**Python deps:** managed by the parent repo's `pyproject.toml` + `uv`.  
**Node deps:** each of `agent/` and `lab/` have their own `package.json`.  
**Env:** `newpoc/.env` — scoped to this POC only.

---

## System Overview

A three-layer deterministic pipeline that hunts PSA-graded Pokémon card deals on eBay:

```
Watchman (Python poller)
    │ scrapes eBay BIN + Auction listings
    │ Slop Filter → Landed Cost Gate → Seller Gate
    │ categorizes: AUCTION (price discovery) | BUY_IT_NOW (immediate action)
    ▼
Conductor (FastAPI + SQLite)          ←── /evaluate endpoint
    │ IQR Math Gate → Sanitized Market Average
    │ Historical Snapshot → $100+ undervalue trigger
    │ Sentiment Modifier (Reddit, ±5–10% weight)
    │ Budget Circuit Breaker
    │ GO / NO_GO decision → status = ANALYZING
    ▼
Last-Mile Agent (Node.js / Stagehand + Browserbase)
    │ reuses persistent Browserbase session (bypasses login/CAPTCHA)
    │ PSA Oracle Harvest: extracts Grade 10 pop vs Total Pop
    │ Cert Verification: extracts PSA Cert # + validates prefix
    │ Price Lock: verifies checkout price === Conductor's max_allowed_price
    │ Authenticity Guarantee check (high-value items)
    │ Confirm and pay via CSS selector or page.act()
    │ saves screenshot + DOM snapshot to receipts/
    ▼
Conductor /agent/result endpoint
    └─ updates Deal → BOUGHT or REJECTED
       creates AuditLog row
       fires Tier 3 push notification
```

**Core principle:** Zero AI in financial decisions. LLM only reads pages and acts on them. Conductor enforces all guardrails deterministically.

---

## Quick Start

**Prerequisites:** Python ≥3.12, Node ≥20.19.0, `uv` installed

```bash
# From repo root (cardAgentPOC/)
cp newpoc/.env.example newpoc/.env
# Fill in real credentials in newpoc/.env

# Python backend (uses root pyproject.toml)
uv run uvicorn newpoc.backend.main:app --reload --port 8001

# Watchman
uv run python -m newpoc.backend.monitor

# Agent
cd newpoc/agent && npm install
npx ts-node checkout.ts '{"deal_id":1,"url":"...","max_allowed_price":350.00,"expected_cert_prefix":"POKE"}'

# Lab dashboard
cd newpoc/lab && npm install && npm run dev
```

---

## Database Schema

**File:** `newpoc/backend/db/cardhero.db`

### `want_list`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| name | TEXT | e.g. "Umbreon VMAX" |
| grade | TEXT | e.g. "PSA 10" |
| max_price | REAL | Absolute ceiling incl. tax + shipping |
| cert_prefix | TEXT | Expected PSA cert prefix, e.g. "POKE" |
| target_id | TEXT | eBay search term anchor |
| set_name | TEXT | |
| year | INTEGER | |
| is_active | BOOLEAN | |
| created_at | DATETIME | |

### `price_history`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| want_list_id | INTEGER FK | |
| week_start | DATE | ISO week Monday |
| raw_prices | TEXT | JSON array of observed prices that week |
| iqr_low | REAL | Q1 − 1.5×IQR |
| iqr_high | REAL | Q3 + 1.5×IQR |
| sanitized_avg | REAL | Mean of prices within IQR bounds |
| sample_count | INTEGER | |
| created_at | DATETIME | |

### `deals`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| want_list_id | INTEGER FK | |
| url | TEXT | Full eBay listing URL |
| listing_type | TEXT | `BUY_IT_NOW` or `AUCTION` |
| price | REAL | |
| shipping | REAL | |
| tax_estimate | REAL | price × TAX_RATE |
| landed_cost | REAL | price + shipping + tax |
| status | TEXT | `PENDING` → `ANALYZING` → `BOUGHT` or `REJECTED` |
| watchman_score | REAL | 0.0–1.0 |
| sentiment_score | REAL | −1.0 to 1.0 (Reddit signal) |
| sentiment_weight | REAL | Effective weight applied (capped at 0.10) |
| undervalue_delta | REAL | sanitized_avg − landed_cost |
| seller_username | TEXT | |
| seller_rating | REAL | |
| seller_feedback_count | INTEGER | |
| ebay_item_id | TEXT | |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### `audit_log`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| deal_id | INTEGER FK UNIQUE | |
| agent_extraction_json | TEXT | Raw stagehand.extract() output |
| psa_pop_grade10 | INTEGER | Grade 10 population |
| psa_pop_total | INTEGER | Total population |
| screenshot_path | TEXT | |
| dom_snapshot_path | TEXT | |
| verified_cert | TEXT | Cert # agent found on page |
| price_locked | REAL | Price agent saw at checkout |
| authenticity_guaranteed | BOOLEAN | |
| session_id | TEXT | Browserbase session ID |
| model_used | TEXT | e.g. "google/gemini-2.5-flash" |
| extraction_latency_ms | INTEGER | |
| created_at | DATETIME | |

### `lab_runs`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| deal_id | INTEGER FK | |
| model | TEXT | "gemini-2.5-flash", "claude-sonnet-4-6", "gpt-4o" |
| extracted_cert | TEXT | |
| extracted_price | REAL | |
| extracted_pop_grade10 | INTEGER | |
| extracted_pop_total | INTEGER | |
| ground_truth_cert | TEXT | Manual verification |
| cert_correct | BOOLEAN | |
| price_correct | BOOLEAN | |
| latency_ms | INTEGER | |
| created_at | DATETIME | |

---

## Conductor Decision Tree (`/evaluate`)

```
POST /evaluate
    │
    ├─ WantList item exists + is_active? ──No──→ 404
    │
    ├─ listing_type == AUCTION? ──────────Yes──→ record price_history only, return AUCTION_NOTED
    │
    ├─ landed_cost > max_price? ──────────Yes──→ NO_GO: "over_max_price"
    │
    ├─ landed_cost > budget_remaining? ───Yes──→ NO_GO: "daily_budget_exceeded"
    │
    ├─ duplicate URL in non-REJECTED? ────Yes──→ NO_GO: "duplicate_listing"
    │
    ├─ sanitized_avg exists AND
    │  (sanitized_avg - landed_cost) < 100? Yes─→ NO_GO: "insufficient_undervalue"
    │
    ├─ sentiment_score applies?
    │  effective_weight = min(abs(sentiment_score) × 0.10, 0.10)
    │  adjust watchman_score ±effective_weight
    │
    └─ All clear ──────────────────────────────→ GO
        Creates Deal row, status=ANALYZING
        Returns deal_id
```

---

## Watchman Filter Waterfall (`backend/monitor.py`)

```
Gate 1 — Slop Filter
  Title contains (case-insensitive): "proxy", "reprint", "digital", "read",
  "custom", "fake", "lot" → SKIP

Gate 2 — Landed Cost Gate
  landed_cost = price + shipping + (price × TAX_RATE)
  landed_cost > want_item.max_price → SKIP

Gate 3 — Seller Rating
  seller_rating < 98.0 → SKIP

Gate 4 — Seller Feedback
  seller_feedback_count < 100 → SKIP

Gate 5 — Listing Type Split
  AUCTION → POST /price-history (data ingestion only)
  BUY_IT_NOW → POST /evaluate (full decision pipeline)
```

---

## Stagehand v3 Patterns

```typescript
// Constructor
const stagehand = new Stagehand({
  env: "BROWSERBASE",
  model: "google/gemini-2.5-flash",
  browserbaseSessionID: process.env.BROWSERBASE_SESSION_ID, // persistent session
});
await stagehand.init();
const page = stagehand.page;

// Credential masking — values NEVER sent to LLM
await stagehand.act({
  action: "type %password% into the password field",
  variables: { password: process.env.EBAY_PASSWORD! },
});

// Structured extraction with Zod
const data = await stagehand.extract({
  instruction: "extract PSA cert number, listing price, and PSA Grade 10 pop vs Total pop",
  schema: z.object({
    cert_number: z.string(),
    price: z.number(),
    psa_pop_grade10: z.number().optional(),
    psa_pop_total: z.number().optional(),
    authenticity_guaranteed: z.boolean().optional(),
  }),
});
```

---

## Anti-Detection Layer (v2.1)

### Step 3.3 — Residential Proxy Bridge

Browserbase datacenter IPs trigger eBay hCaptcha on every guest checkout. Fix: route the session through a residential proxy with sticky sessions so the IP doesn't rotate between checkout pages.

**Constructor logic (`newpoc/agent/checkout.ts`):**
```typescript
const proxyUrl = process.env.RESIDENTIAL_PROXY_URL; // http://user:pass@host:port

const stagehand = new Stagehand({
  env: "BROWSERBASE",
  model: MODEL_USED,
  ...(sessionId
    ? { browserbaseSessionID: sessionId }
    : {
        browserbaseSessionCreateParams: {
          projectId: process.env.BROWSERBASE_PROJECT_ID!,
          ...(proxyUrl ? {
            proxies: [{ type: "external", server: proxyUrl }],
          } : {}),
          browserSettings: {
            solveCaptchas: true,   // secondary fallback if proxy fails
            viewport: { width: 1920, height: 1080 },
          },
        },
      }),
});
```

**Sticky session requirement:** Must be configured at the proxy provider level (not in code). When purchasing a residential proxy, enable "sticky session" mode so all requests in a single checkout flow share one IP. eBay re-challenges if the IP changes between "Review Order" and "Confirm."

**Verification:** After a run, check `audit_log.session_id` in the DB and look up the session in the Browserbase dashboard. The IP's ISP field should show a residential carrier (Comcast, AT&T, Verizon), not Amazon or Google Cloud.

---

### Step 3.4 — Behavioral Humanization

Add timing randomness and cursor jitter before high-stakes interactions to avoid heuristic bot detection.

**Implementation in `checkout.ts` before the "Confirm and pay" act call:**
```typescript
// Random delay 1.5s–3s before confirm
const delay = 1500 + Math.random() * 1500;
await sleep(delay);

// Cursor jitter: small random moves before clicking
const jitterSteps = 3 + Math.floor(Math.random() * 3);
for (let i = 0; i < jitterSteps; i++) {
  await page.mouse.move(
    600 + Math.random() * 200,
    400 + Math.random() * 150,
    { steps: 5 }
  );
  await sleep(80 + Math.random() * 120);
}

await stagehand.act("click the Confirm and pay button");
```

Note: Behavioral humanization is a secondary defense. With a residential IP, eBay's hCaptcha trigger is neutralized at the source. Cursor jitter addresses fingerprint-based heuristics (mouse acceleration patterns) that fire after the IP check passes.

---

### Step 3.5 — Cost Guardrail (Proxy Data Cap)

Cap proxy data usage at 5MB per agent run to keep residential proxy costs ≤$0.50 per acquisition. Since Browserbase does not expose real-time bandwidth via API, implement a **time-based proxy** for the cap: assume ~1MB/12s of active browsing (conservative). Terminate session if elapsed time exceeds 60s on any single checkout page.

```typescript
const PAGE_TIMEOUT_MS = 60_000; // 1 min per page = ~5MB cap proxy
```

Set this as the `timeout` on `page.waitForNavigation()` and `page.waitForSelector()` calls. If exceeded, fall through to the REJECTED path with `rejection_reason: "proxy_timeout"`.

**Actual data tracking (if proxy provider exposes API):** Check provider dashboard after first 10 runs to calibrate real MB/run. Adjust `PAGE_TIMEOUT_MS` if usage is consistently under or over 5MB.

---

### Environment Variables (Anti-Detection)

| Variable | Purpose |
|----------|---------|
| `RESIDENTIAL_PROXY_URL` | `http://user:pass@host:port` — sticky residential proxy from Smartproxy/Bright Data |

---

## Security Invariants

1. **LLM never sees credentials.** Stagehand `variables: {}` substitutes into DOM only.
2. **Price lock before any act().** Price guard runs before `stagehand.act()` — no checkout with wrong price.
3. **Persistent sessions are read-only logins.** Session refresh ("Clerk") is a separate manual flow.
4. **Conductor enforces budget, not agent.** Agent has no access to spend limits.
5. **Sentiment cannot flip a NO_GO to GO.** Weight capped at ±10% of watchman_score only.
6. **Autonomous authority threshold.** Deals > AGENT_BUDGET require push notification approval before act().
7. **No PII in DB.** AuditLog stores session ID and extraction JSON only — no payment info.

---

## API Reference

```bash
# Conductor
GET  /health                      # system status, daily spend, budget remaining
GET  /want-list                   # active want list items
GET  /deals?status=ANALYZING      # filter by status
GET  /deals/{id}                  # single deal + audit log
PATCH /deals/{id}/status          # {"status": "REJECTED"}
POST /evaluate                    # Watchman → Conductor handoff (BIN listings)
POST /price-history               # Watchman → Conductor ingestion (Auction listings)
POST /agent/result                # Agent → Conductor callback

# Lab
GET  /lab/runs                    # all extraction lab runs
GET  /lab/runs/{deal_id}          # compare models on a specific deal
POST /lab/runs                    # submit a new lab extraction run
GET  /lab/metrics                 # cull rate, avg latency, cert accuracy by model
```

---

## Environment Variables

See `.env.example` for the full list. Key vars:

| Variable | Purpose |
|----------|---------|
| `BROWSERBASE_API_KEY` | Browserbase auth |
| `BROWSERBASE_PROJECT_ID` | Browserbase project |
| `BROWSERBASE_SESSION_ID` | Persistent session ID (refresh periodically) |
| `GOOGLE_API_KEY` | Gemini model for Stagehand |
| `ANTHROPIC_API_KEY` | Sonnet model for Lab A/B |
| `OPENAI_API_KEY` | GPT model for Lab A/B |
| `EBAY_USERNAME` | eBay login |
| `EBAY_PASSWORD` | eBay login (masked in agent) |
| `DAILY_SPEND_LIMIT` | Budget circuit breaker (e.g. 500.00) |
| `AGENT_BUDGET` | Autonomous authority ceiling (e.g. 150.00) |
| `TAX_RATE` | e.g. 0.09 |
| `PRICE_TRIGGER_DELTA` | Undervalue threshold in $ (e.g. 100.00) |
| `REDDIT_CLIENT_ID` | Reddit API for sentiment |
| `REDDIT_CLIENT_SECRET` | Reddit API |
| `RESIDENTIAL_PROXY_URL` | Sticky residential proxy URL (`http://user:pass@host:port`) |

---

## Code Quality — Run Before Every Commit

Both tools are installed as dev deps (`uv add ruff vulture --dev`).

### Ruff (linter + formatter)
```bash
uv run ruff check newpoc/backend/      # lint — must return "All checks passed!"
uv run ruff format newpoc/backend/     # auto-format
```
Catches: unused imports, bare `== True` comparisons, style issues, modern Python syntax.
**FastAPI route handlers and Pydantic fields will NOT appear** — ruff understands decorators.

### Vulture (dead code)
```bash
uv run vulture newpoc/backend/ --min-confidence 80
```
Run at 80% confidence — 60% produces too many false positives from FastAPI/SQLAlchemy.
**Expected false positives at 60%:** FastAPI route functions (framework registers them via decorator), SQLAlchemy `relationship()` definitions (ORM wires them at query time), Pydantic model fields (used by serialization). These are NOT dead code.
**Real findings:** Unused local variables, unused loop counters (rename to `_`), imports that nothing reads.

### TypeScript (frontend)
```bash
cd newpoc/lab && npx tsc --noEmit     # must return 0 errors before any commit
```

### Checklist before committing
1. `uv run ruff check newpoc/backend/` → clean
2. `uv run vulture newpoc/backend/ --min-confidence 80` → clean
3. `cd newpoc/lab && npx tsc --noEmit` → 0 errors

---

## Debugging

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `insufficient_undervalue` on every deal | No price_history rows yet | Run Watchman for a full week to build history, or seed manually |
| Agent skips login (good) | Persistent session active | Expected behavior — session is valid |
| Agent hits login wall | Session expired | Run Clerk refresh flow, update `BROWSERBASE_SESSION_ID` in `.env` |
| Sentiment always 0.0 | Reddit API creds missing | Set `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| Lab dashboard shows no runs | No `lab_runs` rows | Submit a run via `POST /lab/runs` |
| hCaptcha image grid still appears | Proxy not configured or not sticky | Set `RESIDENTIAL_PROXY_URL`, confirm sticky mode in provider dashboard |
| Session ISP shows Amazon in audit log | `RESIDENTIAL_PROXY_URL` not set or falling back | Verify env var loaded: `console.log(process.env.RESIDENTIAL_PROXY_URL)` at agent start |
| Agent REJECTED with `proxy_timeout` | Page took >60s — proxy too slow | Try a different proxy region (US East for eBay.com) |
