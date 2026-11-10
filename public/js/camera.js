// カメラで写真を撮る
// - 対応ブラウザ（https か localhost で開いたとき）は画面の中でカメラを起動する
// - 使えないときは、スマホのカメラアプリ（<input capture>）や写真の選択に切り替える
// - 前回同じ部位を撮った写真を「うすく重ねる」と、同じ角度・距離で撮りやすく、変化を比べやすい

const MAX_SIDE = 1600; // 保存する写真の長い辺。皮膚の様子がわかり、容量も抑えられる大きさ
const QUALITY = 0.85;

export const cameraSupported = () => Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", QUALITY));
}

function drawScaled(source, w, h, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// 選んだ写真ファイルを、保存用の大きさのJPEGにする（向きはブラウザが自動で直す）
export async function resizeImage(file, max = MAX_SIDE) {
  if (window.createImageBitmap) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const blob = await canvasToBlob(drawScaled(bmp, bmp.width, bmp.height, max));
      bmp.close?.();
      return blob;
    } catch {
      // 下の方法で読み直す
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("写真を読み込めませんでした。"));
      i.src = url;
    });
    return await canvasToBlob(drawScaled(img, img.naturalWidth, img.naturalHeight, max));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ファイル選択（スマホではカメラアプリが開く）
export function pickFile({ capture = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (capture) input.setAttribute("capture", "environment");
    input.style.display = "none";
    document.body.append(input);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      resolve(file ? await resizeImage(file) : null);
    });
    // 選ばずに閉じたとき（対応ブラウザのみ）
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    input.click();
  });
}

/**
 * 画面の中でカメラを起動して1枚撮る。撮った写真（Blob）を返す。やめたら null。
 * @param {{ ghostUrl?: string|null, title?: string }} options
 */
export function openCamera({ ghostUrl = null, title = "写真を撮る" } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "camera-dialog";
    dialog.setAttribute("aria-label", title);
    dialog.innerHTML = `
      <div class="camera-stage">
        <video class="camera-video" playsinline muted autoplay></video>
        ${ghostUrl ? `<img class="camera-ghost" alt="">` : ""}
        <div class="camera-guide" aria-hidden="true"></div>
        <img class="camera-shot" alt="撮った写真" hidden>
        <p class="camera-msg" role="status" aria-live="polite">カメラを準備しています…</p>
      </div>
      <div class="camera-bar">
        <div class="camera-row camera-live">
          <button type="button" class="cam-btn" data-cam="close">✕<span>やめる</span></button>
          <button type="button" class="cam-shutter" data-cam="shoot" aria-label="撮る" disabled><span></span></button>
          <button type="button" class="cam-btn" data-cam="flip">⟲<span>切り替え</span></button>
        </div>
        ${
          ghostUrl
            ? `<label class="cam-ghost-toggle camera-live"><input type="checkbox" data-cam="ghost" checked> 前回の写真をうすく重ねる</label>`
            : ""
        }
        <div class="camera-row camera-review" hidden>
          <button type="button" class="btn" data-cam="retake">↺ 撮り直す</button>
          <button type="button" class="btn btn-primary" data-cam="use">この写真を使う</button>
        </div>
        <button type="button" class="cam-link" data-cam="file">カメラが使えないときは、写真を選ぶ</button>
      </div>`;
    document.body.append(dialog);

    const $ = (s) => dialog.querySelector(s);
    if (ghostUrl) $(".camera-ghost").src = ghostUrl;
    const video = $(".camera-video");
    const shot = $(".camera-shot");
    const msg = $(".camera-msg");
    let stream = null;
    let facing = "environment";
    let blob = null;
    let shotUrl = null;

    const stop = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    const finish = (result) => {
      stop();
      if (shotUrl) URL.revokeObjectURL(shotUrl);
      dialog.close();
      dialog.remove();
      resolve(result);
    };

    async function start() {
      stop();
      msg.hidden = false;
      msg.textContent = "カメラを準備しています…";
      $('[data-cam="shoot"]').disabled = true;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        video.srcObject = stream;
        await video.play().catch(() => {});
        video.classList.toggle("mirror", facing === "user");
        msg.hidden = true;
        $('[data-cam="shoot"]').disabled = false;
      } catch (e) {
        msg.textContent =
          e?.name === "NotAllowedError"
            ? "カメラが使えません。ブラウザの設定でカメラを「許可」にしてください。下の「写真を選ぶ」からも取り込めます。"
            : "カメラを起動できませんでした。下の「写真を選ぶ」から取り込めます。";
      }
    }

    function setMode(review) {
      dialog.querySelectorAll(".camera-live").forEach((el) => (el.hidden = review));
      $(".camera-review").hidden = !review;
      shot.hidden = !review;
      video.hidden = review;
      const ghost = $(".camera-ghost");
      if (ghost) ghost.hidden = review || !$('[data-cam="ghost"]').checked;
    }

    dialog.addEventListener("click", async (e) => {
      const action = e.target.closest("[data-cam]")?.dataset.cam;
      if (!action) return;
      if (action === "close") finish(null);
      if (action === "flip") {
        facing = facing === "environment" ? "user" : "environment";
        start();
      }
      if (action === "ghost") {
        $(".camera-ghost").hidden = !e.target.checked;
      }
      if (action === "shoot" && video.videoWidth) {
        const canvas = drawScaled(video, video.videoWidth, video.videoHeight);
        blob = await canvasToBlob(canvas);
        if (shotUrl) URL.revokeObjectURL(shotUrl);
        shotUrl = URL.createObjectURL(blob);
        shot.src = shotUrl;
        setMode(true);
      }
      if (action === "retake") {
        blob = null;
        setMode(false);
      }
      if (action === "use" && blob) finish(blob);
      if (action === "file") {
        stop();
        const picked = await pickFile({ capture: true });
        if (picked) finish(picked);
        else start();
      }
    });
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(null);
    });

    dialog.showModal();
    start();
  });
}

/** カメラが使えれば画面内カメラ、使えなければスマホのカメラアプリ／写真選択 */
export function takePhoto(options) {
  return cameraSupported() ? openCamera(options) : pickFile({ capture: true });
}

/** 一覧表示用の小さい画像（data URL）を作る */
export async function makeThumb(blob, max = 480) {
  const resized = await resizeImage(blob, max);
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(resized);
  });
}
