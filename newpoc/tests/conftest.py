"""
Test fixtures for CardHero v2 E2E tests.

Uses an in-memory SQLite database per test function so tests are fully isolated
and don't touch the real cardhero.db.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from newpoc.backend.database import Base, get_db, WantList, Portfolio, PriceHistory
from newpoc.backend.main import app

import json
from datetime import date, timedelta


# ─────────────────────────────────────────────────────────────────────────────
# In-memory DB engine (one per test session for speed)
# ─────────────────────────────────────────────────────────────────────────────

TEST_DATABASE_URL = "sqlite://"  # pure in-memory, no file


@pytest.fixture(scope="function")
def db_engine():
    """Fresh in-memory SQLite engine per test function."""
    engine = create_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # single connection shared across threads
    )
    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


@pytest.fixture(scope="function")
def db_session(db_engine):
    """DB session scoped to a single test."""
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=db_engine)
    session = TestingSession()
    yield session
    session.close()


@pytest.fixture(scope="function")
def client(db_session):
    """FastAPI TestClient with the real app, DB overridden to in-memory session."""
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# ─────────────────────────────────────────────────────────────────────────────
# Data fixtures
# ─────────────────────────────────────────────────────────────────────────────

def _monday(weeks_ago: int = 0) -> date:
    today = date.today()
    this_monday = today - timedelta(days=today.weekday())
    return this_monday - timedelta(weeks=weeks_ago)


@pytest.fixture(scope="function")
def seeded_client(db_session):
    """
    TestClient with a seeded in-memory database:
      - 2 WantList items
      - 1 Portfolio item
      - 2 weeks of price_history for want_list[0] (sanitized_avg ~315)
    """
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    # Seed WantList
    card1 = WantList(
        name="Charizard ex", grade="PSA 10", max_price=380.0,
        cert_prefix="POKE", target_id="charizard-ex-psa10",
        set_name="Obsidian Flames", year=2023, is_active=True,
    )
    card2 = WantList(
        name="Blastoise ex", grade="PSA 10", max_price=120.0,
        cert_prefix="POKE", target_id="blastoise-ex-psa10",
        set_name="Scarlet & Violet 151", year=2023, is_active=True,
    )
    inactive = WantList(
        name="Inactive Card", grade="PSA 10", max_price=100.0,
        is_active=False,
    )
    db_session.add_all([card1, card2, inactive])
    db_session.flush()

    # Seed Portfolio
    portfolio = Portfolio(
        name="Charizard ex", grade="PSA 10",
        purchase_price=310.0, current_value=355.0,
        cert_number="POKE-48291033",
        purchase_date=date(2024, 1, 15),
        set_name="Obsidian Flames", year=2023,
    )
    db_session.add(portfolio)

    # Seed price_history for card1 (2 weeks, 6 prices each → sanitized_avg ~315)
    prices_week1 = [310.0, 325.0, 318.0, 299.0, 340.0, 335.0]
    prices_week2 = [305.0, 315.0, 322.0, 308.0, 330.0, 311.0]

    def iqr(prices):
        s = sorted(prices)
        def pct(d, p):
            idx = p / 100.0 * (len(d) - 1)
            lo, hi = int(idx), min(int(idx)+1, len(d)-1)
            return d[lo] + (idx - lo) * (d[hi] - d[lo])
        q1, q3 = pct(s, 25), pct(s, 75)
        iq = q3 - q1
        low, high = q1 - 1.5*iq, q3 + 1.5*iq
        inliers = [p for p in s if low <= p <= high]
        return round(low, 2), round(high, 2), round(sum(inliers)/len(inliers), 2) if inliers else None

    for weeks_ago, prices in [(2, prices_week1), (1, prices_week2)]:
        low, high, avg = iqr(prices)
        db_session.add(PriceHistory(
            want_list_id=card1.id,
            week_start=_monday(weeks_ago),
            raw_prices=json.dumps(prices),
            iqr_low=low, iqr_high=high,
            sanitized_avg=avg,
            sample_count=len(prices),
        ))

    db_session.commit()

    with TestClient(app) as c:
        yield c, db_session, card1, card2

    app.dependency_overrides.clear()
