"""
SQLAlchemy ORM models and engine for CardHero v2.

5 tables: want_list, price_history, portfolio, deals, audit_log, lab_runs
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

from backend.config import DATABASE_URL, DB_DIR

DB_DIR.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class WantList(Base):
    __tablename__ = "want_list"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    grade = Column(String, nullable=False)
    max_price = Column(Float, nullable=False)
    cert_prefix = Column(String, nullable=True)
    target_id = Column(String, nullable=True)
    set_name = Column(String, nullable=True)
    year = Column(Integer, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    deals = relationship("Deal", back_populates="want_list_item")
    price_history = relationship("PriceHistory", back_populates="want_list_item")


class PriceHistory(Base):
    __tablename__ = "price_history"

    id = Column(Integer, primary_key=True, index=True)
    want_list_id = Column(Integer, ForeignKey("want_list.id"), nullable=False)
    week_start = Column(Date, nullable=False)
    raw_prices = Column(Text, nullable=False)          # JSON array of observed prices
    iqr_low = Column(Float, nullable=True)             # Q1 − 1.5 × IQR (Tukey lower fence)
    iqr_high = Column(Float, nullable=True)            # Q3 + 1.5 × IQR (Tukey upper fence)
    sanitized_avg = Column(Float, nullable=True)       # Mean of inlier prices
    sample_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("want_list_id", "week_start", name="uq_ph_wl_week"),
    )

    want_list_item = relationship("WantList", back_populates="price_history")


class Portfolio(Base):
    __tablename__ = "portfolio"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    grade = Column(String, nullable=False)
    purchase_price = Column(Float, nullable=False)
    current_value = Column(Float, nullable=False)
    cert_number = Column(String, nullable=False, unique=True)
    purchase_date = Column(Date, nullable=False)
    set_name = Column(String, nullable=True)
    year = Column(Integer, nullable=True)
    notes = Column(String, nullable=True)


class Deal(Base):
    __tablename__ = "deals"

    id = Column(Integer, primary_key=True, index=True)
    want_list_id = Column(Integer, ForeignKey("want_list.id"), nullable=False)
    url = Column(String, nullable=False)
    listing_type = Column(String, nullable=False, default="BUY_IT_NOW")
    price = Column(Float, nullable=False)
    shipping = Column(Float, nullable=False, default=0.0)
    tax_estimate = Column(Float, nullable=False, default=0.0)
    landed_cost = Column(Float, nullable=False)
    status = Column(String, nullable=False, default="PENDING")
    watchman_score = Column(Float, nullable=True)
    sentiment_score = Column(Float, nullable=True)
    sentiment_weight = Column(Float, nullable=True)
    undervalue_delta = Column(Float, nullable=True)
    seller_username = Column(String, nullable=True)
    seller_rating = Column(Float, nullable=True)
    seller_feedback_count = Column(Integer, nullable=True)
    ebay_item_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    want_list_item = relationship("WantList", back_populates="deals")
    audit_log = relationship("AuditLog", back_populates="deal", uselist=False)
    lab_runs = relationship("LabRun", back_populates="deal")


class AuditLog(Base):
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True)
    deal_id = Column(Integer, ForeignKey("deals.id"), nullable=False, unique=True)
    agent_extraction_json = Column(Text, nullable=True)
    psa_pop_grade10 = Column(Integer, nullable=True)
    psa_pop_total = Column(Integer, nullable=True)
    screenshot_path = Column(String, nullable=True)
    dom_snapshot_path = Column(String, nullable=True)
    verified_cert = Column(String, nullable=True)
    price_locked = Column(Float, nullable=True)
    authenticity_guaranteed = Column(Boolean, nullable=True)
    session_id = Column(String, nullable=True)
    model_used = Column(String, nullable=True)
    extraction_latency_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    deal = relationship("Deal", back_populates="audit_log")


class LabRun(Base):
    __tablename__ = "lab_runs"

    id = Column(Integer, primary_key=True, index=True)
    deal_id = Column(Integer, ForeignKey("deals.id"), nullable=False)
    model = Column(String, nullable=False)
    extracted_cert = Column(String, nullable=True)
    extracted_price = Column(Float, nullable=True)
    extracted_pop_grade10 = Column(Integer, nullable=True)
    extracted_pop_total = Column(Integer, nullable=True)
    ground_truth_cert = Column(String, nullable=True)
    cert_correct = Column(Boolean, nullable=True)
    price_correct = Column(Boolean, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    deal = relationship("Deal", back_populates="lab_runs")


class SystemMeta(Base):
    """Key-value store for system state (e.g. Watchman heartbeat)."""
    __tablename__ = "system_meta"

    key = Column(String, primary_key=True)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PushSubscription(Base):
    """Browser push subscription registered by a user."""
    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    endpoint = Column(Text, nullable=False, unique=True)
    p256dh = Column(Text, nullable=False)
    auth = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


def init_db() -> None:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
