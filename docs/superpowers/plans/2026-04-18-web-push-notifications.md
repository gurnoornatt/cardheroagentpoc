# Web Push Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire a native OS push notification the instant a deal passes all filters in `/evaluate`, visible even when the browser tab is closed — works on Vercel deployment.

**Architecture:** pywebpush on the FastAPI backend fans push payloads out to all stored browser subscriptions via VAPID-authenticated Web Push. A Vite-served service worker receives the push and calls `showNotification()`. The React frontend registers the service worker, requests permission, and POSTs the subscription to `POST /notifications/subscribe` on mount. `send_push()` runs in a FastAPI `BackgroundTask` so it never delays the `/evaluate` response.

**Tech Stack:** Python/FastAPI (pywebpush, SQLAlchemy/SQLite), TypeScript/React (Vite, Web Push API native, no new npm deps)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `newpoc/backend/database.py` | Modify | Add `PushSubscription` SQLAlchemy model |
| `newpoc/backend/main.py` | Modify | Add `GET /notifications/vapid-public-key`, `POST /notifications/subscribe`, `DELETE /notifications/subscribe`, `send_push()` helper, BackgroundTask hook in `/evaluate` |
| `newpoc/lab/public/sw.js` | **Create** | Service worker — `push` event + `notificationclick` handler |
| `newpoc/lab/src/lib/notifications.ts` | **Create** | `setupPushNotifications()` — permission + SW registration + subscribe |
| `newpoc/lab/src/lib/api.ts` | Modify | Add `vapidPublicKey()`, `subscribePush()`, `unsubscribePush()` |
| `newpoc/lab/src/App.tsx` | Modify | Call `setupPushNotifications()` on mount (2 s delay) |
| `newpoc/.env.example` | Modify | Add `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_CLAIMS_EMAIL` |
| `newpoc/lab/vercel.json` | Modify | Add `sw.js` static route before the catch-all SPA rewrite |
| `tests/test_push_notifications.py` | **Create** | FastAPI TestClient integration tests |

---

## Task 1: Install pywebpush and generate VAPID keys

**Files:**
- Modify: `pyproject.toml` (via uv command)
- Modify: `newpoc/.env.example`
- Modify: `newpoc/.env` (your local copy — never committed)

- [ ] **Step 1: Install pywebpush**

```bash
uv add pywebpush
```

Expected: `pyproject.toml` gains `"pywebpush>=2.0.0"` in `dependencies`.

- [ ] **Step 2: Verify install**

```bash
uv run python -c "from pywebpush import webpush, WebPushException; print('ok')"
```

Expected output: `ok`

- [ ] **Step 3: Generate VAPID key pair**

```bash
uv run python -c "
import base64
from py_vapid import Vapid
from cryptography.hazmat.primitives.serialization import (
    Encoding, PrivateFormat, PublicFormat, NoEncryption
)
v = Vapid()
v.generate_keys()
priv = base64.urlsafe_b64encode(
    v.private_key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())
).decode().rstrip('=')
pub = base64.urlsafe_b64encode(
    v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
).decode().rstrip('=')
print('VAPID_PRIVATE_KEY=' + priv)
print('VAPID_PUBLIC_KEY=' + pub)
"
```

Copy the two printed lines into `newpoc/.env` (local only, never committed).

- [ ] **Step 4: Update `.env.example`**

Open `newpoc/.env.example` and append at the end (before the final newline):

```
# ── Web Push Notifications ───────────────────────────────────────────────────
VAPID_PRIVATE_KEY=          # base64url-encoded VAPID private key (run Task 1 Step 3 to generate)
VAPID_PUBLIC_KEY=           # base64url-encoded VAPID public key (application server key)
VAPID_CLAIMS_EMAIL=eknoor.natt93@gmail.com
```

- [ ] **Step 5: Commit**

```bash
git add newpoc/.env.example pyproject.toml uv.lock
git commit -m "feat: add pywebpush dependency + VAPID key docs"
```

---

## Task 2: Add `PushSubscription` model to `database.py`

**Files:**
- Modify: `newpoc/backend/database.py`
- Create: `tests/test_push_notifications.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_push_notifications.py`:

```python
"""Tests for Web Push notification endpoints."""
import pytest
from fastapi.testclient import TestClient
from newpoc.backend.database import Base, engine
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


def test_push_subscription_table_exists():
    """PushSubscription table should be created by init_db."""
    from sqlalchemy import inspect
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    assert "push_subscriptions" in tables
```

