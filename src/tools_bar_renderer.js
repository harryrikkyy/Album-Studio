// All privileged calls go through the toolsBarAPI contextBridge surface
// (src/tools_bar_preload.js) — this window runs with contextIsolation and no
// Node access.
const api = window.toolsBarAPI;

const toastEl     = document.getElementById('toast');
const dropdown    = document.getElementById('dropdown');
const dropdownList = document.getElementById('dropdownList');
const dropdownHint = document.getElementById('dropdownHint');
const searchInput = document.getElementById('actionSearch');
const searchKbd   = document.getElementById('searchKbd');
const btnRefresh  = document.getElementById('btnRefreshActions');
const btnSwap     = document.getElementById('btnSwapImages');
const btnExportOpen = document.getElementById('btnExportOpen');
const btnExportOpenAll = document.getElementById('btnExportOpenAll');
const btnHide     = document.getElementById('btnHide');

let allActions     = [];     // full list from Photoshop
let visibleActions = [];     // filtered subset shown in the dropdown
let activeIdx      = 0;      // which dropdown item is keyboard-focused
let isLoading      = false;
let actionsLoaded  = false;

const MAX_RESULTS = 5;       // visible rows in the dropdown
const ROW_HEIGHT  = 32;      // approx row height for sizing
const HINT_HEIGHT = 24;      // approx hint footer height

function showToast(msg, ms = 2500) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ─── search dropdown ─────────────────────────────────────────────────
// The dropdown is anchored to the search input's bounding box (not the
// whole bar). The bar's window grows upward by exactly the dropdown's
// height so the visual footprint stays small.

function dropdownHeight() {
  // 5 rows + footer when there's content; just the empty/loading message
  // otherwise.
  const rows = Math.min(MAX_RESULTS, Math.max(visibleActions.length, 1));
  return rows * ROW_HEIGHT + HINT_HEIGHT + 4;
}

function positionDropdown() {
  if (!dropdown.classList.contains('open')) return;
  const rect = searchInput.getBoundingClientRect();
  const h = dropdownHeight();
  // Anchor: bottom of dropdown sits directly above the search input.
  dropdown.style.left = rect.left + 'px';
  dropdown.style.width = rect.width + 'px';
  dropdown.style.top = (rect.top - h - 4) + 'px';
  dropdown.style.height = h + 'px';
}

async function expandWindow() {
  // Add some padding so the dropdown's drop shadow doesn't get clipped.
  await api.setHeight(dropdownHeight() + 12);
}
async function collapseWindow() {
  await api.setHeight(0);
}

async function loadActions(force) {
  if (isLoading) return;
  isLoading = true;
  searchInput.disabled = true;
  searchInput.placeholder = 'Loading actions…';
  try {
    const res = await api.listActions({ force: !!force });
    if (!res || !res.ok) {
      showToast('Could not load actions: ' + (res && res.error || 'unknown'), 4000);
      allActions = [];
    } else {
      allActions = res.actions || [];
      actionsLoaded = true;
      if (allActions.length === 0) {
        showToast('No actions found in Photoshop', 3500);
      }
    }
  } catch (e) {
    showToast('Action load error: ' + e.message, 4000);
  } finally {
    isLoading = false;
    searchInput.disabled = false;
    searchInput.placeholder = actionsLoaded
      ? `Run Photoshop action… (${allActions.length})`
      : 'Run Photoshop action…';
  }
}

// The dropdown opens ONLY when the search input is the actual focus owner
// AND the user typed/clicked into it. Background bar clicks no longer
// accidentally open it because no other element triggers openDropdown().
searchInput.addEventListener('focus', async () => {
  if (!actionsLoaded && !isLoading) await loadActions(false);
  filterAndRender(searchInput.value);
  openDropdown();
});

searchInput.addEventListener('blur', () => {
  // Delay so a click on a dropdown item still registers before we close.
  setTimeout(() => {
    if (!dropdown.contains(document.activeElement)) closeDropdown();
  }, 150);
});

searchInput.addEventListener('input', (e) => {
  filterAndRender(e.target.value);
  if (document.activeElement === searchInput) openDropdown();
});

// Cmd/Ctrl+K is a courtesy shortcut from the search field's own keydown
// (below). We deliberately don't bind it globally — that was previously
// firing even when the user clicked the bar's drag area, which produced
// the "dropdown opens without me touching the search bar" bug.
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dropdown.classList.contains('open')) {
    e.preventDefault();
    closeDropdown();
    searchInput.blur();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (visibleActions.length === 0) return;
    activeIdx = Math.min(activeIdx + 1, visibleActions.length - 1);
    paintActive(true);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (visibleActions.length === 0) return;
    activeIdx = Math.max(activeIdx - 1, 0);
    paintActive(true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const item = visibleActions[activeIdx];
    if (item) runAction(item);
  } else if (e.key === 'Tab') {
    if (dropdown.classList.contains('open')) {
      e.preventDefault();
      if (e.shiftKey) {
        activeIdx = Math.max(activeIdx - 1, 0);
      } else {
        activeIdx = Math.min(activeIdx + 1, visibleActions.length - 1);
      }
      paintActive(true);
    }
  }
});

