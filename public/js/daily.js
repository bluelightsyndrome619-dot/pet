// 日々の記録
// - 1日1ページ：元気・食欲、日記、できごとの写真、ごはん・おやつ、サプリ・お薬、体重、飲んだ水、うんち、散歩（犬）
// - 入力すると自動で保存（保存ボタンなし）
// - 一覧と体重のグラフ
// - 「日々の経過のまとめ」：次の受診で獣医師に見せるため、期間の記録を AI がまとめる（数値の集計はアプリが計算）

import * as store from "./store.js";
import { h, $, $$, today, formatDate, formatShortDate, daysBetween, toast, confirmDialog, showLoading, list, section, usageText } from "./ui.js";

let ctx; // app.js から受け取る道具（avatar, back, notFound, photoFlow, postJson, go, petForAi, aiStatus, setCleanup, app）
export function initDaily(context) {
  ctx = context;
}

export const ENERGY = ["いつもどおり", "少し元気がない", "元気がない"];
export const APPETITE = ["完食", "少し残した", "半分くらい", "ほとんど食べない"];
export const STOOL = ["かため", "ふつう", "やわらかめ", "下痢", "出ていない"];
const isDog = (pet) => pet.species === "犬";

// ---------- 日付 ----------
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

// ---------- 1日分の記録 ----------
function emptyEntry(petId, date) {
  return {
    petId, date, energy: "", appetite: "", diary: "",
    foods: [], supplements: [], weight: "", water: "",
    stool: { state: "", count: "", blood: false }, walks: [],
  };
}

const cleanRows = (rows) => (rows || []).map((r) => ({ ...r, name: (r.name || "").trim(), amount: (r.amount || "").trim() })).filter((r) => r.name || r.amount);
const cleanWalks = (rows) => (rows || []).map((r) => ({ minutes: String(r.minutes || "").trim(), memo: (r.memo || "").trim() })).filter((r) => r.minutes || r.memo);

export function isEmptyEntry(e) {
  return (
    !e.energy && !e.appetite && !(e.diary || "").trim() && !cleanRows(e.foods).length && !cleanRows(e.supplements).length &&
    !String(e.weight || "").trim() && !String(e.water || "").trim() &&
    !e.stool?.state && !String(e.stool?.count || "").trim() && !e.stool?.blood && !cleanWalks(e.walks).length
  );
}

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const round1 = (n) => Math.round(n * 10) / 10;
const walkMinutes = (e) => cleanWalks(e.walks).reduce((s, w) => s + (num(w.minutes) || 0), 0);

/** 一覧などに出す、1日分の短い説明 */
function entryBadges(e, pet) {
  const b = [];
  if (e.energy) b.push(`元気：${e.energy}`);
  if (e.appetite) b.push(`食欲：${e.appetite}`);
  if (num(e.weight) !== null) b.push(`⚖ ${num(e.weight)}kg`);
  if (num(e.water) !== null) b.push(`💧 ${num(e.water)}ml`);
  if (e.stool?.state) b.push(`💩 ${e.stool.state}${num(e.stool.count) ? `×${num(e.stool.count)}` : ""}${e.stool.blood ? "（血・粘液）" : ""}`);
  if (isDog(pet) && cleanWalks(e.walks).length) b.push(`🐕 ${cleanWalks(e.walks).length}回・${walkMinutes(e)}分`);
  return b;
}
const warnState = (e) =>
  (e.energy && e.energy !== "いつもどおり") || ["半分くらい", "ほとんど食べない"].includes(e.appetite) || ["下痢", "出ていない"].includes(e.stool?.state) || e.stool?.blood;

// ---------- 集計（アプリが計算する。AI にもこの値を渡す） ----------
export function computeStats(days, from, to, pet) {
  const inRange = days.filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  const weights = inRange.filter((d) => num(d.weight) !== null).map((d) => ({ date: d.date, kg: num(d.weight) }));
  const waters = inRange.filter((d) => num(d.water) !== null).map((d) => num(d.water));
  const stoolDays = {};
  for (const d of inRange) if (d.stool?.state) stoolDays[d.stool.state] = (stoolDays[d.stool.state] || 0) + 1;
  const walkDays = inRange.filter((d) => cleanWalks(d.walks).length);
  const latestWith = (key) => [...inRange].reverse().find((d) => cleanRows(d[key]).length);
  return {
    periodDays: (daysBetween(from, to) ?? 0) + 1,
    recordedDays: inRange.length,
    weight: weights.length
      ? { first: weights[0], last: weights[weights.length - 1], min: Math.min(...weights.map((w) => w.kg)), max: Math.max(...weights.map((w) => w.kg)), count: weights.length, change: Math.round((weights[weights.length - 1].kg - weights[0].kg) * 100) / 100 }
      : null,
    water: waters.length ? { avg: Math.round(waters.reduce((a, b) => a + b, 0) / waters.length), min: Math.min(...waters), max: Math.max(...waters), days: waters.length } : null,
    stoolDays,
    bloodDays: inRange.filter((d) => d.stool?.blood).map((d) => d.date),
    lowEnergyDays: inRange.filter((d) => d.energy && d.energy !== "いつもどおり").map((d) => `${d.date}（${d.energy}）`),
    lowAppetiteDays: inRange.filter((d) => d.appetite && d.appetite !== "完食").map((d) => `${d.date}（${d.appetite}）`),
    walks: isDog(pet) && walkDays.length
      ? { days: walkDays.length, avgTimesPerDay: round1(walkDays.reduce((s, d) => s + cleanWalks(d.walks).length, 0) / walkDays.length), avgMinutesPerDay: Math.round(walkDays.reduce((s, d) => s + walkMinutes(d), 0) / walkDays.length) }
      : null,
    currentFoods: cleanRows(latestWith("foods")?.foods).map((r) => [r.name, r.amount].filter(Boolean).join(" ")),
    currentSupplements: cleanRows(latestWith("supplements")?.supplements).map((r) => [r.name, r.amount].filter(Boolean).join(" ")),
  };
}

