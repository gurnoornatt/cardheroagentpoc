"""
CardHero v2 — Idempotent database seeder.

Run:  uv run python -m newpoc.backend.seed

Seeds all 5 tables with realistic test data.
Clears existing rows in reverse FK order before inserting.

Expected output:
  [seed] Done. 7 want_list | 6 portfolio | 12 price_history | 10 deals | 2 audit_log | 8 lab_run rows
"""

import json
from datetime import date, datetime, timedelta, timezone

from newpoc.backend.database import (
    AuditLog,
    Deal,
    LabRun,
    Portfolio,
    PriceHistory,
    SessionLocal,
    WantList,
    init_db,
)


# ─────────────────────────────────────────────────────────────────────────────
# IQR helper (inlined to avoid circular import from main.py)
# ─────────────────────────────────────────────────────────────────────────────


def _compute_iqr_stats(prices: list[float]) -> dict:
    if len(prices) < 4:
        return {"iqr_low": None, "iqr_high": None, "sanitized_avg": None}

    sorted_prices = sorted(prices)

    def percentile(data: list[float], pct: float) -> float:
        idx = pct / 100.0 * (len(data) - 1)
        lo = int(idx)
        hi = min(lo + 1, len(data) - 1)
        frac = idx - lo
        return data[lo] + frac * (data[hi] - data[lo])

    q1 = percentile(sorted_prices, 25)
    q3 = percentile(sorted_prices, 75)
    iqr = q3 - q1
    iqr_low = round(q1 - 1.5 * iqr, 2)
    iqr_high = round(q3 + 1.5 * iqr, 2)
    inliers = [p for p in sorted_prices if iqr_low <= p <= iqr_high]
    sanitized_avg = round(sum(inliers) / len(inliers), 2) if inliers else None
    return {"iqr_low": iqr_low, "iqr_high": iqr_high, "sanitized_avg": sanitized_avg}


def _monday(weeks_ago: int = 0) -> date:
    """Return the Monday of the week `weeks_ago` weeks in the past."""
    today = date.today()
    this_monday = today - timedelta(days=today.weekday())
    return this_monday - timedelta(weeks=weeks_ago)


# ─────────────────────────────────────────────────────────────────────────────
# Clear
# ─────────────────────────────────────────────────────────────────────────────


def _clear_tables(db) -> None:
    # Reverse FK order
    db.query(LabRun).delete()
    db.query(AuditLog).delete()
    db.query(Deal).delete()
    db.query(PriceHistory).delete()
    db.query(Portfolio).delete()
    db.query(WantList).delete()
    db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# want_list — 7 cards
# ─────────────────────────────────────────────────────────────────────────────


def _seed_want_list(db) -> dict[str, WantList]:
    cards = [
        dict(name="Charizard ex", grade="PSA 10", max_price=380.00, cert_prefix="POKE", target_id="charizard-ex-obsidian-psa10", set_name="Obsidian Flames", year=2023),
        dict(name="Pikachu VMAX Rainbow Rare", grade="PSA 10", max_price=220.00, cert_prefix="POKE", target_id="pikachu-vmax-rainbow-psa10", set_name="Vivid Voltage", year=2020),
        dict(name="Umbreon VMAX Alt Art", grade="PSA 10", max_price=1800.00, cert_prefix="POKE", target_id="umbreon-vmax-altart-psa10", set_name="Evolving Skies", year=2021),
        dict(name="Charizard VSTAR", grade="PSA 10", max_price=150.00, cert_prefix="POKE", target_id="charizard-vstar-psa10", set_name="Brilliant Stars", year=2022),
        dict(name="Lugia V Alt Art", grade="PSA 10", max_price=600.00, cert_prefix="POKE", target_id="lugia-v-altart-psa10", set_name="Silver Tempest", year=2022),
        dict(name="Rayquaza VMAX Alt Art", grade="PSA 10", max_price=500.00, cert_prefix="POKE", target_id="rayquaza-vmax-altart-psa10", set_name="Evolving Skies", year=2021),
        dict(name="Blastoise ex", grade="PSA 10", max_price=120.00, cert_prefix="POKE", target_id="blastoise-ex-psa10", set_name="Scarlet & Violet 151", year=2023),
    ]
    wl_map: dict[str, WantList] = {}
    for c in cards:
        item = WantList(**c, is_active=True)
        db.add(item)
        db.flush()
        wl_map[c["name"]] = item
    db.commit()
    return wl_map


