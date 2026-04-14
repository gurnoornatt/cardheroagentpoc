# CardHero Agent POC — Engineer Onboarding

Everything you need to get up to speed. Read this before touching any code.

---

## The Mission

Automatically buy underpriced PSA-graded Pokémon cards on eBay before anyone else does.

You have a want list of cards with max prices. The system watches eBay 24/7, finds deals, verifies they're legit, and walks through checkout — no human clicking required. All financial guardrails are deterministic (no LLM in the money path).

---

## The Three Layers

```
WATCHMAN (Python)
  Searches eBay via Apify API every few minutes
  Applies 4-gate waterfall filter (slop keywords, landed cost, seller rating, feedback)
  Posts passing deals to Conductor

CONDUCTOR (FastAPI + SQLite)
  Pure deterministic rules — no LLM
  Checks: daily budget, duplicate URL, price vs max_price
  Says GO or NO_GO
  On GO: creates Deal row (status=ANALYZING), triggers Agent

AGENT (Node.js / Stagehand + Browserbase)
  Opens real cloud browser session
  Navigates to eBay listing
  Extracts PSA cert number + price using GPT-4o-mini
  Walks through checkout (guest checkout only, sub-$5k listings)
  Takes screenshot as proof
  Reports back to Conductor → deal becomes BOUGHT or REJECTED
```

---

## Current Tech Stack

| Layer | Tech | Notes |
|-------|------|-------|
| Watchman | Python + Apify API | Replaced fragile BeautifulSoup HTML scraping |
| Conductor | FastAPI + SQLAlchemy + SQLite | Runs on Railway, port 8001 |
| Agent | TypeScript + Stagehand v3 + Browserbase | Cloud browser, runs on Railway |
| Frontend | React + Vite + TailwindCSS | `newpoc/lab/` |
| Scraping | Apify `delicious_zebu~ebay-product-listing-scraper` | $0.002/result |
| LLM (agent) | `openai/gpt-4o-mini` | Via OPENAI_API_KEY, 500k TPM |
| LLM (A/B lab) | Multiple via OpenRouter | Gemini, GPT, Claude compared |

---

## Repo Structure

```
cardAgentPOC/
  newpoc/
    backend/
      main.py          → FastAPI Conductor: all API endpoints
      monitor.py       → Watchman: Apify scraper + waterfall filter
      database.py      → SQLAlchemy models
      config.py        → env var constants
      seed.py          → seed DB with mock want list + deals
      sentiment.py     → seller sentiment scoring
    agent/
      checkout.ts      → Last-Mile Agent (Stagehand v3)
      package.json     → ts-node + typescript in dependencies (not devDeps)
    lab/
      src/
        pages/Home.tsx → main UI (pipeline runner + scraper lab)
        lib/api.ts     → all API calls typed
        lib/utils.ts   → helpers
    .env               → local secrets (never commit)
    test_pipeline.py   → batch test runner for real eBay listings
  ONBOARD.md           → this file
  CLAUDE.md            → system architecture reference
```

---

## Environment Variables

All of these must be set in `.env` locally and in Railway:

```
BROWSERBASE_API_KEY       Browserbase cloud browser
BROWSERBASE_PROJECT_ID    Browserbase project
OPENAI_API_KEY            GPT-4o-mini for Stagehand agent
OPENROUTER_API_KEY        A/B lab model comparisons
ANTHROPIC_API_KEY         Available but not currently used (ran out of credits)
GOOGLE_API_KEY            Available but not currently used (free tier quota issues)
APIFY_API_TOKEN           Apify scraping API
EBAY_USERNAME             eBay account email
EBAY_PASSWORD             eBay account password
RESIDENTIAL_PROXY_URL     Smartproxy residential (set but not actively tested)
AGENT_BUDGET              Max spend per session
SHIPPING_*                Shipping address fields for checkout form
```

---

## How to Run Locally

```bash
# 1. Install Python deps
uv sync

# 2. Seed the database (run once)
uv run python -m newpoc.backend.seed

# 3. Start Conductor (Terminal 1)
uv run uvicorn newpoc.backend.main:app --port 8001 --reload

# 4. Start Watchman (Terminal 2)
uv run python -m newpoc.backend.monitor

# 5. Start frontend (Terminal 3)
cd newpoc/lab && npm install && npm run dev

# 6. Run batch pipeline test
uv run python newpoc/test_pipeline.py
# or against Railway:
uv run python newpoc/test_pipeline.py https://your-app.up.railway.app
```

---

## Stagehand v3 API — Critical Patterns

**The #1 thing that breaks everything if wrong:**

```typescript
// WRONG (v2 style — throws StagehandInvalidArgumentError):
await stagehand.act({ action: "click the button", variables: { x: "y" } });

// CORRECT (v3):
await stagehand.act("click the button");
await stagehand.act("type %email% into the field", { variables: { email: "x@y.com" } });
```

**Model string format:**
```typescript
"openai/gpt-4o-mini"                    // current
"anthropic/claude-haiku-4-5-20251001"   // was using, no credits
"google/gemini-2.5-flash"               // hit free tier quota (20 RPM)
```

