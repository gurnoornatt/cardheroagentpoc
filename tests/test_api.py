"""
CardHero v2 — End-to-End API tests

Tests every endpoint and decision-tree gate using an in-memory SQLite database.
Each test function gets a fresh, isolated DB via the seeded_client fixture.

Run:  uv run pytest tests/ -v
"""

import json
import pytest


# ─────────────────────────────────────────────────────────────────────────────
# /health
# ─────────────────────────────────────────────────────────────────────────────


class TestHealth:
    def test_health_ok(self, seeded_client):
        client, *_ = seeded_client
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["db"] == "connected"
        assert "daily_spend_today" in body
        assert "budget_remaining" in body
        assert "daily_spend_limit" in body
        assert "agent_budget" in body

    def test_health_budget_fields_numeric(self, seeded_client):
        client, *_ = seeded_client
        body = client.get("/health").json()
        assert isinstance(body["daily_spend_today"], float)
        assert isinstance(body["budget_remaining"], float)
        assert isinstance(body["daily_spend_limit"], float)
        assert isinstance(body["agent_budget"], float)


# ─────────────────────────────────────────────────────────────────────────────
# /want-list
# ─────────────────────────────────────────────────────────────────────────────


class TestWantList:
    def test_returns_only_active(self, seeded_client):
        client, _, card1, card2 = seeded_client
        r = client.get("/want-list")
        assert r.status_code == 200
        items = r.json()
        assert len(items) == 2  # 2 active, 1 inactive → excluded

    def test_includes_sanitized_avg(self, seeded_client):
        client, _, card1, _ = seeded_client
        items = client.get("/want-list").json()
        charizard = next(i for i in items if i["name"] == "Charizard ex")
        # Has 2 weeks of price history → should have a sanitized_avg
        assert charizard["sanitized_avg"] is not None
        assert 290 < charizard["sanitized_avg"] < 340

    def test_no_sanitized_avg_for_card_without_history(self, seeded_client):
        client, _, _, card2 = seeded_client
        items = client.get("/want-list").json()
        blastoise = next(i for i in items if i["name"] == "Blastoise ex")
        assert blastoise["sanitized_avg"] is None


# ─────────────────────────────────────────────────────────────────────────────
# /portfolio
# ─────────────────────────────────────────────────────────────────────────────


class TestPortfolio:
    def test_returns_portfolio(self, seeded_client):
        client, *_ = seeded_client
        r = client.get("/portfolio")
        assert r.status_code == 200
        items = r.json()
        assert len(items) == 1
        item = items[0]
        assert item["name"] == "Charizard ex"
        assert item["cert_number"] == "POKE-48291033"

    def test_pnl_computed(self, seeded_client):
        client, *_ = seeded_client
        items = client.get("/portfolio").json()
        item = items[0]
        assert item["unrealized_pnl"] == pytest.approx(45.0, abs=0.01)
        assert item["pnl_pct"] == pytest.approx(14.52, abs=0.1)


# ─────────────────────────────────────────────────────────────────────────────
# /price-history
# ─────────────────────────────────────────────────────────────────────────────


class TestPriceHistory:
    def test_ingest_first_price(self, seeded_client):
        client, _, _, card2 = seeded_client
        r = client.post("/price-history", json={"want_list_id": card2.id, "price": 95.0})
        assert r.status_code == 200
        body = r.json()
        assert body["want_list_id"] == card2.id
        assert body["sample_count"] == 1
        # Only 1 price → IQR cannot compute
        assert body["sanitized_avg"] is None

    def test_iqr_requires_4_prices(self, seeded_client):
        client, _, _, card2 = seeded_client
        for p in [90.0, 95.0, 100.0]:
            client.post("/price-history", json={"want_list_id": card2.id, "price": p})
        r = client.post("/price-history", json={"want_list_id": card2.id, "price": 98.0})
        body = r.json()
        assert body["sample_count"] == 4
        # Now IQR should compute
        assert body["sanitized_avg"] is not None

    def test_upsert_same_week(self, seeded_client):
        """Posting multiple prices in the same week accumulates into one row."""
        client, _, _, card2 = seeded_client
        client.post("/price-history", json={"want_list_id": card2.id, "price": 90.0})
        client.post("/price-history", json={"want_list_id": card2.id, "price": 92.0})
        r = client.post("/price-history", json={"want_list_id": card2.id, "price": 94.0})
        # 3 prices posted, should be in 1 row
        assert r.json()["sample_count"] == 3

    def test_nonexistent_want_list(self, seeded_client):
        client, *_ = seeded_client
        r = client.post("/price-history", json={"want_list_id": 9999, "price": 50.0})
        assert r.status_code == 404

    def test_iqr_outlier_excluded(self, seeded_client):
        """An extreme outlier should be excluded from sanitized_avg."""
        client, _, _, card2 = seeded_client
        normal_prices = [95.0, 98.0, 97.0, 96.0, 94.0, 99.0]
        for p in normal_prices:
            client.post("/price-history", json={"want_list_id": card2.id, "price": p})
        # Add a wild outlier
        r = client.post("/price-history", json={"want_list_id": card2.id, "price": 500.0})
        body = r.json()
        # sanitized_avg should be near 97, NOT pulled toward 500
        assert body["sanitized_avg"] is not None
        assert body["sanitized_avg"] < 110


