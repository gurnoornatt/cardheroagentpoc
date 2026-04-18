"""Tests for Web Push notification endpoints and send_push() helper."""
import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect

# Patch VAPID env vars before importing main so it loads without KeyError
os.environ.setdefault("VAPID_PRIVATE_KEY", "fake-private-key")
os.environ.setdefault("VAPID_PUBLIC_KEY", "BFake_public_key_base64url_padded_to_65_bytes_AAAA")
os.environ.setdefault("VAPID_CLAIMS_EMAIL", "test@example.com")

from newpoc.backend.database import Base, PushSubscription, SessionLocal, WantList, engine
from newpoc.backend.main import app


@pytest.fixture(autouse=True)
def clean_db():
    """Recreate all tables before each test."""
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


@pytest.fixture
def client():
    return TestClient(app)


# ─── Model test ───────────────────────────────────────────────────────────────


def test_push_subscription_table_exists():
    """PushSubscription table should be created by init_db."""
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    assert "push_subscriptions" in tables


# ─── Endpoint tests ───────────────────────────────────────────────────────────


def test_vapid_public_key_endpoint(client):
    """GET /notifications/vapid-public-key returns the public key."""
    resp = client.get("/notifications/vapid-public-key")
    assert resp.status_code == 200
    data = resp.json()
    assert "public_key" in data
    assert data["public_key"] == os.environ["VAPID_PUBLIC_KEY"]


def test_subscribe_creates_subscription(client):
    """POST /notifications/subscribe stores the subscription."""
    payload = {
        "endpoint": "https://fcm.googleapis.com/fcm/send/test-endpoint",
        "keys": {
            "p256dh": "BNcRdreALRFXTkOOUHK_ABc",
            "auth": "tBHItJI5svbpez7KI4CCXg",
        },
    }
    resp = client.post("/notifications/subscribe", json=payload)
    assert resp.status_code == 201


def test_subscribe_upserts_on_duplicate(client):
    """POST /notifications/subscribe with existing endpoint updates keys and returns 201."""
    first_payload = {
        "endpoint": "https://fcm.googleapis.com/fcm/send/test-endpoint",
        "keys": {"p256dh": "FIRST_KEY_AAAA", "auth": "FIRST_AUTH"},
    }
    client.post("/notifications/subscribe", json=first_payload)

    updated_payload = {
        "endpoint": "https://fcm.googleapis.com/fcm/send/test-endpoint",
        "keys": {"p256dh": "UPDATED_KEY_BBBB", "auth": "UPDATED_AUTH"},
    }
    resp = client.post("/notifications/subscribe", json=updated_payload)
    assert resp.status_code == 201

    # Verify the keys were actually updated in the DB
    db = SessionLocal()
    try:
        row = db.query(PushSubscription).filter_by(
            endpoint="https://fcm.googleapis.com/fcm/send/test-endpoint"
        ).first()
        assert row is not None
        assert row.p256dh == "UPDATED_KEY_BBBB"
        assert row.auth == "UPDATED_AUTH"
    finally:
        db.close()


def test_unsubscribe_removes_subscription(client):
    """DELETE /notifications/subscribe removes the endpoint."""
    payload = {
        "endpoint": "https://fcm.googleapis.com/fcm/send/test-endpoint",
        "keys": {"p256dh": "BNcRdreALRFXTkOOUHK_ABc", "auth": "tBHItJI5svbpez7KI4CCXg"},
    }
    client.post("/notifications/subscribe", json=payload)
    resp = client.delete(
        "/notifications/subscribe",
        params={"endpoint": payload["endpoint"]},
    )
    assert resp.status_code == 204


def test_unsubscribe_nonexistent_returns_204(client):
    """DELETE /notifications/subscribe on unknown endpoint returns 204 (idempotent)."""
    resp = client.delete(
        "/notifications/subscribe",
        params={"endpoint": "https://fcm.googleapis.com/fcm/send/nonexistent"},
    )
    assert resp.status_code == 204


# ─── send_push integration tests ─────────────────────────────────────────────


def _seed_want_list(db):
    item = WantList(name="Charizard ex", grade="PSA 10", max_price=500.0, is_active=True)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _seed_subscription(db, endpoint="https://fcm.googleapis.com/test"):
    sub = PushSubscription(
        endpoint=endpoint,
        p256dh="BNcRdreALRFXTkOOUHK_ABc",
        auth="tBHItJI5svbpez7KI4CCXg",
    )
    db.add(sub)
    db.commit()
    return sub


def test_send_push_called_on_go_decision(client):
    """When /evaluate produces a GO decision, send_push fires as a background task."""
    db = SessionLocal()
    try:
        item = _seed_want_list(db)
        item_id = item.id  # capture before session closes
        _seed_subscription(db)
    finally:
        db.close()

    with patch("newpoc.backend.main.webpush") as mock_webpush:
        mock_webpush.return_value = MagicMock(status_code=201)
        resp = client.post(
            "/evaluate",
            json={
                "want_list_id": item_id,
                "url": "https://www.ebay.com/itm/999999999999",
                "listing_type": "BUY_IT_NOW",
                "price": 300.0,
                "shipping": 0.0,
                "seller_username": "topdealer",
                "seller_rating": 99.9,
                "seller_feedback_count": 5000,
                "watchman_score": 0.85,
            },
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["decision"] == "GO"
    # BackgroundTasks run synchronously in TestClient
    mock_webpush.assert_called_once()


def test_send_push_cleans_up_expired_410_subscription(client):
    """send_push() deletes subscriptions that return 410 Gone from the push service."""
    from requests.models import Response as RequestsResponse
    from newpoc.backend.main import send_push

    db = SessionLocal()
    try:
        _seed_want_list(db)
        _seed_subscription(db, endpoint="https://fcm.googleapis.com/expired")
    finally:
        db.close()

    mock_410 = MagicMock()
    mock_410.status_code = 410
    gone_exc = Exception.__new__(__import__("pywebpush").WebPushException)
    gone_exc.response = mock_410
    gone_exc.args = ("Gone",)

    with patch("newpoc.backend.main.webpush", side_effect=gone_exc):
        send_push(99, "Charizard ex", "PSA 10", 300.0, 400.0)

    db = SessionLocal()
    try:
        count = db.query(PushSubscription).filter_by(
            endpoint="https://fcm.googleapis.com/expired"
        ).count()
        assert count == 0, "Expired 410 subscription should have been deleted"
    finally:
        db.close()


def test_send_push_not_called_on_no_go(client):
    """When /evaluate produces a NO_GO decision, send_push must NOT fire."""
    db = SessionLocal()
    try:
        item = _seed_want_list(db)
        item_id = item.id  # capture before session closes
        _seed_subscription(db)
    finally:
        db.close()

    with patch("newpoc.backend.main.webpush") as mock_webpush:
        resp = client.post(
            "/evaluate",
            json={
                "want_list_id": item_id,
                "url": "https://www.ebay.com/itm/888888888888",
                "listing_type": "BUY_IT_NOW",
                "price": 600.0,  # over max_price=500 → NO_GO
                "shipping": 0.0,
                "seller_username": "topdealer",
                "seller_rating": 99.9,
                "seller_feedback_count": 5000,
                "watchman_score": 0.85,
            },
        )
    assert resp.status_code == 200
    assert resp.json()["decision"] == "NO_GO"
    mock_webpush.assert_not_called()