- [ ] **Step 2: Run the failing test**

```bash
uv run pytest tests/test_push_notifications.py::test_push_subscription_table_exists -v
```

Expected: FAIL — `AssertionError: assert "push_subscriptions" in [...]`

- [ ] **Step 3: Add `PushSubscription` model to `database.py`**

In `newpoc/backend/database.py`, add this class after the `SystemMeta` class (before `init_db()`):

```python
class PushSubscription(Base):
    """Browser push subscription registered by a user."""
    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    endpoint = Column(Text, nullable=False, unique=True)
    p256dh = Column(Text, nullable=False)
    auth = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
uv run pytest tests/test_push_notifications.py::test_push_subscription_table_exists -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add newpoc/backend/database.py tests/test_push_notifications.py
git commit -m "feat: add PushSubscription model + failing test scaffold"
```

---

## Task 3: Add notification endpoints to `main.py`

**Files:**
- Modify: `newpoc/backend/main.py`
- Modify: `tests/test_push_notifications.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_push_notifications.py`:

```python
import os

# Patch VAPID env vars so the module loads without KeyError
os.environ.setdefault("VAPID_PRIVATE_KEY", "fake-private-key")
os.environ.setdefault("VAPID_PUBLIC_KEY", "BFake_public_key_base64url_padded_to_65_bytes_AAAA")
os.environ.setdefault("VAPID_CLAIMS_EMAIL", "test@example.com")


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
    """POST /notifications/subscribe with existing endpoint returns 201 (upsert)."""
    payload = {
        "endpoint": "https://fcm.googleapis.com/fcm/send/test-endpoint",
        "keys": {"p256dh": "BNcRdreALRFXTkOOUHK_ABc", "auth": "tBHItJI5svbpez7KI4CCXg"},
    }
    client.post("/notifications/subscribe", json=payload)
    resp = client.post("/notifications/subscribe", json=payload)  # duplicate
    assert resp.status_code == 201


def test_unsubscribe_removes_subscription(client):
    """DELETE /notifications/subscribe removes the endpoint."""
    payload = {
        "endpoint": "https://fcm.googleapis.com/fcm/send/test-endpoint",
        "keys": {"p256dh": "BNcRdreALRFXTkOOUHK_ABc", "auth": "tBHItJI5svbpez7KI4CCXg"},
    }
    client.post("/notifications/subscribe", json=payload)
    resp = client.delete("/notifications/subscribe", json={"endpoint": payload["endpoint"]})
    assert resp.status_code == 204


def test_unsubscribe_nonexistent_returns_204(client):
    """DELETE /notifications/subscribe on unknown endpoint returns 204 (idempotent)."""
    resp = client.delete(
        "/notifications/subscribe",
        json={"endpoint": "https://fcm.googleapis.com/fcm/send/nonexistent"},
    )
    assert resp.status_code == 204
```

- [ ] **Step 2: Run the failing tests**

```bash
uv run pytest tests/test_push_notifications.py -v -k "vapid or subscribe or unsubscribe"
```

Expected: FAIL — `404 Not Found` on all notification endpoints.

- [ ] **Step 3: Add Pydantic models and read VAPID config in `main.py`**

At the top of `main.py`, after the existing `os` import, add:

```python
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_CLAIMS_EMAIL = os.environ.get("VAPID_CLAIMS_EMAIL", "mailto:admin@example.com")
```

After the `CollectrJobStatusResponse` Pydantic class block, add:

```python
class PushSubscribeRequest(BaseModel):
    endpoint: str
    keys: dict  # {"p256dh": "...", "auth": "..."}


class PushUnsubscribeRequest(BaseModel):
    endpoint: str
```

Also add `PushSubscription` to the database import block:

```python
from newpoc.backend.database import (
    AuditLog,
    Deal,
    LabRun,
    Portfolio,
    PriceHistory,
    PushSubscription,
    SessionLocal,
    SystemMeta,
    WantList,
    get_db,
    init_db,
)
```

- [ ] **Step 4: Add the three notification endpoints to `main.py`**

Add these three endpoints after the `watchman_status` endpoint (around line 456):

