import * as store from "./store.js";
import { takePhoto, pickFile, makeThumb } from "./camera.js";
import { renderBackupReminder, runExport, markBackedUp, lastBackupText } from "./backup.js";
import { initPwa, renderInstallGuide } from "./pwa.js";
import {
  h, $, $$, today, formatDate, formatShortDate, daysBetween, ageText, toast, confirmDialog, openSheet,
  showLoading, list, section, usageText,
} from "./ui.js";

// ============================================================
// 定数
// ============================================================

const SPECIES = [
  { value: "犬", icon: "🐶" },
  { value: "猫", icon: "🐱" },
  { value: "うさぎ", icon: "🐰" },
  { value: "鳥", icon: "🐦" },
  { value: "小動物", icon: "🐹" },
  { value: "その他", icon: "🐾" },
];
const SEXES = ["オス", "メス", "オス（去勢済み）", "メス（避妊済み）", "わからない"];
const SCENES = ["診察・再診", "ワクチン・健康診断", "検査結果の説明", "手術・処置", "入院・退院", "その他"];
const PARTS = ["皮膚", "傷・できもの", "耳", "目", "口・歯", "足・肉球", "お腹", "背中", "しっぽ・おしり", "その他"];

const speciesIcon = (s) => SPECIES.find((x) => x.value === s)?.icon || "🐾";

const SAMPLE = `獣医師：今日はかゆみの件ですね。お腹と内股のところに、赤いぶつぶつとかさぶたがあります。膿皮症、皮膚に細菌が増えている状態だと思います。
飼い主：夜もずっと舐めていて、寝られないみたいなんです。
獣医師：念のため皮膚の表面をテープで取って、顕微鏡で見ましたが、マラセチアは少しだけで、ダニは見つかりませんでした。
獣医師：セファレキシンという抗生物質を、1日2回、朝と夜に1錠ずつ、2週間飲ませてください。途中で良くなっても、2週間は続けてください。
獣医師：シャンプーは週に2回、薬用シャンプーで、泡をつけたまま10分置いてから流してください。舐めて悪化しているので、家ではエリザベスカラーをつけましょう。
飼い主：ごはんはこのままでいいですか？
獣医師：今のままで大丈夫です。もし下痢や吐き気が出たら、薬をいったん止めて連絡してください。赤みが広がったり、元気や食欲がなくなったときも、すぐ来てください。
獣医師：体重は8.2キロで、前回と変わりありません。2週間後にもう一度見せてください。`;

// ============================================================
// AI の呼び出し（キーはサーバーだけが持つ）
// ============================================================

// server: サーバーから開いているか（ファイルを直接開いたときだけ false。そのときはお試し表示で流れを確かめる）
// offline: 電波がない・サーバーが応答しない（ホーム画面のアプリを電波のないところで開いたときなど）
let aiStatus = { ai: false, model: "demo", server: location.protocol !== "file:", offline: false };

async function loadStatus() {
  if (!aiStatus.server) return;
  if (navigator.onLine === false) {
    aiStatus = { ...aiStatus, offline: true };
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000); // 起動を待たせすぎない
  try {
    const res = await fetch("/api/status", { cache: "no-store", signal: ctrl.signal });
    if (res.ok) aiStatus = { ...aiStatus, ...(await res.json()), offline: false };
    else aiStatus = { ...aiStatus, offline: true };
  } catch {
    aiStatus = { ...aiStatus, offline: true };
  } finally {
    clearTimeout(timer);
  }
}

// AI に頼むときの注意書き（電波がない／お試し表示）
function aiNotice() {
  if (aiStatus.offline) {
    return `<p class="notice">📡 電波がないか、サーバーにつながりません。記録や入力はできますが、まとめるのは電波のあるところでお願いします。</p>`;
  }
  if (!aiStatus.ai) {
    return `<p class="notice">お試し表示中：AIの設定（ANTHROPIC_API_KEY）がないため、まとめは作られず、画面の流れだけ確かめられます。</p>`;
  }
  return "";
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("サーバーにつながりませんでした。電波のよいところで、もう一度お試しください。");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "うまくいきませんでした。もう一度お試しください。");
  return data;
}

// サーバーが無い（ファイルを直接開いた）ときも、画面の流れだけは確かめられるようにする
const DEMO = "【お試し表示】AIにつながっていないため、まとめは行われていません。";
function localDemoVisit(transcript) {
  const s = transcript.split(/(?<=[。！？!?\n])/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
  return {
    result: {
      title: (s[0] || "説明の記録").replace(/^[^：:]{1,8}[：:]/, "").slice(0, 20),
      family: { headline: DEMO, explanation: s.join(""), key_points: s, home_care: [], medicines: [], warning_signs: [], next_schedule: [], glossary: [], confirm_with_vet: ["お試し表示のため、内容は必ず獣医師に確認してください。"] },
      record: { one_liner: DEMO, reason: "記載なし", findings: "記載なし", diagnosis: "記載なし", treatment: "記載なし", medications: [], tests: [], vaccines_preventives: [], weight: "記載なし", next_visit: "記載なし", uncertainties: [] },
    },
    model: "demo (サーバーなし)", inputTokens: 0, outputTokens: 0,
  };
}
function localDemoHistory(visits) {
  return {
    result: {
      overview: `${DEMO}記録は${visits.length}件あります。`, ongoing: [], current_medicines: [],
      timeline: [...visits].reverse().map((v) => ({ date: v.date, event: v.record?.one_liner || v.title })),
      preventive_care: [], cautions: [], weight_trend: "記録なし", upcoming: [], questions_for_next_visit: [],
    },
    model: "demo (サーバーなし)", inputTokens: 0, outputTokens: 0,
  };
}

const petForAi = (p) => ({ name: p.name, species: p.species, breed: p.breed, birthday: p.birthday, note: p.note });

// ============================================================
// ルーター（# のあとで画面を切り替える）
// ============================================================

const app = $("#app");
let objectUrls = [];
let cleanup = null;

function blobUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  return { parts: path.split("/").filter(Boolean), query: new URLSearchParams(query) };
}

