// 前回選んだ文字の大きさを、画面が表示される前に反映する（ちらつき防止）
try {
  const s = localStorage.getItem("mkp-text-size");
  if (s && s !== "normal") document.documentElement.dataset.size = s;
} catch {
  /* 保存が使えない環境では標準の大きさ */
}
