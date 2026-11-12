// バックアップの声かけ
// 記録と写真は端末の中だけにあるため、機種変更やブラウザのデータ削除で消えないよう、
// 「最後のバックアップ（なければ最初の記録）から30日」たったら、画面の上でお知らせする。
// 「あとで」を押したら30日間は出さず、31日目にまた出す。
// 日時の保存は localStorage（使えない環境では毎回「まだ」として扱い、画面は普通に動く）

import * as store from "./store.js";
import { h, formatDate, today, toast, showLoading } from "./ui.js";

const LAST_KEY = "mkp-last-backup";
const SNOOZE_KEY = "mkp-backup-snooze";
export const REMIND_DAYS = 30;
const SNOOZE_DAYS = 30;
const DAY = 86400000;

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 保存できない環境でも、この画面では動く */
  }
}

export const lastBackupAt = () => read(LAST_KEY);
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / DAY);

/** 書き出したとき・読み込んだときに呼ぶ（その時点の記録はファイルに残っているため） */
export function markBackedUp() {
  write(LAST_KEY, new Date().toISOString());
  write(SNOOZE_KEY, null);
}

/** 設定画面用の一文 */
export function lastBackupText() {
  const last = lastBackupAt();
  if (!last) return "まだ書き出していません";
  const d = daysSince(last);
  return `最後の書き出し：${formatDate(last.slice(0, 10))}（${d === 0 ? "今日" : `${d}日前`}）`;
}

/** 写真も含めてファイルに書き出す */
export async function runExport() {
  const hide = showLoading("書き出しています", "写真が多いと少し時間がかかります。");
  try {
    const data = await store.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `medikataru-pet-backup-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    markBackedUp();
    toast("書き出しました。「ダウンロード」（iPhoneは「ファイル」アプリ）に保存されます");
    return true;
  } catch {
    toast("書き出せませんでした。もう一度お試しください");
    return false;
  } finally {
    hide();
  }
}

/** お知らせを出すかどうか。出すなら表示に使う情報を返す */
export async function backupReminder(now = Date.now()) {
  const summary = await store.dataSummary();
  if (summary.visits + summary.photos + summary.daily === 0) return null; // 守る記録がまだない
  const snooze = read(SNOOZE_KEY);
  if (snooze && now < new Date(snooze).getTime()) return null;
  const last = lastBackupAt();
  const base = last || summary.firstAt;
  if (!base || now - new Date(base).getTime() < REMIND_DAYS * DAY) return null;
  return { ...summary, last, days: daysSince(base) };
}

/** お知らせを slot の中に描く。出さないときは空のまま */
export async function renderBackupReminder(slot) {
  if (!slot) return;
  const r = await backupReminder();
  if (!r || !slot.isConnected) return;
  const count = [r.visits ? `受診の記録${r.visits}件` : "", r.daily ? `日々の記録${r.daily}日分` : "", r.photos ? `写真${r.photos}枚` : ""].filter(Boolean).join("・");
  slot.innerHTML = `
    <section class="backup-banner" role="region" aria-label="バックアップのお知らせ">
      <p class="backup-title"><span class="backup-icon" aria-hidden="true">💾</span>${
        r.last ? `最後のバックアップから${r.days}日たちました` : "まだバックアップしていません"
      }</p>
      <p class="backup-text">${h(count)}が、このスマホの中だけにあります。機種変更やブラウザのデータ削除で消えないよう、ファイルに書き出しておきましょう。</p>
      <div class="backup-actions">
        <button type="button" class="btn btn-primary" data-backup="now">今すぐバックアップ</button>
        <button type="button" class="btn btn-ghost" data-backup="later">あとで</button>
      </div>
    </section>`;
  slot.querySelector('[data-backup="now"]').onclick = async () => {
    if (await runExport()) slot.innerHTML = "";
  };
  slot.querySelector('[data-backup="later"]').onclick = () => {
    write(SNOOZE_KEY, new Date(Date.now() + SNOOZE_DAYS * DAY).toISOString());
    slot.innerHTML = "";
    toast(`${SNOOZE_DAYS}日後に、もう一度お知らせします`);
  };
}