async function render() {
  cleanup?.();
  cleanup = null;
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  window.speechSynthesis?.cancel();

  const { parts, query } = parseHash();
  try {
    if (parts.length === 0) await viewHome();
    else if (parts[0] === "settings") await viewSettings();
    else if (parts[0] === "pet" && parts[1] === "new") await viewPetForm(null);
    else if (parts[0] === "pet" && parts[2] === "edit") await viewPetForm(parts[1]);
    else if (parts[0] === "pet" && parts[2] === "record") await viewRecord(parts[1]);
    else if (parts[0] === "pet" && parts[2] === "photos") await viewPhotos(parts[1], query);
    else if (parts[0] === "pet" && parts[2] === "history") await viewHistoryEntry(parts[1]);
    else if (parts[0] === "pet" && parts[1]) await viewPet(parts[1]);
    else if (parts[0] === "visit" && parts[1]) await viewVisit(parts[1], query);
    else notFound();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="alert alert-error" role="alert">画面を表示できませんでした。${h(e.message)}</div>
      <a class="btn" href="#/">最初の画面にもどる</a>`;
  }
  const heading = $("h1", app);
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

function notFound() {
  app.innerHTML = `
    <div class="empty">
      <p class="empty-icon" aria-hidden="true">🐾</p>
      <h1>見つかりませんでした</h1>
      <p class="muted">消されたか、アドレスがまちがっているかもしれません。</p>
      <a class="btn btn-primary" href="#/">最初の画面にもどる</a>
    </div>`;
}

const back = (href, label) => `<a class="back-link no-print" href="${href}">‹ ${h(label)}</a>`;

function avatar(pet, size = "") {
  return pet.avatar
    ? `<span class="avatar ${size}"><img src="${h(pet.avatar)}" alt=""></span>`
    : `<span class="avatar ${size}" aria-hidden="true">${speciesIcon(pet.species)}</span>`;
}

// ============================================================
// 最初の画面：ペットの一覧
// ============================================================

async function viewHome() {
  const pets = await store.listPets();
  const rows = await Promise.all(
    pets.map(async (p) => {
      const visits = await store.listVisits(p.id);
      return { pet: p, count: visits.length, last: visits[0] };
    }),
  );
  document.title = "MediKataru for pet";

  app.innerHTML = `
    <div id="backup-slot"></div>
    <section class="hero">
      <div class="hero-text">
        <p class="eyebrow">MediKataru for pet</p>
        <h1>動物病院での説明を、<br>家族みんなにわかる言葉で。</h1>
        <p class="lead">録音するだけで、むずかしい説明をやさしくまとめます。これまでの受診歴も、皮膚や傷の写真も、ひとつの場所に。</p>
      </div>
      <div class="hero-art" aria-hidden="true">${heroArt()}</div>
    </section>

    <div id="install-slot"></div>

    ${
      rows.length
        ? `<h2 class="list-heading">うちの子 <span class="muted small">（${rows.length}）</span></h2>
           <ul class="pet-grid">
             ${rows
               .map(
                 ({ pet, count, last }) => `
               <li>
                 <a class="pet-card" href="#/pet/${pet.id}">
                   ${avatar(pet, "avatar-lg")}
                   <span class="pet-card-body">
                     <span class="pet-name">${h(pet.name)}</span>
                     <span class="muted small">${h([pet.species, pet.breed, ageText(pet.birthday)].filter(Boolean).join("・"))}</span>
                     <span class="pet-meta">${count ? `受診 ${count}件 ・ 最後 ${formatShortDate(last.date)}` : "まだ記録がありません"}</span>
                   </span>
                   <span class="go" aria-hidden="true">›</span>
                 </a>
               </li>`,
               )
               .join("")}
           </ul>`
        : `<section class="card how-to">
             <h2 class="section-title">はじめかた</h2>
             <ol class="how-steps">
               <li><span class="step-badge">1</span><span><b>うちの子を登録</b><br><span class="muted">名前と種類だけでOK</span></span></li>
               <li><span class="step-badge">2</span><span><b>診察室で録音</b><br><span class="muted">先生の了承をもらってから</span></span></li>
               <li><span class="step-badge">3</span><span><b>ボタン一つでまとめ</b><br><span class="muted">家族へLINEで送れます</span></span></li>
             </ol>
           </section>`
    }

    <a class="btn btn-primary btn-big" href="#/pet/new">
      <span class="btn-icon" aria-hidden="true">＋</span>
      <span>うちの子を登録する<span class="btn-sub">犬・猫・うさぎ・鳥など</span></span>
    </a>

    <p class="privacy-note">🔒 記録と写真は、この端末のブラウザの中だけに保存されます。機種変更の前は「設定」からバックアップしてください。</p>`;
  renderBackupReminder($("#backup-slot"));
  renderInstallGuide($("#install-slot"), { dismissible: true });
}

function heroArt() {
  return `
  <svg viewBox="0 0 220 180" role="img">
    <defs>
      <linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" class="svg-stop-color-accent-soft"/><stop offset="1" class="svg-stop-color-peach"/>
      </linearGradient>
    </defs>
    <circle cx="112" cy="92" r="78" fill="url(#hg)"/>
    <g class="svg-fill-brand">
      <ellipse cx="112" cy="112" rx="30" ry="25"/>
      <ellipse cx="76" cy="78" rx="12" ry="15" transform="rotate(-20 76 78)"/>
      <ellipse cx="100" cy="60" rx="12" ry="16"/>
      <ellipse cx="126" cy="60" rx="12" ry="16"/>
      <ellipse cx="149" cy="78" rx="12" ry="15" transform="rotate(20 149 78)"/>
    </g>
    <path d="M112 121c-9-7-15-12-15-18a7 7 0 0 1 15-3 7 7 0 0 1 15 3c0 6-6 11-15 18z" class="svg-fill-surface"/>
    <g class="svg-fill-accent" opacity=".85">
      <circle cx="186" cy="40" r="6"/><circle cx="34" cy="138" r="5"/><circle cx="196" cy="140" r="4"/>
    </g>
  </svg>`;
}

// ============================================================
// ペットの登録・編集
// ============================================================

async function viewPetForm(id) {
  const pet = id ? await store.getPet(id) : null;
  if (id && !pet) return notFound();
  const p = pet || { species: "犬" };
  let avatarData = p.avatar || null;
  document.title = `${pet ? "プロフィールを直す" : "うちの子を登録"} | MediKataru for pet`;

  app.innerHTML = `
    ${back(pet ? `#/pet/${pet.id}` : "#/", pet ? `${pet.name}のページにもどる` : "もどる")}
    <h1>${pet ? "プロフィールを直す" : "うちの子を登録"}</h1>
    <form class="stack" id="pet-form" novalidate>
      <div class="avatar-edit">
        <span id="avatar-preview">${avatar({ ...p, avatar: avatarData }, "avatar-xl")}</span>
        <div class="stack-sm">
          <button type="button" class="btn" id="avatar-take">📷 写真を撮る</button>
          <button type="button" class="btn btn-ghost" id="avatar-pick">写真を選ぶ</button>
        </div>
      </div>

      <div>
        <label for="name">名前 <span class="req">必須</span></label>
        <input id="name" name="name" required maxlength="40" value="${h(p.name)}" placeholder="例：こむぎ" autocomplete="off">
      </div>

      <fieldset class="tiles tiles-3">
        <legend class="label">種類</legend>
        ${SPECIES.map(
          (s) => `
          <label class="tile">
            <input type="radio" name="species" value="${s.value}" ${p.species === s.value ? "checked" : ""}>
            <span><span class="tile-icon" aria-hidden="true">${s.icon}</span>${s.value}</span>
          </label>`,
        ).join("")}
      </fieldset>

      <div>
        <label for="breed">品種 <span class="hint">書かなくても大丈夫です</span></label>
        <input id="breed" name="breed" maxlength="40" value="${h(p.breed)}" placeholder="例：柴犬、スコティッシュフォールド">
      </div>

      <div class="grid-2">
        <div>
          <label for="sex">性別</label>
          <select id="sex" name="sex">
            <option value="">選ばない</option>
            ${SEXES.map((s) => `<option ${p.sex === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div>
          <label for="birthday">生年月日 <span class="hint">だいたいでOK</span></label>
          <input id="birthday" name="birthday" type="date" max="${today()}" value="${h(p.birthday)}">
        </div>
      </div>

      <div>
        <label for="note">アレルギー・持病・苦手なことなど <span class="hint">受診歴のまとめにも使います</span></label>
        <textarea id="note" name="note" rows="3" maxlength="400" placeholder="例：鶏肉アレルギー。爪切りが苦手。">${h(p.note)}</textarea>
      </div>

      <div id="form-error" class="alert alert-error" role="alert" hidden></div>
      <button class="btn btn-primary btn-big">${pet ? "保存する" : "登録する"}</button>
      ${pet ? `<button type="button" class="btn btn-danger-ghost" id="delete-pet">このペットの記録をすべて消す</button>` : ""}
    </form>`;

  const setAvatar = async (blob) => {
    if (!blob) return;
    avatarData = await makeThumb(blob, 320);
    $("#avatar-preview").innerHTML = avatar({ ...p, avatar: avatarData }, "avatar-xl");
  };
  $("#avatar-take").onclick = async () => setAvatar(await takePhoto({ title: "プロフィール写真を撮る" }));
  $("#avatar-pick").onclick = async () => setAvatar(await pickFile({ capture: false }));
  $$('input[name="species"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (!avatarData) $("#avatar-preview").innerHTML = avatar({ species: r.value }, "avatar-xl");
    }),
  );

  $("#pet-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get("name") || "").trim();
    if (!name) {
      $("#form-error").hidden = false;
      $("#form-error").textContent = "名前を入れてください。";
      $("#name").focus();
      return;
    }
    const saved = await store.savePet({
      ...(pet || {}),
      id: pet?.id || store.newId(),
      name,
      species: String(f.get("species") || "その他"),
      breed: String(f.get("breed") || "").trim(),
      sex: String(f.get("sex") || ""),
      birthday: String(f.get("birthday") || ""),
      note: String(f.get("note") || "").trim(),
      avatar: avatarData,
    });
    toast(pet ? "保存しました" : `${saved.name}を登録しました`);
    go(`#/pet/${saved.id}`);
  };

  if (pet) {
    $("#delete-pet").onclick = async () => {
      const ok = await confirmDialog({
        title: `${pet.name}の記録をすべて消しますか？`,
        message: "受診の記録・写真・受診歴のまとめもすべて消え、元にもどせません。",
        ok: "すべて消す",
        danger: true,
      });
      if (!ok) return;
      await store.deletePet(pet.id);
      toast("消しました");
      go("#/");
    };
  }
}

// ============================================================
// ペットのページ
// ============================================================

async function viewPet(id) {
  const pet = await store.getPet(id);
  if (!pet) return notFound();
  const [visits, photos] = await Promise.all([store.listVisits(id), store.listPhotos(id)]);
  document.title = `${pet.name} | MediKataru for pet`;

  app.innerHTML = `
    ${back("#/", "うちの子の一覧にもどる")}
    <section class="profile card">
      ${avatar(pet, "avatar-xl")}
      <div class="profile-body">
        <h1>${h(pet.name)}</h1>
        <p class="chips">
          ${[pet.species, pet.breed, pet.sex, ageText(pet.birthday)].filter(Boolean).map((t) => `<span class="chip">${h(t)}</span>`).join("")}
        </p>
        ${pet.note ? `<p class="muted small profile-note">📝 ${h(pet.note)}</p>` : ""}
        <a class="text-link" href="#/pet/${pet.id}/edit">プロフィールを直す</a>
      </div>
    </section>

    <div id="backup-slot"></div>

    <div class="action-grid">
      <a class="btn btn-primary btn-big" href="#/pet/${pet.id}/record">
        <span class="btn-icon" aria-hidden="true">🎙</span>
        <span>説明を記録する<span class="btn-sub">録音して、わかりやすく</span></span>
      </a>
      <button type="button" class="btn btn-accent btn-big" id="take-photo">
        <span class="btn-icon" aria-hidden="true">📷</span>
        <span>写真を撮る<span class="btn-sub">皮膚や傷の様子を残す</span></span>
      </button>
    </div>

    ${
      visits.length
        ? `<a class="history-banner" href="#/visit/${visits[0].id}?tab=history">
             <span class="history-banner-icon" aria-hidden="true">📚</span>
             <span><b>これまでの受診歴を見る</b><br><span class="muted small">${visits.length}回分の受診を1枚にまとめます</span></span>
             <span class="go" aria-hidden="true">›</span>
           </a>`
        : ""
    }

    <section class="block">
      <h2 class="list-heading">受診の記録 <span class="muted small">（${visits.length}件）</span></h2>
      ${
        visits.length
          ? `<ul class="visit-list">
              ${visits
                .map(
                  (v) => `
                <li>
                  <a class="visit-card" href="#/visit/${v.id}">
                    <span class="visit-date"><b>${formatShortDate(v.date)}</b><span>${h(v.date?.slice(0, 4) || "")}</span></span>
                    <span class="visit-body">
                      <span class="visit-tags"><span class="badge">${h(v.scene)}</span>${v.clinic ? `<span class="muted small">${h(v.clinic)}</span>` : ""}</span>
                      <span class="visit-title">${h(v.title)}</span>
                      <span class="muted small clamp-2">${h(v.family?.headline)}</span>
                    </span>
                    <span class="go" aria-hidden="true">›</span>
                  </a>
                </li>`,
                )
                .join("")}
            </ul>`
          : `<p class="notice">まだ記録がありません。上の「説明を記録する」から始められます。</p>`
      }
    </section>

    <section class="block">
      <div class="spread">
        <h2 class="list-heading">写真の記録 <span class="muted small">（${photos.length}枚）</span></h2>
        ${photos.length ? `<a class="text-link" href="#/pet/${pet.id}/photos">すべて見る ›</a>` : ""}
      </div>
      ${
        photos.length
          ? `<ul class="photo-strip">
              ${photos
                .slice(0, 8)
                .map(
                  (ph) => `
                <li><a href="#/pet/${pet.id}/photos?open=${ph.id}" class="photo-thumb">
                  <img src="${h(ph.thumb)}" alt="${h(`${ph.part} ${formatShortDate(ph.date)}`)}" loading="lazy">
                  <span class="photo-cap">${h(ph.part)}<br>${formatShortDate(ph.date)}</span>
                </a></li>`,
                )
                .join("")}
            </ul>`
          : `<p class="muted">皮膚の赤み・傷・できものなどを撮っておくと、変化をくらべたり、病院で見せたりできます。</p>`
      }
    </section>`;

  $("#take-photo").onclick = async () => {
    const saved = await photoFlow(pet, {});
    if (saved) render();
  };
  renderBackupReminder($("#backup-slot"));
}

// ============================================================
// 写真を撮って保存する流れ：部位を選ぶ → 撮る → メモして保存
// ============================================================

async function photoFlow(pet, { visitId = null, date = today() }) {
  const photos = await store.listPhotos(pet.id);
  const lastByPart = {};
  for (const p of photos) if (!lastByPart[p.part]) lastByPart[p.part] = p;

  // 1. どこを撮るか
  let part = null;
  const { value } = await openSheet(
    `<form method="dialog" class="sheet-body">
       <h2 class="sheet-title">どこを撮りますか？</h2>
       <p class="muted small">前に同じ場所を撮っていれば、その写真をうすく重ねて、同じ角度で撮れます。</p>
       <div class="part-grid">
         ${PARTS.map(
           (p) => `<button class="part-btn" value="${h(p)}">${h(p)}${lastByPart[p] ? `<small>前回 ${formatShortDate(lastByPart[p].date)}</small>` : ""}</button>`,
         ).join("")}
       </div>
       <div class="sheet-actions"><button value="cancel" class="btn">やめる</button></div>
     </form>`,
    { label: "撮る場所を選ぶ" },
  );
  if (!value || value === "cancel") return null;
  part = value;

  // 2. 撮る
  const blob = await takePhoto({ ghostUrl: lastByPart[part]?.thumb || null, title: `${part}を撮る` });
  if (!blob) return null;

  // 3. メモして保存
  const previewUrl = URL.createObjectURL(blob);
  const result = await openSheet(
    `<form method="dialog" class="sheet-body" id="photo-meta">
       <h2 class="sheet-title">${h(part)}の写真を保存</h2>
       <img class="sheet-photo" src="${previewUrl}" alt="撮った写真">
       ${
         lastByPart[part]
           ? `<p class="muted small">前回（${formatDate(lastByPart[part].date)}）の写真と、あとで「くらべる」で並べて見られます。</p>`
           : ""
       }
       <div class="grid-2">
         <div>
           <label for="ph-date">撮った日</label>
           <input id="ph-date" name="date" type="date" value="${h(date)}" max="${today()}">
         </div>
         <div>
           <label for="ph-part">場所</label>
           <select id="ph-part" name="part">${PARTS.map((p) => `<option ${p === part ? "selected" : ""}>${p}</option>`).join("")}</select>
         </div>
       </div>
       <div>
         <label for="ph-memo">様子のメモ <span class="hint">受診歴のまとめにも使われます</span></label>
         <textarea id="ph-memo" name="memo" rows="3" maxlength="300" placeholder="例：右の内股。赤みは500円玉くらい。昨日より少し広がった。かゆがる。"></textarea>
       </div>
       <div class="sheet-actions">
         <button value="cancel" class="btn">保存しない</button>
         <button value="save" class="btn btn-primary">保存する</button>
       </div>
     </form>`,
    {
      label: "写真を保存",
      onOpen: (d) => {
        d.querySelector("form").addEventListener("submit", (e) => {
          const f = new FormData(e.target);
          d.dataset.date = String(f.get("date") || today());
          d.dataset.part = String(f.get("part") || part);
          d.dataset.memo = String(f.get("memo") || "").trim();
        });
      },
    },
  );
  URL.revokeObjectURL(previewUrl);
  if (result.value !== "save") return null;

  const d = result.dialog.dataset;
  const photo = await store.savePhoto({
    id: store.newId(),
    petId: pet.id,
    visitId,
    date: d.date || date,
    part: d.part || part,
    memo: d.memo || "",
    blob,
    thumb: await makeThumb(blob),
    createdAt: new Date().toISOString(),
  });
  toast("写真を保存しました");
  return photo;
}

// ============================================================
// 説明を記録する（準備 → 録音 → 確認してまとめる）
// ============================================================

function getRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

async function viewRecord(petId) {
  const pet = await store.getPet(petId);
  if (!pet) return notFound();
  const visits = await store.listVisits(petId);
  const clinics = [...new Set(visits.map((v) => v.clinic).filter(Boolean))];
  const visitId = store.newId(); // 録音中に撮った写真をこの受診につなげるため、先に決めておく
  const supported = Boolean(getRecognition());
  document.title = `説明を記録 | ${pet.name}`;

  const STEP_NAMES = ["準備", "録音", "確認してまとめる"];
  let step = 0;
  let transcript = "";
  let recording = false;
  let want = false;
  let rec = null;
  let seconds = 0;
  let timer = null;
  let attached = [];

  app.innerHTML = `
    ${back(`#/pet/${pet.id}`, `${pet.name}のページにもどる`)}
    <h1 class="with-avatar">${avatar(pet, "avatar-sm")}<span>${h(pet.name)}の説明を記録</span></h1>
    ${aiNotice()}
    <ol class="steps" aria-label="進み具合">
      ${STEP_NAMES.map((n, i) => `<li data-step="${i}">${i + 1}. ${n}</li>`).join("")}
    </ol>

    <section class="stack" data-panel="0">
      <h2 class="step-title"><span class="step-num">1</span>はじめに確認します</h2>
      <label class="choice">
        <input type="checkbox" id="consent">
        <span>獣医師・スタッフに「録音して、家族向けにまとめたい」と伝え、了承をもらいました
          <span class="hint">了承がないと記録できません</span></span>
      </label>
      <div class="grid-2">
        <div>
          <label for="date">受診日</label>
          <input id="date" type="date" value="${today()}" max="${today()}">
        </div>
        <div>
          <label for="clinic">病院 <span class="hint">書かなくてもOK</span></label>
          <input id="clinic" list="clinic-list" maxlength="60" value="${h(clinics[0] || "")}" placeholder="例：さくら動物病院">
          <datalist id="clinic-list">${clinics.map((c) => `<option value="${h(c)}">`).join("")}</datalist>
        </div>
      </div>
      <fieldset class="tiles">
        <legend class="label">どんな場面の説明ですか？</legend>
        ${SCENES.map(
          (s, i) => `<label class="tile"><input type="radio" name="scene" value="${s}" ${i === 0 ? "checked" : ""}><span>${s}</span></label>`,
        ).join("")}
      </fieldset>
      <div>
        <label for="vet">説明してくれた人 <span class="hint">書かなくてもOK</span></label>
        <input id="vet" maxlength="60" placeholder="例：佐藤先生">
      </div>
      <button type="button" class="btn btn-primary btn-big" data-go="1" id="to-rec" disabled>次へ進む →</button>
      <p class="muted small center" id="consent-hint">上の四角を押してチェックを入れると進めます</p>
    </section>

    <section class="stack" data-panel="1" hidden>
      <h2 class="step-title"><span class="step-num">2</span>説明を録音します</h2>
      ${
        supported
          ? `<p class="muted">説明が始まったら、下の丸いボタンを押してください。終わったらもう一度押します。</p>
             <div class="rec-wrap">
               <button type="button" class="rec-btn" id="rec-btn" aria-pressed="false">
                 <span class="rec-icon" aria-hidden="true">🎙</span><span id="rec-label">押して録音</span>
               </button>
               <div class="timer" id="timer" hidden></div>
             </div>
             <div class="alert alert-error" role="alert" id="speech-error" hidden></div>
             <div class="card live-card" id="live" aria-live="polite" hidden>
               <div class="label">聞き取れた言葉（最後の部分）</div>
               <div class="transcript" id="live-text"></div>
             </div>`
          : `<p class="notice">このブラウザでは録音で文字にする機能が使えません。iPhoneは「Safari」、Androidは「Chrome」で開いてください。
             または「文字で入力する」を押して、内容を書いてください。</p>`
      }
      <button type="button" class="btn btn-accent btn-wide" id="rec-photo">📷 診察中の写真を撮る（あとでもOK）</button>
      <div id="attached-1"></div>
      <button type="button" class="btn btn-primary btn-big" data-go="2" id="to-confirm" ${supported ? "disabled" : ""}>次へ（内容を確認） →</button>
      <div class="spread">
        <button type="button" class="btn" data-go="0">← もどる</button>
        <button type="button" class="btn btn-ghost" data-go="2" id="type-instead">録音せずに文字で入力する</button>
      </div>
    </section>

    <section class="stack" data-panel="2" hidden>
      <h2 class="step-title"><span class="step-num">3</span>内容を確認して、まとめます</h2>
      <div>
        <label for="transcript">説明の内容 <span class="hint">聞き間違いがあれば直してください。直さなくても、まとめられます。</span></label>
        <textarea id="transcript" rows="10" placeholder="ここに説明の内容が入ります。直接書いたり、貼り付けたりもできます。"></textarea>
        <div class="spread small">
          <span class="muted" id="count">0 文字</span>
          <button type="button" class="btn btn-ghost btn-sm" id="sample">お試し用の会話を入れる</button>
        </div>
      </div>
      <div id="attached-2"></div>
      <div class="alert alert-error" role="alert" id="sum-error" hidden></div>
      <button type="button" class="btn btn-primary btn-big" id="summarize" disabled>
        <span class="btn-icon" aria-hidden="true">✨</span>
        <span>わかりやすくまとめる<span class="btn-sub">家族向けのまとめと、受診歴の記録を作ります</span></span>
      </button>
      <p class="muted small center" id="len-hint">説明の内容を20文字以上入れると押せます</p>
      <button type="button" class="btn" data-go="1">← 録音にもどる</button>
    </section>`;

  const ta = $("#transcript");

  function setStep(n) {
    stopRec();
    step = n;
    $$("[data-panel]").forEach((p) => (p.hidden = Number(p.dataset.panel) !== n));
    $$(".steps li").forEach((li) => {
      const i = Number(li.dataset.step);
      li.dataset.state = i < n ? "done" : i === n ? "current" : "todo";
      if (i === n) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    if (n === 2) {
      ta.value = transcript;
      updateCount();
    }
    window.scrollTo({ top: 0 });
    $(`[data-panel="${n}"] .step-title`)?.focus?.();
  }
  $$(".step-title").forEach((t) => (t.tabIndex = -1));

  $("#consent").onchange = (e) => {
    $("#to-rec").disabled = !e.target.checked;
    $("#consent-hint").hidden = e.target.checked;
  };
  $$("[data-go]").forEach((b) => (b.onclick = () => setStep(Number(b.dataset.go))));

  // ---- 録音 ----
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  function paintRec(interim = "") {
    if (!supported) return;
    $("#rec-btn").classList.toggle("recording", recording);
    $("#rec-btn").setAttribute("aria-pressed", String(recording));
    $(".rec-icon").textContent = recording ? "■" : "🎙";
    $("#rec-label").textContent = recording ? "押して止める" : transcript ? "続きを録音" : "押して録音";
    $("#timer").hidden = !(recording || seconds);
    $("#timer").textContent = `${recording ? "● 録音中 " : "録音した時間 "}${fmt(seconds)}`;
    $("#live").hidden = !(transcript || interim);
    const last = transcript.split("\n").slice(-3).join("\n");
    $("#live-text").innerHTML = h(last) + (interim ? `<span class="live">${transcript ? "\n" : ""}${h(interim)}</span>` : "");
    $("#to-confirm").disabled = !transcript;
    $("#to-confirm").textContent = recording ? "録音を止めて次へ →" : "次へ（内容を確認） →";
    $("#type-instead").hidden = Boolean(transcript);
  }

  function startRec() {
    const Ctor = getRecognition();
    rec = new Ctor();
    rec.lang = "ja-JP";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let fin = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (fin) transcript = transcript ? `${transcript}\n${fin}` : fin;
      paintRec(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech") return;
      want = false;
      $("#speech-error").hidden = false;
      $("#speech-error").textContent =
        e.error === "not-allowed"
          ? "マイクが使えません。画面の上に出る「マイクの使用を許可」を押してください。出ない場合はブラウザの設定でマイクを許可してください。"
          : `うまく聞き取れませんでした（${e.error}）。もう一度押してください。`;
    };
    // ブラウザは無音が続くと聞き取りを自動で止めるので、録音中なら再開する
    rec.onend = () => {
      if (want) {
        try {
          rec.start();
          return;
        } catch {
          /* 止める */
        }
      }
      recording = false;
      clearInterval(timer);
      paintRec();
    };
    want = true;
    recording = true;
    $("#speech-error").hidden = true;
    rec.start();
    timer = setInterval(() => {
      seconds += 1;
      paintRec();
    }, 1000);
    paintRec();
  }
  function stopRec() {
    want = false;
    try {
      rec?.stop();
    } catch {
      /* すでに止まっている */
    }
    recording = false;
    clearInterval(timer);
    if (supported && $("#rec-btn")) paintRec();
  }
  if (supported) $("#rec-btn").onclick = () => (recording ? stopRec() : startRec());
  cleanup = stopRec;

  // ---- 写真 ----
  function paintAttached() {
    const html = attached.length
      ? `<div class="attached"><p class="label">この受診に添える写真（${attached.length}枚）</p>
           <ul class="photo-strip">${attached
             .map((p) => `<li><span class="photo-thumb"><img src="${h(p.thumb)}" alt="${h(p.part)}"><span class="photo-cap">${h(p.part)}</span></span></li>`)
             .join("")}</ul></div>`
      : "";
    $("#attached-1").innerHTML = html;
    $("#attached-2").innerHTML = html;
  }
  $("#rec-photo").onclick = async () => {
    const wasRecording = recording;
    const photo = await photoFlow(pet, { visitId, date: $("#date").value || today() });
    if (photo) {
      attached.push(photo);
      paintAttached();
    }
    // 写真を撮っている間も録音は続く（ブラウザが止めた場合は再開ボタンを押す）
    if (wasRecording && !recording) paintRec();
  };

  // ---- 確認してまとめる ----
  function updateCount() {
    transcript = ta.value;
    $("#count").textContent = `${ta.value.length.toLocaleString()} 文字`;
    const ok = ta.value.trim().length >= 20;
    $("#summarize").disabled = !ok;
    $("#len-hint").hidden = ok;
  }
  ta.oninput = updateCount;
  $("#sample").onclick = () => {
    ta.value = SAMPLE;
    updateCount();
  };

  $("#summarize").onclick = async () => {
    const payload = {
      pet: petForAi(pet),
      date: $("#date").value || today(),
      scene: $('input[name="scene"]:checked')?.value || "その他",
      clinic: $("#clinic").value.trim(),
      vet: $("#vet").value.trim(),
      transcript: ta.value.trim(),
      consent: $("#consent").checked,
    };
    const hide = showLoading("わかりやすい言葉にまとめています", "30秒から1分ほどかかります。<br>この画面のまま、お待ちください。");
    $("#sum-error").hidden = true;
    if (aiStatus.offline) await loadStatus();
    try {
      const out = aiStatus.server ? await postJson("/api/visit-summary", payload) : localDemoVisit(payload.transcript);
      const visit = await store.saveVisit({
        id: visitId,
        petId: pet.id,
        date: payload.date,
        scene: payload.scene,
        clinic: payload.clinic,
        vet: payload.vet,
        transcript: payload.transcript,
        title: out.result.title,
        family: out.result.family,
        record: out.result.record,
        model: out.model,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        createdAt: new Date().toISOString(),
      });
      hide();
      go(`#/visit/${visit.id}`);
    } catch (e) {
      hide();
      $("#sum-error").hidden = false;
      $("#sum-error").textContent = e.message;
    }
  };

  setStep(0);
}