```python
# ─────────────────────────────────────────────────────────────────────────────
# Notification endpoints
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/notifications/vapid-public-key")
def get_vapid_public_key():
    """Return the VAPID application server key so the browser can subscribe."""
    return {"public_key": VAPID_PUBLIC_KEY}


@app.post("/notifications/subscribe", status_code=201)
def subscribe_push(body: PushSubscribeRequest, db: Session = Depends(get_db)):
    """Upsert a push subscription. Called by the browser after subscribing."""
    existing = db.query(PushSubscription).filter_by(endpoint=body.endpoint).first()
    if existing:
        existing.p256dh = body.keys.get("p256dh", "")
        existing.auth = body.keys.get("auth", "")
    else:
        sub = PushSubscription(
            endpoint=body.endpoint,
            p256dh=body.keys.get("p256dh", ""),
            auth=body.keys.get("auth", ""),
        )
        db.add(sub)
    db.commit()
    return {"ok": True}


@app.delete("/notifications/subscribe", status_code=204)
def unsubscribe_push(body: PushUnsubscribeRequest, db: Session = Depends(get_db)):
    """Remove a push subscription (called when user revokes permission)."""
    sub = db.query(PushSubscription).filter_by(endpoint=body.endpoint).first()
    if sub:
        db.delete(sub)
        db.commit()
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest tests/test_push_notifications.py -v -k "vapid or subscribe or unsubscribe"
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add newpoc/backend/main.py tests/test_push_notifications.py
git commit -m "feat: add VAPID key endpoint + subscribe/unsubscribe endpoints"
```

---

## Task 4: Add `send_push()` helper and wire into `/evaluate`

**Files:**
- Modify: `newpoc/backend/main.py`
- Modify: `tests/test_push_notifications.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_push_notifications.py`:

```python
from unittest.mock import patch, MagicMock
from newpoc.backend.database import WantList, PushSubscription, SessionLocal


def _seed_want_list(db):
    item = WantList(
        name="Charizard ex",
        grade="PSA 10",
        max_price=500.0,
        is_active=True,
    )
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
        _seed_subscription(db)
    finally:
        db.close()

    with patch("newpoc.backend.main.webpush") as mock_webpush:
        mock_webpush.return_value = MagicMock(status_code=201)
        resp = client.post(
            "/evaluate",
            json={
                "want_list_id": item.id,
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
    # Background task runs synchronously in TestClient
    mock_webpush.assert_called_once()


def test_send_push_not_called_on_no_go(client):
    """When /evaluate produces a NO_GO decision, send_push must NOT fire."""
    db = SessionLocal()
    try:
        item = _seed_want_list(db)
        _seed_subscription(db)
    finally:
        db.close()

    with patch("newpoc.backend.main.webpush") as mock_webpush:
        resp = client.post(
            "/evaluate",
            json={
                "want_list_id": item.id,
                "url": "https://www.ebay.com/itm/888888888888",
                "listing_type": "BUY_IT_NOW",
                "price": 600.0,   # over max_price=500 → NO_GO
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
```

- [ ] **Step 2: Run the failing test**

```bash
uv run pytest tests/test_push_notifications.py::test_send_push_called_on_go_decision tests/test_push_notifications.py::test_send_push_not_called_on_no_go -v
```

Expected: FAIL — `AssertionError: Expected call`

- [ ] **Step 3: Add `send_push()` to `main.py`**

Add these imports at the top of `main.py` (with the other imports):

```python
from pywebpush import WebPushException, webpush
```

Add the `send_push()` function after the three notification endpoints (before the `/evaluate` endpoint):

```python
def send_push(deal_id: int, card_name: str, card_grade: str, landed_cost: float, max_price: float) -> None:
    """
    Fan push notification out to all subscribed browsers.
    Runs in a BackgroundTask — never blocks /evaluate.
    Deletes expired subscriptions (410 Gone) automatically.
    """
    pct_below = round((1 - landed_cost / max_price) * 100) if max_price > 0 else 0
    title = f"{card_name} {card_grade}"
    body = f"${landed_cost:.0f} landed · {pct_below}% under your max"
    payload = json.dumps({"title": title, "body": body, "url": "/#findings"})

    if not VAPID_PRIVATE_KEY or not VAPID_PUBLIC_KEY:
        logger.warning("[send_push] VAPID keys not configured — skipping push")
        return

    db = SessionLocal()
    try:
        subs = db.query(PushSubscription).all()
        stale_ids = []
        for sub in subs:
            try:
                webpush(
                    subscription_info={
                        "endpoint": sub.endpoint,
                        "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                    },
                    data=payload,
                    vapid_private_key=VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": f"mailto:{VAPID_CLAIMS_EMAIL}"},
                )
                logger.info("[send_push] push sent — deal_id=%d endpoint=...%s", deal_id, sub.endpoint[-20:])
            except WebPushException as exc:
                if exc.response is not None and exc.response.status_code == 410:
                    stale_ids.append(sub.id)
                    logger.info("[send_push] subscription expired, removing — endpoint=...%s", sub.endpoint[-20:])
                else:
                    logger.warning("[send_push] push failed — %s", exc)
        if stale_ids:
            db.query(PushSubscription).filter(PushSubscription.id.in_(stale_ids)).delete(synchronize_session=False)
            db.commit()
    except Exception as exc:
        logger.warning("[send_push] unexpected error — %s", exc)
    finally:
        db.close()
```