// Cmd/Ctrl+K from the field itself focuses+selects (re-trigger). Useful
// while the field already has focus and the user wants to start over.
searchInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    searchInput.select();
  }
});

function openDropdown() {
  if (dropdown.classList.contains('open')) return;
  dropdown.classList.add('open');
  positionDropdown();
  expandWindow();
  // Make sure clicks land on dropdown items immediately, even if the user
  // hasn't moved the mouse yet (e.g., tabbed in via keyboard).
  setInteractive(true);
}
function closeDropdown() {
  if (!dropdown.classList.contains('open')) return;
  dropdown.classList.remove('open');
  collapseWindow();
}

function filterAndRender(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    // Empty query — show first MAX_RESULTS actions (alphabetic) so the
    // user sees a small preview of what's available without filling the
    // dropdown with everything.
    visibleActions = allActions.slice(0, MAX_RESULTS);
  } else {
    // Subsequence-friendly fuzzy match: every character in the query must
    // appear in the action name in order, plus a small bonus when the
    // characters appear in a contiguous prefix. Cheap, readable, and
    // forgiving of typos / abbreviations like "vibr" → "vibrance".
    visibleActions = allActions
      .map((a) => ({ a, score: scoreMatch(q, a.name.toLowerCase(), a.set.toLowerCase()) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_RESULTS)
      .map((x) => x.a);
  }
  activeIdx = 0;
  renderDropdown();
  // Re-position whenever results change so the height resizes correctly.
  if (dropdown.classList.contains('open')) {
    positionDropdown();
    expandWindow();
  }
}

function scoreMatch(query, name, set) {
  // 0 = no match, higher = better.
  // First check substring in name (cheapest path) for the bulk-of-cases win.
  const nameIdx = name.indexOf(query);
  if (nameIdx === 0) return 100;        // prefix match — best
  if (nameIdx > 0) return 60 - nameIdx; // earlier-in-string wins
  // Substring in set name (e.g., "default" → all default-set actions).
  if (set.indexOf(query) !== -1) return 30;
  // Subsequence fallback — every query char appears in order in name.
  let i = 0;
  for (let j = 0; j < name.length && i < query.length; j++) {
    if (name[j] === query[i]) i++;
  }
  return i === query.length ? 20 : 0;
}

function renderDropdown() {
  if (visibleActions.length === 0) {
    dropdownHint.style.display = 'none';
    if (allActions.length === 0 && actionsLoaded) {
      dropdownList.innerHTML = '<div class="dropdown__empty">No actions in Photoshop yet — record one in Window → Actions, then click ↻.</div>';
    } else if (!actionsLoaded) {
      dropdownList.innerHTML = '<div class="dropdown__empty">Loading actions…</div>';
    } else {
      dropdownList.innerHTML = '<div class="dropdown__empty">No matches</div>';
    }
    return;
  }
  dropdownList.innerHTML = visibleActions.map((a, i) => `
    <div class="dropdown__item ${i === activeIdx ? 'active' : ''}" data-idx="${i}" role="option" tabindex="-1">
      <span class="dropdown__name">${escapeHtml(a.name)}</span>
      <span class="dropdown__set">${escapeHtml(a.set)}</span>
    </div>
  `).join('');
  dropdownHint.style.display = '';
  dropdownHint.innerHTML = `
    <span>↑ ↓ navigate · ⏎ run · esc close</span>
    <span>${visibleActions.length} of ${allActions.length}</span>
  `;
  // Wire mouse interactions on freshly rendered items.
  dropdownList.querySelectorAll('.dropdown__item').forEach((el) => {
    el.addEventListener('mousedown', (ev) => {
      // Use mousedown so the input doesn't blur and close the dropdown
      // before the click fires.
      ev.preventDefault();
      const idx = parseInt(el.dataset.idx, 10);
      const item = visibleActions[idx];
      if (item) runAction(item);
    });
    el.addEventListener('mouseenter', () => {
      activeIdx = parseInt(el.dataset.idx, 10);
      paintActive();
    });
  });
  paintActive(true);
}

function paintActive(scroll) {
  const items = dropdownList.querySelectorAll('.dropdown__item');
  items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  if (scroll && items[activeIdx]) {
    items[activeIdx].scrollIntoView({ block: 'nearest' });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function runAction(item) {
  closeDropdown();
  searchInput.blur();
  showToast(`Running: ${item.name}…`, 1500);
  try {
    const res = await api.runAction({
      setName: item.set,
      actionName: item.name,
    });
    if (res && res.ok) {
      showToast(`✓ ${item.name}`, 2000);
    } else {
      showToast(`Action failed: ${(res && res.error) || 'unknown'}`, 4500);
    }
  } catch (e) {
    showToast('Action error: ' + e.message, 4500);
  }
}

btnRefresh.addEventListener('click', async () => {
  btnRefresh.disabled = true;
  btnRefresh.style.opacity = '0.5';
  await loadActions(true);
  btnRefresh.disabled = false;
  btnRefresh.style.opacity = '';
  showToast(`Re-scanned · ${allActions.length} actions`, 2000);
  if (document.activeElement === searchInput) {
    filterAndRender(searchInput.value);
  }
});

// ─── existing tool handlers ────────────────────────────────────────
btnSwap.addEventListener('click', async () => {
  btnSwap.disabled = true;
  try {
    const result = await api.swapImages();
    showToast(typeof result === 'string' ? result : 'Swap complete');
  } catch (e) {
    showToast('Swap failed: ' + (e.message || e));
  } finally {
    btnSwap.disabled = false;
  }
});

// Shared handler for both export buttons — scope distinguishes them.
async function _runExportOpen(btn, scope) {
  btn.disabled = true;
  const labelSpan = btn.querySelector('span:last-child');
  const original = labelSpan.textContent;
  labelSpan.textContent = 'Exporting…';
  try {
    const r = await api.exportOpenDocs(scope);
    if (!r || !r.ok) {
      showToast('Export failed: ' + ((r && r.error) || 'unknown'), 4500);
    } else if (r.empty || r.total === 0) {
      showToast(scope === 'active' ? 'No active document in Photoshop' : 'No documents open in Photoshop', 3000);
    } else if (r.processed === 0) {
      showToast(`Nothing exported · ${r.skipped} skipped (unsaved or non-PSD)`, 4000);
    } else {
      const parts = [`${r.processed} exported`];
      if (r.skipped) parts.push(`${r.skipped} skipped`);
      if (r.failed) parts.push(`${r.failed} failed`);
      const secs = r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : '';
      showToast('✓ ' + parts.join(' · ') + secs, 3500);
    }
  } catch (e) {
    showToast('Export failed: ' + (e.message || e), 4500);
  } finally {
    labelSpan.textContent = original;
    btn.disabled = false;
  }
}

btnExportOpen.addEventListener('click', () => _runExportOpen(btnExportOpen, 'active'));
btnExportOpenAll.addEventListener('click', () => _runExportOpen(btnExportOpenAll, 'all'));

btnHide.addEventListener('click', () => {
  api.close();
});

// Keep the dropdown glued to the search input when the bar's window
// resizes (which happens whenever Photoshop's width changes).
window.addEventListener('resize', () => {
  if (dropdown.classList.contains('open')) positionDropdown();
});

// ─── click-through for empty areas ──────────────────────────────────
// The bar's window is transparent so the area above the bar (used to host
// the dropdown) doesn't paint dark. But that means the OS still routes
// mouse events to our window for that whole rectangle — which would cover
// part of the canvas.
//
// Strategy: the window starts in "ignore but forward" mode (clicks pass
// through, but the renderer still gets mousemove events for hit testing).
// On every mousemove we check whether the pointer is over visible chrome
// (.bar or an open .dropdown); if yes, switch to interactive so the click
// reaches our buttons; if no, switch back so the click reaches Photoshop.
const bar = document.querySelector('.bar');
let _interactive = false;
function setInteractive(interactive) {
  if (interactive === _interactive) return;
  _interactive = interactive;
  api.setInteractive(interactive);
}

function isOverChrome(x, y) {
  const inBar = pointInRect(x, y, bar.getBoundingClientRect());
  if (inBar) return true;
  if (dropdown.classList.contains('open')) {
    const inDrop = pointInRect(x, y, dropdown.getBoundingClientRect());
    if (inDrop) return true;
  }
  return false;
}
function pointInRect(x, y, r) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

document.addEventListener('mousemove', (e) => {
  setInteractive(isOverChrome(e.clientX, e.clientY));
}, { passive: true });

// Edge case handler — `openDropdown` already calls setInteractive via
// the mousemove machinery on subsequent moves, but ensures that the very
// first frame after opening accepts clicks even if the user hasn't moved
// the mouse yet (e.g., they tabbed into the field).
function ensureInteractiveWhenOpen() {
  if (dropdown.classList.contains('open')) setInteractive(true);
}
