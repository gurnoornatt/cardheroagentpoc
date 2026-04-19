"""
CardHero v2 — Watchman (eBay poller)

Scrapes eBay BIN and Auction listings for each active WantList item.
Applies a 5-gate waterfall filter before forwarding to the Conductor.

Gate 1 — Slop Filter (title keywords)
Gate 2 — Landed Cost Gate (price + shipping + tax vs max_price)
Gate 3 — Seller Rating (>= 98.0)
Gate 4 — Seller Feedback Count (>= 100)
Gate 5 — Listing Type Split:
  AUCTION   → POST /price-history  (data ingestion only)
  BUY_IT_NOW → POST /evaluate       → trigger_agent on GO

Run:  uv run python -m backend.monitor
"""

import json
import logging
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus

import requests
from bs4 import BeautifulSoup

from backend.config import (
    CONDUCTOR_URL,
    POLL_INTERVAL_SECONDS,
    SELLER_FEEDBACK_MIN,
    SELLER_RATING_MIN,
    SLOP_KEYWORDS,
    TAX_RATE,
)
from backend.database import SessionLocal, SystemMeta, WantList, init_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [watchman] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

EBAY_SEARCH_BASE = "https://www.ebay.com/sch/i.html"
APIFY_API_TOKEN = os.getenv("APIFY_API_TOKEN")
APIFY_ACTOR = "delicious_zebu~ebay-product-listing-scraper"

# Multi-platform actor registry.
# Set actor string when Apify paid plan is purchased; None = platform disabled (returns []).
PLATFORM_ACTORS: dict[str, str | None] = {
    "ebay":           APIFY_ACTOR,
    "mercari":        None,   # "h4sh/mercari-scraper" — enable when paid plan purchased
    "offerup":        None,   # "piotrv1001/offerup-listings-scraper"
    "fb_marketplace": None,   # "apify/facebook-marketplace-scraper"
}


@dataclass
class WantListProxy:
    """Lightweight stand-in for WantList ORM used by deal-hunt endpoint."""
    max_price: float
    name: str = ""

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


# ─────────────────────────────────────────────────────────────────────────────
# eBay URL builder
# ─────────────────────────────────────────────────────────────────────────────


def build_ebay_url(item: WantList, listing_type: str = "BUY_IT_NOW") -> str:
    """
    Build an eBay search URL for a want_list item.
    listing_type: "BUY_IT_NOW" → LH_BIN=1, "AUCTION" → LH_Auction=1
    """
    query = f"{item.name} {item.grade}"
    if item.set_name:
        query += f" {item.set_name}"
    encoded = quote_plus(query)

    params = f"_nkw={encoded}&_sop=15&_ipg=50"  # sort by newly listed, 50 per page
    if listing_type == "BUY_IT_NOW":
        params += "&LH_BIN=1"
    else:
        params += "&LH_Auction=1"

    return f"{EBAY_SEARCH_BASE}?{params}"


# ─────────────────────────────────────────────────────────────────────────────
# eBay scraper
# ─────────────────────────────────────────────────────────────────────────────


def scrape_listings(search_url: str, listing_type: str = "BUY_IT_NOW") -> list[dict]:
    """
    Scrape eBay search results via Apify actor (falls back to HTML scraping).
    Returns list of dicts with: title, price, shipping, seller_username,
    seller_rating, seller_feedback_count, url, listing_type.
    """
    if APIFY_API_TOKEN:
        results = _scrape_listings_apify(search_url, listing_type)
        if results:
            return results
        logger.warning("[scraper] Apify returned 0 results, falling back to HTML scraper")

    return _scrape_listings_html(search_url, listing_type)


