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
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
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
    items = db.query(WantList).filter(WantList.is_active == True).all()
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
        .filter(WantList.id == candidate.want_list_id, WantList.is_active == True)
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
def agent_result(result: AgentResult, db: Session = Depends(get_db)):
    deal = db.query(Deal).filter(Deal.id == result.deal_id).first()
    if not deal:
        raise HTTPException(status_code=404, detail=f"Deal {result.deal_id} not found")

    deal.status = result.final_status.upper()
    deal.updated_at = datetime.now(timezone.utc)

    # Create or update audit log
    audit = db.query(AuditLog).filter(AuditLog.deal_id == result.deal_id).first()
    if audit is None:
        audit = AuditLog(deal_id=result.deal_id)
        db.add(audit)

    audit.agent_extraction_json = result.agent_extraction_json
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
