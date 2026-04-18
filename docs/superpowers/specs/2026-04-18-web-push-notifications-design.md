# Web Push Notifications — Design Spec
**Date:** 2026-04-18  
**Status:** Approved

---

## Goal

When the Watchman finds a deal that passes all filters (status = PENDING), every subscribed user receives a native macOS (or OS-native) desktop notification immediately — even if the CardHero browser tab is closed. Clicking the notification opens the dashboard directly to the Findings section.

---

## Architecture

Three components work together:

```
Watchman → POST /evaluate → creates PENDING deal
                                    │
                              send_push(deal)
                                    │
                         pywebpush → Apple/Google Push Servers
                                    │
                         Service Worker in browser
                                    │
                         Native macOS notification
```

### 1. VAPID Keys
Generated once via `pywebpush` CLI, stored in `.env`:
```
VAPID_PRIVATE_KEY=...
VAPID_PUBLIC_KEY=...
VAPID_CLAIMS_EMAIL=eknoor.natt93@gmail.com
```
The public key is exposed to the frontend via `GET /notifications/vapid-public-key`.

### 2. Database — `push_subscriptions` table
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| endpoint | TEXT UNIQUE | Push service URL (browser-generated) |
| p256dh | TEXT | Encryption key |
| auth | TEXT | Auth secret |
| created_at | DATETIME | |

Stored in existing SQLite DB via new `PushSubscription` SQLAlchemy model.

### 3. Backend — new endpoints

**`GET /notifications/vapid-public-key`**  
Returns `{ "public_key": "..." }`. Frontend uses this to create the push subscription.

**`POST /notifications/subscribe`**  
Body: `{ "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } }`  
Upserts into `push_subscriptions`. Returns 201.

**`DELETE /notifications/subscribe`**  
Body: `{ "endpoint": "..." }`  
Removes subscription. Returns 204.

### 4. `send_push(deal, want_item)` helper
Called inside `/evaluate` immediately after a Deal row is committed with status=PENDING.

```python
def send_push(deal: Deal, want_item: WantList) -> None:
    pct_below = round((1 - deal.landed_cost / want_item.max_price) * 100)
    title = f"{want_item.name} {want_item.grade}"
    body = f"${deal.landed_cost:.0f} landed · {pct_below}% under your max"
    payload = json.dumps({"title": title, "body": body, "url": "/#findings"})
    
    # Fan out to all subscriptions, remove expired ones (410 Gone)
    for sub in db.query(PushSubscription).all():
        try:
            webpush(subscription_info=..., data=payload, vapid_private_key=..., vapid_claims=...)
        except WebPushException as e:
            if e.response and e.response.status_code == 410:
                db.delete(sub)  # subscription expired, clean up
    db.commit()
```

Runs in a background thread (FastAPI `BackgroundTasks`) so it never delays the `/evaluate` response.

### 5. Frontend — Service Worker (`public/sw.js`)

```javascript
self.addEventListener('push', (event) => {
  const { title, body, url } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/favicon.svg',
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

### 6. Frontend — Permission + Subscription (`src/lib/notifications.ts`)

Called once on app load (after user interaction, to satisfy browser requirement):

```typescript
async function setupPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  
  const reg = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;
  
  const { public_key } = await api.vapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(public_key),
  });
  
  await api.subscribePush(sub.toJSON());
}
```

Called from `App.tsx` on first render, after a short delay (avoids the jarring immediate permission prompt).

---

## Notification Content

| Scenario | Title | Body |
|----------|-------|------|
| Single deal | `Charizard ex PSA 10` | `$340 landed · 15% under your max` |
| Click action | Opens `<vercel-url>/#findings` in browser | |

Batching (multiple deals from same poll): the Watchman polls on a cycle; each deal that passes goes through `/evaluate` individually. Each fires its own push. If 3 deals arrive within seconds, the user gets 3 notifications — macOS stacks them visually. This is fine for a POC; future work could add a 5-second debounce window.

---

## Files Changed

| File | Change |
|------|--------|
| `newpoc/backend/database.py` | Add `PushSubscription` model |
| `newpoc/backend/main.py` | Add 3 endpoints + `send_push()` + BackgroundTask hook in `/evaluate` |
| `newpoc/lab/public/sw.js` | New — service worker (push + click handlers) |
| `newpoc/lab/src/lib/notifications.ts` | New — permission request + subscription setup |
| `newpoc/lab/src/lib/api.ts` | Add `vapidPublicKey()` + `subscribePush()` + `unsubscribePush()` |
| `newpoc/lab/src/App.tsx` | Call `setupPushNotifications()` on mount |
| `newpoc/.env.example` | Add `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_CLAIMS_EMAIL` |

---

## Dependencies

```
# Python
pywebpush  (uv add pywebpush)

# No new npm deps — Web Push API is native to all modern browsers
```

---

## Error Handling

- **Permission denied:** `setupPushNotifications()` returns silently. No UI error shown — don't nag.
- **Subscription expired (410):** `send_push()` deletes the stale row automatically.
- **Push send failure (network):** Log warning, continue. Non-blocking via BackgroundTasks.
- **No subscriptions:** `send_push()` is a no-op — no error.

---

## Out of Scope

- Notification preferences / per-card muting
- Batching with debounce window (can add later)
- iOS Safari (requires additional manifest setup — future work)