# ─────────────────────────────────────────────────────────────────────────────
# /evaluate — 8-gate decision tree
# ─────────────────────────────────────────────────────────────────────────────


class TestEvaluate:
    """Test each gate of the 8-gate decision tree independently."""

    def _base_payload(self, want_list_id: int, url: str = "https://www.ebay.com/itm/TEST001") -> dict:
        return {
            "want_list_id": want_list_id,
            "url": url,
            "listing_type": "BUY_IT_NOW",
            "price": 185.0,      # landed ≈ 201.65 — under max 380, under budget 500
            "shipping": 0.0,
            "seller_username": "test_seller",
            "seller_rating": 99.5,
            "seller_feedback_count": 500,
            "watchman_score": 0.72,
        }

    # Gate 1: WantList must exist
    def test_gate1_want_list_not_found(self, seeded_client):
        client, *_ = seeded_client
        r = client.post("/evaluate", json=self._base_payload(9999))
        assert r.status_code == 404

    # Gate 1: WantList must be active
    def test_gate1_inactive_want_list(self, seeded_client):
        client, db, card1, card2 = seeded_client
        from backend.database import WantList
        inactive = db.query(WantList).filter(WantList.is_active == False).first()
        r = client.post("/evaluate", json=self._base_payload(inactive.id))
        assert r.status_code == 404

    # Gate 2: AUCTION short-circuit
    def test_gate2_auction_noted(self, seeded_client):
        client, _, card1, _ = seeded_client
        payload = {**self._base_payload(card1.id), "listing_type": "AUCTION"}
        r = client.post("/evaluate", json=payload)
        assert r.status_code == 200
        body = r.json()
        assert body["decision"] == "AUCTION_NOTED"
        assert body["deal_id"] is None

    def test_gate2_auction_records_price_history(self, seeded_client):
        """Auction submission via /evaluate should also update price_history."""
        client, db, _, card2 = seeded_client
        from backend.database import PriceHistory
        payload = {**self._base_payload(card2.id), "listing_type": "AUCTION", "price": 85.0}
        client.post("/evaluate", json=payload)
        row = db.query(PriceHistory).filter(PriceHistory.want_list_id == card2.id).first()
        assert row is not None
        assert 85.0 in json.loads(row.raw_prices)

    # Gate 3: Landed cost vs max_price
    def test_gate3_over_max_price(self, seeded_client):
        client, _, _, card2 = seeded_client  # card2 = Blastoise ex, max_price=120
        payload = {**self._base_payload(card2.id), "price": 115.0, "shipping": 10.0}
        # landed = 115 + 10 + 115*0.09 = 135.35 > 120
        r = client.post("/evaluate", json=payload)
        body = r.json()
        assert body["decision"] == "NO_GO"
        assert body["reason"] == "over_max_price"

    # Gate 4: Budget circuit breaker
    def test_gate4_daily_budget_exceeded(self, seeded_client):
        client, db, card1, _ = seeded_client
        from backend.database import Deal
        from datetime import datetime, timezone
        # Inject a large BOUGHT deal to exhaust the budget
        big_deal = Deal(
            want_list_id=card1.id, url="https://fake.url/itm/1",
            listing_type="BUY_IT_NOW",
            price=490.0, shipping=0.0,
            tax_estimate=44.1, landed_cost=534.1,
            status="BOUGHT", watchman_score=0.5,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(big_deal)
        db.commit()
        r = client.post("/evaluate", json=self._base_payload(card1.id))
        body = r.json()
        assert body["decision"] == "NO_GO"
        assert body["reason"] == "daily_budget_exceeded"

    # Gate 5: Duplicate URL
    def test_gate5_duplicate_listing(self, seeded_client):
        client, _, card1, _ = seeded_client
        url = "https://www.ebay.com/itm/DUPLICATE_TEST"
        payload = {**self._base_payload(card1.id, url=url)}
        r1 = client.post("/evaluate", json=payload)
        assert r1.json()["decision"] in ("GO", "NO_GO")  # may or may not pass gate 6

        if r1.json()["decision"] == "GO":
            # Try same URL again → should be duplicate
            r2 = client.post("/evaluate", json=payload)
            assert r2.json()["decision"] == "NO_GO"
            assert "duplicate_listing" in r2.json()["reason"]

    # Gate 6: Insufficient undervalue
    def test_gate6_insufficient_undervalue(self, seeded_client):
        """Card1 has sanitized_avg ~315. price=220 → landed ~239.8 → delta ~75 < 100."""
        client, _, card1, _ = seeded_client
        payload = {**self._base_payload(card1.id), "price": 220.0, "shipping": 0.0,
                   "url": "https://www.ebay.com/itm/UNDERVALUE_TEST"}
        r = client.post("/evaluate", json=payload)
        body = r.json()
        assert body["decision"] == "NO_GO"
        assert body["reason"] == "insufficient_undervalue"
        assert body["undervalue_delta"] < 100

    def test_gate6_passes_when_no_history(self, seeded_client):
        """card2 has no price history → undervalue gate skipped → should reach GO."""
        client, _, _, card2 = seeded_client
        payload = {**self._base_payload(card2.id), "price": 80.0,
                   "url": "https://www.ebay.com/itm/NO_HISTORY_TEST"}
        r = client.post("/evaluate", json=payload)
        body = r.json()
        # No history → gate 6 skipped → should GO (if budget allows)
        assert body["decision"] == "GO"

    # Gate 8: Successful GO
    def test_gate8_go_creates_deal(self, seeded_client):
        client, db, card1, _ = seeded_client
        from backend.database import Deal
        payload = {**self._base_payload(card1.id), "price": 185.0,
                   "url": "https://www.ebay.com/itm/GO_TEST_UNIQUE"}
        r = client.post("/evaluate", json=payload)
        body = r.json()
        assert body["decision"] == "GO"
        assert body["deal_id"] is not None
        assert body["landed_cost"] == pytest.approx(201.65, abs=0.1)
        deal = db.query(Deal).filter(Deal.id == body["deal_id"]).first()
        assert deal is not None
        assert deal.status == "ANALYZING"
        assert deal.listing_type == "BUY_IT_NOW"

    def test_go_response_includes_sentiment(self, seeded_client):
        client, _, card1, _ = seeded_client
        payload = {**self._base_payload(card1.id), "url": "https://www.ebay.com/itm/SENTIMENT_TEST"}
        body = client.post("/evaluate", json=payload).json()
        if body["decision"] == "GO":
            assert "sentiment_score" in body
            assert isinstance(body["sentiment_score"], float)

    def test_go_landed_cost_correct(self, seeded_client):
        """Verify landed_cost = price + shipping + price * TAX_RATE."""
        client, _, _, card2 = seeded_client
        payload = {**self._base_payload(card2.id), "price": 80.0, "shipping": 5.0,
                   "url": "https://www.ebay.com/itm/MATH_TEST"}
        body = client.post("/evaluate", json=payload).json()
        expected = round(80.0 + 5.0 + 80.0 * 0.09, 2)
        assert body["landed_cost"] == pytest.approx(expected, abs=0.01)


# ─────────────────────────────────────────────────────────────────────────────
# /deals
# ─────────────────────────────────────────────────────────────────────────────


class TestDeals:
    def _create_deal(self, client, want_list_id, url, price=80.0):
        r = client.post("/evaluate", json={
            "want_list_id": want_list_id,
            "url": url,
            "listing_type": "BUY_IT_NOW",
            "price": price,
            "shipping": 0.0,
            "seller_username": "seller",
            "seller_rating": 99.5,
            "seller_feedback_count": 500,
            "watchman_score": 0.7,
        })
        return r.json()

    def test_list_deals_empty(self, seeded_client):
        client, *_ = seeded_client
        r = client.get("/deals")
        assert r.status_code == 200
        assert r.json() == []

    def test_list_deals_after_go(self, seeded_client):
        client, _, _, card2 = seeded_client
        result = self._create_deal(client, card2.id, "https://www.ebay.com/itm/D001")
        assert result["decision"] == "GO"
        deals = client.get("/deals").json()
        assert len(deals) == 1
        assert deals[0]["status"] == "ANALYZING"

    def test_filter_by_status(self, seeded_client):
        client, _, _, card2 = seeded_client
        self._create_deal(client, card2.id, "https://www.ebay.com/itm/D002")
        analyzing = client.get("/deals?status=ANALYZING").json()
        assert all(d["status"] == "ANALYZING" for d in analyzing)
        pending = client.get("/deals?status=PENDING").json()
        assert pending == []

    def test_get_single_deal(self, seeded_client):
        client, _, _, card2 = seeded_client
        result = self._create_deal(client, card2.id, "https://www.ebay.com/itm/D003")
        deal_id = result["deal_id"]
        r = client.get(f"/deals/{deal_id}")
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == deal_id
        assert body["listing_type"] == "BUY_IT_NOW"

    def test_get_nonexistent_deal(self, seeded_client):
        client, *_ = seeded_client
        r = client.get("/deals/99999")
        assert r.status_code == 404

    def test_patch_deal_status(self, seeded_client):
        client, _, _, card2 = seeded_client
        result = self._create_deal(client, card2.id, "https://www.ebay.com/itm/D004")
        deal_id = result["deal_id"]
        r = client.patch(f"/deals/{deal_id}/status", json={"status": "REJECTED"})
        assert r.status_code == 200
        assert r.json()["status"] == "REJECTED"

    def test_patch_invalid_status(self, seeded_client):
        client, _, _, card2 = seeded_client
        result = self._create_deal(client, card2.id, "https://www.ebay.com/itm/D005")
        deal_id = result["deal_id"]
        r = client.patch(f"/deals/{deal_id}/status", json={"status": "INVALID_STATUS"})
        assert r.status_code == 400

    def test_deal_includes_sentiment_fields(self, seeded_client):
        client, _, _, card2 = seeded_client
        result = self._create_deal(client, card2.id, "https://www.ebay.com/itm/D006")
        if result["decision"] == "GO":
            deal = client.get(f"/deals/{result['deal_id']}").json()
            assert "sentiment_score" in deal
            assert "sentiment_weight" in deal
            assert "listing_type" in deal


# ─────────────────────────────────────────────────────────────────────────────
# /agent/result
# ─────────────────────────────────────────────────────────────────────────────


class TestAgentResult:
    def _create_analyzing_deal(self, client, db, want_list_id):
        """Create a deal directly in ANALYZING state."""
        from backend.database import Deal
        from datetime import datetime, timezone
        deal = Deal(
            want_list_id=want_list_id,
            url="https://www.ebay.com/itm/AGENT_TEST",
            listing_type="BUY_IT_NOW",
            price=80.0, shipping=0.0,
            tax_estimate=7.2, landed_cost=87.2,
            status="ANALYZING",
            watchman_score=0.7,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(deal)
        db.commit()
        db.refresh(deal)
        return deal

    def test_agent_result_bought(self, seeded_client):
        client, db, _, card2 = seeded_client
        deal = self._create_analyzing_deal(client, db, card2.id)

        r = client.post("/agent/result", json={
            "deal_id": deal.id,
            "session_id": "bb-sess-test123",
            "verified_cert": "POKE-12345678",
            "price_locked": 80.0,
            "psa_pop_grade10": 25,
            "psa_pop_total": 200,
            "authenticity_guaranteed": True,
            "screenshot_path": "receipts/deal_test.png",
            "dom_snapshot_path": "receipts/deal_test_dom.html",
            "agent_extraction_json": '{"cert_number": "POKE-12345678", "price": 80.0}',
            "final_status": "BOUGHT",
            "rejection_reason": None,
            "model_used": "google/gemini-2.5-flash",
            "extraction_latency_ms": 2100,
        })
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "BOUGHT"

    def test_agent_result_creates_audit_log(self, seeded_client):
        client, db, _, card2 = seeded_client
        deal = self._create_analyzing_deal(client, db, card2.id)

        client.post("/agent/result", json={
            "deal_id": deal.id,
            "session_id": "bb-sess-audit",
            "verified_cert": "POKE-87654321",
            "price_locked": 80.0,
            "psa_pop_grade10": 30,
            "psa_pop_total": 250,
            "authenticity_guaranteed": False,
            "screenshot_path": "receipts/audit_test.png",
            "dom_snapshot_path": "receipts/audit_test_dom.html",
            "agent_extraction_json": '{"cert_number": "POKE-87654321"}',
            "final_status": "BOUGHT",
            "rejection_reason": None,
            "model_used": "google/gemini-2.5-flash",
            "extraction_latency_ms": 1800,
        })

        deal_detail = client.get(f"/deals/{deal.id}").json()
        assert "audit_log" in deal_detail
        audit = deal_detail["audit_log"]
        assert audit["verified_cert"] == "POKE-87654321"
        assert audit["psa_pop_grade10"] == 30
        assert audit["psa_pop_total"] == 250
        assert audit["model_used"] == "google/gemini-2.5-flash"
        assert audit["extraction_latency_ms"] == 1800

    def test_agent_result_rejected(self, seeded_client):
        client, db, _, card2 = seeded_client
        deal = self._create_analyzing_deal(client, db, card2.id)

        r = client.post("/agent/result", json={
            "deal_id": deal.id,
            "session_id": "bb-sess-rej",
            "verified_cert": "WRONG-99999",
            "price_locked": None,
            "psa_pop_grade10": None,
            "psa_pop_total": None,
            "authenticity_guaranteed": None,
            "screenshot_path": None,
            "dom_snapshot_path": None,
            "agent_extraction_json": '{"cert_number": "WRONG-99999"}',
            "final_status": "REJECTED",
            "rejection_reason": "cert_prefix_mismatch",
            "model_used": "google/gemini-2.5-flash",
            "extraction_latency_ms": 1500,
        })
        assert r.json()["status"] == "REJECTED"

    def test_agent_result_nonexistent_deal(self, seeded_client):
        client, *_ = seeded_client
        r = client.post("/agent/result", json={
            "deal_id": 99999,
            "session_id": "fake",
            "agent_extraction_json": "{}",
            "final_status": "REJECTED",
        })
        assert r.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# /lab endpoints
# ─────────────────────────────────────────────────────────────────────────────


class TestLab:
    def _create_deal(self, db, want_list_id):
        from backend.database import Deal
        from datetime import datetime, timezone
        deal = Deal(
            want_list_id=want_list_id,
            url=f"https://www.ebay.com/itm/LAB{id(db)}",
            listing_type="BUY_IT_NOW",
            price=80.0, shipping=0.0,
            tax_estimate=7.2, landed_cost=87.2,
            status="BOUGHT", watchman_score=0.7,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(deal)
        db.commit()
        db.refresh(deal)
        return deal

    def test_list_lab_runs_empty(self, seeded_client):
        client, *_ = seeded_client
        r = client.get("/lab/runs")
        assert r.status_code == 200
        assert r.json() == []

    def test_create_lab_run(self, seeded_client):
        client, db, _, card2 = seeded_client
        deal = self._create_deal(db, card2.id)
        r = client.post("/lab/runs", json={
            "deal_id": deal.id,
            "model": "google/gemini-2.5-flash",
            "extracted_cert": "POKE-12345678",
            "extracted_price": 80.0,
            "extracted_pop_grade10": 25,
            "extracted_pop_total": 200,
            "ground_truth_cert": "POKE-12345678",
            "latency_ms": 2100,
        })
        assert r.status_code == 201
        body = r.json()
        assert body["model"] == "google/gemini-2.5-flash"
        assert body["cert_correct"] is True
        assert body["price_correct"] is True

    def test_cert_correct_auto_computed(self, seeded_client):
        client, db, _, card2 = seeded_client
        deal = self._create_deal(db, card2.id)
        # Wrong cert
        r = client.post("/lab/runs", json={
            "deal_id": deal.id,
            "model": "gpt-4o",
            "extracted_cert": "12345678",  # missing POKE- prefix
            "extracted_price": 80.0,
            "ground_truth_cert": "POKE-12345678",
            "latency_ms": 3800,
        })
        assert r.status_code == 201
        assert r.json()["cert_correct"] is False

    def test_price_correct_within_1_dollar(self, seeded_client):
        client, db, _, card2 = seeded_client
        deal = self._create_deal(db, card2.id)
        r = client.post("/lab/runs", json={
            "deal_id": deal.id,
            "model": "claude-sonnet-4-6",
            "extracted_cert": "POKE-X",
            "extracted_price": 80.50,  # within $1 of deal.price=80
            "latency_ms": 4200,
        })
        assert r.json()["price_correct"] is True

    def test_price_wrong_beyond_1_dollar(self, seeded_client):
        client, db, _, card2 = seeded_client
        deal = self._create_deal(db, card2.id)
        r = client.post("/lab/runs", json={
            "deal_id": deal.id,
            "model": "claude-sonnet-4-6",
            "extracted_cert": "POKE-X",
            "extracted_price": 82.50,  # $2.50 off → wrong
            "latency_ms": 4200,
        })
        assert r.json()["price_correct"] is False

    def test_get_runs_for_deal(self, seeded_client):
        client, db, _, card2 = seeded_client
        deal = self._create_deal(db, card2.id)
        for model, cert in [("google/gemini-2.5-flash", "POKE-X"), ("gpt-4o", "POKE-Y")]:
            client.post("/lab/runs", json={
                "deal_id": deal.id, "model": model,
                "extracted_cert": cert, "latency_ms": 2000,
            })
        runs = client.get(f"/lab/runs/{deal.id}").json()
        assert len(runs) == 2
        models = {r["model"] for r in runs}
        assert "google/gemini-2.5-flash" in models
        assert "gpt-4o" in models

    def test_lab_metrics_accuracy_and_latency(self, seeded_client):
        client, db, _, card2 = seeded_client
        deal = self._create_deal(db, card2.id)

        # Gemini: 2 runs, both correct certs
        for cert, latency in [("POKE-X", 2000), ("POKE-X", 2200)]:
            client.post("/lab/runs", json={
                "deal_id": deal.id, "model": "google/gemini-2.5-flash",
                "extracted_cert": cert, "ground_truth_cert": "POKE-X",
                "latency_ms": latency,
            })

        # GPT-4o: 1 run, wrong cert
        client.post("/lab/runs", json={
            "deal_id": deal.id, "model": "gpt-4o",
            "extracted_cert": "WRONG", "ground_truth_cert": "POKE-X",
            "latency_ms": 5000,
        })

        metrics = client.get("/lab/metrics").json()
        assert "google/gemini-2.5-flash" in metrics
        assert "gpt-4o" in metrics

        gemini = metrics["google/gemini-2.5-flash"]
        assert gemini["run_count"] == 2
        assert gemini["cert_accuracy"] == pytest.approx(1.0)
        assert gemini["avg_latency_ms"] == 2100

        gpt = metrics["gpt-4o"]
        assert gpt["cert_accuracy"] == pytest.approx(0.0)

    def test_lab_run_nonexistent_deal(self, seeded_client):
        client, *_ = seeded_client
        r = client.post("/lab/runs", json={
            "deal_id": 99999, "model": "test",
        })
        assert r.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# IQR math — unit tests for _compute_iqr_stats
# ─────────────────────────────────────────────────────────────────────────────


class TestIQRMath:
    """Unit tests for the IQR computation logic (imported directly)."""

    def test_less_than_4_prices_returns_none(self):
        from backend.main import _compute_iqr_stats
        for n in range(0, 4):
            stats = _compute_iqr_stats([100.0] * n)
            assert stats["sanitized_avg"] is None
            assert stats["iqr_low"] is None
            assert stats["iqr_high"] is None

    def test_uniform_prices(self):
        from backend.main import _compute_iqr_stats
        prices = [100.0, 100.0, 100.0, 100.0, 100.0]
        stats = _compute_iqr_stats(prices)
        assert stats["sanitized_avg"] == pytest.approx(100.0)
        assert stats["iqr_low"] == pytest.approx(100.0)
        assert stats["iqr_high"] == pytest.approx(100.0)

    def test_outlier_excluded(self):
        from backend.main import _compute_iqr_stats
        # Normal cluster around 100, one extreme outlier
        prices = [95.0, 98.0, 100.0, 102.0, 105.0, 1000.0]
        stats = _compute_iqr_stats(prices)
        # 1000 is way outside fences → sanitized_avg should be near 100
        assert stats["sanitized_avg"] is not None
        assert stats["sanitized_avg"] < 120

    def test_realistic_card_prices(self):
        from backend.main import _compute_iqr_stats
        prices = [310.0, 325.0, 318.0, 299.0, 340.0, 335.0, 312.0]
        stats = _compute_iqr_stats(prices)
        assert stats["sanitized_avg"] is not None
        assert 300 < stats["sanitized_avg"] < 330
        assert stats["iqr_low"] < stats["iqr_high"]

    def test_symmetrical_distribution(self):
        from backend.main import _compute_iqr_stats
        prices = [90.0, 95.0, 100.0, 105.0, 110.0]
        stats = _compute_iqr_stats(prices)
        assert stats["sanitized_avg"] == pytest.approx(100.0, abs=1.0)


# ─────────────────────────────────────────────────────────────────────────────
# Decision-tree integration: end-to-end pipeline simulation
# ─────────────────────────────────────────────────────────────────────────────


class TestFullPipeline:
    """
    Simulates the real flow:
    Watchman → POST /price-history (auctions)
            → POST /evaluate (BIN) → GO → agent result → BOUGHT
    """

    def test_auction_builds_history_then_bin_deal_goes(self, seeded_client):
        client, _, _, card2 = seeded_client
        # Step 1: Feed auction prices to build history (simulate 6 weeks of Watchman data)
        for price in [90.0, 95.0, 92.0, 98.0, 93.0, 97.0]:
            r = client.post("/price-history", json={"want_list_id": card2.id, "price": price})
            assert r.status_code == 200

        # Verify sanitized_avg is now set
        wl_items = client.get("/want-list").json()
        blastoise = next(i for i in wl_items if i["name"] == "Blastoise ex")
        assert blastoise["sanitized_avg"] is not None
        avg = blastoise["sanitized_avg"]

        # Step 2: Find a price that's $100+ below sanitized_avg
        # avg ≈ 94. A deal at $0 wouldn't make sense, but avg is low here.
        # Use card1 (Charizard ex) which has more history
        wl_items2 = client.get("/want-list").json()
        charizard = next(i for i in wl_items2 if i["name"] == "Charizard ex")
        char_avg = charizard["sanitized_avg"]
        assert char_avg is not None

        # Price that gives undervalue_delta > 100
        target_price = char_avg - 110 - (char_avg - 110) * 0.09  # approx
        target_price = max(10.0, target_price)

        r = client.post("/evaluate", json={
            "want_list_id": charizard["id"],
            "url": "https://www.ebay.com/itm/PIPELINE_TEST",
            "listing_type": "BUY_IT_NOW",
            "price": round(target_price, 2),
            "shipping": 0.0,
            "seller_username": "pipeline_seller",
            "seller_rating": 99.5,
            "seller_feedback_count": 500,
            "watchman_score": 0.75,
        })
        body = r.json()
        assert body["decision"] == "GO", f"Expected GO but got: {body}"
        deal_id = body["deal_id"]
        assert body["undervalue_delta"] is not None
        assert body["undervalue_delta"] >= 100

        # Step 3: Agent reports BOUGHT
        r2 = client.post("/agent/result", json={
            "deal_id": deal_id,
            "session_id": "bb-pipeline-test",
            "verified_cert": "POKE-99887766",
            "price_locked": round(target_price, 2),
            "psa_pop_grade10": 55,
            "psa_pop_total": 400,
            "authenticity_guaranteed": True,
            "screenshot_path": f"receipts/deal_{deal_id}_pipeline.png",
            "dom_snapshot_path": f"receipts/deal_{deal_id}_pipeline_dom.html",
            "agent_extraction_json": '{"cert_number": "POKE-99887766", "price": ' + str(target_price) + '}',
            "final_status": "BOUGHT",
            "rejection_reason": None,
            "model_used": "google/gemini-2.5-flash",
            "extraction_latency_ms": 2350,
        })
        assert r2.status_code == 200
        assert r2.json()["status"] == "BOUGHT"

        # Step 4: Verify deal detail has audit log
        deal_detail = client.get(f"/deals/{deal_id}").json()
        assert deal_detail["status"] == "BOUGHT"
        assert deal_detail["audit_log"]["psa_pop_grade10"] == 55
        assert deal_detail["audit_log"]["authenticity_guaranteed"] is True

        # Step 5: Verify health shows spend increased
        health = client.get("/health").json()
        assert health["daily_spend_today"] > 0
