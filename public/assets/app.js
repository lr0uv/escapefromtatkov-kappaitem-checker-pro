// Kappaチェッカー本体。
// 進捗はまずこの端末（localStorage）に保存し、合言葉があるときだけサーバーと同期する。

const STORE_KEY = 'kcc:v2';
const PREFS_KEY = 'kcc:prefs';
const ITEMS_CACHE = 'kcc:items:';
const SYNC_DELAY = 2500; // チェックしてから同期するまでの待ち時間（連打をまとめて1回にする）
const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const QR_LIB = '/assets/vendor/qrcode.js'; // QRコード生成ライブラリ qrcode-generator 1.4.4（MIT）
// 解放条件のチェックもアイテムと同じ進捗データに入れて同期する（サーバーは24桁の英数字IDだけを受け付ける）。
// トレーダーとタスクは tarkov.dev のIDをそのまま使い、レベル条件だけはこの固定IDで記録する
const LEVEL_KEY = '000000000000000000000042';

import { T } from './i18n.js';

const $ = (id) => document.getElementById(id);

const storage = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できない環境（プライベートモード等）では無視 */ }
  },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};

const prefs = Object.assign(
  { mode: 'regular', filter: 'all', doneLast: true, guideSeen: false },
  storage.get(PREFS_KEY, {}),
);
// store.profiles[モード][アイテムID] = [1(所持)|0(未所持), 更新時刻]
const store = Object.assign({ profiles: {}, key: null, shareId: null, lastSync: null }, storage.get(STORE_KEY, {}));

const state = {
  items: [],
  itemsMeta: null,
  reqs: null,       // Kappa解放条件（レベル・トレーダー・タスク）
  share: null,      // 閲覧専用リンクで開いたときの進捗
  syncTimer: null,
  syncing: false,
  undo: null,
};

// 表示言語は index.html の先頭のスクリプトが決める（URL → 本人が選んだ言語 → ブラウザの言語の順）
prefs.lang = document.documentElement.dataset.lang === 'ja' ? 'ja' : 'en';