// ---------- 体重のグラフ（1本の線。数値の一覧もつける） ----------
export function weightChart(points, { id = "wc" } = {}) {
  if (points.length < 2) return "";
  const W = 360, H = 190, L = 44, R = 14, T = 16, B = 30;
  const xs = points.map((p) => new Date(p.date).getTime());
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...points.map((p) => p.kg)), y1 = Math.max(...points.map((p) => p.kg));
  const pad = Math.max((y1 - y0) * 0.25, 0.2);
  y0 = Math.max(0, y0 - pad);
  y1 = y1 + pad;
  const X = (t) => L + ((t - x0) / Math.max(x1 - x0, 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const ticks = [0, 0.5, 1].map((f) => y0 + (y1 - y0) * f);
  const pts = points.map((p, i) => ({ ...p, x: X(xs[i]), y: Y(p.kg) }));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return `
    <figure class="wc" id="${id}">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="体重の変化：${h(points[0].date)} ${points[0].kg}kg から ${h(points[points.length - 1].date)} ${points[points.length - 1].kg}kg">
        ${ticks
          .map(
            (v) => `<line class="wc-grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>
                    <text class="wc-label" x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${round1(v)}</text>`,
          )
          .join("")}
        <text class="wc-label" x="${L}" y="${H - 8}" text-anchor="start">${formatShortDate(points[0].date)}</text>
        <text class="wc-label" x="${W - R}" y="${H - 8}" text-anchor="end">${formatShortDate(points[points.length - 1].date)}</text>
        <line class="wc-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
        <path class="wc-line" d="${path}"/>
        ${pts.map((p) => `<circle class="wc-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"/>`).join("")}
        <rect class="wc-hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>
      </svg>
      <div class="wc-tip" role="status" hidden></div>
      <figcaption class="muted small">単位：kg ・ グラフを押すと、その日の体重が出ます</figcaption>
    </figure>
    <details class="wc-table"><summary>数値で見る（${points.length}件）</summary>
      <ul class="kv-list">${[...points].reverse().map((p) => `<li><span>${formatDate(p.date)}</span><b>${p.kg} kg</b></li>`).join("")}</ul>
    </details>`;
}

export function bindWeightChart(root, points) {
  const fig = root?.querySelector(".wc");
  if (!fig) return;
  const svg = fig.querySelector("svg");
  const tip = fig.querySelector(".wc-tip");
  const cross = fig.querySelector(".wc-cross");
  const dots = [...fig.querySelectorAll(".wc-dot")];
  const show = (ev) => {
    const box = svg.getBoundingClientRect();
    const vx = ((ev.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
    let best = 0;
    dots.forEach((d, i) => {
      if (Math.abs(d.cx.baseVal.value - vx) < Math.abs(dots[best].cx.baseVal.value - vx)) best = i;
    });
    const d = dots[best];
    dots.forEach((x, i) => x.classList.toggle("is-active", i === best));
    cross.setAttribute("x1", d.cx.baseVal.value);
    cross.setAttribute("x2", d.cx.baseVal.value);
    cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = `${formatShortDate(points[best].date)}　${points[best].kg} kg`;
    const px = (d.cx.baseVal.value / svg.viewBox.baseVal.width) * box.width;
    tip.classList.toggle("is-left", px > box.width * 0.6);
    tip.classList.toggle("is-right", px < box.width * 0.25);
    tip.style.left = `${Math.round(px)}px`; // CSSOM での指定は CSP の対象外
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
    dots.forEach((x) => x.classList.remove("is-active"));
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}

// ============================================================
// 1日のページ（入力すると自動で保存）
// ============================================================
export async function viewDaily(petId, query) {
  const pet = await store.getPet(petId);
  if (!pet) return ctx.notFound();
  const date = validDate(query.get("date")) && query.get("date") <= today() ? query.get("date") : today();
  const all = await store.listDaily(petId);
  const saved = all.find((d) => d.date === date);
  let entry = saved ? structuredClone(saved) : emptyEntry(pet.id, date);
  entry.stool ||= { state: "", count: "", blood: false };
  const prev = all.filter((d) => d.date < date); // 新しい順
  const prevWeight = prev.find((d) => num(d.weight) !== null);
  const prevFoods = prev.find((d) => cleanRows(d.foods).length || cleanRows(d.supplements).length);
  const dayPhotos = async () => (await store.listPhotos(pet.id)).filter((p) => p.date === date).reverse();
  document.title = `日々の記録 ${formatShortDate(date)} | ${pet.name}`;

  const chips = (field, options) =>
    `<div class="choice-chips" role="group" aria-label="${field === "energy" ? "元気" : field === "appetite" ? "食欲" : "うんちの状態"}">${options
      .map((o) => `<button type="button" class="chip-btn" data-chip="${field}" data-value="${h(o)}" aria-pressed="false">${h(o)}</button>`)
      .join("")}</div>`;

  ctx.app.innerHTML = `
    ${ctx.back(`#/pet/${pet.id}/days`, "日々の記録の一覧へ")}
    <h1 class="with-avatar">${ctx.avatar(pet, "avatar-sm")}<span>${h(pet.name)}の日々の記録</span></h1>

    <nav class="day-nav" aria-label="日付を選ぶ">
      <a class="btn btn-sm" href="#/pet/${pet.id}/daily?date=${addDays(date, -1)}" aria-label="前の日">‹ 前の日</a>
      <label class="day-picker">
        <span class="day-picker-label"><b>${formatShortDate(date).replace("/", "月").replace("（", "日（")}</b><small>${date.slice(0, 4)}年${date === today() ? "・今日" : ""} ▾</small></span>
        <input type="date" id="day-date" value="${date}" max="${today()}" aria-label="日付を選ぶ">
      </label>
      ${
        date < today()
          ? `<a class="btn btn-sm" href="#/pet/${pet.id}/daily?date=${addDays(date, 1)}" aria-label="次の日">次の日 ›</a>`
          : `<span class="btn btn-sm is-placeholder" aria-hidden="true">次の日 ›</span>`
      }
    </nav>
    <p class="save-status muted small" id="save-status" role="status">入力すると、自動で保存されます</p>

    <form id="daily-form" class="daily-form" novalidate>
      ${section({
        icon: "🐾",
        title: "今日のようす",
        body: `
          <p class="field-label">元気</p>${chips("energy", ENERGY)}
          <p class="field-label">食欲</p>${chips("appetite", APPETITE)}
          <label for="diary" class="field-label">日記・気になったこと <span class="hint">吐いた・かゆがった・いつもとちがう様子なども</span></label>
          <textarea id="diary" name="diary" rows="4" maxlength="2000" placeholder="例：朝の散歩で元気に走った。夜に後ろ足をよくなめていた。">${h(entry.diary)}</textarea>`,
      })}

      ${section({
        icon: "📷",
        title: "できごとの写真",
        body: `<div id="day-photos"></div>
          <button type="button" class="btn btn-accent btn-wide" id="day-photo">📷 写真を撮る</button>`,
      })}

      ${section({
        icon: "🍚",
        title: "ごはん・おやつ",
        body: `<div class="rows" id="rows-foods"></div>
          <div class="row-actions">
            <button type="button" class="btn btn-sm" data-add="foods">＋ 追加</button>
            ${prevFoods ? `<button type="button" class="btn btn-sm btn-ghost" id="copy-prev">前の記録（${formatShortDate(prevFoods.date)}）と同じにする</button>` : ""}
          </div>`,
      })}

      ${section({
        icon: "💊",
        title: "サプリメント・飲んでいるお薬",
        body: `<div class="rows" id="rows-supplements"></div>
          <div class="row-actions"><button type="button" class="btn btn-sm" data-add="supplements">＋ 追加</button></div>`,
      })}

      <div class="grid-2">
        ${section({
          icon: "⚖️",
          title: "体重",
          body: `<div class="unit-input"><input id="weight" name="weight" inputmode="decimal" autocomplete="off" placeholder="例：8.2" value="${h(entry.weight)}" aria-label="体重（kg）"><span>kg</span></div>
            ${prevWeight ? `<p class="hint">前回 ${num(prevWeight.weight)}kg（${formatShortDate(prevWeight.date)}）</p>` : ""}`,
        })}
        ${section({
          icon: "💧",
          title: "飲んだ水",
          body: `<div class="unit-input"><input id="water" name="water" inputmode="numeric" autocomplete="off" placeholder="例：350" value="${h(entry.water)}" aria-label="飲んだ水（ml）"><span>ml</span></div>
            <div class="row-actions"><button type="button" class="btn btn-sm" data-water="50">＋50</button><button type="button" class="btn btn-sm" data-water="100">＋100</button></div>
            <p class="hint">わからないときは空欄で大丈夫です</p>`,
        })}
      </div>

      ${section({
        icon: "💩",
        title: "うんち",
        body: `${chips("stool", STOOL)}
          <div class="stool-more">
            <div class="stepper" role="group" aria-label="回数">
              <span class="field-label">回数</span>
              <button type="button" class="btn btn-sm" data-step="-1" aria-label="1回へらす">−</button>
              <output id="stool-count">${num(entry.stool.count) ?? 0}</output><span>回</span>
              <button type="button" class="btn btn-sm" data-step="1" aria-label="1回ふやす">＋</button>
            </div>
            <label class="check-inline"><input type="checkbox" id="stool-blood" ${entry.stool.blood ? "checked" : ""}> 血や粘液（ねばねば）が混じる</label>
          </div>`,
      })}

      ${
        isDog(pet)
          ? section({
              icon: "🐕",
              title: "散歩",
              body: `<div class="rows" id="rows-walks"></div>
                <div class="row-actions"><button type="button" class="btn btn-sm" data-add="walks">＋ 散歩を追加</button><span class="muted small" id="walk-total"></span></div>`,
            })
          : ""
      }
    </form>

    <div class="stack no-print">
      <a class="btn btn-primary btn-wide" href="#/pet/${pet.id}/report">✨ 日々の経過をまとめる（受診用）</a>
      <button type="button" class="btn btn-danger-ghost" id="delete-day">この日の記録を消す</button>
    </div>`;

  // ---- 行（ごはん・サプリ・散歩） ----
  function rowHtml(kind, r, i) {
    if (kind === "walks") {
      return `<div class="row row-walk" data-row="${kind}" data-i="${i}">
        <div class="unit-input"><input data-k="minutes" inputmode="numeric" placeholder="30" value="${h(r.minutes)}" aria-label="散歩${i + 1}の時間（分）"><span>分</span></div>
        <input data-k="memo" placeholder="例：朝・公園" value="${h(r.memo)}" aria-label="散歩${i + 1}のメモ">
        <button type="button" class="row-del" data-del="${kind}" data-i="${i}" aria-label="散歩${i + 1}を消す">✕</button>
      </div>`;
    }
    const label = kind === "foods" ? "ごはん" : "サプリ・お薬";
    return `<div class="row" data-row="${kind}" data-i="${i}">
      <input data-k="name" placeholder="${kind === "foods" ? "例：○○ドライフード" : "例：関節用サプリ"}" value="${h(r.name)}" aria-label="${label}${i + 1}の名前">
      <input data-k="amount" placeholder="${kind === "foods" ? "例：朝夕 各60g" : "例：1日1粒"}" value="${h(r.amount)}" aria-label="${label}${i + 1}の量">
      <button type="button" class="row-del" data-del="${kind}" data-i="${i}" aria-label="${label}${i + 1}を消す">✕</button>
    </div>`;
  }
  function paintRows(kind) {
    const box = $(`#rows-${kind}`);
    if (!box) return;
    if (!entry[kind].length) entry[kind] = kind === "walks" ? [{ minutes: "", memo: "" }] : [{ name: "", amount: "" }];
    box.innerHTML = entry[kind].map((r, i) => rowHtml(kind, r, i)).join("");
    if (kind === "walks") $("#walk-total").textContent = walkMinutes(entry) ? `合計 ${walkMinutes(entry)}分` : "";
  }
  function paintChips() {
    $$("[data-chip]").forEach((b) => {
      const v = b.dataset.chip === "stool" ? entry.stool.state : entry[b.dataset.chip];
      b.setAttribute("aria-pressed", String(v === b.dataset.value));
    });
  }
  async function paintPhotos() {
    const ps = await dayPhotos();
    $("#day-photos").innerHTML = ps.length
      ? `<ul class="photo-strip">${ps
          .map((p) => `<li><a class="photo-thumb" href="#/pet/${pet.id}/photos?open=${p.id}"><img src="${h(p.thumb)}" alt="${h(`${p.part} ${p.memo}`)}"><span class="photo-cap">${h(p.part)}</span></a></li>`)
          .join("")}</ul>`
      : `<p class="muted small">この日の写真はまだありません。</p>`;
  }

  // ---- 保存（入力のたびに少し待ってから） ----
  let timer = null;
  let dirty = false;
  function readForm() {
    entry.diary = $("#diary").value;
    entry.weight = $("#weight").value.trim();
    entry.water = $("#water").value.trim();
    entry.stool.blood = $("#stool-blood").checked;
    for (const kind of ["foods", "supplements", "walks"]) {
      $$(`[data-row="${kind}"]`).forEach((row) => {
        const r = entry[kind][Number(row.dataset.i)];
        if (r) row.querySelectorAll("[data-k]").forEach((inp) => (r[inp.dataset.k] = inp.value));
      });
    }
    if (isDog(pet)) $("#walk-total").textContent = walkMinutes(entry) ? `合計 ${walkMinutes(entry)}分` : "";
  }
  async function saveNow() {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    const clean = {
      ...entry,
      foods: cleanRows(entry.foods),
      supplements: cleanRows(entry.supplements),
      walks: isDog(pet) ? cleanWalks(entry.walks) : [],
      stool: { ...entry.stool, count: entry.stool.count === "" ? "" : String(entry.stool.count) },
      createdAt: entry.createdAt || new Date().toISOString(),
    };
    if (isEmptyEntry(clean)) {
      await store.deleteDaily(pet.id, date);
      $("#save-status") && ($("#save-status").textContent = "入力すると、自動で保存されます");
      return;
    }
    const savedEntry = await store.saveDaily(clean);
    entry.createdAt = savedEntry.createdAt;
    const t = new Date();
    if ($("#save-status")) $("#save-status").textContent = `✓ 保存しました（${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}）`;
  }
  const changed = () => {
    dirty = true;
    if ($("#save-status")) $("#save-status").textContent = "保存しています…";
    clearTimeout(timer);
    timer = setTimeout(saveNow, 600);
  };
  // 画面を移るとき・アプリを閉じるときは、待たずに保存する
  const flush = () => {
    if (!$("#daily-form")) return;
    readForm();
    saveNow();
  };
  const onHide = () => document.visibilityState === "hidden" && flush();
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", flush);
  ctx.setCleanup(() => {
    flush();
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", flush);
  });

  const form = $("#daily-form");
  form.addEventListener("input", () => {
    readForm();
    changed();
  });
  form.addEventListener("change", () => {
    readForm();
    changed();
  });
  form.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    readForm();
    if (t.dataset.chip) {
      const f = t.dataset.chip;
      const cur = f === "stool" ? entry.stool.state : entry[f];
      const next = cur === t.dataset.value ? "" : t.dataset.value; // もう一度押すと外れる
      if (f === "stool") {
        entry.stool.state = next;
        if (next && next !== "出ていない" && !num(entry.stool.count)) entry.stool.count = "1";
        if (next === "出ていない") entry.stool.count = "0";
        $("#stool-count").textContent = num(entry.stool.count) ?? 0;
      } else entry[f] = next;
      paintChips();
    } else if (t.dataset.add) {
      const k = t.dataset.add;
      entry[k].push(k === "walks" ? { minutes: "", memo: "" } : { name: "", amount: "" });
      paintRows(k);
      $(`#rows-${k} .row:last-child input`)?.focus();
    } else if (t.dataset.del) {
      const k = t.dataset.del;
      entry[k].splice(Number(t.dataset.i), 1);
      paintRows(k);
    } else if (t.dataset.water) {
      entry.water = String((num(entry.water) || 0) + Number(t.dataset.water));
      $("#water").value = entry.water;
    } else if (t.dataset.step) {
      entry.stool.count = String(Math.max(0, (num(entry.stool.count) || 0) + Number(t.dataset.step)));
      $("#stool-count").textContent = entry.stool.count;
    } else if (t.id === "copy-prev") {
      entry.foods = structuredClone(cleanRows(prevFoods.foods));
      entry.supplements = structuredClone(cleanRows(prevFoods.supplements));
      paintRows("foods");
      paintRows("supplements");
      toast("前の記録のごはん・サプリを入れました");
    } else return;
    changed();
  });

  $("#day-date").addEventListener("change", (e) => {
    if (validDate(e.target.value)) ctx.go(`#/pet/${pet.id}/daily?date=${e.target.value}`);
  });
  $("#day-photo").onclick = async () => {
    const photo = await ctx.photoFlow(pet, { date, part: "できごと" });
    if (photo) paintPhotos();
  };
  $("#delete-day").onclick = async () => {
    const ok = await confirmDialog({
      title: `${formatShortDate(date)}の記録を消しますか？`,
      message: "消すと元にもどせません。写真は消えずに「写真の記録」に残ります。",
      ok: "消す",
      danger: true,
    });
    if (!ok) return;
    dirty = false;
    clearTimeout(timer);
    await store.deleteDaily(pet.id, date);
    toast("消しました");
    ctx.go(`#/pet/${pet.id}/days`);
  };

  paintChips();
  paintRows("foods");
  paintRows("supplements");
  if (isDog(pet)) paintRows("walks");
  paintPhotos();
  if (saved) $("#save-status").textContent = "保存済みの記録です。直すと自動で保存されます";
}

// ============================================================
// 日々の記録の一覧
// ============================================================
export async function viewDays(petId) {
  const pet = await store.getPet(petId);
  if (!pet) return ctx.notFound();
  const days = await store.listDaily(petId);
  const todayEntry = days.find((d) => d.date === today());
  const weights = [...days].reverse().filter((d) => num(d.weight) !== null).map((d) => ({ date: d.date, kg: num(d.weight) })).slice(-60);
  document.title = `日々の記録 | ${pet.name}`;

  ctx.app.innerHTML = `
    ${ctx.back(`#/pet/${pet.id}`, `${pet.name}のページにもどる`)}
    <h1 class="with-avatar">${ctx.avatar(pet, "avatar-sm")}<span>${h(pet.name)}の日々の記録</span></h1>

    <div class="action-grid">
      <a class="btn btn-primary btn-big" href="#/pet/${pet.id}/daily">
        <span class="btn-icon" aria-hidden="true">📔</span>
        <span>${todayEntry ? "今日の記録を見る・直す" : "今日の記録をつける"}<span class="btn-sub">ごはん・体重・うんち${isDog(pet) ? "・散歩" : ""}など</span></span>
      </a>
      <a class="btn btn-accent btn-big" href="#/pet/${pet.id}/report">
        <span class="btn-icon" aria-hidden="true">✨</span>
        <span>日々の経過をまとめる<span class="btn-sub">次の受診で獣医師に見せる</span></span>
      </a>
    </div>

    ${weights.length >= 2 ? section({ icon: "⚖️", title: "体重の変化", body: weightChart(weights, { id: "wc-days" }) }) : ""}

    <section class="block">
      <h2 class="list-heading">記録した日 <span class="muted small">（${days.length}日）</span></h2>
      ${
        days.length
          ? `<ul class="day-list">${days
              .slice(0, 120)
              .map(
                (d) => `<li><a class="day-card ${warnState(d) ? "is-warn" : ""}" href="#/pet/${pet.id}/daily?date=${d.date}">
                  <span class="visit-date"><b>${formatShortDate(d.date)}</b><span>${d.date.slice(0, 4)}</span></span>
                  <span class="day-body">
                    <span class="day-badges">${entryBadges(d, pet).map((b) => `<span class="chip">${h(b)}</span>`).join("") || `<span class="muted small">日記のみ</span>`}</span>
                    ${d.diary ? `<span class="muted small clamp-2">${h(d.diary)}</span>` : ""}
                  </span>
                  <span class="go" aria-hidden="true">›</span>
                </a></li>`,
              )
              .join("")}</ul>`
          : `<p class="notice">まだ記録がありません。「今日の記録をつける」から始められます。毎日でなくても、気づいたときだけで大丈夫です。</p>`
      }
    </section>`;
  bindWeightChart(ctx.app, weights);
}

// ============================================================
// 日々の経過のまとめ（受診用）
// ============================================================
const RANGES = [
  { key: "visit", label: "前回の受診から" },
  { key: "7", label: "7日間" },
  { key: "14", label: "14日間" },
  { key: "30", label: "30日間" },
];

export async function viewReport(petId, query) {
  const pet = await store.getPet(petId);
  if (!pet) return ctx.notFound();
  const [days, visits, photos, saved] = await Promise.all([
    store.listDaily(petId),
    store.listVisits(petId),
    store.listPhotos(petId),
    store.getDailySummary(petId),
  ]);
  const lastVisit = visits.find((v) => v.date <= today());
  const to = today();
  let key = query.get("range");
  if (!RANGES.some((r) => r.key === key) || (key === "visit" && !lastVisit)) {
    key = saved?.rangeKey && (saved.rangeKey !== "visit" || lastVisit) ? saved.rangeKey : lastVisit && daysBetween(lastVisit.date, to) <= 120 ? "visit" : "14";
  }
  const from = key === "visit" ? lastVisit.date : addDays(to, -(Number(key) - 1));
  const inRange = days.filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  const rangePhotos = photos.filter((p) => p.date >= from && p.date <= to && p.memo);
  const stats = computeStats(days, from, to, pet);
  const dataKey = `${from}|${to}|${inRange.map((d) => d.updatedAt).join(",")}|${rangePhotos.length}`;
  const current = saved && saved.from === from && saved.to === to ? saved : null;
  const fresh = current && current.dataKey === dataKey;
  const weights = inRange.filter((d) => num(d.weight) !== null).map((d) => ({ date: d.date, kg: num(d.weight) }));
  document.title = `日々の経過のまとめ | ${pet.name}`;

  const statRows = [
    ["記録した日", `${stats.recordedDays}日 / ${stats.periodDays}日`],
    stats.weight && ["体重", `${stats.weight.first.kg}kg → ${stats.weight.last.kg}kg（${stats.weight.change > 0 ? "+" : ""}${stats.weight.change}kg）`],
    stats.water && ["飲んだ水", `平均 ${stats.water.avg}ml/日（${stats.water.min}〜${stats.water.max}ml・${stats.water.days}日分）`],
    Object.keys(stats.stoolDays).length && ["うんち", Object.entries(stats.stoolDays).map(([k, v]) => `${k} ${v}日`).join("・") + (stats.bloodDays.length ? `・血や粘液 ${stats.bloodDays.length}日` : "")],
    stats.lowEnergyDays.length && ["元気がない日", `${stats.lowEnergyDays.length}日`],
    stats.lowAppetiteDays.length && ["食べ残した日", `${stats.lowAppetiteDays.length}日`],
    stats.walks && ["散歩", `平均 ${stats.walks.avgTimesPerDay}回・${stats.walks.avgMinutesPerDay}分/日`],
    stats.currentFoods.length && ["今のごはん", stats.currentFoods.join("、")],
    stats.currentSupplements.length && ["サプリ・お薬", stats.currentSupplements.join("、")],
  ].filter(Boolean);

  ctx.app.innerHTML = `
    ${ctx.back(`#/pet/${pet.id}/days`, "日々の記録の一覧へ")}
    <div class="page-head">
      <p class="muted small meta-line">${ctx.avatar(pet, "avatar-xs")}<span>${h(pet.name)}</span></p>
      <h1>日々の経過のまとめ</h1>
      <p class="muted">${formatDate(from)} 〜 ${formatDate(to)}${key === "visit" ? `（前回の受診：${h(lastVisit.title)}）` : ""}</p>
    </div>

    <div class="filter-chips no-print" role="group" aria-label="まとめる期間">
      ${RANGES.filter((r) => r.key !== "visit" || lastVisit)
        .map((r) => `<a class="chip-btn" href="#/pet/${pet.id}/report?range=${r.key}" aria-pressed="${r.key === key}">${r.label}</a>`)
        .join("")}
    </div>

    ${section({
      icon: "📊",
      title: "記録の数字（アプリが計算）",
      body: inRange.length
        ? `<ul class="kv-list">${statRows.map(([k, v]) => `<li><span>${h(k)}</span><b>${h(v)}</b></li>`).join("")}</ul>`
        : `<p class="notice">この期間の記録がありません。期間を変えるか、「今日の記録をつける」から記録してください。</p>`,
    })}

    ${weights.length >= 2 ? section({ icon: "⚖️", title: "体重の変化", body: weightChart(weights, { id: "wc-report" }) }) : ""}

    <section class="card headline-card no-print">
      ${
        current
          ? `<p class="muted small">${fresh ? "この期間の最新の記録でまとめています" : "⚠ まとめた後に記録が変わりました。まとめ直すと最新になります"}（${formatDate(current.updatedAt.slice(0, 10))}作成）</p>`
          : `<p>この期間の記録（${inRange.length}日分）と写真のメモをもとに、AIが受診用のまとめを作ります。</p>`
      }
      <div class="alert alert-error" role="alert" id="rep-error" hidden></div>
      <button type="button" class="btn ${current && fresh ? "" : "btn-primary"} btn-wide" id="make-report" ${inRange.length ? "" : "disabled"}>
        ✨ ${current ? "最新の記録でまとめ直す" : "AIでまとめる"}
      </button>
    </section>

    <div id="report-body"></div>
    <div id="report-share"></div>`;

  bindWeightChart(ctx.app, weights);

  function paintResult(sum) {
    const r = sum.result;
    $("#report-body").innerHTML = `
      <section class="card headline-card"><p class="headline">${h(r.overview)}</p></section>
      ${r.events.length ? section({ icon: "🗓", title: "伝えたいできごと", body: `<ol class="timeline timeline-plain">${r.events.map((e) => `<li><span class="tl-date">${h(e.date)}</span><span>${h(e.event)}</span></li>`).join("")}</ol>`, tone: "warn-card" }) : ""}
      <section class="card section-card">
        <h2 class="section-title"><span class="section-icon" aria-hidden="true">🩺</span>項目ごとの様子</h2>
        <dl class="report-dl">
          ${[["元気・食欲", r.energy_appetite], ["体重", r.weight], ["飲んだ水", r.water], ["うんち", r.stool], ["ごはん・サプリ", r.food_supplements], ...(isDog(pet) ? [["散歩", r.walks]] : [])]
            .map(([k, v]) => `<div><dt>${h(k)}</dt><dd>${h(v)}</dd></div>`)
            .join("")}
        </dl>
      </section>
      ${r.questions_for_vet.length ? section({ icon: "❓", title: "獣医師に聞いてみること", body: list(r.questions_for_vet) }) : ""}
      <p class="notice">これはAIがご家族の記録をまとめたものです。まちがいが入ることがあります。診察のときは、気になることを直接獣医師に伝えてください。</p>
      <p class="muted small usage">${h(usageText(sum))}</p>`;

    const text = [
      `【MediKataru for pet】${pet.name}の日々の経過（${formatDate(from)}〜${formatDate(to)}）`,
      [pet.species, pet.breed].filter(Boolean).join("・"),
      "",
      r.overview,
      "",
      "■ 記録の数字",
      ...statRows.map(([k, v]) => `・${k}：${v}`),
      "",
      ...(r.events.length ? ["■ 伝えたいできごと", ...r.events.map((e) => `・${e.date} ${e.event}`), ""] : []),
      "■ 項目ごとの様子",
      `・元気・食欲：${r.energy_appetite}`,
      `・体重：${r.weight}`,
      `・飲んだ水：${r.water}`,
      `・うんち：${r.stool}`,
      `・ごはん・サプリ：${r.food_supplements}`,
      ...(isDog(pet) ? [`・散歩：${r.walks}`] : []),
      "",
      ...(r.questions_for_vet.length ? ["■ 獣医師に聞いてみること", ...r.questions_for_vet.map((q) => `・${q}`), ""] : []),
      "※AIがご家族の記録をまとめたものです。まちがいが入ることがあります。",
    ].join("\n");
    $("#report-share").innerHTML = `
      <section class="card no-print">
        <h2 class="section-title"><span class="section-icon" aria-hidden="true">🏥</span>病院で見せる・送る</h2>
        <p class="muted">診察のときに、この画面をそのまま見せるか、印刷して持っていけます。家族にも送れます。</p>
        <div class="stack-sm">
          <button type="button" class="btn btn-primary btn-wide" id="rep-print">🖨 印刷する</button>
          <a class="btn btn-big btn-line" id="rep-line" target="_blank" rel="noreferrer" href="https://line.me/R/share?text=${encodeURIComponent(text)}">
            <span class="btn-icon" aria-hidden="true">💬</span><span>LINEで送る<span class="btn-sub">送る相手は LINE の画面で選びます</span></span>
          </a>
          <button type="button" class="btn btn-wide" id="rep-copy">📋 文章をコピーする</button>
        </div>
      </section>`;
    $("#rep-print").onclick = () => window.print();
    $("#rep-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast("コピーしました");
      } catch {
        toast("コピーできませんでした");
      }
    };
  }
  if (current) paintResult(current);

  $("#make-report").onclick = async () => {
    const payload = {
      pet: ctx.petForAi(pet),
      from,
      to,
      stats,
      lastVisit: lastVisit
        ? { date: lastVisit.date, title: lastVisit.title, diagnosis: lastVisit.record?.diagnosis, medications: lastVisit.record?.medications, next_visit: lastVisit.record?.next_visit }
        : null,
      days: inRange.map((d) => ({
        date: d.date,
        energy: d.energy || undefined,
        appetite: d.appetite || undefined,
        diary: d.diary || undefined,
        foods: cleanRows(d.foods).length ? cleanRows(d.foods) : undefined,
        supplements: cleanRows(d.supplements).length ? cleanRows(d.supplements) : undefined,
        weight_kg: num(d.weight) ?? undefined,
        water_ml: num(d.water) ?? undefined,
        stool: d.stool?.state ? d.stool : undefined,
        walks: isDog(pet) && cleanWalks(d.walks).length ? cleanWalks(d.walks) : undefined,
        photo_memos: rangePhotos.filter((p) => p.date === d.date).map((p) => `${p.part}：${p.memo}`),
      })),
    };
    // 写真のメモだけの日も入れる
    for (const p of rangePhotos) {
      if (!payload.days.some((d) => d.date === p.date)) payload.days.push({ date: p.date, photo_memos: [`${p.part}：${p.memo}`] });
    }
    payload.days.sort((a, b) => a.date.localeCompare(b.date));

    const hide = showLoading("日々の経過をまとめています", `${inRange.length}日分の記録を読みこんでいます。<br>30秒から1分ほど、お待ちください。`);
    $("#rep-error").hidden = true;
    try {
      const st = ctx.aiStatus();
      const out = st.server ? await ctx.postJson("/api/daily-summary", payload) : localDemo(payload.days);
      const sum = await store.saveDailySummary({
        petId: pet.id, from, to, rangeKey: key, dataKey, result: out.result,
        model: out.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens, updatedAt: new Date().toISOString(),
      });
      hide();
      paintResult(sum);
      $("#make-report").textContent = "✨ 最新の記録でまとめ直す";
      $("#make-report").classList.remove("btn-primary");
      $("#report-body").scrollIntoView({ behavior: "smooth", block: "start" });
      toast("日々の経過をまとめました");
    } catch (e) {
      hide();
      $("#rep-error").hidden = false;
      $("#rep-error").textContent = e.message;
    }
  };
}

function localDemo(days) {
  return {
    result: {
      overview: `【お試し表示】AIにつながっていないため、まとめは行われていません。記録は${days.length}日分あります。`,
      energy_appetite: "記録なし", weight: "記録なし", water: "記録なし", stool: "記録なし", food_supplements: "記録なし", walks: "記録なし",
      events: [], questions_for_vet: [],
    },
    model: "demo (サーバーなし)", inputTokens: 0, outputTokens: 0,
  };
}

// ============================================================
// ペットのページに出す「日々の記録」の欄
// ============================================================
export async function dailySectionHtml(pet) {
  const days = await store.listDaily(pet.id);
  const recent = days.slice(0, 4);
  return `
    <section class="block">
      <div class="spread">
        <h2 class="list-heading">日々の記録 <span class="muted small">（${days.length}日）</span></h2>
        ${days.length ? `<a class="text-link" href="#/pet/${pet.id}/days">すべて見る ›</a>` : ""}
      </div>
      ${
        recent.length
          ? `<ul class="day-list">${recent
              .map(
                (d) => `<li><a class="day-card ${warnState(d) ? "is-warn" : ""}" href="#/pet/${pet.id}/daily?date=${d.date}">
                  <span class="visit-date"><b>${formatShortDate(d.date)}</b><span>${d.date.slice(0, 4)}</span></span>
                  <span class="day-body"><span class="day-badges">${entryBadges(d, pet).slice(0, 4).map((b) => `<span class="chip">${h(b)}</span>`).join("") || `<span class="muted small">日記のみ</span>`}</span>
                  ${d.diary ? `<span class="muted small clamp-2">${h(d.diary)}</span>` : ""}</span>
                  <span class="go" aria-hidden="true">›</span>
                </a></li>`,
              )
              .join("")}</ul>
            <a class="history-banner" href="#/pet/${pet.id}/report">
              <span class="history-banner-icon" aria-hidden="true">✨</span>
              <span><b>日々の経過をまとめる（受診用）</b><br><span class="muted small">次の受診で獣医師に見せられます</span></span>
              <span class="go" aria-hidden="true">›</span>
            </a>`
          : `<p class="muted">ごはん・体重・うんち${isDog(pet) ? "・散歩" : ""}・日記などを毎日（気づいたときだけでも）残しておくと、次の受診でAIがまとめて獣医師に見せられます。</p>`
      }
    </section>`;
}