// ============================================================
// まとめの画面：「今日の説明」と「これまでの受診歴」をボタン一つで切り替え
// ============================================================

async function viewHistoryEntry(petId) {
  const visits = await store.listVisits(petId);
  if (!visits.length) return go(`#/pet/${petId}`);
  location.replace(`#/visit/${visits[0].id}?tab=history`);
}

async function viewVisit(id, query) {
  const visit = await store.getVisit(id);
  if (!visit) return notFound();
  const pet = await store.getPet(visit.petId);
  if (!pet) return notFound();
  const [visits, visitPhotos, allPhotos, savedHistory] = await Promise.all([
    store.listVisits(pet.id),
    store.listVisitPhotos(visit.id),
    store.listPhotos(pet.id),
    store.getHistory(pet.id),
  ]);
  let tab = query.get("tab") === "history" ? "history" : "family";
  document.title = `${visit.title} | ${pet.name}`;

  const f = visit.family;
  const visitKey = visits.map((v) => `${v.id}:${v.createdAt}`).sort().join("|");

  app.innerHTML = `
    ${back(`#/pet/${pet.id}`, `${pet.name}のページにもどる`)}
    <div class="page-head">
      <p class="muted small meta-line">
        ${avatar(pet, "avatar-xs")}<span>${h(pet.name)}</span>
        <span>・${formatDate(visit.date)}</span>
      </p>
      <h1 id="page-title"></h1>
      <p class="visit-tags"><span class="badge">${h(visit.scene)}</span>${[visit.clinic, visit.vet].filter(Boolean).map((t) => `<span class="muted small">${h(t)}</span>`).join("")}</p>
    </div>

    <div class="segmented no-print" role="tablist" aria-label="表示の切り替え">
      <button type="button" role="tab" id="tab-family" aria-controls="panel-family">
        <span aria-hidden="true">🐾</span> 今日の説明<small>家族にわかりやすく</small>
      </button>
      <button type="button" role="tab" id="tab-history" aria-controls="panel-history">
        <span aria-hidden="true">📚</span> これまでの受診歴<small>経過をまとめて見る</small>
      </button>
    </div>

    <div role="tabpanel" id="panel-family" aria-labelledby="tab-family">
      <section class="card headline-card">
        <p class="headline">${h(f.headline)}</p>
        <p>${h(f.explanation)}</p>
        <div class="no-print" id="read-aloud"></div>
      </section>
      ${f.warning_signs.length ? section({ icon: "⚠️", title: "こんな様子なら、早めに病院へ連絡", body: list(f.warning_signs), tone: "warn-card" }) : ""}
      ${section({ icon: "📌", title: "大事なこと", body: list(f.key_points) })}
      ${
        f.medicines.length
          ? section({
              icon: "💊",
              title: "お薬",
              body: `<ul class="med-list">${f.medicines
                .map(
                  (m) => `<li class="med">
                    <p class="med-name">${h(m.name)}</p>
                    ${m.purpose && m.purpose !== "記載なし" ? `<p><span class="med-label">何の薬</span>${h(m.purpose)}</p>` : ""}
                    ${m.how_to_give && m.how_to_give !== "記載なし" ? `<p><span class="med-label">あげ方</span>${h(m.how_to_give)}</p>` : ""}
                  </li>`,
                )
                .join("")}</ul>`,
            })
          : ""
      }
      ${section({ icon: "🏠", title: "おうちですること・気をつけること", body: list(f.home_care) })}
      ${section({ icon: "📅", title: "これからの予定", body: list(f.next_schedule, "説明の中では、予定の話はありませんでした") })}
      ${
        f.glossary.length
          ? `<details class="card section-card">
               <summary><span class="section-icon" aria-hidden="true">📖</span>むずかしい言葉の意味（${f.glossary.length}語）</summary>
               <dl class="glossary">${f.glossary.map((g) => `<div><dt>${h(g.term)}</dt><dd>${h(g.plain)}</dd></div>`).join("")}</dl>
             </details>`
          : ""
      }
      ${f.confirm_with_vet.length ? section({ icon: "❓", title: "次に病院で確認しましょう", body: list(f.confirm_with_vet) }) : ""}
      ${section({
        icon: "📷",
        title: "この日の写真",
        body: `${
          visitPhotos.length
            ? `<ul class="photo-strip">${visitPhotos
                .map(
                  (p) => `<li><a class="photo-thumb" href="#/pet/${pet.id}/photos?open=${p.id}">
                    <img src="${h(p.thumb)}" alt="${h(p.part)}"><span class="photo-cap">${h(p.part)}</span></a></li>`,
                )
                .join("")}</ul>`
            : `<p class="muted">この受診の写真はまだありません。</p>`
        }
        <button type="button" class="btn btn-accent btn-wide no-print" id="add-visit-photo">📷 この受診に写真を追加</button>`,
      })}
      <p class="notice">これはAIが説明をまとめたものです。まちがいが入ることがあります。お薬や治療のことは自分で決めずに、必ず獣医師に確認してください。</p>
    </div>

    <div role="tabpanel" id="panel-history" aria-labelledby="tab-history" hidden>
      <div id="history-body"></div>
    </div>

    <section class="card no-print" id="share">
      <h2 class="section-title"><span class="section-icon" aria-hidden="true">💌</span><span id="share-title">家族に送る</span></h2>
      <p class="muted" id="share-desc"></p>
      <div class="stack-sm">
        <a class="btn btn-big btn-line" id="share-line" target="_blank" rel="noreferrer">
          <span class="btn-icon" aria-hidden="true">💬</span><span>LINEで送る<span class="btn-sub">送る相手は LINE の画面で選びます</span></span>
        </a>
        ${navigator.share ? `<button type="button" class="btn btn-wide" id="share-device">📤 ほかの方法で送る（メールなど）</button>` : ""}
        <button type="button" class="btn btn-wide" id="share-copy">📋 文章をコピーする</button>
        <details><summary>送る文章を見る</summary><div class="transcript" id="share-text"></div></details>
      </div>
    </section>

    <section class="card" id="original">
      <details>
        <summary>もとの説明（録音した文字）を見る</summary>
        <p class="muted small">まとめた内容に「あれ？」と思ったら、もとの説明と見比べて、獣医師に確認してください。</p>
        <div class="transcript">${h(visit.transcript)}</div>
      </details>
    </section>

    <div class="stack no-print">
      <button type="button" class="btn btn-wide" id="print">🖨 印刷する</button>
      <button type="button" class="btn btn-danger-ghost" id="delete-visit">この記録を消す</button>
    </div>
    <p class="muted small usage">${h(usageText(visit))}</p>`;

  // ---- 読み上げ ----
  if ("speechSynthesis" in window) {
    const part = (t, items) => (items.length ? `${t}。${items.join("。")}。` : "");
    const text = [
      f.headline, f.explanation,
      part("こんな様子なら、早めに病院へ連絡してください", f.warning_signs),
      part("大事なこと", f.key_points),
      part("お薬", f.medicines.map((m) => `${m.name}、${m.how_to_give}`)),
      part("おうちですること", f.home_care),
      part("これからの予定", f.next_schedule),
    ].join("");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-wide";
    const paint = (on) => {
      btn.innerHTML = on ? "■ 読み上げを止める" : "🔊 声で読み上げる";
      btn.classList.toggle("btn-danger", on);
      btn.setAttribute("aria-pressed", String(on));
    };
    paint(false);
    btn.onclick = () => {
      if (speechSynthesis.speaking) {
        speechSynthesis.cancel();
        return paint(false);
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      u.rate = 0.9;
      u.onend = u.onerror = () => paint(false);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      paint(true);
    };
    $("#read-aloud").append(btn);
  }

  // ---- これまでの受診歴 ----
  let currentHistory = savedHistory;
  function paintHistory() {
    if (!$("#history-body")) return; // 別の画面に移ったあと
    const r = currentHistory?.result;
    const fresh = currentHistory && currentHistory.visitKey === visitKey && currentHistory.photoCount === allPhotos.length;
    const photosByPart = {};
    for (const p of [...allPhotos].reverse()) (photosByPart[p.part] ||= []).push(p);

    const localTimeline = `
      <ol class="timeline">
        ${visits
          .map(
            (v) => `<li class="${v.id === visit.id ? "is-current" : ""}">
              <a href="#/visit/${v.id}">
                <span class="tl-date">${formatDate(v.date)}</span>
                <span class="tl-title">${h(v.title)}${v.id === visit.id ? ` <span class="badge badge-soft">今見ている記録</span>` : ""}</span>
                <span class="muted small">${h([v.scene, v.clinic].filter(Boolean).join("・"))}</span>
                ${v.record?.medications?.length ? `<span class="small tl-meds">💊 ${h(v.record.medications.join(" / "))}</span>` : ""}
              </a>
            </li>`,
          )
          .join("")}
      </ol>`;

    const photoLog = Object.keys(photosByPart).length
      ? `<div class="part-log">
          ${Object.entries(photosByPart)
            .map(
              ([part, ps]) => `
            <div class="part-row">
              <p class="part-name">${h(part)} <span class="muted small">${ps.length}枚</span></p>
              <ul class="photo-strip">
                ${ps
                  .map(
                    (p) => `<li><a class="photo-thumb" href="#/pet/${pet.id}/photos?open=${p.id}">
                      <img src="${h(p.thumb)}" alt="${h(`${part} ${formatShortDate(p.date)}`)}" loading="lazy">
                      <span class="photo-cap">${formatShortDate(p.date)}</span></a></li>`,
                  )
                  .join("")}
              </ul>
            </div>`,
            )
            .join("")}
          <a class="text-link no-print" href="#/pet/${pet.id}/photos">写真を並べてくらべる ›</a>
        </div>`
      : `<p class="muted">写真はまだありません。</p>`;

    $("#history-body").innerHTML = `
      <section class="card headline-card history-head">
        <p class="eyebrow">${h(pet.name)}のこれまで ・ 受診${visits.length}回${allPhotos.length ? ` ・ 写真${allPhotos.length}枚` : ""}</p>
        ${
          r
            ? `<p>${h(r.overview)}</p>
               <p class="muted small">${fresh ? "最新の記録でまとめています" : "⚠ まとめた後に記録が増えました。まとめ直すと最新になります"}（${h(formatDate(currentHistory.updatedAt.slice(0, 10)))}作成）</p>`
            : `<p>受診の記録と写真のメモをもとに、AIが経過を1枚にまとめます。ほかの病院やペットシッターさんに見せるときにも使えます。</p>`
        }
        <div class="alert alert-error" role="alert" id="hist-error" hidden></div>
        <button type="button" class="btn ${r && fresh ? "" : "btn-primary"} btn-wide no-print" id="make-history">
          ✨ ${r ? "最新の記録でまとめ直す" : "受診歴をまとめる"}
        </button>
      </section>

      ${
        r
          ? `
        ${r.cautions.length ? section({ icon: "⚠️", title: "伝えておきたい注意点", body: list(r.cautions), tone: "warn-card" }) : ""}
        ${section({ icon: "🩺", title: "続いている症状・様子を見ていること", body: list(r.ongoing) })}
        ${section({ icon: "💊", title: "今のお薬", body: list(r.current_medicines, "記録の中では、続いているお薬はありません") })}
        ${section({ icon: "📅", title: "これからの予定", body: list(r.upcoming, "予定の記録はありません") })}
        ${section({ icon: "🛡", title: "ワクチン・予防", body: list(r.preventive_care, "予防の記録はありません") })}
        ${section({ icon: "⚖️", title: "体重の変化", body: `<p>${h(r.weight_trend)}</p>` })}
        ${r.questions_for_next_visit.length ? section({ icon: "❓", title: "次の受診で聞いてみること", body: list(r.questions_for_next_visit) }) : ""}
        ${
          r.timeline.length
            ? section({
                icon: "🗓",
                title: "受診の流れ（AIのまとめ）",
                body: `<ol class="timeline timeline-plain">${r.timeline
                  .map((t) => `<li><span class="tl-date">${h(t.date)}</span><span>${h(t.event)}</span></li>`)
                  .join("")}</ol>`,
              })
            : ""
        }`
          : ""
      }

      ${section({ icon: "📋", title: `受診の一覧（${visits.length}件）`, body: localTimeline })}
      ${section({ icon: "📷", title: "写真の記録（場所ごと・古い順）", body: photoLog })}
      ${r ? `<p class="notice">これはAIが記録をまとめたものです。まちがいが入ることがあります。気になる点は獣医師に確認してください。</p>` : ""}
      ${r ? `<p class="muted small usage">${h(usageText(currentHistory))}</p>` : ""}`;

    $("#make-history").onclick = async () => {
      const ordered = [...visits].reverse();
      const payload = {
        pet: petForAi(pet),
        visits: ordered.map((v) => ({ date: v.date, clinic: v.clinic, scene: v.scene, title: v.title, record: v.record })),
        photos: [...allPhotos].reverse().map((p) => ({ date: p.date, part: p.part, memo: p.memo })),
      };
      const hide = showLoading("これまでの受診歴をまとめています", `受診${visits.length}回分を読みこんでいます。<br>30秒から1分ほど、お待ちください。`);
      try {
        const out = aiStatus.server ? await postJson("/api/history-summary", payload) : localDemoHistory(visits);
        currentHistory = await store.saveHistory({
          petId: pet.id,
          result: out.result,
          visitKey,
          photoCount: allPhotos.length,
          model: out.model,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          updatedAt: new Date().toISOString(),
        });
        hide();
        paintHistory();
        paintShare();
        toast("受診歴をまとめました");
      } catch (e) {
        hide();
        $("#hist-error").hidden = false;
        $("#hist-error").textContent = e.message;
      }
    };
  }

  // ---- 送る文章 ----
  const DISCLAIMER = "※AIがまとめたものです。まちがいが入ることがあります。お薬や治療のことは、必ず獣医師に確認してください。";
  const block = (title, items) => (items?.length ? [`■ ${title}`, ...items.map((i) => `・${i}`), ""] : []);
  function familyText() {
    return [
      `【MediKataru for pet】${pet.name}の受診のまとめ`,
      `${formatDate(visit.date)}（${[visit.scene, visit.clinic, visit.vet].filter(Boolean).join("／")}）`,
      "",
      "■ ひとことで",
      f.headline,
      "",
      f.explanation,
      "",
      ...block("こんな様子なら早めに病院へ連絡", f.warning_signs),
      ...block("大事なこと", f.key_points),
      ...block("お薬", f.medicines.map((m) => `${m.name}：${[m.purpose, m.how_to_give].filter((x) => x && x !== "記載なし").join("。")}`)),
      ...block("おうちですること", f.home_care),
      ...block("これからの予定", f.next_schedule),
      DISCLAIMER,
    ].join("\n");
  }
  function historyText() {
    const r = currentHistory?.result;
    const head = [`【MediKataru for pet】${pet.name}のこれまでの受診歴`, [pet.species, pet.breed, ageText(pet.birthday)].filter(Boolean).join("・"), ""];
    if (!r) {
      return [...head, ...block("受診の一覧", [...visits].reverse().map((v) => `${formatDate(v.date)} ${v.title}`)), DISCLAIMER].join("\n");
    }
    return [
      ...head,
      r.overview,
      "",
      ...block("注意点", r.cautions),
      ...block("続いていること", r.ongoing),
      ...block("今のお薬", r.current_medicines),
      ...block("これからの予定", r.upcoming),
      ...block("ワクチン・予防", r.preventive_care),
      ...(r.weight_trend && r.weight_trend !== "記録なし" ? ["■ 体重", r.weight_trend, ""] : []),
      ...block("受診の流れ", r.timeline.map((t) => `${t.date} ${t.event}`)),
      DISCLAIMER,
    ].join("\n");
  }
  function paintShare() {
    const text = tab === "family" ? familyText() : historyText();
    $("#share-title").textContent = tab === "family" ? "家族に送る" : "受診歴を送る";
    $("#share-desc").textContent =
      tab === "family"
        ? "あなたのスマホの LINE やメールが開き、「今日の説明」のまとめが入った状態になります。もとの説明（録音した文字）は入りません。"
        : "「これまでの受診歴」のまとめを送れます。ほかの病院・ペットホテル・ペットシッターさんに伝えるときにも使えます。写真は入りません。";
    $("#share-text").textContent = text;
    $("#share-line").href = `https://line.me/R/share?text=${encodeURIComponent(text)}`;
    $("#share-line").onclick = () => toast("LINEを開きます。送る相手を選んでください。");
    if ($("#share-device")) {
      $("#share-device").onclick = async () => {
        try {
          await navigator.share({ title: `${pet.name}のまとめ`, text });
        } catch (e) {
          if (e?.name !== "AbortError") toast("この方法は使えませんでした。「文章をコピーする」を使ってください。");
        }
      };
    }
    $("#share-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast("コピーしました。LINEやメールに貼り付けて送ってください。");
      } catch {
        toast("コピーできませんでした。「送る文章を見る」から文字を選んでコピーしてください。");
      }
    };
  }

  // ---- 切り替え ----
  function setTab(next, focus = false) {
    tab = next;
    const isFamily = tab === "family";
    $("#tab-family").setAttribute("aria-selected", String(isFamily));
    $("#tab-history").setAttribute("aria-selected", String(!isFamily));
    $("#tab-family").tabIndex = isFamily ? 0 : -1;
    $("#tab-history").tabIndex = isFamily ? -1 : 0;
    $("#panel-family").hidden = !isFamily;
    $("#panel-history").hidden = isFamily;
    $("#original").hidden = !isFamily;
    $("#page-title").textContent = isFamily ? visit.title : `${pet.name}のこれまでの受診歴`;
    document.body.dataset.tab = tab;
    if (!isFamily && !$("#history-body").innerHTML) paintHistory();
    paintShare();
    window.history.replaceState(null, "", `#/visit/${visit.id}${isFamily ? "" : "?tab=history"}`);
    if (focus) $(isFamily ? "#tab-family" : "#tab-history").focus();
  }
  $("#tab-family").onclick = () => setTab("family");
  $("#tab-history").onclick = () => setTab("history");
  $(".segmented").addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") setTab(tab === "family" ? "history" : "family", true);
  });
  cleanup = () => delete document.body.dataset.tab;
  setTab(tab);

  // ---- そのほか ----
  $("#add-visit-photo").onclick = async () => {
    const photo = await photoFlow(pet, { visitId: visit.id, date: visit.date });
    if (photo) render();
  };
  $("#print").onclick = () => window.print();
  $("#delete-visit").onclick = async () => {
    const ok = await confirmDialog({
      title: "この記録を消しますか？",
      message: "消すと元にもどせません。この日の写真は消えずに「写真の記録」に残ります。",
      ok: "消す",
      danger: true,
    });
    if (!ok) return;
    await store.deleteVisit(visit.id);
    toast("消しました");
    go(`#/pet/${pet.id}`);
  };
}

