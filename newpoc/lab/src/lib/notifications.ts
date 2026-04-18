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
 * - VAPID key fetch fails
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
