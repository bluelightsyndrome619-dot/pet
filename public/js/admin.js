// 管理者（医師）用の画面：AI が言い換えに迷ったところを確認し、正しい言い換えを「用語辞書」に登録する
// - 合言葉（サーバーの ADMIN_PASSWORD）で開く。合言葉はこのタブの間だけ覚える（sessionStorage）
// - 辞書に登録した言い換えは、次からのまとめで AI に渡される

import { h, $, $$, toast, confirmDialog } from "./ui.js";

const KEY = "mkp-admin-key";
let ctx;
export function initAdmin(context) {
  ctx = context;
}

const getKey = () => {
  try {
    return sessionStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
};
const setKey = (v) => {
  try {
    if (v) sessionStorage.setItem(KEY, v);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* 保存できなくても、この画面では使える */
  }
};

async function api(path, { method = "GET", body, key = getKey() } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { "X-Admin-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new Error("サーバーにつながりませんでした。");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) setKey("");
  if (!res.ok) {
    const err = new Error(data.error || "うまくいきませんでした。");
    err.status = res.status;
    throw err;
  }
  return data;
}

const CAT_ICON = { 言い換え: "💬", 聞き取り: "🎧", あいまい: "🔀", その他: "📝" };
const fmtTime = (s) => String(s || "").replace("T", " ").slice(0, 16);

export async function viewAdmin(query) {
  document.title = "管理者の確認 | MediKataru for pet";
  if (!getKey()) return paintLogin();
  let stats;
  try {
    stats = await api("/api/admin/stats");
  } catch (e) {
    return paintLogin(e.message);
  }
  const tab = ["flags", "glossary", "stats", "done", "usage"].includes(query.get("tab")) ? query.get("tab") : "flags";
  const open = Object.values(stats.byModel).reduce((s, m) => s + (m.open || 0), 0);

  ctx.app.innerHTML = `
    ${ctx.back("#/settings", "設定にもどる")}
    <div class="page-head">
      <h1>管理者の確認</h1>
      <p class="muted small">未確認の報告 <b>${open}件</b> ・ 用語辞書 <b>${stats.glossary}語</b> ・ 今のAI <b>${h(stats.model || "")}</b></p>
      ${
        stats.mode === "file"
          ? `<p class="notice">⚠ 保存先がサーバーの中のファイルになっています。Render ではサーバーが入れ替わると消えるため、TURSO_DATABASE_URL と TURSO_AUTH_TOKEN を設定してください。</p>`
          : ""
      }
    </div>
    <div class="filter-chips no-print" role="group" aria-label="表示の切り替え">
      ${[
        ["flags", `未確認の報告（${open}）`],
        ["glossary", "用語辞書"],
        ["stats", "モデルごとの集計"],
        ["usage", "AIの利用量"],
        ["done", "確認済み"],
      ]
        .map(([k, l]) => `<a class="chip-btn" href="#/admin?tab=${k}" aria-pressed="${k === tab}">${l}</a>`)
        .join("")}
    </div>
    <div id="admin-body"><p class="muted">読み込んでいます…</p></div>
    <button type="button" class="btn btn-ghost" id="admin-logout">管理者の画面を閉じる（合言葉を消す）</button>`;

  $("#admin-logout").onclick = () => {
    setKey("");
    ctx.go("#/settings");
  };
  try {
    if (tab === "flags") await paintFlags("open");
    if (tab === "done") await paintDone(query.get("status"));
    if (tab === "glossary") await paintGlossary();
    if (tab === "stats") paintStats(stats);
    if (tab === "usage") await paintUsage();
  } catch (e) {
    if (e.status === 401) return paintLogin(e.message);
    $("#admin-body").innerHTML = `<div class="alert alert-error" role="alert">${h(e.message)}</div>`;
  }
}

function paintLogin(message = "") {
  ctx.app.innerHTML = `
    ${ctx.back("#/settings", "設定にもどる")}
    <h1>管理者の確認</h1>
    <form class="card stack" id="admin-login">
      <p class="muted">AIが言い換えに迷ったところを確認する画面です。管理者の合言葉を入れてください。</p>
      <div>
        <label for="admin-key">合言葉</label>
        <input id="admin-key" type="password" autocomplete="current-password" required>
      </div>
      ${message ? `<div class="alert alert-error" role="alert">${h(message)}</div>` : ""}
      <button class="btn btn-primary btn-wide">開く</button>
    </form>`;
  $("#admin-login").onsubmit = async (e) => {
    e.preventDefault();
    const key = $("#admin-key").value.trim();
    try {
      await api("/api/admin/stats", { key });
      setKey(key);
      ctx.render();
    } catch (err) {
      paintLogin(err.message);
    }
  };
  $("#admin-key").focus();
}

function flagCard(f, { editable }) {
  const statusLabel = { fixed: "✓ 直して登録", approved: "✓ そのまま登録", dismissed: "問題なし" }[f.status] || "";
  return `
    <article class="card flag-card" data-id="${h(f.id)}">
      <p class="flag-meta">
        <span class="badge">${CAT_ICON[f.category] || "📝"} ${h(f.category)}</span>
        <span class="muted small">${h(fmtTime(f.created_at))}${f.species ? ` ・ ${h(f.species)}` : ""} ・ ${h(f.model)}</span>
        ${statusLabel ? `<span class="badge badge-soft">${statusLabel}</span>` : ""}
      </p>
      <dl class="flag-dl">
        <div><dt>迷った言葉</dt><dd class="flag-term">${h(f.term)}</dd></div>
        <div><dt>AIの言い換え</dt><dd>${f.used_plain ? h(f.used_plain) : `<span class="muted">（使っていない）</span>`}</dd></div>
        <div><dt>迷った理由</dt><dd>${h(f.reason)}</dd></div>
        ${f.context ? `<div><dt>前後の文</dt><dd class="flag-context">${h(f.context)}</dd></div>` : ""}
        ${f.admin_plain && f.status !== "dismissed" ? `<div><dt>登録した言い換え</dt><dd>${h(f.admin_plain)}</dd></div>` : ""}
      </dl>
      ${
        editable
          ? `<form class="flag-form stack-sm">
              <label>辞書に登録する用語<input name="term" value="${h(f.term)}" maxlength="80" required></label>
              <label>正しい言い換え <span class="hint">AIの言い換えでよければ、そのまま登録できます</span>
                <textarea name="plain" rows="2" maxlength="300" required>${h(f.used_plain)}</textarea></label>
              <label>メモ（任意） <span class="hint">AIには渡しません</span><input name="note" maxlength="300"></label>
              <div class="flag-actions">
                <button class="btn btn-primary" value="register">辞書に登録して完了</button>
                <button type="button" class="btn" data-dismiss="${h(f.id)}">問題なし（登録しない）</button>
              </div>
            </form>`
          : ""
      }
    </article>`;
}

async function paintFlags(status) {
  const { flags } = await api(`/api/admin/flags?status=${status}`);
  const body = $("#admin-body");
  if (!flags.length) {
    body.innerHTML = `<p class="notice">未確認の報告はありません。AIがまとめで迷ったところがあると、ここに自動で届きます。</p>`;
    return;
  }
  body.innerHTML = `<p class="muted small">古い順に並んでいます。名前・病院名・電話番号などは「＊＊」に置き換えてあります。</p>${flags.map((f) => flagCard(f, { editable: true })).join("")}`;
  const done = (card, msg) => {
    card.remove();
    toast(msg);
    if (!$(".flag-card")) body.innerHTML = `<p class="notice">未確認の報告はすべて確認しました。</p>`;
  };
  $$(".flag-form", body).forEach((form) => {
    const card = form.closest(".flag-card");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        const r = await api("/api/admin/flags/resolve", {
          method: "POST",
          body: { id: card.dataset.id, action: "register", term: fd.get("term"), plain: fd.get("plain"), note: fd.get("note") },
        });
        done(card, r.status === "fixed" ? "直した言い換えを辞書に登録しました" : "AIの言い換えを辞書に登録しました");
      } catch (err) {
        toast(err.message);
      }
    };
  });
  $$("[data-dismiss]", body).forEach((b) => {
    b.onclick = async () => {
      try {
        await api("/api/admin/flags/resolve", { method: "POST", body: { id: b.dataset.dismiss, action: "dismiss" } });
        done(b.closest(".flag-card"), "「問題なし」にしました");
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

async function paintDone(statusParam) {
  const status = ["fixed", "approved", "dismissed"].includes(statusParam) ? statusParam : "fixed";
  const { flags } = await api(`/api/admin/flags?status=${status}`);
  $("#admin-body").innerHTML = `
    <div class="filter-chips" role="group" aria-label="確認済みの種類">
      ${[
        ["fixed", "直して登録"],
        ["approved", "そのまま登録"],
        ["dismissed", "問題なし"],
      ]
        .map(([k, l]) => `<a class="chip-btn" href="#/admin?tab=done&status=${k}" aria-pressed="${k === status}">${l}</a>`)
        .join("")}
    </div>
    ${flags.length ? flags.map((f) => flagCard(f, { editable: false })).join("") : `<p class="notice">まだありません。</p>`}`;
}

async function paintGlossary() {
  const { glossary } = await api("/api/admin/glossary");
  const body = $("#admin-body");
  body.innerHTML = `
    <form class="card stack-sm" id="gl-form">
      <h2 class="section-title"><span class="section-icon" aria-hidden="true">➕</span>言い換えを登録する</h2>
      <p class="muted small">同じ用語を登録すると上書きします。説明の中にこの用語が出てくると、AIはこの言い換えを使います。</p>
      <label>用語<input name="term" maxlength="80" required placeholder="例：膿皮症"></label>
      <label>言い換え<textarea name="plain" rows="2" maxlength="300" required placeholder="例：皮膚に細菌が増えて、赤いぶつぶつやかさぶたができる状態"></textarea></label>
      <label>メモ（任意）<input name="note" maxlength="300"></label>
      <button class="btn btn-primary">登録する</button>
    </form>
    ${
      glossary.length
        ? `<ul class="gl-list">${glossary
            .map(
              (g) => `<li class="gl-item ${Number(g.active) ? "" : "is-off"}">
                <div class="gl-text"><b>${h(g.term)}</b><span>${h(g.plain)}</span>${g.note ? `<small class="muted">${h(g.note)}</small>` : ""}</div>
                <div class="gl-actions">
                  <button type="button" class="btn btn-sm" data-edit="${h(g.term)}">直す</button>
                  <button type="button" class="btn btn-sm ${Number(g.active) ? "" : "btn-primary"}" data-toggle="${h(g.id)}" data-active="${Number(g.active) ? 0 : 1}">${Number(g.active) ? "使わない" : "使う"}</button>
                </div>
              </li>`,
            )
            .join("")}</ul>`
        : `<p class="notice">まだ登録はありません。</p>`
    }`;
  const form = $("#gl-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api("/api/admin/glossary", { method: "POST", body: { term: fd.get("term"), plain: fd.get("plain"), note: fd.get("note") } });
      toast("登録しました");
      paintGlossary();
    } catch (err) {
      toast(err.message);
    }
  };
  $$("[data-edit]", body).forEach((b) => {
    b.onclick = () => {
      const g = glossary.find((x) => x.term === b.dataset.edit);
      form.term.value = g.term;
      form.plain.value = g.plain;
      form.note.value = g.note || "";
      form.scrollIntoView({ behavior: "smooth" });
      form.plain.focus();
    };
  });
  $$("[data-toggle]", body).forEach((b) => {
    b.onclick = async () => {
      const on = b.dataset.active === "1";
      if (!on && !(await confirmDialog({ title: "この言い換えを使わないようにしますか？", message: "辞書には残り、あとで「使う」にもどせます。", ok: "使わない" }))) return;
      try {
        await api("/api/admin/glossary/active", { method: "POST", body: { id: b.dataset.toggle, active: on } });
        paintGlossary();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

function paintStats(stats) {
  const rows = Object.entries(stats.byModel);
  $("#admin-body").innerHTML = rows.length
    ? `<p class="muted small">「直した割合」が高いほど、AIの報告が役に立っている（本当に直す必要があった）ことを示します。「問題なし」が多いモデルは、迷いすぎています。</p>
      ${rows
        .map(([m, c]) => {
          const total = c.open + c.fixed + c.approved + c.dismissed;
          const checked = c.fixed + c.approved + c.dismissed;
          const rate = checked ? `${Math.round((c.fixed / checked) * 100)}%` : "—";
          return `<section class="card stats-card">
            <h2 class="section-title">${h(m)}</h2>
            <p class="stats-rate"><span class="muted small">直した割合</span><b>${rate}</b><span class="muted small">（確認した ${checked}件のうち）</span></p>
            <ul class="kv-list">
              <li><span>報告</span><b>${total}件</b></li>
              <li><span>直して登録</span><b>${c.fixed}件</b></li>
              <li><span>そのまま登録</span><b>${c.approved}件</b></li>
              <li><span>問題なし</span><b>${c.dismissed}件</b></li>
              <li><span>未確認</span><b>${c.open}件</b></li>
            </ul>
          </section>`;
        })
        .join("")}`
    : `<p class="notice">まだ報告がありません。</p>`;
}

// AI の利用量：月ごとの回数と金額（目安）。利用者の画面には出さない
async function paintUsage() {
  const { usage, model } = await api("/api/admin/usage");
  const yen = (v) => (v === null || v === undefined ? "—" : `約${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()}円`);
  if (!usage.length) {
    $("#admin-body").innerHTML = `<p class="notice">まだ記録がありません。AIでまとめると、ここに回数と金額が出ます（今のAI：${h(model)}）。</p>`;
    return;
  }
  const months = [...new Set(usage.map((u) => u.month))];
  $("#admin-body").innerHTML = `
    <p class="muted small">金額は、使ったトークン数と公開価格から計算した目安です（1ドル150円で換算）。正確な請求額は Anthropic の管理画面で確認してください。だれが使ったかは記録していません。</p>
    ${months
      .map((m) => {
        const rows = usage.filter((u) => u.month === m);
        const total = rows.reduce((a, u) => a + (u.yen || 0), 0);
        const count = rows.reduce((a, u) => a + u.count, 0);
        return `<section class="card stats-card">
          <h2 class="section-title">${m.replace("-", "年")}月</h2>
          <p class="stats-rate"><span class="muted small">合計</span><b>${yen(total)}</b><span class="muted small">（${count}回・1回あたり ${yen(count ? total / count : null)}）</span></p>
          <ul class="kv-list">${rows
            .map((u) => `<li><span>${h(u.kind)}<br><small>${h(u.model)}</small></span><b>${u.count}回・${yen(u.yen)}</b></li>`)
            .join("")}</ul>
        </section>`;
      })
      .join("")}`;
}