- [ ] **Step 4: Wire `send_push()` into the GO path of `/evaluate`**

In `main.py`, find the `/evaluate` endpoint function signature. It currently starts with:

```python
@app.post("/evaluate", response_model=EvaluateResponse)
def evaluate(candidate: DealCandidate, db: Session = Depends(get_db)):
```

Change it to:

```python
@app.post("/evaluate", response_model=EvaluateResponse)
def evaluate(
    candidate: DealCandidate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
```

Then, immediately after `db.refresh(deal)` in the GO path (after "Gate 8: GO — create Deal"), add:

```python
    background_tasks.add_task(
        send_push,
        deal.id,
        wl_item.name,
        wl_item.grade,
        landed_cost,
        wl_item.max_price,
    )
```

The full GO block should look like:

```python
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

    background_tasks.add_task(
        send_push,
        deal.id,
        wl_item.name,
        wl_item.grade,
        landed_cost,
        wl_item.max_price,
    )

    logger.info(
        f"[evaluate] GO — deal_id={deal.id} landed_cost={landed_cost} "
        f"undervalue_delta={undervalue_delta} sentiment={sentiment_score:.4f}"
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run pytest tests/test_push_notifications.py -v
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add newpoc/backend/main.py tests/test_push_notifications.py
git commit -m "feat: add send_push() helper + wire into /evaluate GO path"
```

---

## Task 5: Create the service worker `public/sw.js`

**Files:**
- Create: `newpoc/lab/public/sw.js`
- Modify: `newpoc/lab/vercel.json`

- [ ] **Step 1: Create the `public/` directory and `sw.js`**

Create `newpoc/lab/public/sw.js`:

```javascript
/* CardHero — Web Push Service Worker */

self.addEventListener('push', (event) => {
  if (!event.data) return;

  const { title, body, url } = event.data.json();

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url },
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // If a CardHero tab is already open, focus it
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.focus();
            client.navigate(event.notification.data.url);
            return;
          }
        }
        // Otherwise open a new tab
        if (clients.openWindow) {
          return clients.openWindow(event.notification.data.url);
        }
      })
  );
});
```

- [ ] **Step 2: Fix `vercel.json` so `/sw.js` is NOT swallowed by the SPA catch-all**

The current `vercel.json` has `"source": "/(.*)" → "/index.html"` as the last rule. Vercel resolves static files before rewrites, so `dist/sw.js` (built from `public/sw.js`) will be served directly. However, we must also set the `Service-Worker-Allowed` header to `"/"` so the SW can control the full origin.

Edit `newpoc/lab/vercel.json` to:

```json
{
  "headers": [
    {
      "source": "/sw.js",
      "headers": [
        { "key": "Service-Worker-Allowed", "value": "/" },
        { "key": "Cache-Control", "value": "no-cache" }
      ]
    }
  ],
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://cardheroagentpoc-production.up.railway.app/:path*"
    },
    {
      "source": "/receipts/:path*",
      "destination": "https://cardheroagentpoc-production.up.railway.app/receipts/:path*"
    },
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
```

- [ ] **Step 3: Verify `sw.js` is copied by Vite**

```bash
cd newpoc/lab && npm run build 2>&1 | tail -5
ls dist/sw.js
```

Expected: `dist/sw.js` exists.

- [ ] **Step 4: Commit**

```bash
git add newpoc/lab/public/sw.js newpoc/lab/vercel.json
git commit -m "feat: add service worker for Web Push + fix vercel.json headers"
```

---

