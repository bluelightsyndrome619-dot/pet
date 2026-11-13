// 画面づくりの小さな道具

/** HTML に入れる文字を安全にする */
export function h(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const pad = (n) => String(n).padStart(2, "0");
export const pad2 = pad;

/** 今日の日付（YYYY-MM-DD、端末の時刻） */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const parseDate = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/** 2026年11月10日（火） */
export function formatDate(ymd) {
  const d = parseDate(ymd);
  if (!d) return ymd || "日付なし";
  const w = "日月火水木金土"[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}

/** 11/10（火） */
export function formatShortDate(ymd) {
  const d = parseDate(ymd);
  if (!d) return ymd || "日付なし";
  return `${d.getMonth() + 1}/${d.getDate()}（${"日月火水木金土"[d.getDay()]}）`;
}

export function daysBetween(a, b) {
  const da = parseDate(a);
  const db = parseDate(b);
  return da && db ? Math.round(Math.abs(db - da) / 86400000) : null;
}

/** 生年月日から「3歳2か月」 */
export function ageText(birthday) {
  const b = parseDate(birthday);
  if (!b) return "";
  const now = new Date();
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) months -= 1;
  if (months < 0) return "";
  const y = Math.floor(months / 12);
  const m = months % 12;
  return y ? `${y}歳${m ? `${m}か月` : ""}` : `${m}か月`;
}

/** 下に出るお知らせ。5秒で消える。押しても消える */
export function toast(message) {
  let box = $(".toast");
  if (!box) {
    box = document.createElement("div");
    box.className = "toast";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    box.title = "押すと閉じます";
    box.addEventListener("click", () => {
      clearTimeout(toast.timer);
      box.classList.remove("show");
    });
    document.body.append(box);
  }
  box.innerHTML = `<span class="toast-text">${h(message)}</span><span class="toast-x" aria-hidden="true">✕</span>`;
  box.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove("show"), 5000);
}

/** 「本当に消しますか？」をもう一度聞く */
export function confirmDialog({ title, message = "", ok = "はい", cancel = "やめる", danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "sheet";
    d.innerHTML = `
      <form method="dialog" class="sheet-body">
        <h2 class="sheet-title">${h(title)}</h2>
        ${message ? `<p>${h(message)}</p>` : ""}
        <div class="sheet-actions">
          <button value="cancel" class="btn">${h(cancel)}</button>
          <button value="ok" class="btn ${danger ? "btn-danger" : "btn-primary"}">${h(ok)}</button>
        </div>
      </form>`;
    document.body.append(d);
    d.addEventListener("close", () => {
      resolve(d.returnValue === "ok");
      d.remove();
    });
    d.showModal();
  });
}

/** 中身を自由に入れられる下からのシート。閉じると close の値（returnValue）を返す */
export function openSheet(html, { onOpen, label = "" } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "sheet";
    if (label) d.setAttribute("aria-label", label);
    d.innerHTML = html;
    document.body.append(d);
    d.addEventListener("close", () => {
      resolve({ value: d.returnValue, dialog: d });
      setTimeout(() => d.remove(), 0);
    });
    d.addEventListener("click", (e) => {
      if (e.target === d) d.close("cancel"); // 外側を押したら閉じる
    });
    d.showModal();
    onOpen?.(d);
  });
}

/** 待っている間の全画面表示 */
export function showLoading(title, text) {
  const box = document.createElement("div");
  box.className = "overlay";
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "assertive");
  box.innerHTML = `
    <div class="overlay-box">
      <div class="paw-loader" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <p class="headline">${h(title)}</p>
      <p>${text}</p>
    </div>`;
  document.body.append(box);
  return () => box.remove();
}

/** 箇条書き。空なら一言 */
export function list(items, empty = "特にありません") {
  return items?.length
    ? `<ul class="big-list">${items.map((i) => `<li>${h(i)}</li>`).join("")}</ul>`
    : `<p class="muted">${h(empty)}</p>`;
}

export function section({ icon, title, body, tone = "" }) {
  return `
    <section class="card section-card ${tone}">
      <h2 class="section-title"><span class="section-icon" aria-hidden="true">${icon}</span>${h(title)}</h2>
      ${body}
    </section>`;
}
