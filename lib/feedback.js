// AIが「わかりやすい言葉への言い換え」で迷った点（報告）と、管理者が確認した言い換え（用語辞書）
//
// 保存先
// - TURSO_DATABASE_URL があれば Turso（クラウドのデータベース）。公開先（Render）ではこちら
// - なければ手元のファイル（./data/feedback.db）。開発用。Render ではサーバーが入れ替わると消える
//
// 個人が特定されないように
// - 保存するのは、迷った用語・AIの言い換え・理由・前後の短い文だけ。説明の全文・ペット情報・利用者の情報は保存しない
// - ペットの名前・病院・説明者の名前（入力された値）、電話番号・メール・URL・郵便番号・長い数字は「＊＊」に置き換える
// - 利用者を結びつける情報（IPアドレス・端末ID など）は保存しない

import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

let client = null;
let ready = null;

export const dbMode = () => (process.env.TURSO_DATABASE_URL?.trim() ? "turso" : "file");

function connect() {
  const url = process.env.TURSO_DATABASE_URL?.trim(); // 管理画面からのコピーで前後に空白が入りやすい
  if (url) return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined });
  mkdirSync("./data", { recursive: true });
  return createClient({ url: "file:./data/feedback.db" });
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS review_flags (
     id          TEXT PRIMARY KEY,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     category    TEXT NOT NULL,
     term        TEXT NOT NULL,
     used_plain  TEXT NOT NULL DEFAULT '',
     reason      TEXT NOT NULL DEFAULT '',
     context     TEXT NOT NULL DEFAULT '',
     species     TEXT NOT NULL DEFAULT '',
     model       TEXT NOT NULL DEFAULT '',
     status      TEXT NOT NULL DEFAULT 'open',   -- open / fixed（直して登録）/ approved（AIの言い換えでよい・登録）/ dismissed（問題なし）
     resolved_at TEXT,
     admin_plain TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS review_flags_status ON review_flags(status, created_at)`,
  // AI の利用量（管理者だけが見る）。だれが使ったかは保存しない
  `CREATE TABLE IF NOT EXISTS ai_usage (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at    TEXT NOT NULL DEFAULT (datetime('now')),
     kind          TEXT NOT NULL,
     model         TEXT NOT NULL,
     input_tokens  INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS glossary (
     id         TEXT PRIMARY KEY,
     term       TEXT NOT NULL UNIQUE,
     plain      TEXT NOT NULL,
     note       TEXT NOT NULL DEFAULT '',
     active     INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
];

async function db() {
  if (!client) client = connect();
  if (!ready) {
    ready = client.batch(SCHEMA, "write").catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
  return client;
}

// ---------- 個人が特定されそうな部分を消す ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function mask(text, secrets = []) {
  let t = String(text ?? "");
  for (const s of secrets.map((x) => String(x || "").trim()).filter((x) => x.length >= 2)) {
    t = t.replace(new RegExp(escapeRe(s), "g"), "＊＊");
  }
  return t
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "＊＊") // メール
    .replace(/https?:\/\/\S+/g, "＊＊") // URL
    .replace(/(\+81[- ]?|0)\d{1,4}[-(（)） ]{1,2}\d{1,4}[-(（)） ]{1,2}\d{3,4}/g, "＊＊") // 電話番号（区切りあり）※郵便番号より先に消す
    .replace(/0\d{9,10}/g, "＊＊") // 電話番号（区切りなし）
    .replace(/〒?\s?\d{3}-\d{4}/g, "＊＊") // 郵便番号
    .replace(/\d{7,}/g, "＊＊"); // 長い数字（会員番号・カルテ番号など）
}

const clip = (v, n) => String(v ?? "").slice(0, n);

/** AI の報告を保存する（まとめの返事を待たせないよう、失敗しても呼び出し元には伝えない） */
export async function saveFlags(flags, { secrets = [], species = "", model = "" } = {}) {
  if (!Array.isArray(flags) || !flags.length) return 0;
  const c = await db();
  const rows = flags.slice(0, 5).map((f) => ({
    sql: `INSERT INTO review_flags (id, category, term, used_plain, reason, context, species, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      clip(f.category, 20) || "その他",
      clip(mask(f.term, secrets), 80),
      clip(mask(f.used_plain, secrets), 300),
      clip(mask(f.reason, secrets), 300),
      clip(mask(f.context, secrets), 160),
      clip(species, 20),
      clip(model, 60),
    ],
  }));
  await c.batch(rows, "write");
  return rows.length;
}

// ---------- 用語辞書（まとめのときに AI へ渡す） ----------
let cache = { at: 0, rows: [] };
export async function activeGlossary() {
  if (Date.now() - cache.at < 60_000) return cache.rows;
  const c = await db();
  const r = await c.execute(`SELECT term, plain FROM glossary WHERE active = 1 ORDER BY term`);
  cache = { at: Date.now(), rows: r.rows.map((x) => ({ term: String(x.term), plain: String(x.plain) })) };
  return cache.rows;
}
/** 説明の中に出てくる用語だけを選ぶ（関係ない用語で指示を長くしない） */
export async function glossaryFor(text) {
  try {
    const rows = await activeGlossary();
    return rows.filter((g) => text.includes(g.term)).slice(0, 60);
  } catch (e) {
    console.error("[feedback] 用語辞書を読めませんでした:", e.message);
    return [];
  }
}

// ---------- 管理者用 ----------
export async function listFlags(status = "open", limit = 200) {
  const c = await db();
  const r = await c.execute({
    sql: `SELECT * FROM review_flags WHERE status = ? ORDER BY created_at ${status === "open" ? "ASC" : "DESC"} LIMIT ?`,
    args: [status, limit],
  });
  return r.rows.map((x) => ({ ...x }));
}

export async function resolveFlag(id, { action, term, plain, note = "" }) {
  const c = await db();
  const found = await c.execute({ sql: `SELECT * FROM review_flags WHERE id = ?`, args: [id] });
  const flag = found.rows[0];
  if (!flag) throw new Error("報告が見つかりません。");
  if (action === "dismiss") {
    await c.execute({ sql: `UPDATE review_flags SET status = 'dismissed', resolved_at = datetime('now') WHERE id = ?`, args: [id] });
    return { status: "dismissed" };
  }
  const t = clip(term || flag.term, 80).trim();
  const p = clip(plain, 300).trim();
  if (!t || !p) throw new Error("用語と言い換えを入れてください。");
  const status = p === String(flag.used_plain).trim() ? "approved" : "fixed";
  await c.batch(
    [
      {
        sql: `INSERT INTO glossary (id, term, plain, note) VALUES (?, ?, ?, ?)
              ON CONFLICT(term) DO UPDATE SET plain = excluded.plain, note = excluded.note, active = 1, updated_at = datetime('now')`,
        args: [randomUUID(), t, p, clip(note, 300)],
      },
      { sql: `UPDATE review_flags SET status = ?, resolved_at = datetime('now'), admin_plain = ? WHERE id = ?`, args: [status, p, id] },
    ],
    "write",
  );
  cache.at = 0;
  return { status };
}

export async function listGlossary() {
  const c = await db();
  const r = await c.execute(`SELECT * FROM glossary ORDER BY active DESC, term`);
  return r.rows.map((x) => ({ ...x }));
}

export async function upsertGlossary({ term, plain, note = "" }) {
  const t = clip(term, 80).trim();
  const p = clip(plain, 300).trim();
  if (!t || !p) throw new Error("用語と言い換えを入れてください。");
  const c = await db();
  await c.execute({
    sql: `INSERT INTO glossary (id, term, plain, note) VALUES (?, ?, ?, ?)
          ON CONFLICT(term) DO UPDATE SET plain = excluded.plain, note = excluded.note, active = 1, updated_at = datetime('now')`,
    args: [randomUUID(), t, p, clip(note, 300)],
  });
  cache.at = 0;
}

export async function setGlossaryActive(id, active) {
  const c = await db();
  await c.execute({ sql: `UPDATE glossary SET active = ?, updated_at = datetime('now') WHERE id = ?`, args: [active ? 1 : 0, id] });
  cache.at = 0;
}

/** モデルごとの集計：AI の報告がどのくらい役に立ったか（直した割合） */
export async function flagStats() {
  const c = await db();
  const r = await c.execute(`SELECT model, status, COUNT(*) AS n FROM review_flags GROUP BY model, status`);
  const byModel = {};
  for (const x of r.rows) {
    const m = String(x.model || "不明");
    byModel[m] ||= { open: 0, fixed: 0, approved: 0, dismissed: 0 };
    byModel[m][String(x.status)] = Number(x.n);
  }
  const g = await c.execute(`SELECT COUNT(*) AS n FROM glossary WHERE active = 1`);
  return { byModel, glossary: Number(g.rows[0].n), mode: dbMode() };
}

// ---------- AI の利用量（管理者だけが見る） ----------
// 1Mトークンあたりの米ドル単価（2026年11月時点の公開価格）。為替は USD_JPY（未設定なら150円）
const PRICES = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
export function estimateYen(model, inputTokens, outputTokens) {
  const price = Object.entries(PRICES).find(([id]) => String(model).startsWith(id))?.[1];
  if (!price) return null;
  return ((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * Number(process.env.USD_JPY || 150);
}

export async function logUsage(kind, { model, inputTokens = 0, outputTokens = 0 }) {
  const c = await db();
  await c.execute({
    sql: `INSERT INTO ai_usage (kind, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?)`,
    args: [clip(kind, 20), clip(model, 60), Number(inputTokens) || 0, Number(outputTokens) || 0],
  });
}

/** 月ごと・モデルごと・種類ごとの回数と金額（直近12か月） */
export async function usageSummary() {
  const c = await db();
  const r = await c.execute(
    `SELECT strftime('%Y-%m', created_at, '+9 hours') AS month, model, kind,
            COUNT(*) AS n, SUM(input_tokens) AS inp, SUM(output_tokens) AS outp
       FROM ai_usage
      WHERE created_at >= datetime('now', '-12 months')
      GROUP BY month, model, kind
      ORDER BY month DESC`,
  );
  return r.rows.map((x) => ({
    month: String(x.month),
    model: String(x.model),
    kind: String(x.kind),
    count: Number(x.n),
    inputTokens: Number(x.inp),
    outputTokens: Number(x.outp),
    yen: estimateYen(String(x.model), Number(x.inp), Number(x.outp)),
  }));
}
