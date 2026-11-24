// Bakery's service worker: it only shows Web Push notifications (server/push.ts) and opens the card on click.
// It caches nothing, so the page always loads from the server.
self.addEventListener("push", (event) => {
  const notice = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(notice.title || "Bakery", {
      body: notice.body || "",
      tag: notice.tag,
      icon: "/favicon.png",
      data: { url: notice.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open Bakery tab: tell it to open the card, which keeps its state; a new tab only when none is open.
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: "open", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
