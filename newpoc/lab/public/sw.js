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
        // If a CardHero tab is already open, focus it and navigate
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
