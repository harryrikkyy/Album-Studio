// @ts-check
// features/retouch_tab.js — Tab 8 "Retouch": the full ported CreativeHubb
// Retouch Pro panel (Effects, Skin Looks, Retouching, Makeup/Lips, Post).
//
// Every card is a one-shot IPC round-trip to the `retouch-run` handler, which
// runs scripts/retouch.jsx against the ACTIVE Photoshop document. The bridge
// is serial, so the whole section goes inert (`is-busy`) while a tool runs.
// The card grid is store-free and DOM-owning, mirroring features/tools_tab.js.

/**
 * Wire Tab 8 retouch cards + shared controls.
 *
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke IPC dispatch
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 * @param {(msg: string) => void} deps.setStatus
 */
function createRetouchTab(deps) {
  const pane = /** @type {HTMLElement} */ (document.getElementById('tab-retouch'));
  if (!pane) return {};

  const statusEl = document.getElementById('retouchStatus');
  let busy = false;

  /** @param {string} msg @param {string} [kind] */
  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'retouch-status' + (kind ? ' retouch-status--' + kind : '');
  }

  // One tool at a time — the Photoshop bridge is serial. While a tool runs the
  // pane stays visible but inert, matching the floating Tools Bar's panel.
  /** @param {{tool: string, level?: string, opacity?: number}} payload @param {string} label */
  async function run(payload, label) {
    if (busy) return;
    busy = true;
    pane.classList.add('is-busy');
    deps.setStatus('Retouch: ' + label + '…');
    setStatus('Running: ' + label + '…', 'run');
    try {
      const r = await deps.invoke('retouch-run', payload);
      if (r && r.ok) {
        setStatus('Done: ' + label, 'ok');
        deps.notify('Retouch · ' + label, 'success', { duration: 2500 });
      } else {
        const err = (r && r.error) || 'unknown error';
        setStatus(label + ' failed: ' + err, 'error');
        deps.toast(label + ' failed: ' + err, 'error', { duration: 6000 });
      }
    } catch (e) {
      const msg = (/** @type {any} */ (e)).message || String(e);
      setStatus(label + ' error: ' + msg, 'error');
      deps.toast(label + ' error: ' + msg, 'error', { duration: 6000 });
    } finally {
      busy = false;
      pane.classList.remove('is-busy');
    }
  }

  // Delegated click on any [data-tool] button (the sliders are handled
  // separately below and carry no data-tool).
  pane.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const btn = /** @type {HTMLElement | null} */ (target.closest('[data-tool]'));
    if (!btn || !pane.contains(btn)) return;
    if (btn.tagName === 'INPUT') return; // sliders wired below
    const tool = /** @type {string} */ (btn.dataset.tool);
    /** @type {{tool: string, level?: string}} */
    const payload = { tool };
    if (btn.dataset.level) payload.level = btn.dataset.level;
    const label = (btn.dataset.label || btn.textContent || tool).trim();
    run(payload, label);
  });

  // Opacity sliders: live readout on input, apply to Photoshop on release.
  // `tool` is the retouch id, output is the paired <output> element.
  /** @param {string} inputId @param {string} outputId @param {string} tool @param {string} label */
  function wireSlider(inputId, outputId, tool, label) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById(inputId));
    const output = document.getElementById(outputId);
    if (!input) return;
    input.addEventListener('input', () => { if (output) output.textContent = input.value + '%'; });
    input.addEventListener('change', () => {
      run({ tool, opacity: Number(input.value) }, label + ' ' + input.value + '%');
    });
  }
  wireSlider('retouchIntensity', 'retouchIntensityOut', 'layer-opacity', 'Intensity');
  wireSlider('retouchDodgeOpacity', 'retouchDodgeOpacityOut', 'dodge-intensity', 'Dodge opacity');
  wireSlider('retouchBurnOpacity', 'retouchBurnOpacityOut', 'burn-intensity', 'Burn opacity');

  return {};
}

module.exports = { createRetouchTab };
