// Service Worker（裏で画面のファイルを保管する仕組み）
// - 電波がなくても、アプリの画面が開き、記録や写真を見られるようにする（記録と写真はもともと端末の中）
// - 電波があるときは、サーバーの最新の画面を使う（更新がすぐ届くように「ネットワーク優先」）
// - ただしサーバーが眠っていて3秒たっても返事がないときは、保管しておいた画面ですぐ開く
//   （裏では最新の画面の取り寄せを続け、次に開いたときに使う）
// - AI の呼び出し（/api/）とほかのサイト（書体など）には手を出さない
//
// 画面のファイルを増やしたら PRECACHE に足し、VERSION を上げる

const VERSION = "v4";
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
  "/js/daily.js",
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
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      // ページの移動は最初の画面で受ける（画面の切り替えは # で行うため）
      const cached = (await cache.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await cache.match("/index.html") : null);
      if (!cached) {
        return network.catch(() => new Response("オフラインです", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
      }
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
      const winner = await Promise.race([network.catch(() => null), timeout]);
      if (winner) return winner;
      event.waitUntil(network.catch(() => {})); // 裏で最新を取り寄せ続ける
      return cached;
    })(),
  );
});