def _scrape_listings_apify(search_url: str, listing_type: str) -> list[dict]:
    """Call Apify eBay Product Listing Scraper actor (async + poll for fresh results)."""
    base = "https://api.apify.com/v2"
    params = {"token": APIFY_API_TOKEN}

    # Step 1 — start the run
    try:
        run_resp = requests.post(
            f"{base}/acts/{APIFY_ACTOR}/runs",
            params=params,
            json={"listingUrls": [search_url]},
            timeout=30,
        )
        run_resp.raise_for_status()
        run_data = run_resp.json()["data"]
        run_id = run_data["id"]
        dataset_id = run_data["defaultDatasetId"]
        logger.info(f"[scraper] Apify run started: {run_id}")
    except Exception as exc:
        logger.warning(f"[scraper] Apify start failed: {exc}")
        return []

    # Step 2 — poll until SUCCEEDED or terminal state (max 90s)
    for _ in range(18):
        time.sleep(5)
        try:
            status_resp = requests.get(
                f"{base}/actor-runs/{run_id}",
                params=params,
                timeout=15,
            )
            status = status_resp.json()["data"]["status"]
            logger.info(f"[scraper] Apify run {run_id} status: {status}")
            if status == "SUCCEEDED":
                break
            if status in ("FAILED", "TIMED-OUT", "ABORTED"):
                logger.warning(f"[scraper] Apify run failed with status: {status}")
                return []
        except Exception as exc:
            logger.warning(f"[scraper] Apify poll error: {exc}")
    else:
        logger.warning("[scraper] Apify run timed out after 90s")
        return []

    # Step 3 — fetch results from this run's dataset (not cached)
    try:
        items_resp = requests.get(
            f"{base}/datasets/{dataset_id}/items",
            params=params,
            timeout=30,
        )
        items_resp.raise_for_status()
        items = items_resp.json()
    except Exception as exc:
        logger.warning(f"[scraper] Apify dataset fetch failed: {exc}")
        return []

    results = []
    for item in items:
        try:
            title = item.get("product_title", "").strip()
            if not title or title.lower() == "shop on ebay":
                continue

            item_url = item.get("product_url", "").split("?")[0]
            if not item_url or "/itm/" not in item_url:
                continue

            price_str = item.get("price", "").replace("$", "").replace(",", "").strip()
            if " to " in price_str:
                price_str = price_str.split(" to ")[0]
            try:
                price = float(price_str)
            except ValueError:
                continue

            # Shipping lives inside card_attribute strings e.g. "Free shipping", "+$4.99 shipping"
            shipping = 0.0
            for attr in item.get("card_attribute", []):
                attr_lower = attr.lower()
                if "free" in attr_lower and ("shipping" in attr_lower or "delivery" in attr_lower):
                    shipping = 0.0
                    break
                if "shipping" in attr_lower and "$" in attr:
                    try:
                        shipping = float(
                            attr.replace("+", "").replace("$", "").split()[0]
                        )
                    except (ValueError, IndexError):
                        pass
                    break

            results.append({
                "title": title,
                "price": price,
                "shipping": shipping,
                # Apify listing scraper doesn't return seller info — use safe defaults
                "seller_username": "unknown",
                "seller_rating": 99.0,
                "seller_feedback_count": 100,
                "url": item_url,
                "listing_type": listing_type,
                "image_url": item.get("image_url", ""),  # for Phase 1 vision cert
            })
        except Exception as exc:
            logger.debug(f"[scraper] Apify item parse error: {exc}")
            continue

    logger.info(f"[scraper] Apify found {len(results)} {listing_type} listings")
    return results