**Page navigation:**
```typescript
// timeout is timeoutMs not timeout
await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 45000 });
```

**Getting the page object:**
```typescript
const page = stagehand.context.pages()[0]; // v3 — NOT stagehand.page
```

---

## Apify Integration

**What's integrated:** `delicious_zebu~ebay-product-listing-scraper`
- Replaces BeautifulSoup HTML scraping in `monitor.py`
- Input field: `listingUrls` (NOT `startUrls`, NOT `listingPageUrls`)
- Must use async run + poll approach (sync endpoint returns cached data)
- Returns: title, price, shipping (parsed from card_attribute), product_url
- Does NOT return: seller rating, seller feedback count, PSA cert number
- Falls back to HTML scraper if `APIFY_API_TOKEN` not set

```python
# Correct API call pattern (from monitor.py):
run_resp = requests.post(f"{base}/acts/{actor}/runs",
    params={"token": token},
    json={"listingUrls": [search_url]})
# Poll /actor-runs/{id} every 5s until SUCCEEDED
# Then GET /datasets/{dataset_id}/items
```

**What we tested and ruled out:**
- `delicious_zebu/ebay-product-details-scraper` → requires paid rental subscription
- `memo23/apify-ebay-search-cheerio` → requires paid rental subscription
- `parseforge/ebay-scraper` → ran, returned 0 items
- Direct HTTP to eBay listing → eBay times out the connection (bot detection)

**Bottom line on cert extraction:** Currently only Browserbase can reliably get the cert number from a listing page. The cert is in "Item Specifics" but no free scraper reaches it.

---

## Browserbase Live View

The agent fetches the debug URL right after `stagehand.init()`:

```typescript
// Correct endpoint — /debug, NOT the session object itself
const debugResp = await axios.get(
  `https://api.browserbase.com/v1/sessions/${sessionId}/debug`,
  { headers: { "x-bb-api-key": process.env.BROWSERBASE_API_KEY! } }
);
const liveUrl = debugResp.data.debuggerFullscreenUrl + "?navbar=false";
await postLog(deal_id, `[BB_SESSION_URL] ${liveUrl}`);
```

The UI parses `[BB_SESSION_URL]` from the log stream and renders an iframe during the run. After the session ends the iframe URL is no longer valid — recording is at `browserbase.com/sessions` dashboard (no direct deep-link URL exists).

---

## Known Issues / Current State

| Issue | Status | Notes |
|-------|--------|-------|
| Cert NOT_FOUND | Active | GPT-4o-mini can't find cert if seller didn't put it in page text |
| HTML scraper returns 0 | Expected | eBay blocks direct requests — Apify is the replacement |
| Seller rating defaults | Accepted | Apify search doesn't return seller info, defaults to 99.0/100 |
| dry_run always = REJECTED | Intentional | REJECTED in test mode means success (reached checkout) |
| Browserbase iframe | Working | Live during session, dead after |

---

## LLM Decision Log

Why we're on GPT-4o-mini:

- `google/gemini-2.5-flash` → hit free tier quota (20 RPM cap regardless of billing credits)
- `anthropic/claude-sonnet-4-6` → 30k TPM, eBay pages use ~40k tokens, constant rate limits
- `anthropic/claude-haiku-4-5-20251001` → 100k TPM but ran out of Anthropic credits
- `openai/gpt-4o-mini` → 500k TPM, $0.15/1M input (5x cheaper than Haiku), credits available

---

## The Bigger Vision (from Sukhpreet)

The current Browserbase approach is correct for a POC but too slow (2-3 min/run) for production. The target architecture is a pure request-based bot:

- Rotating residential proxies + spoofed browser fingerprints
- No actual browser spinning up
- 5-10 seconds per full checkout attempt

**Blocker:** eBay's bot detection kills plain HTTP requests. Need residential proxy infrastructure (like what Apify uses internally). Checkout also has CSRF tokens and payment form complexity that's hard to replicate without a browser.

**Practical bridge step:** Rent `delicious_zebu/ebay-product-details-scraper` (~$10-15/month) to pull cert numbers from Item Specifics via Apify's proxy infrastructure. Cuts Browserbase session work roughly in half. Evaluate from there.

---

## Test Listings

Good listings for testing the full pipeline (all sub-$5k = guest checkout):

| URL | Card | Price | Notes |
|-----|------|-------|-------|
| ebay.com/itm/397807872789 | PSA 8 Charizard ex SIR | $400 | Works end-to-end, cert NOT_FOUND |
| ebay.com/itm/137131098897 | PSA 10 Moonbreon Hyper Alt | $1,550 | Sub-$5k guest checkout |
| ebay.com/itm/137035773539 | PSA 10 Moonbreon | $5,200 | Over $5k, skip for now |

Set max_price $200+ above the listing price to ensure price guard passes.

---

## Deployment

Hosted on Railway. Auto-deploys from `main` branch on push.

The backend serves both the API and the frontend static build. Agent runs as a subprocess spawned by the backend when a deal gets a GO decision.

After pushing, Railway rebuilds — takes ~3-5 minutes. Check Railway logs if anything breaks after deploy.
