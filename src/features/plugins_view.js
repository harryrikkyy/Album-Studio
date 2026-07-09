// @ts-check
// features/plugins_view.js — the plugins panel (Tier 3.B), extracted from
// main.js (Phase 2 split). Lists installed plugins (id, hooks, source,
// status) with enable/disable toggles for user plugins, plus the Refresh and
// Open-folder buttons. (Plugin loading itself happens in the main process —
// see src/plugins.js.)
//
// DOM-owning (#pluginsView) and store-free.

/**
 * Wire the plugins panel.
 *
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  IPC dispatch
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 */
function createPluginsView(deps) {
    async function refreshPluginsView() {
        const res = await deps.invoke('plugins-list');
        const view = document.getElementById('pluginsView');
        if (!view) return;
        if (!res?.ok) { view.innerHTML = `<span class="u-text-secondary">Plugins unavailable</span>`; return; }
        const list = res.plugins;
        if (list.length === 0) {
            view.innerHTML = `<div style="padding:8px 0;color:var(--txt-secondary);">
                No plugins installed. Drop a plugin folder into <code>${res.dir}</code> and click Refresh.
            </div>`;
            return;
        }
        view.innerHTML = `
            <table style="width:100%; border-collapse: collapse; font-size:12px;">
                <thead><tr style="text-align:left; border-bottom:1px solid var(--border-main);">
                    <th style="padding:6px;">Plugin</th>
                    <th style="padding:6px;">Hooks</th>
                    <th style="padding:6px;">Source</th>
                    <th style="padding:6px;">Status</th>
                    <th style="padding:6px;"></th>
                </tr></thead>
                <tbody>
                    ${list.map((/** @type {any} */ p) => `
                        <tr style="border-bottom:1px solid var(--border-main);">
                            <td style="padding:6px;"><strong>${p.id}</strong> <span class="u-text-secondary">v${p.manifest?.version || '?'}</span></td>
                            <td style="padding:6px;">${(p.manifest?.hooks || []).join(', ') || '—'}</td>
                            <td style="padding:6px;">${p.builtin ? 'built-in' : 'user'}</td>
                            <td style="padding:6px;">${p.error
                                ? `<span style="color:var(--btn-red-bg)">error: ${p.error}</span>`
                                : (p.disabled ? '<span class="u-text-secondary">disabled</span>' : '<span style="color:#4caf50;">active</span>')}</td>
                            <td style="padding:6px;">${p.builtin
                                ? '<span class="u-text-secondary">built-in</span>'
                                : `<button class="btn btn--ghost" data-plugin="${p.id}" data-enable="${p.disabled ? 'true' : 'false'}">${p.disabled ? 'Enable' : 'Disable'}</button>`}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        view.querySelectorAll('button[data-plugin]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const b = /** @type {HTMLElement} */ (btn);
                const id = b.dataset.plugin;
                const enable = b.dataset.enable === 'true';
                const r = await deps.invoke('plugins-set-enabled', id, enable);
                if (!r?.ok) { deps.toast('Plugin toggle failed: ' + (r?.error || ''), 'error'); return; }
                refreshPluginsView();
            });
        });
    }

    document.getElementById('btnPluginsRefresh')?.addEventListener('click', async () => {
        await deps.invoke('plugins-reload');
        refreshPluginsView();
    });

    document.getElementById('btnOpenPluginsFolder')?.addEventListener('click', async () => {
        const res = await deps.invoke('plugins-list');
        if (res?.ok) await deps.invoke('open-external', 'file://' + res.dir);
    });

    return { refreshPluginsView };
}

module.exports = { createPluginsView };
