"""
CardHero Conductor — FastAPI state machine.

Run:
    uv run uvicorn backend.main:app --reload
"""

import os
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

load_dotenv()

from backend.database import (
    AuditLog, Deal, Portfolio, WantList, get_db, init_db,
)

DAILY_SPEND_LIMIT = float(os.getenv("DAILY_SPEND_LIMIT", "600.00"))
TAX_RATE = float(os.getenv("TAX_RATE", "0.08"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="CardHero Conductor",
    description="Deterministic deal evaluation engine for PSA-graded Pokemon cards",
    version="1.0.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class DealCandidate(BaseModel):
    want_list_id: int
    url: str
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
    daily_spend_today: float
    budget_remaining: float


class AgentResult(BaseModel):
    deal_id: int
    session_id: str
    verified_cert: Optional[str] = None
    price_locked: Optional[float] = None
    screenshot_path: Optional[str] = None
    dom_snapshot_path: Optional[str] = None
    agent_extraction_json: str
    final_status: str
    rejection_reason: Optional[str] = None


class StatusUpdate(BaseModel):
    status: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health(db: Session = Depends(get_db)):
    today = date.today()
    daily_spend = db.query(func.sum(Deal.landed_cost)).filter(
        Deal.status == "BOUGHT",
        func.date(Deal.updated_at) == today,
    ).scalar() or 0.0
    budget_remaining = max(0.0, DAILY_SPEND_LIMIT - daily_spend)
    return {
        "status": "ok",
        "db": "connected",
        "daily_spend_today": round(daily_spend, 2),
        "budget_remaining": round(budget_remaining, 2),
        "daily_spend_limit": DAILY_SPEND_LIMIT,
    }


@app.post("/evaluate", response_model=EvaluateResponse)
def evaluate(candidate: DealCandidate, db: Session = Depends(get_db)):
    # 1. WantList item must exist and be active
    wl_item = (
        db.query(WantList)
        .filter(WantList.id == candidate.want_list_id, WantList.is_active == True)
        .first()
    )
    if not wl_item:
        raise HTTPException(status_code=404, detail="WantList item not found or inactive")

    # 2. Landed cost
    tax_estimate = candidate.price * TAX_RATE
    landed_cost = round(candidate.price + candidate.shipping + tax_estimate, 2)

    # 3. Daily spend so far
    today = date.today()
    daily_spend = db.query(func.sum(Deal.landed_cost)).filter(
        Deal.status == "BOUGHT",
        func.date(Deal.updated_at) == today,
    ).scalar() or 0.0
    budget_remaining = max(0.0, DAILY_SPEND_LIMIT - daily_spend)

    def no_go(reason: str) -> EvaluateResponse:
        return EvaluateResponse(
            decision="NO_GO",
            reason=reason,
            deal_id=None,
            landed_cost=landed_cost,
            daily_spend_today=round(daily_spend, 2),
            budget_remaining=round(budget_remaining, 2),
        )

    # 4. Price gate
    if landed_cost > wl_item.max_price:
        return no_go(
            f"landed_cost ${landed_cost:.2f} exceeds max_price ${wl_item.max_price:.2f}"
        )

    # 5. Budget circuit breaker
    if landed_cost > budget_remaining:
        return no_go(
            f"daily budget exceeded (${budget_remaining:.2f} remaining of ${DAILY_SPEND_LIMIT:.2f})"
        )

    # 6. Duplicate URL check (ignore previously rejected)
    existing = (
        db.query(Deal)
        .filter(Deal.url == candidate.url, Deal.status.notin_(["REJECTED"]))
        .first()
    )
    if existing:
        return no_go(f"duplicate listing already tracked (deal_id={existing.id})")

    # 7. GO — create Deal row
    item_id = candidate.url.split("/itm/")[-1].split("?")[0]
    deal = Deal(
        want_list_id=candidate.want_list_id,
        url=candidate.url,
        price=candidate.price,
        shipping=candidate.shipping,
        tax_estimate=tax_estimate,
        landed_cost=landed_cost,
        status="ANALYZING",
        watchman_score=candidate.watchman_score,
        seller_username=candidate.seller_username,
        seller_rating=candidate.seller_rating,
        seller_feedback_count=candidate.seller_feedback_count,
        ebay_item_id=item_id,
    )
    db.add(deal)
    db.commit()
    db.refresh(deal)

    return EvaluateResponse(
        decision="GO",
        reason="all checks passed",
        deal_id=deal.id,
        landed_cost=landed_cost,
        daily_spend_today=round(daily_spend, 2),
        budget_remaining=round(budget_remaining, 2),
    )


@app.post("/agent/result")
def agent_result(result: AgentResult, db: Session = Depends(get_db)):
    deal = db.query(Deal).filter(Deal.id == result.deal_id).first()
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found")

    deal.status = result.final_status
    deal.updated_at = datetime.utcnow()

    # Upsert audit log — update existing row if one already exists for this deal
    existing_audit = db.query(AuditLog).filter(AuditLog.deal_id == result.deal_id).first()
    if existing_audit:
        existing_audit.session_id = result.session_id
        existing_audit.verified_cert = result.verified_cert
        existing_audit.price_locked = result.price_locked
        existing_audit.screenshot_path = result.screenshot_path
        existing_audit.dom_snapshot_path = result.dom_snapshot_path
        existing_audit.agent_extraction_json = result.agent_extraction_json
    else:
        audit = AuditLog(
            deal_id=result.deal_id,
            session_id=result.session_id,
            verified_cert=result.verified_cert,
            price_locked=result.price_locked,
            screenshot_path=result.screenshot_path,
            dom_snapshot_path=result.dom_snapshot_path,
            agent_extraction_json=result.agent_extraction_json,
        )
        db.add(audit)
    db.commit()

    return {"ok": True, "deal_id": result.deal_id, "status": result.final_status}


@app.get("/deals")
def list_deals(status: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(Deal)
    if status:
        q = q.filter(Deal.status == status.upper())
    deals = q.order_by(Deal.created_at.desc()).all()
    return [_deal_dict(d) for d in deals]


@app.get("/deals/{deal_id}")
def get_deal(deal_id: int, db: Session = Depends(get_db)):
    deal = db.query(Deal).filter(Deal.id == deal_id).first()
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found")
    d = _deal_dict(deal)
    if deal.audit_log:
        d["audit"] = {
            "verified_cert": deal.audit_log.verified_cert,
            "price_locked": deal.audit_log.price_locked,
            "screenshot_path": deal.audit_log.screenshot_path,
            "dom_snapshot_path": deal.audit_log.dom_snapshot_path,
            "session_id": deal.audit_log.session_id,
            "agent_extraction_json": deal.audit_log.agent_extraction_json,
        }
    return d


@app.patch("/deals/{deal_id}/status")
def update_deal_status(deal_id: int, update: StatusUpdate, db: Session = Depends(get_db)):
    deal = db.query(Deal).filter(Deal.id == deal_id).first()
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found")
    valid = {"PENDING", "ANALYZING", "BOUGHT", "REJECTED"}
    if update.status.upper() not in valid:
        raise HTTPException(status_code=400, detail=f"status must be one of {valid}")
    deal.status = update.status.upper()
    deal.updated_at = datetime.utcnow()
    db.commit()
    return {"deal_id": deal_id, "status": deal.status}


@app.get("/want-list")
def list_want_list(db: Session = Depends(get_db)):
    items = db.query(WantList).filter(WantList.is_active == True).all()
    return [
        {
            "id": w.id,
            "name": w.name,
            "grade": w.grade,
            "max_price": w.max_price,
            "cert_prefix": w.cert_prefix,
            "set_name": w.set_name,
            "year": w.year,
            "target_id": w.target_id,
        }
        for w in items
    ]


@app.get("/portfolio")
def list_portfolio(db: Session = Depends(get_db)):
    items = db.query(Portfolio).all()
    return [
        {
            "id": p.id,
            "name": p.name,
            "grade": p.grade,
            "set_name": p.set_name,
            "year": p.year,
            "cert_number": p.cert_number,
            "purchase_price": p.purchase_price,
            "current_value": p.current_value,
            "unrealized_pnl": round(p.current_value - p.purchase_price, 2),
            "pnl_pct": round((p.current_value - p.purchase_price) / p.purchase_price * 100, 1),
            "purchase_date": p.purchase_date.isoformat(),
            "notes": p.notes,
        }
        for p in items
    ]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _deal_dict(d: Deal) -> dict:
    return {
        "id": d.id,
        "want_list_id": d.want_list_id,
        "card_name": d.want_list_item.name if d.want_list_item else None,
        "url": d.url,
        "ebay_item_id": d.ebay_item_id,
        "price": d.price,
        "shipping": d.shipping,
        "tax_estimate": d.tax_estimate,
        "landed_cost": d.landed_cost,
        "status": d.status,
        "watchman_score": d.watchman_score,
        "seller_username": d.seller_username,
        "seller_rating": d.seller_rating,
        "seller_feedback_count": d.seller_feedback_count,
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "updated_at": d.updated_at.isoformat() if d.updated_at else None,
    }


def start():
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)


if __name__ == "__main__":
    start()
