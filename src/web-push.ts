import { api } from "./api.js";

// Browser side of Web Push (server/push.ts). public/sw.js shows the notifications; this registers it, subscribes the
// browser with the server's key, and routes a clicked notification into an open tab.

/** Push needs HTTPS (or localhost), a service worker and the Push API. */
export const pushSupported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

/** Registers the service worker and opens cards it sends from clicked notifications. Call once at startup. */
export function registerPushWorker(): void {
  if (!pushSupported()) return;
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type !== "open" || !data.url) return;
    const url = new URL(data.url, location.origin);
    if (url.origin !== location.origin) return;
    history.pushState(null, "", url.pathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission, subscribes this browser and saves the subscription on the server. */
export async function enablePush(): Promise<void> {
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error(
      "Notification permission was not granted. Allow notifications for Bakery in your browser.",
    );
  const { publicKey } = await api<{ publicKey: string }>("/push/key");
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    }));
  await api("/push/subscriptions", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api("/push/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