// ============================================================
// 写真の記録：場所ごとに見る・2枚を並べてくらべる
// ============================================================

async function viewPhotos(petId, query) {
  const pet = await store.getPet(petId);
  if (!pet) return notFound();
  const photos = await store.listPhotos(petId);
  const visits = await store.listVisits(petId);
  const visitById = Object.fromEntries(visits.map((v) => [v.id, v]));
  const parts = [...new Set(photos.map((p) => p.part))];
  let filter = query.get("part") || "すべて";
  let compare = false;
  let selected = [];
  document.title = `写真の記録 | ${pet.name}`;

  app.innerHTML = `
    ${back(`#/pet/${pet.id}`, `${pet.name}のページにもどる`)}
    <div class="page-head">
      <h1 class="with-avatar">${avatar(pet, "avatar-sm")}<span>${h(pet.name)}の写真の記録</span></h1>
      <p class="muted">同じ場所を時々撮っておくと、良くなっているか・広がっているかが一目でわかります。</p>
    </div>
    <div class="action-grid">
      <button type="button" class="btn btn-accent btn-big" id="take">
        <span class="btn-icon" aria-hidden="true">📷</span><span>写真を撮る<span class="btn-sub">前回の写真を重ねて撮れます</span></span>
      </button>
      <button type="button" class="btn btn-big" id="compare-toggle" ${photos.length < 2 ? "disabled" : ""}>
        <span class="btn-icon" aria-hidden="true">◧</span><span id="compare-label">2枚をくらべる<span class="btn-sub">前と今を並べて見る</span></span>
      </button>
    </div>
    <p class="compare-help notice" id="compare-help" hidden>くらべたい写真を<b>2枚</b>押してください。</p>
    <div class="filter-chips no-print" role="group" aria-label="場所でしぼる" id="filters"></div>
    <div id="gallery"></div>`;

  function paintFilters() {
    $("#filters").innerHTML = ["すべて", ...parts]
      .map((p) => `<button type="button" class="chip-btn" aria-pressed="${p === filter}" data-part="${h(p)}">${h(p)}</button>`)
      .join("");
  }
  function paintGallery() {
    if (!$("#gallery")) return; // 別の画面に移ったあと
    const shown = photos.filter((p) => filter === "すべて" || p.part === filter);
    if (!shown.length) {
      $("#gallery").innerHTML = `<p class="notice">まだ写真がありません。上の「写真を撮る」から始められます。</p>`;
      return;
    }
    const byMonth = {};
    for (const p of shown) (byMonth[(p.date || "").slice(0, 7)] ||= []).push(p);
    $("#gallery").innerHTML = Object.entries(byMonth)
      .map(
        ([ym, ps]) => `
        <h2 class="month-heading">${ym ? `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月` : "日付なし"}</h2>
        <ul class="photo-grid">
          ${ps
            .map(
              (p) => `<li>
                <button type="button" class="photo-tile ${selected.includes(p.id) ? "is-selected" : ""}" data-photo="${p.id}"
                  aria-label="${h(`${p.part} ${formatDate(p.date)} ${p.memo}`)}" ${compare ? `aria-pressed="${selected.includes(p.id)}"` : ""}>
                  <img src="${h(p.thumb)}" alt="" loading="lazy">
                  <span class="photo-cap">${h(p.part)}<br>${formatShortDate(p.date)}</span>
                  ${compare ? `<span class="select-mark" aria-hidden="true">${selected.includes(p.id) ? selected.indexOf(p.id) + 1 : ""}</span>` : ""}
                </button>
              </li>`,
            )
            .join("")}
        </ul>`,
      )
      .join("");
  }

  $("#filters").onclick = (e) => {
    const b = e.target.closest("[data-part]");
    if (!b) return;
    filter = b.dataset.part;
    paintFilters();
    paintGallery();
  };
  $("#take").onclick = async () => {
    const saved = await photoFlow(pet, {});
    if (saved) render();
  };
  $("#compare-toggle").onclick = () => {
    compare = !compare;
    selected = [];
    $("#compare-help").hidden = !compare;
    $("#compare-label").innerHTML = compare ? "くらべるのをやめる<span class='btn-sub'>ふつうの表示にもどる</span>" : "2枚をくらべる<span class='btn-sub'>前と今を並べて見る</span>";
    $("#compare-toggle").classList.toggle("btn-primary", compare);
    paintGallery();
  };
  $("#gallery").onclick = async (e) => {
    const tile = e.target.closest("[data-photo]");
    if (!tile) return;
    const id = tile.dataset.photo;
    if (!compare) return openPhoto(id);
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id].slice(-2);
    paintGallery();
    if (selected.length === 2) {
      await openCompare(selected.map((sid) => photos.find((p) => p.id === sid)));
      selected = [];
      paintGallery();
    }
  };

  async function openPhoto(id) {
    const p = await store.getPhoto(id);
    if (!p) return;
    const url = p.blob ? blobUrl(p.blob) : p.thumb;
    const v = p.visitId ? visitById[p.visitId] : null;
    const { value, dialog } = await openSheet(
      `<form method="dialog" class="sheet-body sheet-wide">
         <img class="viewer-img" src="${h(url)}" alt="${h(`${p.part} ${formatDate(p.date)}`)}">
         <p class="viewer-meta"><span class="badge">${h(p.part)}</span> ${formatDate(p.date)}</p>
         ${v ? `<p class="small"><a class="text-link" href="#/visit/${v.id}">この日の受診：${h(v.title)} ›</a></p>` : ""}
         <label for="viewer-memo">様子のメモ</label>
         <textarea id="viewer-memo" name="memo" rows="3" maxlength="300">${h(p.memo)}</textarea>
         <div class="sheet-actions sheet-actions-3">
           <button value="delete" class="btn btn-danger-ghost" formnovalidate>消す</button>
           <button value="cancel" class="btn">閉じる</button>
           <button value="save" class="btn btn-primary">メモを保存</button>
         </div>
       </form>`,
      { label: "写真を見る" },
    );
    if (value === "save") {
      await store.savePhoto({ ...p, memo: dialog.querySelector("#viewer-memo").value.trim() });
      toast("メモを保存しました");
      render();
    }
    if (value === "delete") {
      const ok = await confirmDialog({ title: "この写真を消しますか？", message: "消すと元にもどせません。", ok: "消す", danger: true });
      if (!ok) return;
      await store.deletePhoto(p.id);
      toast("消しました");
      render();
    }
    if (query.get("open")) window.history.replaceState(null, "", `#/pet/${pet.id}/photos`);
  }

  async function openCompare([a, b]) {
    const [older, newer] = (a.date || "") <= (b.date || "") ? [a, b] : [b, a];
    const full = await Promise.all([store.getPhoto(older.id), store.getPhoto(newer.id)]);
    const urls = full.map((p) => (p.blob ? blobUrl(p.blob) : p.thumb));
    const days = daysBetween(older.date, newer.date);
    await openSheet(
      `<form method="dialog" class="sheet-body sheet-wide">
         <h2 class="sheet-title">前と今をくらべる</h2>
         <p class="muted small">${days !== null ? `${days}日の間の変化` : ""}${older.part !== newer.part ? "（場所がちがう写真です）" : ""}</p>
         <div class="compare">
           ${[older, newer]
             .map(
               (p, i) => `<figure>
                 <span class="compare-label">${i === 0 ? "前" : "今"}</span>
                 <img src="${h(urls[i])}" alt="${h(`${p.part} ${formatDate(p.date)}`)}">
                 <figcaption><b>${formatDate(p.date)}</b><br><span class="badge">${h(p.part)}</span>${p.memo ? `<br>${h(p.memo)}` : ""}</figcaption>
               </figure>`,
             )
             .join("")}
         </div>
         <div class="sheet-actions"><button value="close" class="btn btn-primary">閉じる</button></div>
       </form>`,
      { label: "写真をくらべる" },
    );
  }

  paintFilters();
  paintGallery();
  if (query.get("open")) openPhoto(query.get("open"));
}