# ─────────────────────────────────────────────────────────────────────────────
# portfolio — 6 items
# ─────────────────────────────────────────────────────────────────────────────


def _seed_portfolio(db) -> None:
    items = [
        dict(name="Charizard ex", grade="PSA 10", purchase_price=310.00, current_value=355.00, cert_number="POKE-48291033", purchase_date=date(2024, 1, 15), set_name="Obsidian Flames", year=2023, notes="Strong pop ratio — Grade 10 is only 12% of total"),
        dict(name="Umbreon VMAX Alt Art", grade="PSA 9", purchase_price=420.00, current_value=510.00, cert_number="POKE-19283746", purchase_date=date(2023, 11, 3), set_name="Evolving Skies", year=2021, notes="PSA 9, bought as undervalue flip candidate"),
        dict(name="Pikachu VMAX Rainbow Rare", grade="PSA 10", purchase_price=165.00, current_value=195.00, cert_number="POKE-55671829", purchase_date=date(2024, 2, 8), set_name="Vivid Voltage", year=2020, notes=None),
        dict(name="Lugia V Alt Art", grade="PSA 10", purchase_price=540.00, current_value=585.00, cert_number="POKE-77892345", purchase_date=date(2024, 3, 1), set_name="Silver Tempest", year=2022, notes="Long-term hold"),
        dict(name="Rayquaza VMAX Alt Art", grade="PSA 10", purchase_price=460.00, current_value=480.00, cert_number="POKE-66123788", purchase_date=date(2024, 1, 28), set_name="Evolving Skies", year=2021, notes=None),
        dict(name="Blastoise ex", grade="PSA 10", purchase_price=88.00, current_value=105.00, cert_number="POKE-34519872", purchase_date=date(2024, 3, 10), set_name="Scarlet & Violet 151", year=2023, notes="Quick flip target"),
    ]
    for item in items:
        db.add(Portfolio(**item))
    db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# price_history — 3 cards × 2 weeks (≥5 prices each so IQR computes)
# ─────────────────────────────────────────────────────────────────────────────


def _seed_price_history(db, wl_map: dict[str, WantList]) -> None:
    # Charizard ex (max_price=380) — sanitized_avg ~315 means
    # a BIN at landed_cost=210 gives undervalue_delta=105 → passes $100 gate
    ph_data = [
        # (card_name, weeks_ago, prices)
        ("Charizard ex",             2, [310.0, 325.0, 318.0, 299.0, 340.0, 335.0, 312.0]),
        ("Charizard ex",             1, [305.0, 315.0, 322.0, 308.0, 330.0, 311.0]),
        ("Umbreon VMAX Alt Art",     2, [1550.0, 1620.0, 1580.0, 1595.0, 1610.0, 1570.0]),
        ("Umbreon VMAX Alt Art",     1, [1590.0, 1605.0, 1625.0, 1575.0, 1640.0, 1600.0]),
        ("Pikachu VMAX Rainbow Rare", 2, [162.0, 170.0, 158.0, 175.0, 165.0, 168.0]),
        ("Pikachu VMAX Rainbow Rare", 1, [160.0, 172.0, 167.0, 163.0, 175.0, 169.0]),
    ]

    for card_name, weeks_ago, prices in ph_data:
        wl = wl_map[card_name]
        stats = _compute_iqr_stats(prices)
        row = PriceHistory(
            want_list_id=wl.id,
            week_start=_monday(weeks_ago),
            raw_prices=json.dumps(prices),
            iqr_low=stats["iqr_low"],
            iqr_high=stats["iqr_high"],
            sanitized_avg=stats["sanitized_avg"],
            sample_count=len(prices),
        )
        db.add(row)

    db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# deals — 10 deals covering all statuses + listing_types
# ─────────────────────────────────────────────────────────────────────────────


