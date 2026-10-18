// サービスワーカー：回線が切れたときでも、前回開いたページ・アイテム一覧・アイコンを表示できるようにする。
// ページとプログラムは「まずネットから取り、取れなかったときだけ保存しておいた物を使う」ので、
// 更新をデプロイすればネットにつながっている人には必ず最新版が届く（古い画面が残り続けることはない）。
const VERSION = 'v1';
const PAGES = `kcc-pages-${VERSION}`;
const ICONS = 'kcc-icons'; // アイテムのアイコンは中身が変わらないので、版をまたいで使い回す
const PRECACHE = ['/', '/en/', '/assets/style.css', '/assets/app.js', '/assets/i18n.js', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(PAGES).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== PAGES && key !== ICONS) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // 同期や共有は常にサーバーの最新が必要なので手を出さない
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/items.php') return;
    e.respondWith(networkFirst(req));
  } else if (url.hostname === 'assets.tarkov.dev') {
    e.respondWith(cacheFirst(req));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(PAGES);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    // 開いたことのないURLでも、ページの移動ならトップページを出す
    if (req.mode === 'navigate') {
      const page = await cache.match(new URL(req.url).pathname.startsWith('/en/') ? '/en/' : '/');
      if (page) return page;
    }
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(ICONS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // 別サイトの画像は中身の見えない形（opaque）で返ってくることがあるが、表示はできるので保存する
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