## Task 6: Create `src/lib/notifications.ts`

**Files:**
- Create: `newpoc/lab/src/lib/notifications.ts`

- [ ] **Step 1: Create the file**

Create `newpoc/lab/src/lib/notifications.ts`:

```typescript
import { api } from "./api";

/**
 * Convert a base64url string (from VAPID public key) to a Uint8Array
 * suitable for PushManager.subscribe({ applicationServerKey }).
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/**
 * Register the service worker, request notification permission, subscribe to
 * Web Push, and POST the subscription to the backend.
 *
 * Silently returns if:
 * - Browser doesn't support service workers or PushManager
 * - User denies permission
 * - Already subscribed (PushManager returns existing sub)
 */
export async function setupPushNotifications(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return;
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });
  } catch {
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return;
  }

  let publicKey: string;
  try {
    const { public_key } = await api.vapidPublicKey();
    publicKey = public_key;
  } catch {
    return;
  }

  let sub: PushSubscription;
  try {
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  } catch {
    return;
  }

  try {
    const subJson = sub.toJSON();
    await api.subscribePush({
      endpoint: sub.endpoint,
      keys: {
        p256dh: subJson.keys?.p256dh ?? "",
        auth: subJson.keys?.auth ?? "",
      },
    });
  } catch {
    // Best-effort — subscription saved in browser, backend missed. Will retry on next mount.
  }
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd newpoc/lab && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add newpoc/lab/src/lib/notifications.ts
git commit -m "feat: add setupPushNotifications() helper"
```

---

## Task 7: Add API methods to `api.ts`

**Files:**
- Modify: `newpoc/lab/src/lib/api.ts`

- [ ] **Step 1: Add three new types and three new methods**

In `newpoc/lab/src/lib/api.ts`, add the type after `VoiceSession`:

```typescript
export interface VapidPublicKeyResponse {
  public_key: string;
}

export interface PushSubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}
```

In the `api` object, add after `voiceSession`:

```typescript
  vapidPublicKey: () =>
    http.get<VapidPublicKeyResponse>("/notifications/vapid-public-key").then((r) => r.data),
  subscribePush: (payload: PushSubscribePayload) =>
    http.post("/notifications/subscribe", payload).then((r) => r.data),
  unsubscribePush: (endpoint: string) =>
    http.delete("/notifications/subscribe", { data: { endpoint } }).then((r) => r.data),
```

- [ ] **Step 2: TypeScript check**

```bash
cd newpoc/lab && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add newpoc/lab/src/lib/api.ts
git commit -m "feat: add vapidPublicKey, subscribePush, unsubscribePush to api.ts"
```

---

## Task 8: Wire `setupPushNotifications()` into `App.tsx`

**Files:**
- Modify: `newpoc/lab/src/App.tsx`

- [ ] **Step 1: Add import and `useEffect` call**

In `newpoc/lab/src/App.tsx`:

Add the import at the top with the other imports:

```typescript
import { setupPushNotifications } from "./lib/notifications";
```

Inside `export default function App()`, after the existing `useEffect` for hashchange, add a new `useEffect`:

```typescript
  // Request push notification permission after 2 s (avoids jarring immediate prompt)
  useEffect(() => {
    const t = setTimeout(() => {
      setupPushNotifications().catch(() => undefined);
    }, 2000);
    return () => clearTimeout(t);
  }, []);
```

- [ ] **Step 2: TypeScript check**

```bash
cd newpoc/lab && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add newpoc/lab/src/App.tsx
git commit -m "feat: call setupPushNotifications() on app mount"
```

---

## Task 9: Quality checks

**Files:** none changed — verification only

- [ ] **Step 1: Ruff lint**

```bash
uv run ruff check newpoc/backend/
```

Expected: `All checks passed!`

If any issues appear (e.g. unused import), fix them before continuing.

- [ ] **Step 2: Vulture dead code**

```bash
uv run vulture newpoc/backend/ --min-confidence 80
```

Expected: no output (or only previously-known FastAPI/SQLAlchemy false positives that are NOT `send_push`, `VAPID_*` variables, or `PushSubscription`).

- [ ] **Step 3: TypeScript**

```bash
cd newpoc/lab && npx tsc --noEmit
```

Expected: `0 errors`

- [ ] **Step 4: Full test suite**

```bash
uv run pytest tests/test_push_notifications.py -v
```