def _seed_deals(db, wl_map: dict[str, WantList]) -> dict[int, Deal]:
    """Returns a 0-indexed map for FK resolution in audit/lab seeding."""
    now = datetime.now(timezone.utc)
    deals_data = [
        # 0: BOUGHT BIN — Charizard ex (undervalue delta ~104, passes gate)
        dict(
            want_list=wl_map["Charizard ex"],
            url="https://www.ebay.com/itm/100000000001",
            listing_type="BUY_IT_NOW",
            price=190.00, shipping=0.0,
            status="BOUGHT",
            watchman_score=0.77,
            sentiment_score=0.32, sentiment_weight=0.032,
            undervalue_delta=108.10,
            seller_username="top_card_shop", seller_rating=99.8, seller_feedback_count=2341,
        ),
        # 1: BOUGHT BIN — Pikachu VMAX (undervalue delta ~106)
        dict(
            want_list=wl_map["Pikachu VMAX Rainbow Rare"],
            url="https://www.ebay.com/itm/100000000002",
            listing_type="BUY_IT_NOW",
            price=50.00, shipping=5.00,
            status="BOUGHT",
            watchman_score=0.68,
            sentiment_score=0.15, sentiment_weight=0.015,
            undervalue_delta=106.55,
            seller_username="card_vault_99", seller_rating=99.5, seller_feedback_count=876,
        ),
        # 2: REJECTED — over max_price (Umbreon)
        dict(
            want_list=wl_map["Umbreon VMAX Alt Art"],
            url="https://www.ebay.com/itm/100000000003",
            listing_type="BUY_IT_NOW",
            price=1820.00, shipping=0.0,
            status="REJECTED",
            watchman_score=0.0,
            sentiment_score=0.0, sentiment_weight=0.0,
            undervalue_delta=None,
            seller_username="psa_market", seller_rating=98.9, seller_feedback_count=450,
        ),
        # 3: REJECTED — cert prefix mismatch (found by agent)
        dict(
            want_list=wl_map["Charizard ex"],
            url="https://www.ebay.com/itm/100000000004",
            listing_type="BUY_IT_NOW",
            price=200.00, shipping=0.0,
            status="REJECTED",
            watchman_score=0.72,
            sentiment_score=0.10, sentiment_weight=0.010,
            undervalue_delta=109.10,
            seller_username="tcg_palace", seller_rating=99.1, seller_feedback_count=310,
        ),
        # 4: REJECTED — insufficient undervalue
        dict(
            want_list=wl_map["Charizard ex"],
            url="https://www.ebay.com/itm/100000000005",
            listing_type="BUY_IT_NOW",
            price=230.00, shipping=5.00,
            status="REJECTED",
            watchman_score=0.45,
            sentiment_score=0.05, sentiment_weight=0.005,
            undervalue_delta=62.15,
            seller_username="card_flip_usa", seller_rating=98.5, seller_feedback_count=203,
        ),
        # 5: ANALYZING — in progress (Charizard VSTAR)
        dict(
            want_list=wl_map["Charizard VSTAR"],
            url="https://www.ebay.com/itm/100000000006",
            listing_type="BUY_IT_NOW",
            price=95.00, shipping=0.0,
            status="ANALYZING",
            watchman_score=0.62,
            sentiment_score=0.20, sentiment_weight=0.020,
            undervalue_delta=None,
            seller_username="mint_graded", seller_rating=99.3, seller_feedback_count=654,
        ),
        # 6: PENDING — queued
        dict(
            want_list=wl_map["Lugia V Alt Art"],
            url="https://www.ebay.com/itm/100000000007",
            listing_type="BUY_IT_NOW",
            price=460.00, shipping=0.0,
            status="PENDING",
            watchman_score=0.58,
            sentiment_score=0.40, sentiment_weight=0.040,
            undervalue_delta=None,
            seller_username="alt_art_cards", seller_rating=99.6, seller_feedback_count=1120,
        ),
        # 7: PENDING — queued
        dict(
            want_list=wl_map["Rayquaza VMAX Alt Art"],
            url="https://www.ebay.com/itm/100000000008",
            listing_type="BUY_IT_NOW",
            price=380.00, shipping=0.0,
            status="PENDING",
            watchman_score=0.52,
            sentiment_score=-0.10, sentiment_weight=0.010,
            undervalue_delta=None,
            seller_username="psatengrade", seller_rating=98.8, seller_feedback_count=289,
        ),
        # 8: REJECTED AUCTION (recorded in price_history, not a BIN deal)
        dict(
            want_list=wl_map["Charizard ex"],
            url="https://www.ebay.com/itm/100000000009",
            listing_type="AUCTION",
            price=295.00, shipping=0.0,
            status="REJECTED",
            watchman_score=0.0,
            sentiment_score=0.0, sentiment_weight=0.0,
            undervalue_delta=None,
            seller_username="auction_king", seller_rating=99.0, seller_feedback_count=512,
        ),
        # 9: REJECTED AUCTION
        dict(
            want_list=wl_map["Umbreon VMAX Alt Art"],
            url="https://www.ebay.com/itm/100000000010",
            listing_type="AUCTION",
            price=1480.00, shipping=15.00,
            status="REJECTED",
            watchman_score=0.0,
            sentiment_score=0.0, sentiment_weight=0.0,
            undervalue_delta=None,
            seller_username="ebay_pokemon", seller_rating=98.3, seller_feedback_count=780,
        ),
    ]

    deal_map: dict[int, Deal] = {}
    for i, d in enumerate(deals_data):
        wl = d.pop("want_list")
        price = d["price"]
        shipping = d["shipping"]
        tax = round(price * 0.09, 2)
        deal = Deal(
            want_list_id=wl.id,
            tax_estimate=tax,
            landed_cost=round(price + shipping + tax, 2),
            ebay_item_id=d["url"].split("/itm/")[-1],
            created_at=now - timedelta(hours=10 - i),
            updated_at=now - timedelta(hours=10 - i),
            **d,
        )
        db.add(deal)
        db.flush()
        deal_map[i] = deal

    db.commit()
    return deal_map


