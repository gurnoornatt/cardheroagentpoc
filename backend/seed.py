"""
Idempotent DB seeder. Safe to re-run — clears and re-seeds all tables.

Usage:
    uv run python -m backend.seed
    # or from backend/ directory:
    uv run python seed.py
"""

import json
import os
import sys
from datetime import datetime, timedelta, date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.database import (
    SessionLocal, init_db,
    WantList, Portfolio, Deal, AuditLog,
)

SEEDS_DIR = os.path.join(os.path.dirname(__file__), "seeds")


def load_want_list(db) -> dict:
    with open(os.path.join(SEEDS_DIR, "want_list.json")) as f:
        items = json.load(f)

    wl_map = {}
    for item in items:
        wl = WantList(
            name=item["name"],
            grade=item["grade"],
            max_price=item["max_price"],
            cert_prefix=item.get("cert_prefix"),
            target_id=item.get("target_id"),
            set_name=item.get("set_name"),
            year=item.get("year"),
            is_active=True,
        )
        db.add(wl)
        db.flush()
        wl_map[item["name"]] = wl

    return wl_map


def load_portfolio(db) -> None:
    with open(os.path.join(SEEDS_DIR, "history.json")) as f:
        data = json.load(f)

    for item in data["portfolio"]:
        p = Portfolio(
            name=item["name"],
            grade=item["grade"],
            purchase_price=item["purchase_price"],
            current_value=item["current_value"],
            cert_number=item["cert_number"],
            purchase_date=date.fromisoformat(item["purchase_date"]),
            set_name=item.get("set_name"),
            year=item.get("year"),
            notes=item.get("notes"),
        )
        db.add(p)


def load_deals(db, wl_map: dict) -> int:
    with open(os.path.join(SEEDS_DIR, "history.json")) as f:
        data = json.load(f)

    audit_count = 0
    for deal_data in data["deals"]:
        wl_item = wl_map.get(deal_data["want_list_item_name"])
        if not wl_item:
            print(f"  [warn] No WantList match for '{deal_data['want_list_item_name']}', skipping")
            continue

        created_at = datetime.utcnow() - timedelta(days=deal_data.get("days_ago", 0))
        item_id = deal_data["url"].split("/itm/")[-1].split("?")[0]

        deal = Deal(
            want_list_id=wl_item.id,
            url=deal_data["url"],
            price=deal_data["price"],
            shipping=deal_data["shipping"],
            tax_estimate=deal_data["tax_estimate"],
            landed_cost=deal_data["landed_cost"],
            status=deal_data["status"],
            watchman_score=deal_data["watchman_score"],
            seller_username=deal_data["seller_username"],
            seller_rating=deal_data["seller_rating"],
            seller_feedback_count=deal_data["seller_feedback_count"],
            ebay_item_id=item_id,
            created_at=created_at,
            updated_at=created_at,
        )
        db.add(deal)
        db.flush()

        if deal_data.get("audit"):
            audit_data = deal_data["audit"]
            audit = AuditLog(
                deal_id=deal.id,
                agent_extraction_json=audit_data.get("agent_extraction_json"),
                screenshot_path=audit_data.get("screenshot_path"),
                dom_snapshot_path=audit_data.get("dom_snapshot_path"),
                verified_cert=audit_data.get("verified_cert"),
                price_locked=audit_data.get("price_locked"),
                session_id=audit_data.get("session_id"),
                created_at=created_at,
            )
            db.add(audit)
            audit_count += 1

    return audit_count


def seed_all():
    init_db()
    db = SessionLocal()
    try:
        # Clear in reverse FK order
        db.query(AuditLog).delete()
        db.query(Deal).delete()
        db.query(Portfolio).delete()
        db.query(WantList).delete()
        db.commit()

        wl_map = load_want_list(db)
        load_portfolio(db)
        audit_count = load_deals(db, wl_map)
        db.commit()

        print(
            f"[seed] Done. "
            f"{len(wl_map)} want_list items | "
            f"6 portfolio items | "
            f"10 deals ({audit_count} with audit logs)."
        )
    except Exception as e:
        db.rollback()
        print(f"[seed] ERROR: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    seed_all()
