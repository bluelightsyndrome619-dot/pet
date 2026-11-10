// Service Worker（裏で画面のファイルを保管する仕組み）
// - 電波がなくても、アプリの画面が開き、記録や写真を見られるようにする（記録と写真はもともと端末の中）
// - 電波があるときは、いつもサーバーの最新の画面を使う（更新がすぐ届くように「ネットワーク優先」）
// - AI の呼び出し（/api/）とほかのサイト（書体など）には手を出さない
//
// 画面のファイルを増やしたら PRECACHE に足し、VERSION を上げる

const VERSION = "v2";
const CACHE = `mkp-shell-${VERSION}`;
const PRECACHE = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/boot.js",
  "/js/app.js",
  "/js/store.js",
  "/js/camera.js",
  "/js/ui.js",
  "/js/backup.js",
  "/js/pwa.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mkp-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 書体などほかのサイト
  if (url.pathname.startsWith("/api/")) return; // AI・状態の確認はいつもサーバーへ

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch {
        // 電波がないとき：保管しておいた画面を使う。ページの移動は最初の画面で受ける（画面の切り替えは # で行うため）
        const cached = (await cache.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await cache.match("/index.html") : null);
        return cached || new Response("オフラインです", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    })(),
  );
});
