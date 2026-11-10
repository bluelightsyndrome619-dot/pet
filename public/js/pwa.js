// PWA（ホーム画面に追加できるWebアプリ）まわり
// - Service Worker を登録して、電波がなくても画面が開くようにする
// - 「ホーム画面に追加」の案内を出す（Android は追加ボタン、iPhone は手順を表示）
// - ホーム画面から開いたときは、ブラウザに「データを消さないで」とお願いする

import { toast } from "./ui.js";
import { runExport } from "./backup.js";

const DISMISS_KEY = "mkp-install-dismissed";
let deferredPrompt = null; // Android などで「追加」の画面を出すための合図
const listeners = new Set();

export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;

export function platform() {
  const ua = navigator.userAgent;
  // iPad は「Mac」と名乗るため、タッチ操作できるかで見分ける
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

export function initPwa() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* 登録できなくても、ふつうのWebアプリとして動く */
      });
    });
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    listeners.forEach((fn) => fn());
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    toast("ホーム画面に追加しました");
    listeners.forEach((fn) => fn());
  });
  if (isStandalone()) navigator.storage?.persist?.().catch(() => {});
}

function dismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function guideHtml({ dismissible }) {
  const os = platform();
  const canPrompt = Boolean(deferredPrompt);
  const steps =
    os === "ios"
      ? `<ol class="install-steps">
           <li><b>Safari</b>で開き、画面の下（iPadは上）の <span class="kbd" aria-label="共有">共有ボタン <span aria-hidden="true">⬆︎</span></span> を押す</li>
           <li>下へ動かして「<b>ホーム画面に追加</b>」を押す</li>
           <li>右上の「<b>追加</b>」を押す</li>
         </ol>
         <p class="install-note">⚠ Safariで使っていた記録は、ホーム画面のアプリに引き継がれないことがあります。追加する前に「先にバックアップ」でファイルに書き出し、ホーム画面のアプリの「設定」で読み込んでください。</p>`
      : canPrompt
        ? ""
        : `<ol class="install-steps">
             <li>ブラウザ（Chrome など）の右上の <span class="kbd">︙</span> メニューを押す</li>
             <li>「<b>ホーム画面に追加</b>」または「<b>アプリをインストール</b>」を押す</li>
           </ol>`;
  return `
    <section class="install-card" role="region" aria-label="ホーム画面に追加">
      <div class="install-head">
        <img class="install-icon" src="/icons/apple-touch-icon.png" alt="" width="52" height="52">
        <div>
          <p class="install-title">ホーム画面に追加すると、アプリのように使えます</p>
          <p class="install-text">アイコンからすぐ開けて、電波がなくても記録や写真を見られます。${
            os === "ios" ? "iPhoneでは、記録も消えにくくなります。" : ""
          }</p>
        </div>
      </div>
      ${steps}
      <div class="install-actions">
        ${canPrompt ? `<button type="button" class="btn btn-primary" data-install="prompt">＋ ホーム画面に追加する</button>` : ""}
        ${os === "ios" ? `<button type="button" class="btn btn-accent" data-install="backup">💾 先にバックアップ</button>` : ""}
        ${dismissible ? `<button type="button" class="btn btn-ghost" data-install="dismiss">閉じる</button>` : ""}
      </div>
    </section>`;
}

/**
 * 「ホーム画面に追加」の案内を slot に描く
 * dismissible: 最初の画面用。「閉じる」を押したら、次からは出さない（設定画面ではいつでも見られる）
 */
export function renderInstallGuide(slot, { dismissible = false } = {}) {
  if (!slot) return;
  const paint = () => {
    if (!slot.isConnected) return listeners.delete(paint);
    if (isStandalone()) {
      slot.innerHTML = dismissible
        ? ""
        : `<p class="alert alert-ok">✓ ホーム画面のアプリとして開いています</p>`;
      return;
    }
    if (dismissible && dismissed()) {
      slot.innerHTML = "";
      return;
    }
    slot.innerHTML = guideHtml({ dismissible });
  };
  listeners.add(paint);
  paint();
  slot.onclick = async (e) => {
    const action = e.target.closest("[data-install]")?.dataset.install;
    if (action === "prompt" && deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice.catch(() => ({}));
      deferredPrompt = null;
      if (outcome !== "accepted") toast("あとからでも、設定から追加できます");
      paint();
    }
    if (action === "backup") await runExport();
    if (action === "dismiss") {
      try {
        localStorage.setItem(DISMISS_KEY, "1");
      } catch {
        /* 保存できなくても、この画面では閉じる */
      }
      slot.innerHTML = "";
      toast("「設定」からいつでも見られます");
    }
  };
}

