// データはこの端末のブラウザの中（IndexedDB）に保存する。サーバーには残らない
// - pets: ペットのプロフィール
// - visits: 受診ごとの説明とまとめ
// - photos: 皮膚・傷などの写真（画像そのものも保存）
// - histories: 「これまでの受診歴」のまとめ（ペットごとに最新の1件）

const DB_NAME = "medikataru-pet";
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pets")) db.createObjectStore("pets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("visits")) {
        db.createObjectStore("visits", { keyPath: "id" }).createIndex("petId", "petId");
      }
      if (!db.objectStoreNames.contains("photos")) {
        const s = db.createObjectStore("photos", { keyPath: "id" });
        s.createIndex("petId", "petId");
        s.createIndex("visitId", "visitId");
      }
      if (!db.objectStoreNames.contains("histories")) db.createObjectStore("histories", { keyPath: "petId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    Promise.resolve(fn(t.objectStore(store))).then((r) => (result = r), reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("保存できませんでした"));
  });
}

export const newId = () =>
  (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/-/g, "").slice(0, 16);

const get = (store, key) => tx(store, "readonly", (s) => done(s.get(key)));
const put = (store, value) => tx(store, "readwrite", (s) => done(s.put(value))).then(() => value);
const del = (store, key) => tx(store, "readwrite", (s) => done(s.delete(key)));
const all = (store) => tx(store, "readonly", (s) => done(s.getAll()));
const byIndex = (store, index, key) => tx(store, "readonly", (s) => done(s.index(index).getAll(key)));

// ---------- ペット ----------
export const listPets = async () => (await all("pets")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
export const getPet = (id) => get("pets", id);
export const savePet = (pet) => put("pets", { createdAt: new Date().toISOString(), ...pet, updatedAt: new Date().toISOString() });

export async function deletePet(id) {
  for (const v of await listVisits(id)) await del("visits", v.id);
  for (const p of await listPhotos(id)) await del("photos", p.id);
  await del("histories", id);
  await del("pets", id);
}

// ---------- 受診 ----------
// 受診日（新しい順）→ 作成日時（新しい順）
const byDateDesc = (a, b) => (b.date || "").localeCompare(a.date || "") || b.createdAt.localeCompare(a.createdAt);

export const listVisits = async (petId) => (await byIndex("visits", "petId", petId)).sort(byDateDesc);
export const getVisit = (id) => get("visits", id);
export const saveVisit = (visit) => put("visits", visit);
export async function deleteVisit(id) {
  // 写真は消さず、受診とのつながりだけ外す
  for (const p of await byIndex("photos", "visitId", id)) await put("photos", { ...p, visitId: null });
  await del("visits", id);
}

// ---------- 写真 ----------
export const listPhotos = async (petId) =>
  (await byIndex("photos", "petId", petId)).sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.createdAt.localeCompare(a.createdAt));
export const listVisitPhotos = async (visitId) => (await byIndex("photos", "visitId", visitId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
export const getPhoto = (id) => get("photos", id);
export const savePhoto = (photo) => put("photos", photo);
export const deletePhoto = (id) => del("photos", id);

// ---------- 受診歴のまとめ ----------
export const getHistory = (petId) => get("histories", petId);
export const saveHistory = (history) => put("histories", history);

// ---------- バックアップ ----------
const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function exportAll() {
  const photos = await all("photos");
  return {
    app: "medikataru-for-pet",
    version: 1,
    exportedAt: new Date().toISOString(),
    pets: await all("pets"),
    visits: await all("visits"),
    histories: await all("histories"),
    photos: await Promise.all(photos.map(async (p) => ({ ...p, blob: p.blob ? await blobToDataUrl(p.blob) : null }))),
  };
}

export async function importAll(data) {
  if (!data || data.app !== "medikataru-for-pet") throw new Error("MediKataru for pet のバックアップファイルではありません。");
  for (const p of data.pets || []) await put("pets", p);
  for (const v of data.visits || []) await put("visits", v);
  for (const h of data.histories || []) await put("histories", h);
  for (const p of data.photos || []) {
    const blob = p.blob ? await (await fetch(p.blob)).blob() : null;
    await put("photos", { ...p, blob });
  }
  return { pets: data.pets?.length || 0, visits: data.visits?.length || 0, photos: data.photos?.length || 0 };
}

// バックアップの声かけ用：記録の数と、いちばん古い記録の日時
export async function dataSummary() {
  const [visits, photos] = await Promise.all([
    tx("visits", "readonly", (s) => done(s.getAll())),
    tx("photos", "readonly", (s) => done(s.getAll())),
  ]);
  const firstAt = [...visits, ...photos].map((x) => x.createdAt).filter(Boolean).sort()[0] || null;
  return { visits: visits.length, photos: photos.length, firstAt };
}

// 保存容量の目安（対応ブラウザのみ）。ブラウザに「消さないで」とお願いもしておく
export async function storageInfo() {
  try {
    await navigator.storage?.persist?.();
    const est = await navigator.storage?.estimate?.();
    return est ? { usage: est.usage || 0, quota: est.quota || 0 } : null;
  } catch {
    return null;
  }
}