def _scrape_listings_html(search_url: str, listing_type: str = "BUY_IT_NOW") -> list[dict]:
    """Fallback: scrape eBay search results directly from HTML."""
    try:
        resp = requests.get(search_url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except Exception as exc:
        logger.warning(f"[scraper] HTML request failed: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    results = []

    for item in soup.select(".s-item__wrapper"):
        try:
            title_el = item.select_one(".s-item__title")
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            if title.lower() == "shop on ebay":
                continue

            link_el = item.select_one(".s-item__link")
            if not link_el:
                continue
            item_url = link_el.get("href", "").split("?")[0]
            if not item_url or "/itm/" not in item_url:
                continue

            price_el = item.select_one(".s-item__price")
            if not price_el:
                continue
            price_text = price_el.get_text(strip=True).replace("$", "").replace(",", "")
            if " to " in price_text:
                price_text = price_text.split(" to ")[0]
            try:
                price = float(price_text)
            except ValueError:
                continue

            shipping = 0.0
            shipping_el = item.select_one(".s-item__shipping, .s-item__freeXDays")
            if shipping_el:
                shipping_text = shipping_el.get_text(strip=True)
                if "free" in shipping_text.lower():
                    shipping = 0.0
                else:
                    try:
                        shipping = float(
                            shipping_text.replace("$", "").replace(",", "").split()[0]
                        )
                    except (ValueError, IndexError):
                        shipping = 0.0

            seller_username = "unknown"
            seller_rating = 99.0
            seller_feedback_count = 100
            seller_el = item.select_one(".s-item__seller-info-text, .s-item__sellerInfo")
            if seller_el:
                seller_text = seller_el.get_text(strip=True)
                parts = seller_text.split()
                if parts:
                    seller_username = parts[0].strip("()")
                    for part in parts:
                        if "%" in part:
                            try:
                                seller_rating = float(part.replace("%", ""))
                            except ValueError:
                                pass
                        elif part.startswith("(") and part.endswith(")"):
                            try:
                                seller_feedback_count = int(part.strip("()").replace(",", ""))
                            except ValueError:
                                pass

            results.append({
                "title": title,
                "price": price,
                "shipping": shipping,
                "seller_username": seller_username,
                "seller_rating": seller_rating,
                "seller_feedback_count": seller_feedback_count,
                "url": item_url,
                "listing_type": listing_type,
            })
        except Exception as exc:
            logger.debug(f"[scraper] HTML item parse error: {exc}")
            continue

    logger.info(f"[scraper] HTML found {len(results)} {listing_type} listings")
    return results


def scrape_platform(card_name: str, grade: str, platform: str) -> list[dict]:
    """
    On-demand multi-platform scraper used by /tools/deal-hunt.
    Returns raw listing dicts (same schema as Watchman scraper output).
    Platforms with actor=None (not yet on paid Apify plan) return [].
    """
    if platform == "ebay":
        query = quote_plus(f"{card_name} {grade}")
        url = f"{EBAY_SEARCH_BASE}?_nkw={query}&_sop=15&_ipg=50&LH_BIN=1"
        return scrape_listings(url, "BUY_IT_NOW")

    actor = PLATFORM_ACTORS.get(platform)
    if actor is None:
        logger.info(f"[deal-hunt] platform={platform} not yet enabled (no Apify actor configured)")
        return []

    # Future: add platform-specific input builders here when paid plan is purchased.
    # Mercari/OfferUp/FB accept different input JSON than eBay's listingUrls.
    return []


# ─────────────────────────────────────────────────────────────────────────────
# Waterfall filter
# ─────────────────────────────────────────────────────────────────────────────


def calculate_watchman_score(
    price: float,
    max_price: float,
    seller_rating: float,
    feedback_count: int,
    shipping: float,
) -> float:
    """
    Composite quality score 0.0–1.0:
      (1 - price/max_price)         × 0.50   price headroom
      ((seller_rating - 98) / 2)    × 0.30   seller quality
      min(feedback_count / 1000, 1) × 0.10   seller experience
      (0.10 if shipping == 0 else 0)          free shipping bonus
    """
    price_component = (1.0 - price / max_price) * 0.50
    rating_component = ((seller_rating - 98.0) / 2.0) * 0.30
    feedback_component = min(feedback_count / 1000.0, 1.0) * 0.10
    shipping_bonus = 0.10 if shipping == 0.0 else 0.0
    score = price_component + rating_component + feedback_component + shipping_bonus
    return round(max(0.0, min(1.0, score)), 4)


def run_waterfall(
    listing: dict, want_item: WantList
) -> tuple[bool, str, dict]:
    """
    Run the 5-gate waterfall filter.
    Returns (passed: bool, reason: str, enriched_listing: dict).
    """
    title_lower = listing["title"].lower()

    # Gate 1: Slop filter
    for keyword in SLOP_KEYWORDS:
        if keyword in title_lower:
            return False, f"slop_keyword:{keyword}", listing

    # Gate 2: Landed cost
    landed_cost = listing["price"] + listing["shipping"] + listing["price"] * TAX_RATE
    landed_cost = round(landed_cost, 2)
    if landed_cost > want_item.max_price:
        return False, f"over_max_price (landed={landed_cost} max={want_item.max_price})", listing

    # Gate 3: Seller rating
    if listing["seller_rating"] < SELLER_RATING_MIN:
        return False, f"low_seller_rating ({listing['seller_rating']})", listing

    # Gate 4: Seller feedback count
    if listing["seller_feedback_count"] < SELLER_FEEDBACK_MIN:
        return False, f"low_feedback_count ({listing['seller_feedback_count']})", listing

    # Gate 5: Enrich with watchman_score and landed_cost (routing done by caller)
    score = calculate_watchman_score(
        listing["price"],
        want_item.max_price,
        listing["seller_rating"],
        listing["seller_feedback_count"],
        listing["shipping"],
    )
    enriched = {
        **listing,
        "landed_cost": landed_cost,
        "tax_estimate": round(listing["price"] * TAX_RATE, 2),
        "watchman_score": score,
    }
    return True, "passed", enriched


# ─────────────────────────────────────────────────────────────────────────────
# Conductor communication
# ─────────────────────────────────────────────────────────────────────────────


def post_price_history(want_list_id: int, price: float) -> Optional[dict]:
    """POST /price-history with a single auction price observation."""
    try:
        resp = requests.post(
            f"{CONDUCTOR_URL}/price-history",
            json={"want_list_id": want_list_id, "price": price},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        logger.warning(f"[watchman] Failed to post price history: {exc}")
        return None


def post_evaluate(want_item: WantList, listing: dict) -> Optional[dict]:
    """POST /evaluate with a BIN listing candidate."""
    payload = {
        "want_list_id": want_item.id,
        "url": listing["url"],
        "listing_type": "BUY_IT_NOW",
        "price": listing["price"],
        "shipping": listing["shipping"],
        "seller_username": listing["seller_username"],
        "seller_rating": listing["seller_rating"],
        "seller_feedback_count": listing["seller_feedback_count"],
        "watchman_score": listing["watchman_score"],
    }
    try:
        resp = requests.post(
            f"{CONDUCTOR_URL}/evaluate",
            json=payload,
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        logger.warning(f"[watchman] /evaluate failed: {exc}")
        return None


def _vision_cert_check_sync(images: list[str]) -> str:
    """
    Call Gemini 2.0 Flash via OpenRouter to extract PSA cert from listing photos.
    Sync version for use in the Watchman poll loop.
    Returns cert number string or "NOT_FOUND".
    """
    openrouter_key = os.getenv("OPENROUTER_API_KEY", "")
    if not openrouter_key or not images:
        return "NOT_FOUND"
    for img_url in images:
        try:
            import re
            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {openrouter_key}", "Content-Type": "application/json"},
                json={
                    "model": "google/gemini-2.0-flash-001",
                    "messages": [{"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": img_url}},
                        {"type": "text", "text": (
                            "PSA-graded Pokémon card eBay listing photo. "
                            "Find the PSA cert number on the yellow slab label "
                            "(8-digit number, optionally prefixed like 'POKE-12345678'). "
                            "Return ONLY the cert number or NOT_FOUND."
                        )},
                    ]}],
                    "max_tokens": 30,
                },
                timeout=20,
            )
            raw = resp.json()["choices"][0]["message"]["content"].strip()
            if raw and raw != "NOT_FOUND" and re.search(r"\d{6,}", raw):
                return re.sub(r"[^A-Z0-9\-]", "", raw.upper())
        except Exception as exc:
            logger.warning(f"[watchman] vision cert error: {exc}")
    return "NOT_FOUND"