# ─────────────────────────────────────────────────────────────────────────────
# audit_log — 2 BOUGHT deals
# ─────────────────────────────────────────────────────────────────────────────


def _seed_audit_logs(db, deal_map: dict[int, Deal]) -> None:
    logs = [
        dict(
            deal=deal_map[0],  # Charizard ex BOUGHT
            agent_extraction_json=json.dumps({
                "cert_number": "POKE-48291033",
                "price": 190.0,
                "psa_pop_grade10": 42,
                "psa_pop_total": 351,
                "authenticity_guaranteed": True,
                "title": "2023 Pokemon Charizard ex PSA 10 Obsidian Flames",
                "seller_username": "top_card_shop",
                "condition": "Graded",
            }),
            psa_pop_grade10=42,
            psa_pop_total=351,
            screenshot_path="receipts/deal_1_2024-03-27T09-15-00.png",
            dom_snapshot_path="receipts/deal_1_2024-03-27T09-15-00_dom.html",
            verified_cert="POKE-48291033",
            price_locked=190.0,
            authenticity_guaranteed=True,
            session_id="bb-sess-abc12345",
            model_used="google/gemini-2.5-flash",
            extraction_latency_ms=2100,
        ),
        dict(
            deal=deal_map[1],  # Pikachu VMAX BOUGHT
            agent_extraction_json=json.dumps({
                "cert_number": "POKE-55671829",
                "price": 50.0,
                "psa_pop_grade10": 89,
                "psa_pop_total": 620,
                "authenticity_guaranteed": False,
                "title": "2020 Pokemon Pikachu VMAX Rainbow Rare PSA 10 Vivid Voltage",
                "seller_username": "card_vault_99",
                "condition": "Graded",
            }),
            psa_pop_grade10=89,
            psa_pop_total=620,
            screenshot_path="receipts/deal_2_2024-03-27T10-22-00.png",
            dom_snapshot_path="receipts/deal_2_2024-03-27T10-22-00_dom.html",
            verified_cert="POKE-55671829",
            price_locked=50.0,
            authenticity_guaranteed=False,
            session_id="bb-sess-def67890",
            model_used="google/gemini-2.5-flash",
            extraction_latency_ms=3400,
        ),
    ]
    for entry in logs:
        deal = entry.pop("deal")
        audit = AuditLog(deal_id=deal.id, **entry)
        db.add(audit)
    db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# lab_runs — 8 rows across 3 models for 3 deals
