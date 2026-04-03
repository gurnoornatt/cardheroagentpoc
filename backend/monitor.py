"""
CardHero Watchman — deterministic waterfall filter + eBay poller.

Run:
    uv run python -m backend.monitor
"""

import json
import os
import subprocess
import sys
import time
from urllib.parse import urlencode

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.database import SessionLocal, WantList

CONDUCTOR_URL = os.getenv("CONDUCTOR_URL", "http://localhost:8000")
TAX_RATE = float(os.getenv("TAX_RATE", "0.08"))
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL", "300"))

EXCLUDE_KEYWORDS = {"proxy", "reprint", "digital", "read", "custom", "fake", "lot"}
SELLER_RATING_MIN = 98.0
SELLER_FEEDBACK_MIN = 100

EBAY_SEARCH_BASE = "https://www.ebay.com/sch/i.html"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def build_ebay_url(item: dict) -> str:
    grade_num = item["grade"].replace("PSA ", "")
    query = f"{item['name']} PSA {grade_num} {item['set_name']}"
    params = {
        "_nkw": query,
        "LH_BIN": "1",
        "LH_ItemCondition": "3",
        "_sop": "15",
        "LH_TitleDesc": "0",
    }
    return f"{EBAY_SEARCH_BASE}?{urlencode(params)}"