def trigger_agent(
    deal_id: int,
    url: str,
    max_price: float,
    cert_prefix: str,
    verified_cert: str = "NOT_FOUND",
    price_locked: Optional[float] = None,
) -> None:
    """
    Spawn the Last-Mile agent as a subprocess.
    Passes pre-extracted cert + price so agent skips Browserbase extraction.
    """
    agent_dir = Path(__file__).resolve().parent.parent / "agent"
    args = json.dumps({
        "deal_id": deal_id,
        "url": url,
        "max_allowed_price": max_price,
        "expected_cert_prefix": cert_prefix or "",
        "verified_cert": verified_cert,
        "price_locked": price_locked,
    })
    logger.info(f"[watchman] Triggering agent: deal_id={deal_id} cert={verified_cert}")
    subprocess.Popen(
        ["npx", "ts-node", "checkout.ts", args],
        cwd=str(agent_dir),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Poll loop
# ─────────────────────────────────────────────────────────────────────────────


def poll_once() -> None:
    """
    For each active WantList item:
      1. Scrape BIN listings → waterfall → /evaluate → trigger_agent on GO
      2. Scrape AUCTION listings → waterfall → /price-history on pass
    """
    db = SessionLocal()
    try:
        want_items = db.query(WantList).filter(WantList.is_active).all()
        logger.info(f"[watchman] Polling {len(want_items)} active want_list items")

        for want_item in want_items:
            logger.info(f"[watchman] Checking: {want_item.name} {want_item.grade}")

            # ── BIN listings ──────────────────────────────────────────────────
            bin_url = build_ebay_url(want_item, "BUY_IT_NOW")
            bin_listings = scrape_listings(bin_url, "BUY_IT_NOW")

            for listing in bin_listings:
                passed, reason, enriched = run_waterfall(listing, want_item)
                if not passed:
                    logger.debug(f"[watchman] BIN filtered ({reason}): {listing['title'][:60]}")
                    continue

                logger.info(
                    f"[watchman] BIN passed waterfall: {listing['title'][:60]} "
                    f"price=${listing['price']} score={enriched['watchman_score']}"
                )
                response = post_evaluate(want_item, enriched)
                if response and response.get("decision") == "GO":
                    deal_id = response["deal_id"]
                    # Phase 1: run vision cert check before opening any browser
                    image_url = enriched.get("image_url", "")
                    verified_cert = _vision_cert_check_sync([image_url]) if image_url else "NOT_FOUND"
                    logger.info(f"[watchman] GO deal_id={deal_id} cert={verified_cert}")
                    trigger_agent(
                        deal_id=deal_id,
                        url=listing["url"],
                        max_price=want_item.max_price,
                        cert_prefix=want_item.cert_prefix or "",
                        verified_cert=verified_cert,
                        price_locked=listing["price"],
                    )

            # ── Auction listings (price discovery only) ───────────────────────
            auction_url = build_ebay_url(want_item, "AUCTION")
            auction_listings = scrape_listings(auction_url, "AUCTION")

            for listing in auction_listings:
                passed, reason, _ = run_waterfall(listing, want_item)
                if not passed:
                    continue
                result = post_price_history(want_item.id, listing["price"])
                if result:
                    logger.debug(
                        f"[watchman] AUCTION recorded: price=${listing['price']} "
                        f"want_list_id={want_item.id} "
                        f"sample_count={result.get('sample_count')}"
                    )

            time.sleep(1)  # brief pause between items to be polite

    finally:
        db.close()


def _write_heartbeat(items_scanned: int, error: str | None = None) -> None:
    """Write Watchman scan result to system_meta so the UI can show status."""
    from datetime import datetime
    db = SessionLocal()
    try:
        val = json.dumps({
            "last_scan_at": datetime.utcnow().isoformat(),
            "items_scanned": items_scanned,
            "error": error,
        })
        row = db.query(SystemMeta).filter_by(key="watchman_status").first()
        if row:
            row.value = val
            row.updated_at = datetime.utcnow()
        else:
            db.add(SystemMeta(key="watchman_status", value=val))
        db.commit()
    except Exception as exc:
        logger.warning(f"[watchman] heartbeat write failed: {exc}")
    finally:
        db.close()


def main() -> None:
    """Infinite poll loop."""
    init_db()
    logger.info(f"[watchman] Starting — poll interval={POLL_INTERVAL_SECONDS}s conductor={CONDUCTOR_URL}")
    while True:
        scan_error: str | None = None
        try:
            poll_once()
        except Exception as exc:
            scan_error = str(exc)
            logger.error(f"[watchman] poll_once() error: {exc}")

        # Count active want list items for heartbeat
        try:
            db = SessionLocal()
            items_scanned = db.query(WantList).filter(WantList.is_active).count()
            db.close()
        except Exception:
            items_scanned = 0

        _write_heartbeat(items_scanned, scan_error)
        logger.info(f"[watchman] Sleeping {POLL_INTERVAL_SECONDS}s...")
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