// ============================================================
// 設定：AIの状態・バックアップ
// ============================================================

async function viewSettings() {
  document.title = "設定 | MediKataru for pet";
  const info = await store.storageInfo();
  const mb = (n) => (n / 1024 / 1024).toFixed(1);

  app.innerHTML = `
    ${back("#/", "もどる")}
    <h1>設定</h1>

    ${section({
      icon: "✨",
      title: "AIによるまとめ",
      body: aiStatus.offline
        ? `<p class="notice">📡 電波がないか、サーバーにつながりません。記録や写真は見られます。まとめるのは電波のあるところでお願いします。</p>`
        : aiStatus.ai
          ? `<p class="alert alert-ok">使えます（${h(aiStatus.model)}）</p>`
          : `<p class="notice">${
              aiStatus.server
                ? "お試し表示中です。サーバーに ANTHROPIC_API_KEY を設定すると、AIでまとめられるようになります。"
                : "サーバーにつながっていません。<code>npm start</code> で起動したサーバーから開いてください（今は画面の流れだけ確かめられます）。"
            }</p>`,
    })}

    ${section({
      icon: "📱",
      title: "ホーム画面に追加（アプリのように使う）",
      body: `<div id="install-slot"></div>`,
    })}

    ${section({
      icon: "💾",
      title: "バックアップ",
      body: `
        <p class="muted">記録と写真は、この端末のブラウザの中だけに保存されています。ブラウザのデータを消したり、機種変更したりすると消えてしまうので、ときどきファイルに書き出してください。</p>
        <p class="small"><b id="last-backup">${h(lastBackupText())}</b></p>
        ${info ? `<p class="small">使っている容量：約${mb(info.usage)}MB${info.quota ? ` / 使える目安 ${mb(info.quota)}MB` : ""}</p>` : ""}
        <div class="stack-sm">
          <button type="button" class="btn btn-primary btn-wide" id="export">⬇ ファイルに書き出す（写真も含む）</button>
          <label class="btn btn-wide file-btn">⬆ ファイルから読み込む<input type="file" id="import" accept="application/json,.json"></label>
        </div>`,
    })}

    ${section({
      icon: "🔒",
      title: "プライバシー",
      body: `<ul class="big-list">
          <li>写真はサーバーに送りません。この端末の中だけに保存します。</li>
          <li>「まとめる」を押したときだけ、説明の文字と、受診歴のまとめでは写真のメモ（文字）がAIに送られます。</li>
          <li>録音は、獣医師・スタッフの了承をもらってから行ってください。</li>
        </ul>`,
    })}
    <p class="muted small center">MediKataru for pet ・ これはAIによる下書きです。診断や治療の判断には使わず、必ず獣医師に確認してください。</p>`;

  renderInstallGuide($("#install-slot"));
  $("#export").onclick = async () => {
    if (await runExport()) $("#last-backup").textContent = lastBackupText();
  };
  $("#import").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ok = await confirmDialog({
      title: "バックアップを読み込みますか？",
      message: "同じ記録がある場合は、ファイルの内容で上書きされます。",
      ok: "読み込む",
    });
    if (!ok) return;
    const hide = showLoading("読み込んでいます", "写真が多いと少し時間がかかります。");
    try {
      const r = await store.importAll(JSON.parse(await file.text()));
      markBackedUp(); // 読み込んだ記録は、そのファイルに残っている
      toast(`読み込みました（ペット${r.pets}・受診${r.visits}・写真${r.photos}）`);
      go("#/");
    } catch (err) {
      toast(err.message || "読み込めませんでした");
    } finally {
      hide();
    }
  };
}

// ============================================================
// 文字の大きさ・起動
// ============================================================

function setupTextSize() {
  const KEY = "mkp-text-size";
  const buttons = $$(".textsize button");
  const paint = (size) => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.size === size)));
  paint(document.documentElement.dataset.size || "normal");
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      const size = b.dataset.size;
      if (size === "normal") delete document.documentElement.dataset.size;
      else document.documentElement.dataset.size = size;
      try {
        localStorage.setItem(KEY, size);
      } catch {
        /* 保存できない環境でも、この画面では切り替わる */
      }
      paint(size);
    }),
  );
}

window.addEventListener("hashchange", render);
// 電波がもどったら、AI が使えるかを確かめ直す
window.addEventListener("online", () => loadStatus());
window.addEventListener("offline", () => (aiStatus = { ...aiStatus, offline: true }));
setupTextSize();
initPwa();
await loadStatus();
render();