# ─────────────────────────────────────────────────────────────────────────────


def _seed_lab_runs(db, deal_map: dict[int, Deal]) -> None:
    runs = [
        # Deal 0 (Charizard ex, BOUGHT) — 3 models
        dict(deal=deal_map[0], model="google/gemini-2.5-flash",
             extracted_cert="POKE-48291033", extracted_price=190.0,
             extracted_pop_grade10=42, extracted_pop_total=351,
             ground_truth_cert="POKE-48291033", cert_correct=True, price_correct=True,
             latency_ms=2100),
        dict(deal=deal_map[0], model="claude-sonnet-4-6",
             extracted_cert="POKE-48291033", extracted_price=190.0,
             extracted_pop_grade10=42, extracted_pop_total=351,
             ground_truth_cert="POKE-48291033", cert_correct=True, price_correct=True,
             latency_ms=4200),
        dict(deal=deal_map[0], model="gpt-4o",
             extracted_cert="48291033",  # wrong format (missing prefix)
             extracted_price=190.0,
             extracted_pop_grade10=42, extracted_pop_total=351,
             ground_truth_cert="POKE-48291033", cert_correct=False, price_correct=True,
             latency_ms=3800),
        # Deal 1 (Pikachu VMAX, BOUGHT) — 2 models
        dict(deal=deal_map[1], model="google/gemini-2.5-flash",
             extracted_cert="POKE-55671829", extracted_price=50.0,
             extracted_pop_grade10=89, extracted_pop_total=620,
             ground_truth_cert="POKE-55671829", cert_correct=True, price_correct=True,
             latency_ms=1950),
        dict(deal=deal_map[1], model="claude-sonnet-4-6",
             extracted_cert="POKE-55671829", extracted_price=52.0,  # off by $2
             extracted_pop_grade10=89, extracted_pop_total=620,
             ground_truth_cert="POKE-55671829", cert_correct=True, price_correct=False,
             latency_ms=3900),
        # Deal 5 (Charizard VSTAR, ANALYZING) — 3 models
        dict(deal=deal_map[5], model="google/gemini-2.5-flash",
             extracted_cert="POKE-77123456", extracted_price=95.0,
             extracted_pop_grade10=15, extracted_pop_total=210,
             ground_truth_cert="POKE-77123456", cert_correct=True, price_correct=True,
             latency_ms=2300),
        dict(deal=deal_map[5], model="gpt-4o",
             extracted_cert="POKE-77123456", extracted_price=95.0,
             extracted_pop_grade10=15, extracted_pop_total=210,
             ground_truth_cert="POKE-77123456", cert_correct=True, price_correct=True,
             latency_ms=5100),
        dict(deal=deal_map[5], model="claude-sonnet-4-6",
             extracted_cert=None,  # ground_truth not yet verified
             extracted_price=95.0,
             extracted_pop_grade10=15, extracted_pop_total=210,
             ground_truth_cert=None, cert_correct=None, price_correct=True,
             latency_ms=4100),
    ]

    for entry in runs:
        deal = entry.pop("deal")
        run = LabRun(deal_id=deal.id, **entry)
        db.add(run)
    db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────


def seed_all() -> None:
    init_db()
    db = SessionLocal()
    try:
        _clear_tables(db)

        wl_map = _seed_want_list(db)
        _seed_portfolio(db)
        _seed_price_history(db, wl_map)
        deal_map = _seed_deals(db, wl_map)
        _seed_audit_logs(db, deal_map)
        _seed_lab_runs(db, deal_map)

        wl_count = db.query(WantList).count()
        port_count = db.query(Portfolio).count()
        ph_count = db.query(PriceHistory).count()
        deal_count = db.query(Deal).count()
        audit_count = db.query(AuditLog).count()
        lab_count = db.query(LabRun).count()

        print(
            f"[seed] Done. {wl_count} want_list | {port_count} portfolio | "
            f"{ph_count} price_history | {deal_count} deals | "
            f"{audit_count} audit_log | {lab_count} lab_run rows"
        )
    finally:
        db.close()


if __name__ == "__main__":
    seed_all()