const t = (k, vars = {}) => (T[prefs.lang][k] ?? T.ja[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
const MODES = ['regular', 'pve', 'season'];
const wikiUrl = (item) => `https://escapefromtarkov.fandom.com/wiki/${encodeURIComponent((item.name.en || '').replace(/ /g, '_'))}`;
const dataMode = (mode) => ({ pve: 'pve', season: 'pvp-season' }[mode] ?? 'regular'); // tarkov.dev のモード名に変換
const profiles = () => state.share ?? store.profiles;
const isFound = (id) => profiles()[prefs.mode]?.[id]?.[0] === 1;

// 表示中の言語は推測のこともあるので保存しない。保存するのは本人がボタンで選んだ langChoice だけ
function savePrefs() { storage.set(PREFS_KEY, { ...prefs, lang: undefined }); }
function saveStore() {
  storage.set(STORE_KEY, store);
  idbSet(STORE_KEY, store);
  requestPersist();
}

// ---------- 予備の保存先（IndexedDB） ----------
// localStorage が消えたときのために、同じ内容を別の保存場所にも書いておく
let idbPromise = null;
function idbOpen() {
  idbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('kcc', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}
async function idbSet(key, value) {
  try {
    const db = await idbOpen();
    db.transaction('kv', 'readwrite').objectStore('kv').put(structuredClone(value), key);
  } catch { /* 使えない環境では何もしない */ }
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

// 起動時に予備の保存先と見比べ、片方にしか無いチェックや合言葉を取り戻す
async function restoreFromBackup() {
  const saved = await idbGet(STORE_KEY);
  if (saved?.profiles) {
    const before = JSON.stringify([store.profiles, store.key]);
    const hadNothing = !hasProgress() && !store.key;
    store.profiles = mergeProfiles(store.profiles, saved.profiles);
    if (!store.key && saved.key) { store.key = saved.key; store.shareId = saved.shareId ?? null; }
    if (JSON.stringify([store.profiles, store.key]) !== before) {
      storage.set(STORE_KEY, store);
      render();
      renderSync();
      if (hadNothing) toast(t('restored'));
    }
  }
  if (hasProgress() || store.key) idbSet(STORE_KEY, store);
  requestPersist();
}

// ブラウザに「このサイトのデータを自動で消さないで」と申請する（認めるかはブラウザ次第）
let persistAsked = false;
async function requestPersist() {
  if (persistAsked || !navigator.storage?.persist || !hasProgress()) return;
  persistAsked = true;
  try { if (!(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

const foundTotal = () => Object.values(store.profiles).reduce((n, p) => n + Object.values(p ?? {}).filter((e) => e[0] === 1).length, 0);
const hasProgress = () => foundTotal() > 0;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const SAFETY_SNOOZE = 3 * 24 * 60 * 60 * 1000; // 「あとで」を押したら3日間は出さない

// 合言葉が無いまま進捗がたまってきたら、復旧手段を用意するよう案内する
function renderSafety() {
  const show = !state.share && !store.key && foundTotal() >= 3 && Date.now() - (prefs.safetyLaterAt ?? 0) > SAFETY_SNOOZE;
  $('safety').hidden = !show;
  $('safety-ios').hidden = !(isIos() && !isStandalone());
}

// ---------- 画面の文言 ----------
function applyI18n() {
  document.documentElement.lang = prefs.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.title = t('metaTitle');
  document.querySelector('meta[name="description"]').content = t('metaDesc');
  $('privacy-link').href = prefs.lang === 'en' ? '/en/privacy.html' : '/privacy.html';
  document.querySelectorAll('#lang-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === prefs.lang)));
  document.documentElement.classList.remove('i18n-wait');
}

// ---------- アイテム一覧 ----------
async function loadItems() {
  const mode = dataMode(prefs.mode);
  const cacheKey = ITEMS_CACHE + mode;
  const cached = storage.get(cacheKey, null);
  if (cached) setItems(cached);
  else { showNotice(t('loading')); showSkeleton(); }

  try {
    const res = await fetch(`/api/items.php?mode=${mode}`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    storage.set(cacheKey, data);
    if (dataMode(prefs.mode) === mode) { setItems(data); showNotice(null); }
  } catch {
    showNotice(cached ? t('offlineList') : t('loadFailed'));
  }
}

function setItems(data) {
  state.items = data.items ?? [];
  state.itemsMeta = data;
  state.reqs = data.requirements ?? null;
  $('data-updated').textContent = data.updatedAt ? new Date(data.updatedAt * 1000).toLocaleString(prefs.lang) : '-';
  render();
}

// 読み込み中は灰色の仮カードを並べて、画面がガタつかないようにする
function showSkeleton() {
  $('grid').replaceChildren(...Array.from({ length: 24 }, () => {
    const li = document.createElement('li');
    li.className = 'skeleton';
    return li;
  }));
}

function showNotice(text) {
  $('notice').hidden = !text;
  $('notice').textContent = text ?? '';
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  let list = state.items.map((item) => ({ item, found: isFound(item.id) }));
  const total = list.length;
  const found = list.filter((x) => x.found).length;

  if (prefs.filter === 'missing') list = list.filter((x) => !x.found);
  if (prefs.filter === 'found') list = list.filter((x) => x.found);
  if (q) {
    list = list.filter(({ item }) => [item.name.ja, item.name.en, item.short.ja, item.short.en]
      .some((s) => s?.toLowerCase().includes(q)));
  }
  if (prefs.doneLast) list.sort((a, b) => a.found - b.found);

  const grid = $('grid');
  grid.replaceChildren(...list.map(({ item, found: f }, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item' + (f ? ' found' : '');
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = String(i + 1).padStart(2, '0');
    btn.dataset.id = item.id;
    btn.setAttribute('aria-pressed', String(f));
    btn.disabled = !!state.share;
    const img = document.createElement('img');
    img.src = item.icon;
    img.alt = '';
    img.loading = 'lazy';
    img.width = 38;
    img.height = 38;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name[prefs.lang] || item.name.en;
    btn.append(no, img, name);
    if (item.count > 1) {
      const qty = document.createElement('span');
      qty.className = 'qty';
      qty.textContent = `×${item.count}`;
      btn.append(qty);
    }
    const box = document.createElement('span');
    box.className = 'box';
    box.setAttribute('aria-hidden', 'true');
    btn.append(box);
    li.append(btn);
    // 入手場所を調べるためのWikiリンク（カード本体のボタンとは別の要素にする）
    const info = document.createElement('a');
    info.className = 'info';
    info.href = wikiUrl(item);
    info.target = '_blank';
    info.rel = 'noopener';
    info.textContent = 'ⓘ';
    info.title = t('wiki');
    info.setAttribute('aria-label', `${t('wiki')}: ${item.name[prefs.lang] || item.name.en}`);
    li.append(info);
    return li;
  }));

  if (total && !list.length) showNotice(found === total && prefs.filter === 'missing' ? t('allDone') : t('noMatch'));
  else if (total && $('notice').textContent === t('noMatch')) showNotice(null);

  $('found-count').textContent = found;
  $('total-count').textContent = total;
  $('total-count-2').textContent = total;
  $('percent').textContent = total ? `${Math.round((found / total) * 100)}%` : '';
  $('remaining-big').textContent = total ? total - found : '–';
  $('remaining-lead').textContent = total ? t(found < total ? 'leftLead' : 'leftDone') : '';
  $('side-mode').textContent = `COLLECTOR · ${t({ regular: 'modeRegular', pve: 'modePve', season: 'modeSeason' }[prefs.mode])}`;
  renderTicks(total, found);
  const reqsLeft = renderReqs(total, found);
  $('complete').hidden = !total || found < total || !!state.share;
  $('complete-lead').textContent = reqsLeft ? t('completeLeadReqs', { n: reqsLeft }) : t('completeLead');
  $('guide').hidden = prefs.guideSeen || !!state.share;
  renderSafety();
  renderTabCounts();
  $('bar-fill').style.width = total ? `${(found / total) * 100}%` : '0';
  document.querySelectorAll('#mode-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === prefs.mode)));
  document.querySelectorAll('#filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === prefs.filter)));
  $('done-last').checked = prefs.doneLast;
}

// Kappa解放条件のチェックリスト。残っている条件の数を返す
function reqRows() {
  const r = state.reqs;
  if (!r) return [];
  const name = (n) => n?.[prefs.lang] || n?.en || '';
  return [
    { group: t('reqGroupBase') },
    ...(r.level ? [{ id: LEVEL_KEY, text: t('reqLevel', { n: r.level }) }] : []),
    ...r.traders.map((x) => ({ id: x.id, text: t('reqTrader', { name: name(x.name), n: x.level }) })),
    ...(r.tasks.length ? [{ group: t('reqGroupTasks') }] : []),
    ...r.tasks.map((x) => ({ id: x.id, text: name(x.name), sub: t('reqTaskSub', { trader: name(x.trader), n: x.level }), wiki: x.wiki })),
  ];
}

function renderReqs(total, found) {
  const rows = reqRows();
  const checks = rows.filter((r) => r.id);
  $('reqs').hidden = !checks.length;
  if (!checks.length) return 0;
  const done = checks.filter((r) => isFound(r.id)).length;
  $('reqs-count').textContent = `${done}/${checks.length}`;
  // 最初の1回だけ開閉を決める。本人が開け閉めしたらそれを覚えておき、決めていなければPCは開く・スマホは閉じる
  if (!state.reqsShown) {
    state.reqsShown = true;
    $('reqs').open = prefs.reqsOpen ?? matchMedia('(min-width: 1024px)').matches;
  }

  const list = rows.map((r) => {
    const li = document.createElement('li');
    if (r.group) {
      li.className = 'req-group';
      li.textContent = r.group;
      return li;
    }
    const f = isFound(r.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'req' + (f ? ' found' : '');
    btn.dataset.id = r.id;
    btn.setAttribute('aria-pressed', String(f));
    btn.disabled = !!state.share;
    const box = document.createElement('span');
    box.className = 'box';
    box.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'req-text';
    text.textContent = r.text;
    if (r.sub) {
      const sub = document.createElement('small');
      sub.textContent = r.sub;
      text.append(sub);
    }
    btn.append(box, text);
    li.append(btn);
    if (r.wiki) {
      const a = document.createElement('a');
      a.className = 'info';
      a.href = r.wiki;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'ⓘ';
      a.title = t('reqWiki');
      a.setAttribute('aria-label', `${t('reqWiki')}: ${r.text}`);
      li.append(a);
    }
    return li;
  });
  // 納品アイテムも条件の1つとして最後に並べる（数は一覧から自動で数える）
  const items = document.createElement('li');
  items.className = 'req-items' + (total && found === total ? ' found' : '');
  items.textContent = `${t('reqItems')}  ${found}/${total}`;
  list.push(items);
  $('reqs-list').replaceChildren(...list);
  return checks.length - done;
}

// 左列の目盛り：1アイテム＝1本。納品済みの数だけ緑にする
function renderTicks(total, found) {
  const el = $('ticks');
  if (el.childElementCount !== total) {
    el.replaceChildren(...Array.from({ length: total }, () => document.createElement('span')));
  }
  [...el.children].forEach((s, i) => s.classList.toggle('on', i < found));
}

// タブに各モードの進捗（例：12/44）を出す。一覧は各モードの保存済みデータから数える
function renderTabCounts() {
  for (const m of MODES) {
    const el = document.querySelector(`[data-count="${m}"]`);
    const items = m === prefs.mode ? state.items : storage.get(ITEMS_CACHE + dataMode(m), null)?.items;
    if (!items?.length) { el.textContent = ''; continue; }
    const p = profiles()[m] ?? {};
    el.textContent = `${items.filter((i) => p[i.id]?.[0] === 1).length}/${items.length}`;
  }
}

function shareToX() {
  const total = state.items.length;
  const found = state.items.filter((i) => isFound(i.id)).length;
  const pct = total ? Math.round((found / total) * 100) : 0;
  const text = total && found === total ? t('shareTextDone') : t('shareText', { found, total, pct });
  const url = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent('https://kappacontainer.com/')}&hashtags=EscapeFromTarkov`;
  window.open(url, '_blank', 'noopener');
}

function resetMode() {
  if (!confirm(t('confirmReset'))) return;
  const p = (store.profiles[prefs.mode] ??= {});
  const now = Date.now();
  // 消すのではなく「未所持」として新しい時刻で記録し、同期先にも外したことが伝わるようにする
  for (const id of Object.keys(p)) if (p[id][0] === 1) p[id] = [0, now];
  saveStore();
  render();
  scheduleSync();
  toast(t('resetDone'));
}

function setFound(id, value) {
  const p = (store.profiles[prefs.mode] ??= {});
  p[id] = [value ? 1 : 0, Date.now()];
  saveStore();
  render();
  scheduleSync();
}

function toggle(id) {
  const before = isFound(id);
  setFound(id, !before);
  const item = state.items.find((i) => i.id === id);
  state.undo = { id, value: before };
  toast(`${before ? t('unchecked') : t('checked')}：${item?.name[prefs.lang] ?? ''}`, t('undo'), () => setFound(id, before));
}

// ---------- 同期 ----------
function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const s = Array.from(bytes, (b) => KEY_ALPHABET[b % 32]).join('');
  return s.match(/.{4}/g).join('-');
}

function normalizeKey(raw) {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(s) ? s.match(/.{4}/g).join('-') : null;
}

function mergeProfiles(a, b) {
  const out = structuredClone(a);
  for (const [mode, items] of Object.entries(b ?? {})) {
    for (const [id, entry] of Object.entries(items ?? {})) {
      const cur = out[mode]?.[id];
      if (!cur || entry[1] > cur[1]) (out[mode] ??= {})[id] = entry;
    }
  }
  return out;
}

function scheduleSync() {
  if (!store.key) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => sync(), SYNC_DELAY);
}

async function sync({ key = store.key, join = false } = {}) {
  if (!key) return false;
  if (state.syncing) { scheduleSync(); return false; }
  state.syncing = true;
  setSyncStatus(t('syncing'));
  try {
    const res = await fetch('/api/sync.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, join, profiles: store.profiles }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = { bad_key: 'badKey', not_found: 'notFound', rate_limited: 'rateLimited' }[data.error] ?? 'syncFailed';
      setSyncStatus(t(msg), true);
      return false;
    }
    // 通信中にチェックが変わっていても失われないよう、もう一度合わせる
    store.profiles = mergeProfiles(data.profiles, store.profiles);
    store.key = data.key;
    store.shareId = data.shareId;
    store.lastSync = Date.now();
    saveStore();
    render();
    renderSync();
    setSyncStatus(`${t('synced')}（${new Date().toLocaleTimeString(prefs.lang)}）`);
    return true;
  } catch {
    setSyncStatus(t('syncFailed'), true);
    return false;
  } finally {
    state.syncing = false;
  }
}

function setSyncStatus(text, error = false) {
  $('sync-status').textContent = text;
  $('sync-status').classList.toggle('error', error);
  renderChip(error);
}

// ヘッダーの同期チップ：同期の状態がひと目で分かるようにする
function renderChip(error = $('sync-status').classList.contains('error')) {
  const st = !store.key ? 'off' : error ? 'error' : 'on';
  $('sync-chip').dataset.state = st;
  $('sync-chip-text').textContent = t({ off: 'chipOff', on: 'chipOn', error: 'chipError' }[st]);
}

const keyLink = () => `${location.origin}${location.pathname}#k=${store.key}`;
const shareLink = () => `${location.origin}${location.pathname}#s=${store.shareId}`;

function renderSync() {
  $('sync-off').hidden = !!store.key;
  $('sync-on').hidden = !store.key;
  renderChip();
  renderSafety();
  if (!store.key) return;
  $('key-text').textContent = store.key;
  $('copy-share').disabled = !store.shareId;
  drawQr(keyLink());
}

let qrLoading = null;
async function drawQr(text) {
  try {
    qrLoading ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = QR_LIB;
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });
    await qrLoading;
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch {
    $('qr').hidden = true;
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { prompt('', text); }
}

// ---------- URLの #k=合言葉 / #s=共有ID ----------
async function handleHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const k = params.get('k');
  const s = params.get('s');
  if (k || s) history.replaceState(null, '', location.pathname + location.search);

  if (k) {
    const key = normalizeKey(k);
    if (key && key !== store.key && confirm(`${t('confirmJoin')}\n\n${key}`)) {
      if (await sync({ key, join: true })) toast(t('synced'));
    }
  }
  if (s && /^[a-f0-9]{16}$/.test(s)) {
    try {
      const res = await fetch(`/api/share.php?id=${s}`);
      if (!res.ok) throw new Error(res.status);
      state.share = (await res.json()).profiles ?? {};
      $('share-banner').hidden = false;
      render();
    } catch {
      toast(t('shareFailed'));
    }
  }
}

// ---------- バックアップ ----------
function exportFile() {
  const blob = new Blob([JSON.stringify({ app: 'kappacontainer', version: 2, profiles: store.profiles }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kappa-progress-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.profiles !== 'object') throw new Error('format');
    store.profiles = mergeProfiles(store.profiles, data.profiles);
    saveStore();
    render();
    scheduleSync();
    toast(t('imported'));
  } catch {
    toast(t('importFailed'));
  }
}

// ---------- 通知 ----------
let toastTimer = null;
function toast(text, actionLabel, action) {
  const el = $('toast');
  el.replaceChildren(document.createTextNode(text));
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => { action(); el.hidden = true; };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- 操作の受け付け ----------
function bind() {
  $('grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.item');
    if (btn && !state.share) toggle(btn.dataset.id);
  });
  $('reqs-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.req');
    if (btn && !state.share) setFound(btn.dataset.id, !isFound(btn.dataset.id));
  });
  // 本人が開け閉めしたときだけ覚えておく（クリックの時点ではまだ切り替わる前なので反対の値を保存する）
  $('reqs').querySelector('summary').addEventListener('click', () => {
    prefs.reqsOpen = !$('reqs').open;
    savePrefs();
  });
  $('mode-tabs').addEventListener('click', (e) => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (!mode || mode === prefs.mode) return;
    const reload = dataMode(mode) !== dataMode(prefs.mode);
    prefs.mode = mode;
    savePrefs();
    if (reload) loadItems(); else render();
  });
  $('filter').addEventListener('click', (e) => {
    const f = e.target.closest('button')?.dataset.filter;
    if (!f) return;
    prefs.filter = f;
    savePrefs();
    render();
  });
  $('done-last').addEventListener('change', (e) => { prefs.doneLast = e.target.checked; savePrefs(); render(); });
  $('search').addEventListener('input', render);
  // JA / EN ボタン：その場で切り替え、URLも / と /en/ で合わせる（再読み込みなし）
  $('lang-switch').addEventListener('click', (e) => {
    const lang = e.target.closest('button')?.dataset.lang;
    if (!lang || lang === prefs.lang) return;
    prefs.lang = lang;
    prefs.langChoice = lang;
    savePrefs();
    document.documentElement.dataset.lang = lang;
    history.replaceState(null, '', (lang === 'en' ? '/en/' : '/') + location.search + location.hash);
    applyI18n();
    renderChip();
    render();
    if (state.itemsMeta) setItems(state.itemsMeta);
  });
  $('leave-share').addEventListener('click', () => {
    state.share = null;
    $('share-banner').hidden = true;
    render();
  });

  $('issue-key').addEventListener('click', () => sync({ key: randomKey() }));
  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = normalizeKey($('join-input').value);
    if (!key) { setSyncStatus(t('badKey'), true); return; }
    if (await sync({ key, join: true })) $('join-input').value = '';
  });
  $('copy-key').addEventListener('click', () => copy(store.key));
  $('copy-share').addEventListener('click', () => copy(shareLink()));
  $('sync-now').addEventListener('click', () => sync());
  $('forget-key').addEventListener('click', () => {
    if (!confirm(t('confirmForget'))) return;
    store.key = null;
    store.shareId = null;
    saveStore();
    renderSync();
    setSyncStatus('');
  });
  $('export').addEventListener('click', exportFile);
  $('reset-mode').addEventListener('click', resetMode);
  $('safety-issue').addEventListener('click', async () => {
    if (await sync({ key: randomKey() })) $('sync-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    renderSafety();
  });
  $('safety-later').addEventListener('click', () => { prefs.safetyLaterAt = Date.now(); savePrefs(); renderSafety(); });
  $('share-x').addEventListener('click', shareToX);
  $('sync-chip').addEventListener('click', () => $('sync-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('guide-close').addEventListener('click', () => { prefs.guideSeen = true; savePrefs(); render(); });
  // 「/」キーで検索欄へ移動（入力中は除く）
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    e.preventDefault();
    $('search').focus();
  });
  $('import').addEventListener('change', (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; });
  window.addEventListener('hashchange', handleHash);
  // 他のタブで進捗が変わったら反映する
  window.addEventListener('storage', (e) => {
    if (e.key !== STORE_KEY) return;
    Object.assign(store, storage.get(STORE_KEY, {}));
    render();
    renderSync();
  });
}

// 英語で表示すると決まったら、URLも /en/ にそろえる（再読み込みはしない）。
// こうしておくと、その人がリンクを共有したときに相手にも英語ページが届く。
// 検索エンジンのクローラーは index.html の先頭で日本語のままにしているので、ここには来ない
if (document.documentElement.dataset.pageLang === 'ja' && prefs.lang === 'en' && location.pathname === '/') {
  history.replaceState(null, '', '/en/' + location.search + location.hash);
}

applyI18n();
bind();
renderSync();
render();
loadItems();
handleHash();
restoreFromBackup().then(() => { if (store.key) sync(); });

// 電波の悪い場所や回線が落ちたときでも、前回開いたページと一覧を表示できるようにする（sw.js）
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
