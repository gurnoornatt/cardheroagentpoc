"""
CardHero v2 — Conductor (FastAPI)

Implements the deterministic decision engine:
  - POST /evaluate      — Watchman→Conductor BIN handoff (8-gate decision tree)
  - POST /price-history — Watchman→Conductor auction data ingestion
  - POST /agent/result  — Agent→Conductor callback
  - GET  /lab/*         — A/B testing metrics endpoints
  + standard CRUD/health endpoints

Port: 8001  (avoids collision with v1 on 8000)
"""

import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import subprocess

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from newpoc.backend.config import (
    AGENT_BUDGET,
    DAILY_SPEND_LIMIT,
    PRICE_TRIGGER_DELTA,
    TAX_RATE,
)
from newpoc.backend.database import (
    AuditLog,
    Deal,
    LabRun,
    Portfolio,
    PriceHistory,
    SessionLocal,
    SystemMeta,
    WantList,
    get_db,
    init_db,
)
from newpoc.backend.sentiment import compute_effective_weight, get_sentiment_score

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info("[conductor] DB initialized — CardHero v2 ready on port 8001")
    yield


app = FastAPI(title="CardHero Conductor v2", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic request/response models
# ─────────────────────────────────────────────────────────────────────────────


class DealCandidate(BaseModel):
    want_list_id: int
    url: str
    listing_type: str = "BUY_IT_NOW"
    price: float
    shipping: float
    seller_username: str
    seller_rating: float
    seller_feedback_count: int
    watchman_score: float


class EvaluateResponse(BaseModel):
    decision: str
    reason: str
    deal_id: Optional[int] = None
    landed_cost: float
    undervalue_delta: Optional[float] = None
    sentiment_score: Optional[float] = None
    daily_spend_today: float
    budget_remaining: float


class PriceHistoryIngest(BaseModel):
    want_list_id: int
    price: float


class PriceHistoryResponse(BaseModel):
    want_list_id: int
    week_start: str
    sample_count: int
    sanitized_avg: Optional[float] = None
    iqr_low: Optional[float] = None
    iqr_high: Optional[float] = None


class AgentResult(BaseModel):
    deal_id: int
    session_id: str
    verified_cert: Optional[str] = None
    price_locked: Optional[float] = None
    psa_pop_grade10: Optional[int] = None
    psa_pop_total: Optional[int] = None
    authenticity_guaranteed: Optional[bool] = None
    screenshot_path: Optional[str] = None
    dom_snapshot_path: Optional[str] = None
    agent_extraction_json: str
    final_status: str
    rejection_reason: Optional[str] = None
    model_used: Optional[str] = None
    extraction_latency_ms: Optional[int] = None
    listing_page_text: Optional[str] = None   # raw page text for A/B model comparison


class PipelineRunRequest(BaseModel):
    url: str
    max_price: float
    dry_run: bool = True          # stops before clicking "Confirm and pay"


class StatusUpdate(BaseModel):
    status: str


class LabRunCreate(BaseModel):
    deal_id: int
    model: str
    extracted_cert: Optional[str] = None
    extracted_price: Optional[float] = None
    extracted_pop_grade10: Optional[int] = None
    extracted_pop_total: Optional[int] = None
    ground_truth_cert: Optional[str] = None
    latency_ms: Optional[int] = None


class LabExtractRequest(BaseModel):
    deal_id: int
    model: str                          # OpenRouter model ID e.g. "google/gemini-3-flash-preview"
    ground_truth_cert: Optional[str] = None
    listing_text: Optional[str] = None  # if provided, skip scraping and use this directly


class DealHuntRequest(BaseModel):
    card_name: str
    grade: str
    max_price: float
    platforms: list[str] = ["ebay"]


class DealHuntResult(BaseModel):
    platform: str
    title: str
    price: float
    shipping: float
    landed_cost: float
    url: str
    image_url: str = ""
    seller_username: str
    seller_rating: float
    seller_feedback_count: int
    watchman_score: float
    filter_passed: bool
    filter_reason: str


class DealHuntResponse(BaseModel):
    results: list[DealHuntResult]
    total: int
    filtered_count: int
    platforms_queried: list[str]


class WantListCreate(BaseModel):
    name: str
    grade: str
    max_price: float
    set_name: Optional[str] = None
    year: Optional[int] = None
    cert_prefix: Optional[str] = None


class CollectrImportRequest(BaseModel):
    showcase_url: str


class CollectrImportResponse(BaseModel):
    cards_found: int
    imported_count: int
    skipped_count: int
    want_list_additions: list[dict]
    skipped_details: list[dict]


class CollectrJobStartResponse(BaseModel):
    job_id: str


class CollectrJobStatusResponse(BaseModel):
    status: str           # "running" | "done" | "error"
    session_url: str | None = None
    result: CollectrImportResponse | None = None
    error: str | None = None


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────


def _compute_iqr_stats(prices: list[float]) -> dict:
    """
    Compute Tukey IQR fences and sanitized average.

    Returns None for all stats when len(prices) < 4 — insufficient data.
    Algorithm:
      Q1 = 25th percentile, Q3 = 75th percentile (linear interpolation)
      IQR = Q3 - Q1
      iqr_low  = Q1 - 1.5 * IQR
      iqr_high = Q3 + 1.5 * IQR
      sanitized_avg = mean of prices where iqr_low <= p <= iqr_high
    """
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


def _ingest_price_for_week(db: Session, want_list_id: int, price: float) -> PriceHistory:
    """
    Upsert a price observation into the current ISO week's price_history row.
    ISO week Monday = today - timedelta(days=today.weekday()).
    Re-computes IQR stats after appending the new price.
    """
    today = date.today()
    week_start = today - timedelta(days=today.weekday())

    row = (
        db.query(PriceHistory)
        .filter(
            PriceHistory.want_list_id == want_list_id,
            PriceHistory.week_start == week_start,
        )
        .first()
    )

    if row is None:
        row = PriceHistory(
            want_list_id=want_list_id,
            week_start=week_start,
            raw_prices=json.dumps([price]),
            sample_count=1,
        )
        db.add(row)
        db.flush()
    else:
        existing = json.loads(row.raw_prices)
        existing.append(price)
        row.raw_prices = json.dumps(existing)
        row.sample_count = len(existing)

    prices = json.loads(row.raw_prices)
    stats = _compute_iqr_stats(prices)
    row.iqr_low = stats["iqr_low"]
    row.iqr_high = stats["iqr_high"]
    row.sanitized_avg = stats["sanitized_avg"]

    return row


def _get_latest_sanitized_avg(db: Session, want_list_id: int) -> Optional[float]:
    """Most recent price_history row with a computed sanitized_avg."""
    row = (
        db.query(PriceHistory)
        .filter(
            PriceHistory.want_list_id == want_list_id,
            PriceHistory.sanitized_avg.isnot(None),
        )
        .order_by(PriceHistory.week_start.desc())
        .first()
    )
    return row.sanitized_avg if row else None


def _daily_spend(db: Session) -> float:
    """Sum of landed_cost for all BOUGHT deals created today (UTC)."""
    today_start = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    result = (
        db.query(func.sum(Deal.landed_cost))
        .filter(Deal.status == "BOUGHT", Deal.created_at >= today_start)
        .scalar()
    )
    return float(result or 0.0)


def _budget_remaining(db: Session) -> float:
    return max(0.0, DAILY_SPEND_LIMIT - _daily_spend(db))


# ─────────────────────────────────────────────────────────────────────────────
# Standard endpoints
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/health")
def health(db: Session = Depends(get_db)):
    daily_spend = _daily_spend(db)
    return {
        "status": "ok",
        "db": "connected",
        "daily_spend_today": round(daily_spend, 2),
        "budget_remaining": round(_budget_remaining(db), 2),
        "daily_spend_limit": DAILY_SPEND_LIMIT,
        "agent_budget": AGENT_BUDGET,
    }


@app.get("/want-list")
def list_want_list(db: Session = Depends(get_db)):
    items = db.query(WantList).filter(WantList.is_active).all()
    result = []
    for item in items:
        sanitized_avg = _get_latest_sanitized_avg(db, item.id)
        result.append(
            {
                "id": item.id,
                "name": item.name,
                "grade": item.grade,
                "max_price": item.max_price,
                "cert_prefix": item.cert_prefix,
                "target_id": item.target_id,
                "set_name": item.set_name,
                "year": item.year,
                "is_active": item.is_active,
                "sanitized_avg": sanitized_avg,
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
        )
    return result


@app.post("/want-list", status_code=201)
def create_want_list_item(body: WantListCreate, db: Session = Depends(get_db)):
    """Add a new card to the want list."""
    if body.max_price <= 0:
        raise HTTPException(status_code=400, detail="max_price must be > 0")
    item = WantList(
        name=body.name.strip(),
        grade=body.grade.strip(),
        max_price=body.max_price,
        set_name=body.set_name,
        year=body.year,
        cert_prefix=body.cert_prefix,
        is_active=True,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return {
        "id": item.id,
        "name": item.name,
        "grade": item.grade,
        "max_price": item.max_price,
        "set_name": item.set_name,
        "year": item.year,
        "is_active": item.is_active,
        "sanitized_avg": None,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


@app.delete("/want-list/{item_id}", status_code=204)
def delete_want_list_item(item_id: int, db: Session = Depends(get_db)):
    """Remove a card from the want list (soft delete — sets is_active=False)."""
    item = db.query(WantList).filter(WantList.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Want list item not found")
    item.is_active = False
    db.commit()


@app.get("/watchman/status")
def watchman_status(db: Session = Depends(get_db)):
    """
    Returns the last Watchman heartbeat — lets the UI show running/offline/blocked.
    The Watchman writes this after every poll_once() call.
    """
    row = db.query(SystemMeta).filter_by(key="watchman_status").first()
    if not row or not row.value:
        return {"status": "offline", "last_scan_at": None, "items_scanned": 0, "error": None}

    data = json.loads(row.value)
    last_scan_at = data.get("last_scan_at")
    error = data.get("error")
    items_scanned = data.get("items_scanned", 0)

    # Stale if no heartbeat in last 10 minutes
    stale = True
    if last_scan_at:
        try:
            last_dt = datetime.fromisoformat(last_scan_at)
            stale = (datetime.utcnow() - last_dt).total_seconds() > 600
        except ValueError:
            pass

    if stale:
        status = "offline"
    elif error:
        status = "blocked"
    else:
        status = "running"

    return {
        "status": status,
        "last_scan_at": last_scan_at,
        "items_scanned": items_scanned,
        "error": error,
    }


@app.get("/portfolio")
def list_portfolio(db: Session = Depends(get_db)):
    items = db.query(Portfolio).all()
    result = []
    for item in items:
        pnl = round(item.current_value - item.purchase_price, 2)
        pnl_pct = round(pnl / item.purchase_price * 100, 2) if item.purchase_price else 0.0
        result.append(
            {
                "id": item.id,
                "name": item.name,
                "grade": item.grade,
                "purchase_price": item.purchase_price,
                "current_value": item.current_value,
                "cert_number": item.cert_number,
                "purchase_date": item.purchase_date.isoformat() if item.purchase_date else None,
                "set_name": item.set_name,
                "year": item.year,
                "notes": item.notes,
                "unrealized_pnl": pnl,
                "pnl_pct": pnl_pct,
            }
        )
    return result


@app.get("/deals")
def list_deals(status: Optional[str] = None, db: Session = Depends(get_db)):
    query = db.query(Deal)
    if status:
        query = query.filter(Deal.status == status.upper())
    deals = query.order_by(Deal.created_at.desc()).all()
    return [_deal_to_dict(d) for d in deals]


@app.get("/deals/{deal_id}")
def get_deal(deal_id: int, db: Session = Depends(get_db)):
    deal = db.query(Deal).filter(Deal.id == deal_id).first()
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found")
    d = _deal_to_dict(deal)
    if deal.audit_log:
        al = deal.audit_log
        d["audit_log"] = {
            "id": al.id,
            "agent_extraction_json": al.agent_extraction_json,
            "psa_pop_grade10": al.psa_pop_grade10,
            "psa_pop_total": al.psa_pop_total,
            "screenshot_path": al.screenshot_path,
            "dom_snapshot_path": al.dom_snapshot_path,
            "verified_cert": al.verified_cert,
            "price_locked": al.price_locked,
            "authenticity_guaranteed": al.authenticity_guaranteed,
            "session_id": al.session_id,
            "model_used": al.model_used,
            "extraction_latency_ms": al.extraction_latency_ms,
            "created_at": al.created_at.isoformat() if al.created_at else None,
        }
    return d


@app.patch("/deals/{deal_id}/status")
def update_deal_status(
    deal_id: int, update: StatusUpdate, db: Session = Depends(get_db)
):
    deal = db.query(Deal).filter(Deal.id == deal_id).first()
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found")
    valid = {"PENDING", "ANALYZING", "BOUGHT", "REJECTED"}
    if update.status.upper() not in valid:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid}")
    deal.status = update.status.upper()
    deal.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(deal)
    return _deal_to_dict(deal)


def _deal_to_dict(deal: Deal) -> dict:
    return {
        "id": deal.id,
        "want_list_id": deal.want_list_id,
        "url": deal.url,
        "listing_type": deal.listing_type,
        "price": deal.price,
        "shipping": deal.shipping,
        "tax_estimate": deal.tax_estimate,
        "landed_cost": deal.landed_cost,
        "status": deal.status,
        "watchman_score": deal.watchman_score,
        "sentiment_score": deal.sentiment_score,
        "sentiment_weight": deal.sentiment_weight,
        "undervalue_delta": deal.undervalue_delta,
        "seller_username": deal.seller_username,
        "seller_rating": deal.seller_rating,
        "seller_feedback_count": deal.seller_feedback_count,
        "ebay_item_id": deal.ebay_item_id,
        "created_at": deal.created_at.isoformat() if deal.created_at else None,
        "updated_at": deal.updated_at.isoformat() if deal.updated_at else None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# POST /evaluate — 8-gate decision tree
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/evaluate", response_model=EvaluateResponse)
def evaluate(candidate: DealCandidate, db: Session = Depends(get_db)):
    # Gate 1: WantList item must exist and be active
    wl_item = (
        db.query(WantList)
        .filter(WantList.id == candidate.want_list_id, WantList.is_active)
        .first()
    )
    if not wl_item:
        raise HTTPException(status_code=404, detail="WantList item not found or inactive")

    tax_estimate = round(candidate.price * TAX_RATE, 2)
    landed_cost = round(candidate.price + candidate.shipping + tax_estimate, 2)
    daily_spend = _daily_spend(db)
    budget_remaining = _budget_remaining(db)

    def no_go(reason: str, **kwargs) -> EvaluateResponse:
        logger.info(f"[evaluate] NO_GO — {reason} | want_list_id={candidate.want_list_id} url={candidate.url}")
        return EvaluateResponse(
            decision="NO_GO",
            reason=reason,
            landed_cost=landed_cost,
            daily_spend_today=round(daily_spend, 2),
            budget_remaining=round(budget_remaining, 2),
            **kwargs,
        )

    # Gate 2: Auction short-circuit — record price history only
    if candidate.listing_type.upper() == "AUCTION":
        _ingest_price_for_week(db, candidate.want_list_id, candidate.price)
        db.commit()
        logger.info(f"[evaluate] AUCTION_NOTED — price={candidate.price} want_list_id={candidate.want_list_id}")
        return EvaluateResponse(
            decision="AUCTION_NOTED",
            reason="auction price recorded in price_history",
            landed_cost=landed_cost,
            daily_spend_today=round(daily_spend, 2),
            budget_remaining=round(budget_remaining, 2),
        )

    # Gate 3: Landed cost vs max_price
    if landed_cost > wl_item.max_price:
        return no_go("over_max_price")

    # Gate 4: Budget circuit breaker
    if landed_cost > budget_remaining:
        return no_go("daily_budget_exceeded")

    # Gate 5: Duplicate URL (non-REJECTED deals)
    existing = (
        db.query(Deal)
        .filter(Deal.url == candidate.url, Deal.status.notin_(["REJECTED"]))
        .first()
    )
    if existing:
        return no_go(f"duplicate_listing (deal_id={existing.id})")

    # Gate 6: Insufficient undervalue vs sanitized_avg
    sanitized_avg = _get_latest_sanitized_avg(db, candidate.want_list_id)
    undervalue_delta: Optional[float] = None
    if sanitized_avg is not None:
        undervalue_delta = round(sanitized_avg - landed_cost, 2)
        if undervalue_delta < PRICE_TRIGGER_DELTA:
            return no_go("insufficient_undervalue", undervalue_delta=undervalue_delta)

    # Gate 7: Sentiment modifier (cannot flip NO_GO — only adjusts watchman_score)
    sentiment_score = get_sentiment_score(wl_item.name)
    effective_weight = compute_effective_weight(sentiment_score)
    if sentiment_score >= 0:
        adjusted_score = candidate.watchman_score + effective_weight
    else:
        adjusted_score = candidate.watchman_score - effective_weight
    adjusted_score = round(max(0.0, min(1.0, adjusted_score)), 4)

    # Gate 8: GO — create Deal with status=ANALYZING
    ebay_item_id = candidate.url.split("/itm/")[-1].split("?")[0] if "/itm/" in candidate.url else ""
    deal = Deal(
        want_list_id=candidate.want_list_id,
        url=candidate.url,
        listing_type="BUY_IT_NOW",
        price=candidate.price,
        shipping=candidate.shipping,
        tax_estimate=tax_estimate,
        landed_cost=landed_cost,
        status="ANALYZING",
        watchman_score=adjusted_score,
        sentiment_score=round(sentiment_score, 4),
        sentiment_weight=effective_weight,
        undervalue_delta=undervalue_delta,
        seller_username=candidate.seller_username,
        seller_rating=candidate.seller_rating,
        seller_feedback_count=candidate.seller_feedback_count,
        ebay_item_id=ebay_item_id,
    )
    db.add(deal)
    db.commit()
    db.refresh(deal)

    logger.info(
        f"[evaluate] GO — deal_id={deal.id} landed_cost={landed_cost} "
        f"undervalue_delta={undervalue_delta} sentiment={sentiment_score:.4f}"
    )

    return EvaluateResponse(
        decision="GO",
        reason="all checks passed",
        deal_id=deal.id,
        landed_cost=landed_cost,
        undervalue_delta=undervalue_delta,
        sentiment_score=round(sentiment_score, 4),
        daily_spend_today=round(daily_spend, 2),
        budget_remaining=round(budget_remaining, 2),
    )


# ─────────────────────────────────────────────────────────────────────────────
# POST /price-history — auction ingestion
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/price-history", response_model=PriceHistoryResponse)
def ingest_price_history(payload: PriceHistoryIngest, db: Session = Depends(get_db)):
    wl_item = db.query(WantList).filter(WantList.id == payload.want_list_id).first()
    if not wl_item:
        raise HTTPException(status_code=404, detail="WantList item not found")

    row = _ingest_price_for_week(db, payload.want_list_id, payload.price)
    db.commit()
    db.refresh(row)

    return PriceHistoryResponse(
        want_list_id=row.want_list_id,
        week_start=row.week_start.isoformat(),
        sample_count=row.sample_count,
        sanitized_avg=row.sanitized_avg,
        iqr_low=row.iqr_low,
        iqr_high=row.iqr_high,
    )


# ─────────────────────────────────────────────────────────────────────────────
# POST /agent/result — agent callback
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/agent/result")
def agent_result(
    result: AgentResult,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    deal = db.query(Deal).filter(Deal.id == result.deal_id).first()
    if not deal:
        raise HTTPException(status_code=404, detail=f"Deal {result.deal_id} not found")

    deal.status = result.final_status.upper()
    deal.updated_at = datetime.now(timezone.utc)

    # Update deal price if agent found the actual price (ad-hoc runs start at 0)
    if result.price_locked and result.price_locked > 0 and deal.price == 0:
        deal.price = result.price_locked
        deal.tax_estimate = round(result.price_locked * TAX_RATE, 2)
        deal.landed_cost = round(result.price_locked * (1 + TAX_RATE), 2)

    # Build extraction JSON — embed rejection_reason for frontend display
    extraction_data: dict = {}
    try:
        extraction_data = json.loads(result.agent_extraction_json)
    except Exception:
        extraction_data = {"raw": result.agent_extraction_json}
    if result.rejection_reason:
        extraction_data["_rejection_reason"] = result.rejection_reason

    # Create or update audit log
    audit = db.query(AuditLog).filter(AuditLog.deal_id == result.deal_id).first()
    if audit is None:
        audit = AuditLog(deal_id=result.deal_id)
        db.add(audit)

    audit.agent_extraction_json = json.dumps(extraction_data)
    audit.psa_pop_grade10 = result.psa_pop_grade10
    audit.psa_pop_total = result.psa_pop_total
    audit.screenshot_path = result.screenshot_path
    audit.dom_snapshot_path = result.dom_snapshot_path
    audit.verified_cert = result.verified_cert
    audit.price_locked = result.price_locked
    audit.authenticity_guaranteed = result.authenticity_guaranteed
    audit.session_id = result.session_id
    audit.model_used = result.model_used
    audit.extraction_latency_ms = result.extraction_latency_ms

    db.commit()

    # A/B comparison — run both OpenRouter models on the same page text in background
    if result.listing_page_text:
        ground_truth = result.verified_cert if result.verified_cert != "NOT_FOUND" else None
        background_tasks.add_task(
            _run_ab_comparison,
            deal_id=result.deal_id,
            listing_text=result.listing_page_text,
            ground_truth_cert=ground_truth,
            deal_price=result.price_locked or 0.0,
        )

    logger.info(
        f"[agent/result] deal_id={result.deal_id} → {result.final_status} "
        f"cert={result.verified_cert} price_locked={result.price_locked}"
    )

    return {
        "deal_id": result.deal_id,
        "status": deal.status,
        "message": f"Deal {result.deal_id} updated to {deal.status}",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Lab endpoints
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/lab/runs")
def list_lab_runs(db: Session = Depends(get_db)):
    runs = db.query(LabRun).order_by(LabRun.created_at.desc()).all()
    return [_lab_run_to_dict(r) for r in runs]


@app.get("/lab/runs/{deal_id}")
def get_lab_runs_for_deal(deal_id: int, db: Session = Depends(get_db)):
    runs = (
        db.query(LabRun)
        .filter(LabRun.deal_id == deal_id)
        .order_by(LabRun.created_at.asc())
        .all()
    )
    return [_lab_run_to_dict(r) for r in runs]


@app.post("/lab/runs", status_code=201)
def create_lab_run(payload: LabRunCreate, db: Session = Depends(get_db)):
    deal = db.query(Deal).filter(Deal.id == payload.deal_id).first()
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found")

    # Auto-compute correctness
    cert_correct = None
    if payload.ground_truth_cert and payload.extracted_cert:
        cert_correct = payload.extracted_cert == payload.ground_truth_cert

    price_correct = None
    if payload.extracted_price is not None:
        price_correct = abs(payload.extracted_price - deal.price) <= 1.00

    run = LabRun(
        deal_id=payload.deal_id,
        model=payload.model,
        extracted_cert=payload.extracted_cert,
        extracted_price=payload.extracted_price,
        extracted_pop_grade10=payload.extracted_pop_grade10,
        extracted_pop_total=payload.extracted_pop_total,
        ground_truth_cert=payload.ground_truth_cert,
        cert_correct=cert_correct,
        price_correct=price_correct,
        latency_ms=payload.latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return _lab_run_to_dict(run)


@app.get("/lab/metrics")
def lab_metrics(db: Session = Depends(get_db)):
    runs = db.query(LabRun).all()
    by_model: dict[str, dict] = {}

    for r in runs:
        m = r.model
        if m not in by_model:
            by_model[m] = {"cert_correct": [], "latencies": [], "count": 0}
        by_model[m]["count"] += 1
        if r.cert_correct is not None:
            by_model[m]["cert_correct"].append(int(r.cert_correct))
        if r.latency_ms is not None:
            by_model[m]["latencies"].append(r.latency_ms)

    result = {}
    for model, data in by_model.items():
        certs = data["cert_correct"]
        lats = data["latencies"]
        result[model] = {
            "run_count": data["count"],
            "cert_accuracy": round(sum(certs) / len(certs), 4) if certs else None,
            "avg_latency_ms": round(sum(lats) / len(lats)) if lats else None,
        }
    return result


AGENT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../agent"))
AB_MODELS = ["google/gemini-3-flash-preview", "openai/gpt-5-nano"]

_OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
_PROXY_URL = os.getenv("RESIDENTIAL_PROXY_URL", "")
_PREFLIGHT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def _fetch_listing_images_sync(url: str) -> dict | None:
    """
    GET eBay listing HTML via residential proxy, parse og: meta tags.
    Returns {"price": float|None, "images": [url, ...]} or None on failure.
    Uses requests (not httpx) for reliable proxy auth handling.
    """
    import requests as _requests
    if not _PROXY_URL:
        logger.warning("[preflight] RESIDENTIAL_PROXY_URL not set — skipping proxy fetch")
        return None
    proxies = {"http": _PROXY_URL, "https": _PROXY_URL}
    try:
        resp = _requests.get(url, headers=_PREFLIGHT_HEADERS, proxies=proxies, timeout=15, allow_redirects=True)
        resp.raise_for_status()
    except Exception as exc:
        logger.warning(f"[preflight] proxy fetch failed: {exc}")
        return None

    from bs4 import BeautifulSoup
    soup = BeautifulSoup(resp.text, "html.parser")

    # og:image is server-rendered — always present even on React pages
    images = [
        tag["content"]
        for tag in soup.find_all("meta", property="og:image")
        if tag.get("content", "").startswith("http")
    ][:3]

    # Price from og:price:amount or itemprop="price"
    price: float | None = None
    price_tag = soup.find("meta", property="og:price:amount") or soup.find("span", itemprop="price")
    if price_tag:
        try:
            raw_price = price_tag.get("content") or ""
            price = float(raw_price.replace(",", "").strip())
        except (ValueError, AttributeError):
            pass

    logger.info(f"[preflight] fetched listing — images={len(images)} price={price}")
    return {"price": price, "images": images}


async def _fetch_listing_images(url: str) -> dict | None:
    """Async wrapper — runs sync proxy fetch in a thread to avoid blocking the event loop."""
    import asyncio
    return await asyncio.to_thread(_fetch_listing_images_sync, url)


async def _vision_cert_check(images: list[str]) -> str:
    """
    Call Gemini 2.0 Flash via OpenRouter with listing images.
    Returns cert number string or "NOT_FOUND".
    """
    if not _OPENROUTER_KEY or not images:
        return "NOT_FOUND"
    for img_url in images:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {_OPENROUTER_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": "google/gemini-2.0-flash-001",
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": img_url}},
                                {
                                    "type": "text",
                                    "text": (
                                        "This is a product photo from an eBay listing for a PSA-graded "
                                        "Pokémon card. Find the PSA certification number on the yellow "
                                        "slab label — typically an 8-digit number, sometimes prefixed "
                                        "like 'POKE-12345678'. Return ONLY the cert number. "
                                        "If not visible, return: NOT_FOUND"
                                    ),
                                },
                            ],
                        }],
                        "max_tokens": 30,
                    },
                )
            raw = resp.json()["choices"][0]["message"]["content"].strip()
            if raw and raw != "NOT_FOUND" and re.search(r"\d{6,}", raw):
                return re.sub(r"[^A-Z0-9\-]", "", raw.upper())
        except Exception as exc:
            logger.warning(f"[preflight] vision cert error: {exc}")
    return "NOT_FOUND"


async def _phase1_preflight(
    deal_id: int,
    url: str,
    max_price: float,
    dry_run: bool,
) -> None:
    """
    Phase 1: fetch listing data via residential proxy + run vision cert check.
    Then spawn the Node agent (Phase 2) with pre-extracted cert + price.
    The agent skips all Browserbase extraction and goes straight to checkout.
    """
    logger.info(f"[preflight] deal_id={deal_id} Phase 1 starting")

    listing = await _fetch_listing_images(url)
    price_locked: float | None = listing["price"] if listing else None
    images: list[str] = listing["images"] if listing else []
    verified_cert = await _vision_cert_check(images)

    logger.info(
        f"[preflight] deal_id={deal_id} "
        f"price={price_locked} cert={verified_cert} images={len(images)}"
    )

    agent_input = json.dumps({
        "deal_id": deal_id,
        "url": url,
        "max_allowed_price": max_price,
        "expected_cert_prefix": "",
        "dry_run": dry_run,
        "verified_cert": verified_cert,
        "price_locked": price_locked,
    })
    subprocess.Popen(
        ["npx", "ts-node", "checkout.ts", agent_input],
        cwd=AGENT_DIR,
        stdout=None,
        stderr=None,
    )


def _extraction_prompt(listing_text: str) -> str:
    return (
        "Extract data from this eBay Pokemon card listing. "
        "Return ONLY JSON, no markdown, no extra text.\n\n"
        f"Listing text:\n{listing_text[:3500]}\n\n"
        'JSON: {"cert_number": "PSA cert as shown (e.g. POKE-12345678) or NOT_FOUND", '
        '"price": 0.0, "psa_pop_grade10": 0, "psa_pop_total": 0, "authenticity_guaranteed": false}'
    )


async def _call_openrouter(model: str, prompt: str) -> dict:
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY not set")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer": "https://cardhero.app",
                "X-Title": "CardHero Lab",
            },
            json={"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0},
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            lines = content.splitlines()
            content = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:]).strip()
        return json.loads(content)


async def _run_ab_comparison(
    deal_id: int, listing_text: str, ground_truth_cert: Optional[str], deal_price: float
) -> None:
    """Run Gemini 3 Flash + GPT-5 Nano via OpenRouter in background, save lab_runs."""
    for model in AB_MODELS:
        start = datetime.now(timezone.utc)
        try:
            extracted = await _call_openrouter(model, _extraction_prompt(listing_text))
            latency_ms = int((datetime.now(timezone.utc) - start).total_seconds() * 1000)

            ec = extracted.get("cert_number") or None
            ep = extracted.get("price")

            cert_correct = None
            if ground_truth_cert and ec and ec != "NOT_FOUND":
                cert_correct = ec == ground_truth_cert

            price_correct = None
            if ep and float(ep) > 0 and deal_price > 0:
                price_correct = abs(float(ep) - deal_price) <= 1.00

            db = SessionLocal()
            try:
                run = LabRun(
                    deal_id=deal_id, model=model,
                    extracted_cert=str(ec) if ec else None,
                    extracted_price=float(ep) if ep else None,
                    extracted_pop_grade10=int(extracted.get("psa_pop_grade10") or 0) or None,
                    extracted_pop_total=int(extracted.get("psa_pop_total") or 0) or None,
                    ground_truth_cert=ground_truth_cert,
                    cert_correct=cert_correct, price_correct=price_correct,
                    latency_ms=latency_ms,
                )
                db.add(run)
                db.commit()
                logger.info(f"[a/b] deal_id={deal_id} model={model} cert={ec} latency={latency_ms}ms")
            finally:
                db.close()
        except Exception as exc:
            logger.error(f"[a/b] {model} deal_id={deal_id} failed: {exc}")


def _validate_pipeline_request(payload: PipelineRunRequest, request: Request) -> None:
    """Validate URL is an eBay listing, and check optional API key if configured."""
    from urllib.parse import urlparse
    try:
        parsed = urlparse(payload.url)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL must use http or https")
    hostname = parsed.netloc.lower().lstrip("www.")
    if hostname not in ("ebay.com", "ebay.co.uk", "ebay.ca", "ebay.com.au"):
        raise HTTPException(status_code=400, detail="URL must be from ebay.com")
    if "/itm/" not in payload.url:
        raise HTTPException(status_code=400, detail="URL must be a valid eBay listing (/itm/)")
    if payload.max_price <= 0 or payload.max_price > 10_000:
        raise HTTPException(status_code=400, detail="max_price must be between 0 and 10,000")

    # Optional API key guard — set PIPELINE_API_KEY env var to enable.
    # If not set, anyone can call the endpoint (fine for local dev / private deploy).
    required_key = os.getenv("PIPELINE_API_KEY", "")
    if required_key:
        provided = request.headers.get("X-API-Key", "")
        if provided != required_key:
            raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key header")


@app.post("/pipeline/run", status_code=201)
async def run_pipeline(
    payload: PipelineRunRequest,
    background_tasks: BackgroundTasks,
    request: Request,
    db: Session = Depends(get_db),
):
    """
    Two-phase pipeline:
      Phase 1 (BackgroundTask): fetch listing via residential proxy + vision cert check
      Phase 2 (spawned by preflight): Node agent does checkout only — no extraction
    Returns deal_id immediately; poll GET /deals/{id} for status.
    """
    _validate_pipeline_request(payload, request)

    wl = db.query(WantList).filter(WantList.is_active).first()
    if not wl:
        raise HTTPException(status_code=400, detail="No active want list items in DB")

    clean_url = payload.url.split("?")[0]
    ebay_item_id = clean_url.split("/itm/")[-1] if "/itm/" in clean_url else ""

    deal = Deal(
        want_list_id=wl.id,
        url=clean_url,
        listing_type="BUY_IT_NOW",
        price=0.0, shipping=0.0, tax_estimate=0.0, landed_cost=0.0,
        status="ANALYZING",
        watchman_score=0.0,
        ebay_item_id=ebay_item_id,
    )
    db.add(deal)
    db.commit()
    db.refresh(deal)

    background_tasks.add_task(
        _phase1_preflight,
        deal.id, payload.url, payload.max_price, payload.dry_run,
    )

    logger.info(f"[pipeline/run] deal_id={deal.id} url={clean_url} preflight queued")
    return {"deal_id": deal.id, "status": "ANALYZING"}


@app.post("/lab/extract", status_code=201)
async def run_lab_extraction(payload: LabExtractRequest, db: Session = Depends(get_db)):
    """
    Fetch an eBay listing, send it to an OpenRouter model, save the extraction as a lab_run.
    Supports any OpenRouter model ID: google/gemini-3-flash-preview, openai/gpt-5-nano, etc.
    """
    deal = db.query(Deal).filter(Deal.id == payload.deal_id).first()
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found")

    start_ts = datetime.now(timezone.utc)

    # 1. Require caller-supplied listing text (backend cannot scrape eBay — bot detection)
    if not payload.listing_text:
        raise HTTPException(
            status_code=400,
            detail="listing_text is required — run the agent first to capture page text"
        )
    listing_text = payload.listing_text

    # 2. Build structured extraction prompt
    prompt = (
        "You are extracting data from an eBay listing for a PSA-graded Pokemon card.\n\n"
        f"Listing content:\n{listing_text}\n\n"
        "Return ONLY this JSON structure — no other text:\n"
        '{"cert_number": "PSA cert number as shown, or NOT_FOUND", '
        '"price": 0.0, '
        '"psa_pop_grade10": 0, '
        '"psa_pop_total": 0, '
        '"authenticity_guaranteed": false}'
    )

    # 3. Call OpenRouter
    try:
        extracted = await _call_openrouter(payload.model, prompt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OpenRouter error: {exc}")

    latency_ms = int((datetime.now(timezone.utc) - start_ts).total_seconds() * 1000)

    # 4. Auto-compute correctness
    extracted_cert = extracted.get("cert_number") or None
    extracted_price = extracted.get("price")

    cert_correct = None
    if payload.ground_truth_cert and extracted_cert and extracted_cert != "NOT_FOUND":
        cert_correct = extracted_cert == payload.ground_truth_cert

    price_correct = None
    if extracted_price is not None and float(extracted_price) > 0:
        price_correct = abs(float(extracted_price) - deal.price) <= 1.00

    pop10 = extracted.get("psa_pop_grade10")
    pop_total = extracted.get("psa_pop_total")

    run = LabRun(
        deal_id=payload.deal_id,
        model=payload.model,
        extracted_cert=str(extracted_cert) if extracted_cert else None,
        extracted_price=float(extracted_price) if extracted_price else None,
        extracted_pop_grade10=int(pop10) if pop10 else None,
        extracted_pop_total=int(pop_total) if pop_total else None,
        ground_truth_cert=payload.ground_truth_cert,
        cert_correct=cert_correct,
        price_correct=price_correct,
        latency_ms=latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    logger.info(
        f"[lab/extract] deal_id={payload.deal_id} model={payload.model} "
        f"cert={extracted_cert} price={extracted_price} latency={latency_ms}ms"
    )
    return _lab_run_to_dict(run)


# ─────────────────────────────────────────────────────────────────────────────
# Agent log streaming (in-memory, keyed by deal_id)
# ─────────────────────────────────────────────────────────────────────────────

_agent_logs: dict[int, list[str]] = {}


class LogMessage(BaseModel):
    message: str


@app.post("/deals/{deal_id}/log", status_code=204)
def add_agent_log(deal_id: int, payload: LogMessage):
    if deal_id not in _agent_logs:
        _agent_logs[deal_id] = []
    _agent_logs[deal_id].append(payload.message)


@app.get("/deals/{deal_id}/logs")
def get_agent_logs(deal_id: int):
    return {"logs": _agent_logs.get(deal_id, [])}


def _lab_run_to_dict(r: LabRun) -> dict:
    return {
        "id": r.id,
        "deal_id": r.deal_id,
        "model": r.model,
        "extracted_cert": r.extracted_cert,
        "extracted_price": r.extracted_price,
        "extracted_pop_grade10": r.extracted_pop_grade10,
        "extracted_pop_total": r.extracted_pop_total,
        "ground_truth_cert": r.ground_truth_cert,
        "cert_correct": r.cert_correct,
        "price_correct": r.price_correct,
        "latency_ms": r.latency_ms,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Scraper comparison endpoint
# ─────────────────────────────────────────────────────────────────────────────

class ScraperCompareRequest(BaseModel):
    query: str


@app.post("/scraper-compare")
def scraper_compare(req: ScraperCompareRequest):
    """Run HTML and Apify scrapers in parallel and return side-by-side results."""
    import time
    from concurrent.futures import ThreadPoolExecutor
    from urllib.parse import quote_plus
    from newpoc.backend.monitor import _scrape_listings_apify, _scrape_listings_html

    search_url = (
        f"https://www.ebay.com/sch/i.html"
        f"?_nkw={quote_plus(req.query)}&_sop=15&_ipg=50&LH_BIN=1"
    )

    def run_html():
        t0 = time.time()
        results = _scrape_listings_html(search_url, "BUY_IT_NOW")
        return results, int((time.time() - t0) * 1000)

    def run_apify():
        t0 = time.time()
        results = _scrape_listings_apify(search_url, "BUY_IT_NOW")
        return results, int((time.time() - t0) * 1000)

    with ThreadPoolExecutor(max_workers=2) as ex:
        html_f = ex.submit(run_html)
        apify_f = ex.submit(run_apify)
        html_results, html_ms = html_f.result()
        apify_results, apify_ms = apify_f.result()

    def summarize(results: list, elapsed_ms: int) -> dict:
        prices = [r["price"] for r in results if r["price"] > 0]
        return {
            "count": len(results),
            "time_ms": elapsed_ms,
            "price_min": round(min(prices), 2) if prices else None,
            "price_max": round(max(prices), 2) if prices else None,
            "price_avg": round(sum(prices) / len(prices), 2) if prices else None,
            "samples": [
                {
                    "title": r["title"][:80],
                    "price": r["price"],
                    "shipping": r["shipping"],
                    "url": r["url"],
                }
                for r in results[:6]
            ],
        }

    return {
        "query": req.query,
        "search_url": search_url,
        "html": summarize(html_results, html_ms),
        "apify": summarize(apify_results, apify_ms),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Feature: Multi-platform deal hunter
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/tools/deal-hunt", response_model=DealHuntResponse)
def deal_hunt(req: DealHuntRequest):
    """
    On-demand multi-platform deal search. Agent-callable tool endpoint.
    eBay is always active. Mercari/OfferUp/FB activate when PLATFORM_ACTORS are set.
    """
    from newpoc.backend.monitor import WantListProxy, run_waterfall, scrape_platform

    valid_platforms = {"ebay", "mercari", "offerup", "fb_marketplace"}
    platforms = [p for p in req.platforms if p in valid_platforms]
    if not platforms:
        raise HTTPException(status_code=400, detail="No valid platforms specified")

    proxy = WantListProxy(max_price=req.max_price, name=req.card_name)
    all_results: list[DealHuntResult] = []

    for platform in platforms:
        raw = scrape_platform(req.card_name, req.grade, platform)
        for listing in raw:
            passed, reason, enriched = run_waterfall(listing, proxy)
            all_results.append(DealHuntResult(
                platform=platform,
                title=listing["title"],
                price=listing["price"],
                shipping=listing["shipping"],
                landed_cost=enriched.get("landed_cost", listing["price"] + listing["shipping"]),
                url=listing["url"],
                image_url=listing.get("image_url", ""),
                seller_username=listing["seller_username"],
                seller_rating=listing["seller_rating"],
                seller_feedback_count=listing["seller_feedback_count"],
                watchman_score=enriched.get("watchman_score", 0.0),
                filter_passed=passed,
                filter_reason=reason,
            ))

    # Passed deals first, then ranked by watchman_score desc
    all_results.sort(key=lambda r: (not r.filter_passed, -r.watchman_score))
    filtered_count = sum(1 for r in all_results if r.filter_passed)

    return DealHuntResponse(
        results=all_results,
        total=len(all_results),
        filtered_count=filtered_count,
        platforms_queried=platforms,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Feature: Collectr portfolio importer
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/integrations/collectr/import", response_model=CollectrJobStartResponse)
def collectr_import(req: CollectrImportRequest):
    """
    Start an async Collectr import job. Returns job_id immediately.
    Poll GET /integrations/collectr/job/{job_id} to watch progress and get
    the live Browserbase session URL + final results.
    """
    from urllib.parse import urlparse
    from newpoc.backend.integrations.collectr import start_collectr_job

    try:
        parsed = urlparse(req.showcase_url)
        if parsed.hostname != "app.getcollectr.com" or "/showcase/profile/" not in parsed.path:
            raise ValueError
    except (ValueError, AttributeError):
        raise HTTPException(
            status_code=400,
            detail="URL must be a Collectr showcase profile URL: https://app.getcollectr.com/showcase/profile/{uuid}",
        )

    job_id = start_collectr_job(req.showcase_url)
    logger.info(f"[collectr] started job {job_id[:8]} for {req.showcase_url}")
    return CollectrJobStartResponse(job_id=job_id)


@app.get("/integrations/collectr/job/{job_id}", response_model=CollectrJobStatusResponse)
def collectr_job_status(job_id: str):
    """
    Poll the status of a running Collectr import job.
    Returns session_url as soon as the Browserbase session starts (for live iframe embed).
    Returns result when done.
    """
    from newpoc.backend.integrations.collectr import get_job

    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    result = None
    if job.get("result"):
        r = job["result"]
        result = CollectrImportResponse(
            cards_found=r["cards_found"],
            imported_count=r["imported_count"],
            skipped_count=r["skipped_count"],
            want_list_additions=r["want_list_additions"],
            skipped_details=r["skipped_details"],
        )

    return CollectrJobStatusResponse(
        status=job["status"],
        session_url=job.get("session_url"),
        result=result,
        error=job.get("error"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Feature: Voice session relay (OpenAI Realtime API ephemeral key)
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/voice/session")
async def voice_session():
    """
    Create an OpenAI Realtime API ephemeral key (60s TTL).
    Browser uses this to connect directly to OpenAI WebSocket —
    the real OPENAI_API_KEY is never exposed to the frontend.
    """
    openai_key = os.getenv("OPENAI_API_KEY", "")
    if not openai_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY not configured")

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            "https://api.openai.com/v1/realtime/sessions",
            headers={
                "Authorization": f"Bearer {openai_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-realtime-preview-2024-12-17",
                "voice": "alloy",
            },
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"OpenAI session error: {resp.text[:300]}")

    data = resp.json()
    return {
        "client_secret": data.get("client_secret"),
        "expires_at": data.get("expires_at"),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Static files — serve agent screenshots
# Must be mounted AFTER all API routes
# ─────────────────────────────────────────────────────────────────────────────
_RECEIPTS_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../receipts"))
os.makedirs(_RECEIPTS_PATH, exist_ok=True)
app.mount("/receipts", StaticFiles(directory=_RECEIPTS_PATH), name="receipts")
