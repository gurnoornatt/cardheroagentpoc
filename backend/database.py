import os
from datetime import datetime, date
from sqlalchemy import (
    create_engine, Column, Integer, String, Float, Boolean,
    DateTime, Date, Text, ForeignKey, func
)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./backend/db/cardhero.db")

os.makedirs("backend/db", exist_ok=True)

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
    price = Column(Float, nullable=False)
    shipping = Column(Float, nullable=False, default=0.0)
    tax_estimate = Column(Float, nullable=False, default=0.0)
    landed_cost = Column(Float, nullable=False)
    status = Column(String, nullable=False, default="PENDING")
    watchman_score = Column(Float, nullable=True)
    seller_username = Column(String, nullable=True)
    seller_rating = Column(Float, nullable=True)
    seller_feedback_count = Column(Integer, nullable=True)
    ebay_item_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    want_list_item = relationship("WantList", back_populates="deals")
    audit_log = relationship("AuditLog", back_populates="deal", uselist=False)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True)
    deal_id = Column(Integer, ForeignKey("deals.id"), nullable=False, unique=True)
    agent_extraction_json = Column(Text, nullable=True)
    screenshot_path = Column(String, nullable=True)
    dom_snapshot_path = Column(String, nullable=True)
    verified_cert = Column(String, nullable=True)
    price_locked = Column(Float, nullable=True)
    session_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    deal = relationship("Deal", back_populates="audit_log")


def init_db():
    os.makedirs("backend/db", exist_ok=True)
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
