/* ============================================================
   ADT PRO — Theme Switcher
   Add <script src="theme.js"></script> BEFORE main.js in index.html
   ============================================================ */

(function () {
    'use strict';

    const STORAGE_KEY = 'adt_theme';

    const THEMES = [
        {
            id:      'nebula',
            label:   'Nebula',
            sub:     '3D · Cosmic',
            dotClass: 'nebula',
            accent:  '#8B7BFF'
        },
        {
            id:      'obsidian',
            label:   'Obsidian Gold',
            sub:     '3D · Luxury',
            dotClass: 'obsidian',
            accent:  '#E8C07D'
        },
        {
            id:      'synthwave',
            label:   'Synthwave',
            sub:     '3D · Neon',
            dotClass: 'synthwave',
            accent:  '#FF2E97'
        },
        {
            id:      'glass',
            label:   'Glass',
            sub:     'Apple Tahoe 26',
            dotClass: 'glass',
            accent:  '#0A84FF'
        },
        {
            id:      'glass-dark',
            label:   'Glass (Dark)',
            sub:     'Apple Tahoe 26',
            dotClass: 'glass-dark',
            accent:  '#409CFF'
        }
    ];

    // ── Apply theme ─────────────────────────────────────────────
    function applyTheme(id) {
        const theme = THEMES.find(t => t.id === id) || THEMES[0];
        document.documentElement.setAttribute('data-theme', theme.id);
        localStorage.setItem(STORAGE_KEY, theme.id);

        // Update button label
        const btn = document.getElementById('themeBtn');
        if (btn) {
            const dot = btn.querySelector('.theme-dot');
            const lbl = btn.querySelector('.theme-btn-label');
            if (dot) { dot.className = 'theme-dot ' + theme.dotClass; }
            if (lbl) lbl.textContent = theme.label;
        }

        // Sync active class on dropdown options
        document.querySelectorAll('.theme-option').forEach(opt => {
            opt.classList.toggle('active', opt.dataset.theme === theme.id);
        });
    }

    // ── Build the dropdown ──────────────────────────────────────
    function buildDropdown() {
        const container = document.getElementById('themeContainer');
        const dropdown  = document.getElementById('themeDropdown');
        if (!container || !dropdown) return;

        dropdown.innerHTML = '';

        THEMES.forEach((theme, i) => {
            if (i > 0) {
                const sep = document.createElement('div');
                sep.className = 'theme-sep';
                dropdown.appendChild(sep);
            }

            const opt = document.createElement('button');
            opt.className = 'theme-option';
            opt.dataset.theme = theme.id;
            opt.innerHTML =
                `<span class="theme-dot ${theme.dotClass}"></span>` +
                `<span>${theme.label}</span>` +
                `<span class="theme-label-sub">${theme.sub}</span>`;

            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                applyTheme(theme.id);
                closeDropdown();
            });

            dropdown.appendChild(opt);
        });
    }

    // ── Dropdown open / close ───────────────────────────────────
    // The dropdown is reparented to <body> and positioned as `fixed` from the
    // button's bounding rect. This sidesteps EVERY possible ancestor problem:
    // overflow:hidden on the nav (obsidian theme has one), z-index/stacking
    // contexts, transforms — none of them can clip or occlude a body-level
    // fixed element with a high z-index.
    let _ddReparented = false;
    function positionDropdown() {
        const dd  = document.getElementById('themeDropdown');
        const btn = document.getElementById('themeBtn');
        if (!dd || !btn) return;
        if (!_ddReparented) { document.body.appendChild(dd); _ddReparented = true; }
        const r = btn.getBoundingClientRect();
        dd.style.position = 'fixed';
        dd.style.top  = (r.bottom + 5) + 'px';
        // Right-align the dropdown to the button's right edge.
        dd.style.left = 'auto';
        dd.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
        dd.style.zIndex = '100000';
    }
    function openDropdown()  {
        positionDropdown();
        document.getElementById('themeDropdown').classList.add('open');
    }
    function closeDropdown() {
        const dd = document.getElementById('themeDropdown');
        if (dd) dd.classList.remove('open');
    }
    function isOpen() {
        const dd = document.getElementById('themeDropdown');
        return dd && dd.classList.contains('open');
    }
    function toggleDropdown() {
        if (isOpen()) closeDropdown(); else openDropdown();
    }

    // ── Wire up events after DOM is ready ──────────────────────
    function init() {
        buildDropdown();

        const btn = document.getElementById('themeBtn');
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleDropdown();
            });
        } else {
            console.warn('[theme] #themeBtn not found at init');
        }

        // Close on outside click. The dropdown now lives at <body> level, so
        // we must treat clicks inside EITHER the container OR the dropdown as
        // "inside" — otherwise selecting a theme would close before firing.
        document.addEventListener('click', (e) => {
            if (e.target.closest('#themeContainer')) return;
            if (e.target.closest('#themeDropdown')) return;
            closeDropdown();
        });

        // Keep the fixed-positioned dropdown glued to the button on resize.
        window.addEventListener('resize', () => { if (isOpen()) positionDropdown(); });

        // Apply saved or default theme
        const saved = localStorage.getItem(STORAGE_KEY) || 'nebula';
        applyTheme(saved);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose for main.js if needed
    window.ADTTheme = { apply: applyTheme, themes: THEMES };
})();
