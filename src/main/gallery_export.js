// gallery_export.js — self-contained client proof gallery.
//
// Extracted from app.js (Phase: app.js split). Generates an HTML gallery in
// `<projectPath>/proofs/gallery/` for client review: a single index.html with
// vanilla JS — swipeable / arrow-keyed browsing, per-page Approve/Comment
// persisted to localStorage, and an "Export feedback" download.

const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const guards = require('../ipc_guards')
const telemetry = require('../telemetry')

function registerGalleryExportHandler() {
  ipcMain.handle('export-proof-gallery', async (event, payload) => {
    payload = guards.reqObject(payload, 'payload', 'export-proof-gallery')
    // payload = { projectPath, pages: [{ pageNum, proofPath, label }], albumName }
    const galleryDir = path.join(payload.projectPath, 'proofs', 'gallery')
    fs.mkdirSync(galleryDir, { recursive: true })
    fs.mkdirSync(path.join(galleryDir, 'pages'), { recursive: true })

    // Copy each proof JPEG into the gallery so the folder is self-contained
    // and can be zipped or dropped onto Dropbox without dangling references.
    const manifest = []
    for (const p of payload.pages) {
      if (!fs.existsSync(p.proofPath)) continue
      const dest = path.join(galleryDir, 'pages', `page_${String(p.pageNum).padStart(3, '0')}.jpg`)
      fs.copyFileSync(p.proofPath, dest)
      manifest.push({
        pageNum: p.pageNum,
        label: p.label || `Page ${p.pageNum}`,
        file: `pages/page_${String(p.pageNum).padStart(3, '0')}.jpg`,
      })
    }

    const html = buildGalleryHtml(payload.albumName || 'Album Proof', manifest)
    fs.writeFileSync(path.join(galleryDir, 'index.html'), html)
    fs.writeFileSync(path.join(galleryDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    telemetry.event('proof_gallery_export', { pages: manifest.length })
    return { ok: true, path: galleryDir, pages: manifest.length }
  })
}

function buildGalleryHtml(albumName, manifest) {
  // Inline page list keeps the gallery a single self-contained file with no
  // network dependencies — works offline and from a Dropbox shared link.
  const pageJson = JSON.stringify(manifest)
  const safeAlbum = String(albumName).replace(/</g, '&lt;')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${safeAlbum} — Proof</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0a0a0a; color: #f3f3f3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 10; padding: 14px 20px;
    background: rgba(10,10,10,0.85); backdrop-filter: blur(12px);
    border-bottom: 1px solid #222; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 500; flex: 1; }
  header .meta { font-size: 13px; color: #888; }
  .stage { position: relative; padding: 24px; min-height: calc(100vh - 60px);
    display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .page-wrap { width: 100%; max-width: 1200px; aspect-ratio: 3/2;
    background: #181818; border-radius: 12px; overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5); position: relative; }
  .page-wrap img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    width: 100%; max-width: 1200px; }
  button, .btn { background: #1d1d1d; color: #f3f3f3; border: 1px solid #333;
    padding: 9px 16px; border-radius: 8px; cursor: pointer; font: inherit; }
  button:hover { background: #2a2a2a; }
  .btn-primary { background: #e31c1c; border-color: #e31c1c; }
  .btn-primary:hover { background: #c01818; }
  .approved { background: #1f6f3c !important; border-color: #1f6f3c !important; }
  textarea { flex: 1; min-width: 240px; min-height: 36px; padding: 8px 12px;
    background: #141414; color: #f3f3f3; border: 1px solid #333;
    border-radius: 8px; font: inherit; resize: vertical; }
  .pager { display: flex; align-items: center; gap: 8px; }
  .pager input { width: 60px; padding: 6px 8px; background: #141414;
    color: #f3f3f3; border: 1px solid #333; border-radius: 6px; text-align: center; }
  .nav-arrow { position: absolute; top: 50%; transform: translateY(-50%);
    width: 48px; height: 48px; border-radius: 50%; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; user-select: none; font-size: 22px; }
  .nav-arrow.prev { left: 14px; }
  .nav-arrow.next { right: 14px; }
  .nav-arrow:hover { background: rgba(0,0,0,0.85); }
  @media (max-width: 700px) {
    .page-wrap { aspect-ratio: 1.5/1; border-radius: 8px; }
    .nav-arrow { width: 40px; height: 40px; font-size: 18px; }
  }
</style>
</head>
<body>
<header>
  <h1>${safeAlbum}</h1>
  <span class="meta" id="meta"></span>
  <button class="btn-primary" id="exportBtn">Send Feedback</button>
</header>
<div class="stage">
  <div class="page-wrap">
    <img id="pageImg" alt="">
    <div class="nav-arrow prev" id="prev">‹</div>
    <div class="nav-arrow next" id="next">›</div>
  </div>
  <div class="controls">
    <div class="pager">
      <button id="firstBtn">⏮</button>
      <input id="pageInput" type="number" min="1">
      <span id="totalLbl"></span>
      <button id="lastBtn">⏭</button>
    </div>
    <button id="approveBtn">✓ Approve</button>
    <textarea id="commentBox" placeholder="Add a comment for this page (optional)"></textarea>
  </div>
</div>
<script>
const pages = ${pageJson};
const state = JSON.parse(localStorage.getItem('proofFeedback') || '{}'); // pageNum -> { approved, comment }
let idx = 0;

const img = document.getElementById('pageImg');
const meta = document.getElementById('meta');
const approveBtn = document.getElementById('approveBtn');
const commentBox = document.getElementById('commentBox');
const pageInput = document.getElementById('pageInput');
const totalLbl = document.getElementById('totalLbl');

totalLbl.textContent = '/ ' + pages.length;

function persist() {
  localStorage.setItem('proofFeedback', JSON.stringify(state));
}
function render() {
  const p = pages[idx];
  if (!p) return;
  img.src = p.file;
  img.alt = p.label;
  meta.textContent = p.label;
  pageInput.value = idx + 1;
  const fb = state[p.pageNum] || {};
  commentBox.value = fb.comment || '';
  approveBtn.classList.toggle('approved', !!fb.approved);
  approveBtn.textContent = fb.approved ? '✓ Approved' : '✓ Approve';
}
function go(n) { idx = Math.max(0, Math.min(pages.length - 1, n)); render(); }

document.getElementById('prev').onclick = () => go(idx - 1);
document.getElementById('next').onclick = () => go(idx + 1);
document.getElementById('firstBtn').onclick = () => go(0);
document.getElementById('lastBtn').onclick = () => go(pages.length - 1);
pageInput.onchange = () => go(parseInt(pageInput.value, 10) - 1);
approveBtn.onclick = () => {
  const p = pages[idx]; const fb = state[p.pageNum] || {};
  fb.approved = !fb.approved; state[p.pageNum] = fb; persist(); render();
};
commentBox.oninput = () => {
  const p = pages[idx]; const fb = state[p.pageNum] || {};
  fb.comment = commentBox.value; state[p.pageNum] = fb; persist();
};
document.getElementById('exportBtn').onclick = () => {
  const out = pages.map(p => ({
    pageNum: p.pageNum, label: p.label,
    approved: !!(state[p.pageNum] && state[p.pageNum].approved),
    comment: (state[p.pageNum] && state[p.pageNum].comment) || ''
  }));
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'feedback.json';
  document.body.appendChild(a); a.click(); a.remove();
};
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') go(idx - 1);
  else if (e.key === 'ArrowRight') go(idx + 1);
  else if (e.key === 'a' || e.key === 'A') approveBtn.click();
});
render();
</script>
</body>
</html>`
}

module.exports = { registerGalleryExportHandler }
