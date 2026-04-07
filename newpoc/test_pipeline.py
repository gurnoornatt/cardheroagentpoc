#!/usr/bin/env python3
"""
CardHero pipeline test runner.

Runs a batch of real eBay listings through the full pipeline and prints a summary.
Stops before confirming payment (dry_run=True).

Usage:
  uv run python newpoc/test_pipeline.py                          # localhost:8001
  uv run python newpoc/test_pipeline.py https://your.railway.app # Railway
"""
import json
import sys
import time

import requests

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8001"

# ── Test cases ────────────────────────────────────────────────────────────────
# fmt: off
TESTS = [
    {
        "label":     "PSA 8 Charizard ex SIR",
        "url":       "https://www.ebay.com/itm/397807872789",
        "max_price": 500.0,
        "note":      "sub-$5k → guest checkout path",
    },
    {
        "label":     "PSA 10 Moonbreon Hyper Alt",
        "url":       "https://www.ebay.com/itm/137131098897",
        "max_price": 1800.0,
        "note":      "sub-$5k → guest checkout path",
    },
    {
        "label":     "PSA 10 Moonbreon (high-value)",
        "url":       "https://www.ebay.com/itm/137035773539",
        "max_price": 5500.0,
        "note":      "over $5k → eBay forces login, tests auth flow",
    },
]
# fmt: on

POLL_INTERVAL = 5   # seconds between status checks
TIMEOUT       = 300 # 5 minutes max per deal


# ── Helpers ───────────────────────────────────────────────────────────────────

def poll(deal_id: int) -> dict | None:
    start = time.time()
    while time.time() - start < TIMEOUT:
        try:
            r = requests.get(f"{BASE}/deals/{deal_id}", timeout=10)
            deal = r.json()
            status = deal["status"]
            elapsed = int(time.time() - start)
            print(f"    [{elapsed:>3}s] {status}", flush=True)
            if status in ("BOUGHT", "REJECTED"):
                return deal
        except Exception as e:
            print(f"    poll error: {e}", flush=True)
        time.sleep(POLL_INTERVAL)
    return None


def fmt_result(deal: dict) -> None:
    audit = deal.get("audit_log") or {}
    status = deal["status"]
    icon = "✓" if status == "BOUGHT" else "✗"
    print(f"\n  {icon} Final status : {status}")
    print(f"    Cert found   : {audit.get('verified_cert') or 'NOT_FOUND'}")
    print(f"    Price locked : {('$' + str(audit.get('price_locked'))) if audit.get('price_locked') else '—'}")
    print(f"    Screenshot   : {audit.get('screenshot_path') or 'none'}")
    if status == "REJECTED":
        try:
            reason = json.loads(audit.get("agent_extraction_json") or "{}").get(
                "_rejection_reason", "—"
            )
            print(f"    Reason       : {reason[:120]}")
        except Exception:
            pass


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"CardHero pipeline test → {BASE}")
    print(f"Running {len(TESTS)} tests sequentially (dry_run=True, won't confirm payment)\n")

    # Quick health check
    try:
        h = requests.get(f"{BASE}/health", timeout=5).json()
        print(f"Backend: {h['status']} | budget remaining: ${h['budget_remaining']:.2f}\n")
    except Exception as e:
        print(f"Cannot reach backend at {BASE}: {e}")
        print("Start it first:  uv run uvicorn newpoc.backend.main:app --port 8001")
        sys.exit(1)

    results = []

    for i, test in enumerate(TESTS, 1):
        print(f"{'─'*60}")
        print(f"[{i}/{len(TESTS)}] {test['label']}")
        print(f"  URL      : {test['url']}")
        print(f"  Max price: ${test['max_price']}")
        print(f"  Note     : {test['note']}")
        print()

        # Kick off pipeline
        try:
            r = requests.post(
                f"{BASE}/pipeline/run",
                json={"url": test["url"], "max_price": test["max_price"], "dry_run": True},
                timeout=15,
            )
            r.raise_for_status()
            deal_id = r.json()["deal_id"]
            print(f"  Deal #{deal_id} created — polling…")
        except Exception as e:
            print(f"  FAILED to start pipeline: {e}")
            results.append({**test, "outcome": "PIPELINE_ERROR", "deal_id": None})
            continue

        # Wait for terminal status
        deal = poll(deal_id)
        if deal is None:
            print(f"\n  ⚠ TIMEOUT — deal #{deal_id} still ANALYZING after {TIMEOUT}s")
            results.append({**test, "outcome": "TIMEOUT", "deal_id": deal_id})
        else:
            fmt_result(deal)
            results.append({**test, "outcome": deal["status"], "deal_id": deal_id})

        print()

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    for r in results:
        icon = "✓" if r["outcome"] == "BOUGHT" else ("⚠" if r["outcome"] == "TIMEOUT" else "✗")
        deal_ref = f"#{r['deal_id']}" if r["deal_id"] else "—"
        print(f"  {icon} {r['label']:<35} {r['outcome']:<12} deal {deal_ref}")


if __name__ == "__main__":
    main()