Expected: all tests green.

- [ ] **Step 5: Commit quality fixes (if any)**

```bash
git add -u
git commit -m "chore: ruff + vulture + tsc clean after push notifications"
```

---

## Task 10: End-to-end manual test

**Files:** none — verification only

**Prerequisites:** Backend running on port 8001 with real VAPID keys in `.env`.

- [ ] **Step 1: Start the backend**

```bash
uv run uvicorn newpoc.backend.main:app --reload --port 8001
```

Verify: no startup errors, especially no `KeyError` for VAPID env vars.

- [ ] **Step 2: Confirm VAPID endpoint returns your key**

```bash
curl http://localhost:8001/notifications/vapid-public-key
```

Expected: `{"public_key":"B..."}` (your real key, not empty).

- [ ] **Step 3: Start the frontend**

```bash
cd newpoc/lab && npm run dev
```

Open `http://localhost:5173` in a Chromium-based browser (Chrome/Edge — Safari requires additional manifest setup per the spec's out-of-scope note).

- [ ] **Step 4: Grant notification permission**

After 2 seconds, the browser should show a "Allow notifications?" permission prompt. Click **Allow**.

Open DevTools → Application → Service Workers. Confirm `sw.js` is registered and active.

Open DevTools → Application → Notifications. Confirm a subscription appears with `https://fcm.googleapis.com/...` or `https://fcm.push.apple.com/...` as endpoint.

- [ ] **Step 5: Verify subscription saved in backend**

```bash
curl http://localhost:8001/notifications/vapid-public-key  # still returns key (server healthy)
```

Confirm the subscription row exists in SQLite:

```bash
sqlite3 newpoc/backend/db/cardhero.db "SELECT id, substr(endpoint,1,50), created_at FROM push_subscriptions;"
```

Expected: 1 row.

- [ ] **Step 6: Trigger a test push via `/evaluate`**

First seed a want_list item if needed:

```bash
curl -X GET http://localhost:8001/want-list | python3 -m json.tool | head -20
```

Then evaluate a fake deal (replace `want_list_id` with a real ID, ensure `price` is under `max_price`):

```bash
curl -X POST http://localhost:8001/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "want_list_id": 1,
    "url": "https://www.ebay.com/itm/push-test-001",
    "listing_type": "BUY_IT_NOW",
    "price": 200.0,
    "shipping": 0.0,
    "seller_username": "testpushseller",
    "seller_rating": 99.5,
    "seller_feedback_count": 500,
    "watchman_score": 0.80
  }'
```

Expected response: `{"decision": "GO", ...}`

Expected outcome: **a native OS notification appears on your desktop** within 2-3 seconds saying e.g. `Charizard ex PSA 10` / `$218 landed · 35% under your max`.

- [ ] **Step 7: Test notification click**

Click the notification. It should open/focus a browser tab pointed at `http://localhost:5173/#findings`.

- [ ] **Step 8: Final commit**

```bash
git add .
git commit -m "feat: web push notifications — VAPID, service worker, subscription flow, send_push on GO"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] VAPID keys generated + stored in .env — Task 1
- [x] `PushSubscription` model — Task 2
- [x] `GET /notifications/vapid-public-key` — Task 3
- [x] `POST /notifications/subscribe` — Task 3
- [x] `DELETE /notifications/subscribe` — Task 3
- [x] `send_push()` helper — Task 4
- [x] BackgroundTask hook in `/evaluate` — Task 4
- [x] `public/sw.js` with push + click handlers — Task 5
- [x] `src/lib/notifications.ts` with `setupPushNotifications()` — Task 6
- [x] `api.ts` additions — Task 7
- [x] `App.tsx` mount call with 2s delay — Task 8
- [x] `.env.example` updated — Task 1
- [x] 410 Gone cleanup — Task 4 (in `send_push()`)
- [x] Permission-denied silent return — Task 6
- [x] Push failure non-blocking — Task 4 (BackgroundTasks + except)
- [x] Vercel `Service-Worker-Allowed` header — Task 5

**Type consistency:**
- `PushSubscribePayload` defined in `api.ts` Step 1, used in `notifications.ts` Task 6 and `api.ts` `subscribePush` method — consistent.
- `send_push()` signature `(deal_id, card_name, card_grade, landed_cost, max_price)` matches the `background_tasks.add_task()` call in Task 4.

**No placeholders:** All steps contain complete code.