def scrape_listings(search_url: str) -> list[dict]:
    try:
        resp = requests.get(search_url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"  [scraper] fetch error: {e}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    results = []

    for item in soup.select("div.s-item__wrapper")[:8]:
        try:
            title_el = item.select_one(".s-item__title span")
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            if title.lower() == "shop on ebay":
                continue

            price_el = item.select_one(".s-item__price")
            if not price_el:
                continue
            price_text = price_el.get_text(strip=True).replace("$", "").replace(",", "").split("to")[0].strip()
            try:
                price = float(price_text)
            except ValueError:
                continue

            shipping = 0.0
            ship_el = item.select_one(".s-item__shipping, .s-item__freeXDays")
            if ship_el:
                ship_text = ship_el.get_text(strip=True).lower()
                if "free" in ship_text:
                    shipping = 0.0
                else:
                    import re
                    m = re.search(r"\$([0-9.]+)", ship_text)
                    if m:
                        shipping = float(m.group(1))

            seller_info = ""
            seller_el = item.select_one(".s-item__seller-info-text")
            if seller_el:
                seller_info = seller_el.get_text(strip=True)

            seller_username = "unknown"
            seller_rating = 0.0
            seller_feedback_count = 0
            if seller_info:
                import re
                username_m = re.search(r"^([^\s(]+)", seller_info)
                if username_m:
                    seller_username = username_m.group(1)
                rating_m = re.search(r"([0-9.]+)%", seller_info)
                if rating_m:
                    seller_rating = float(rating_m.group(1))
                feedback_m = re.search(r"\(([0-9,]+)\)", seller_info)
                if feedback_m:
                    seller_feedback_count = int(feedback_m.group(1).replace(",", ""))

            url_el = item.select_one("a.s-item__link")
            url = url_el["href"].split("?")[0] if url_el else ""

            results.append({
                "title": title,
                "price": price,
                "shipping": shipping,
                "seller_username": seller_username,
                "seller_rating": seller_rating,
                "seller_feedback_count": seller_feedback_count,
                "url": url,
            })
        except Exception:
            continue

    return results


def calculate_watchman_score(
    price: float,
    max_price: float,
    seller_rating: float,
    feedback_count: int,
    shipping: float,
) -> float:
    price_ratio = max(0.0, 1.0 - (price / max_price)) * 0.50
    seller_score = max(0.0, min((seller_rating - 98.0) / 2.0, 1.0)) * 0.30
    feedback_score = min(feedback_count / 1000, 1.0) * 0.10
    free_ship_bonus = 0.10 if shipping == 0.0 else 0.0
    return round(price_ratio + seller_score + feedback_score + free_ship_bonus, 4)


def run_waterfall(listing: dict, want_item: dict) -> tuple[bool, str, dict]:
    title_lower = listing["title"].lower()
    for keyword in EXCLUDE_KEYWORDS:
        if keyword in title_lower:
            return False, "title_filter", listing

    tax_estimate = listing["price"] * TAX_RATE
    landed_cost = listing["price"] + listing["shipping"] + tax_estimate
    if landed_cost > want_item["max_price"]:
        return False, "over_budget", listing

    if listing["seller_rating"] < SELLER_RATING_MIN:
        return False, "seller_rating_low", listing

    if listing["seller_feedback_count"] < SELLER_FEEDBACK_MIN:
        return False, "feedback_count_low", listing

    score = calculate_watchman_score(
        price=listing["price"],
        max_price=want_item["max_price"],
        seller_rating=listing["seller_rating"],
        feedback_count=listing["seller_feedback_count"],
        shipping=listing["shipping"],
    )
    enriched = {**listing, "watchman_score": score, "tax_estimate": tax_estimate, "landed_cost": landed_cost}
    return True, "passed", enriched


def post_to_conductor(want_item: dict, enriched: dict) -> dict:
    payload = {
        "want_list_id": want_item["id"],
        "url": enriched["url"],
        "price": enriched["price"],
        "shipping": enriched["shipping"],
        "seller_username": enriched["seller_username"],
        "seller_rating": enriched["seller_rating"],
        "seller_feedback_count": enriched["seller_feedback_count"],
        "watchman_score": enriched["watchman_score"],
    }
    try:
        resp = requests.post(
            f"{CONDUCTOR_URL}/evaluate",
            json=payload,
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        print(f"  [watchman] conductor error: {e}")
        return {}


def trigger_agent(deal_id: int, url: str, max_price: float, cert_prefix: str) -> None:
    args = json.dumps({
        "deal_id": deal_id,
        "url": url,
        "max_allowed_price": max_price,
        "expected_cert_prefix": cert_prefix,
    })
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    print(f"  [watchman] Triggering agent for deal_id={deal_id}")
    subprocess.Popen(
        ["npx", "ts-node", "agent/checkout.ts", args],
        cwd=repo_root,
    )


def poll_once() -> None:
    db = SessionLocal()
    try:
        want_items = db.query(WantList).filter(WantList.is_active == True).all()
        items_data = [
            {
                "id": w.id,
                "name": w.name,
                "grade": w.grade,
                "max_price": w.max_price,
                "set_name": w.set_name or "",
                "cert_prefix": w.cert_prefix or "POKE",
            }
            for w in want_items
        ]
    finally:
        db.close()

    for item in items_data:
        print(f"[watchman] Scanning: {item['name']} ({item['grade']}) max=${item['max_price']}")
        search_url = build_ebay_url(item)
        listings = scrape_listings(search_url)
        print(f"  Found {len(listings)} raw listings")

        for listing in listings[:5]:
            passed, reason, enriched = run_waterfall(listing, item)
            if not passed:
                print(f"  SKIP ({reason}): {listing['title'][:60]}")
                continue

            print(f"  PASS (score={enriched['watchman_score']}): {listing['title'][:60]}")
            result = post_to_conductor(item, enriched)
            if not result:
                continue

            if result.get("decision") == "GO":
                deal_id = result["deal_id"]
                print(f"  GO signal — deal_id={deal_id}, triggering agent")
                trigger_agent(deal_id, enriched["url"], item["max_price"], item["cert_prefix"])
            else:
                print(f"  NO_GO: {result.get('reason', 'unknown')}")


def main():
    print(f"[watchman] Starting. Poll interval: {POLL_INTERVAL_SECONDS}s")
    while True:
        try:
            poll_once()
        except Exception as e:
            print(f"[watchman] Poll error: {e}")
        print(f"[watchman] Sleeping {POLL_INTERVAL_SECONDS}s...")
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
