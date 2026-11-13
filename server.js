// MediKataru for pet のサーバー
// - public/ の画面（HTML・CSS・JavaScript）を配る
// - AI のキー（ANTHROPIC_API_KEY）はここだけで使い、ブラウザには渡さない
// 外部のフレームワークは使わず、Node.js の標準機能だけで動く
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(ROOT, "public");

// 手元で動かすときは .env.local / .env を読む（すでに設定済みの値は上書きしない）
for (const name of [".env.local", ".env"]) {
  const file = join(ROOT, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const { summarizeVisit, summarizeHistory, summarizeDaily, aiEnabled, MODEL, SummarizeError } = await import("./lib/ai.js");
const feedback = await import("./lib/feedback.js");

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 1024 * 1024; // 1MB。写真はサーバーに送らないので、文字だけなら十分

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  // カメラは自分のページだけで使う
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const json = (res, status, data) =>
  send(res, status, JSON.stringify(data), { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new SummarizeError("送られた内容が大きすぎます。説明を分けて記録してください。");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new SummarizeError("送られた内容を読み取れませんでした。");
  }
}

// 同じ人が短時間に何度も押してもAIの費用が膨らまないよう、IPごとに1分あたりの回数を制限する
const hits = new Map();
function rateLimited(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "?";
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 10;
}

// ---------- 管理者（医師）用 ----------
// 合言葉は Render の環境変数 ADMIN_PASSWORD。画面から X-Admin-Key で送られてくる
const adminFails = new Map();
const sha = (v) => createHash("sha256").update(String(v)).digest();
function adminCheck(req) {
  const secret = process.env.ADMIN_PASSWORD?.trim();
  if (!secret) return { status: 503, error: "管理者の合言葉（ADMIN_PASSWORD）が設定されていません。" };
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "?";
  const now = Date.now();
  const fails = (adminFails.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  if (fails.length >= 10) return { status: 429, error: "合言葉の入力に何度も失敗しました。10分ほど待ってください。" };
  const given = String(req.headers["x-admin-key"] || "");
  if (given && timingSafeEqual(sha(given), sha(secret))) return null;
  fails.push(now);
  adminFails.set(ip, fails);
  if (adminFails.size > 5000) adminFails.clear();
  return { status: 401, error: "合言葉がちがいます。" };
}

async function handleAdmin(req, res, path, url) {
  const denied = adminCheck(req);
  if (denied) return json(res, denied.status, { error: denied.error });
  try {
    if (req.method === "GET" && path === "/api/admin/stats") return json(res, 200, await feedback.flagStats());
    if (req.method === "GET" && path === "/api/admin/flags") {
      const status = ["open", "fixed", "approved", "dismissed"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "open";
      return json(res, 200, { flags: await feedback.listFlags(status) });
    }
    if (req.method === "GET" && path === "/api/admin/glossary") return json(res, 200, { glossary: await feedback.listGlossary() });
    if (req.method !== "POST") return json(res, 405, { error: "使えない呼び出し方です。" });
    const body = await readJson(req);
    if (path === "/api/admin/flags/resolve") {
      const action = body.action === "dismiss" ? "dismiss" : "register";
      return json(res, 200, await feedback.resolveFlag(String(body.id || ""), { action, term: body.term, plain: body.plain, note: body.note }));
    }
    if (path === "/api/admin/glossary") {
      await feedback.upsertGlossary(body);
      return json(res, 200, { ok: true });
    }
    if (path === "/api/admin/glossary/active") {
      await feedback.setGlossaryActive(String(body.id || ""), Boolean(body.active));
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "見つかりません。" });
  } catch (error) {
    if (error instanceof SummarizeError || /入れてください|見つかりません/.test(error.message)) return json(res, 400, { error: error.message });
    console.error("[admin]", error);
    return json(res, 500, { error: "データベースにつながりませんでした。TURSO_DATABASE_URL と TURSO_AUTH_TOKEN を確認してください。" });
  }
}

async function handleApi(req, res, path, url) {
  if (path === "/api/health") return json(res, 200, { ok: true });
  if (path === "/api/status") return json(res, 200, { ai: aiEnabled(), model: aiEnabled() ? MODEL : "demo" });
  if (path.startsWith("/api/admin/")) return handleAdmin(req, res, path, url);

  if (req.method !== "POST") return json(res, 405, { error: "使えない呼び出し方です。" });
  if (!["/api/visit-summary", "/api/history-summary", "/api/daily-summary"].includes(path)) return json(res, 404, { error: "見つかりません。" });
  if (rateLimited(req)) return json(res, 429, { error: "続けて何度も押されました。1分ほど待ってから、もう一度お試しください。" });

  try {
    const body = await readJson(req);
    if (path === "/api/visit-summary") {
      const transcript = String(body.transcript || "").trim();
      if (transcript.length < 20) return json(res, 400, { error: "説明の内容を20文字以上入れてください。" });
      if (body.consent !== true) return json(res, 400, { error: "獣医師・スタッフの了承の確認が必要です。" });
      return json(res, 200, await summarizeVisit({ ...body, transcript }));
    }
    if (path === "/api/daily-summary") {
      if (!Array.isArray(body.days) || body.days.length === 0) return json(res, 400, { error: "まとめる日々の記録がありません。" });
      return json(res, 200, await summarizeDaily(body));
    }
    if (!Array.isArray(body.visits) || body.visits.length === 0) {
      return json(res, 400, { error: "まとめる受診の記録がありません。" });
    }
    return json(res, 200, await summarizeHistory(body));
  } catch (error) {
    if (error instanceof SummarizeError) return json(res, 400, { error: error.message });
    console.error(error);
    return json(res, 500, { error: "うまくいきませんでした。少し待ってから、もう一度お試しください。" });
  }
}

async function serveStatic(res, path) {
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
  let file = join(PUBLIC, rel || "index.html");
  if (!file.startsWith(PUBLIC + sep) && file !== PUBLIC) return send(res, 403, "Forbidden");
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(PUBLIC, "index.html"); // 画面の切り替えは # で行うので、ほかは最初の画面を返す
  }
  try {
    const body = await readFile(file);
    const type = TYPES[extname(file)] || "application/octet-stream";
    // 更新がすぐ届くよう、毎回新しいかを確かめてもらう
    send(res, 200, body, { "Content-Type": type, "Cache-Control": "no-cache" });
  } catch {
    send(res, 404, "Not Found");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  if (path.startsWith("/api/")) return handleApi(req, res, path, url);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed");
  return serveStatic(res, path);
}).listen(PORT, () => {
  console.log(`MediKataru for pet: http://localhost:${PORT}  (AI: ${aiEnabled() ? MODEL : "お試し表示"})`);
});
