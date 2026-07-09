// @ts-check
// ui_feedback.js — the toast + status notification system, extracted from
// main.js (Phase 2 split).
//
// Replaces the previous pattern of writing every state change into the 10px
// footer #statusText label that nobody reads. Now:
//   setStatus(msg)              → footer only (transient progress)
//   toast(msg, kind, opts)      → ephemeral toast in the corner
//   notify(msg, kind, opts)     → BOTH: toast + footer
//
// kind ∈ 'info' | 'success' | 'warning' | 'error'.
// `duration: 0` makes a toast sticky (user must close).
//
// This is a DOM-owning module (it builds the toast stack and writes the
// footer directly); it has no store or IPC dependencies, so feature modules
// keep receiving these three functions as injected deps from main.js.

const _toastIcons = { info: 'ℹ', success: '✓', warning: '⚠', error: '✕' };

function _ensureToastStack() {
    let stack = document.getElementById('toastStack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toastStack';
        stack.className = 'toast-stack';
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    return stack;
}

/**
 * Show an ephemeral toast in the corner stack.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [kind]
 * @param {{ duration?: number }} [opts]  duration 0 = sticky
 * @returns {{ dismiss: () => void }}
 */
function toast(message, kind = 'info', { duration = 3500 } = {}) {
    const stack = _ensureToastStack();
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    if (kind === 'error') el.setAttribute('aria-live', 'assertive');

    const icon = document.createElement('span');
    icon.className = 'toast__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = _toastIcons[kind] || _toastIcons.info;

    const body = document.createElement('div');
    body.className = 'toast__body';
    body.textContent = message;

    const close = document.createElement('button');
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';

    el.appendChild(icon);
    el.appendChild(body);
    el.appendChild(close);
    stack.appendChild(el);

    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const dismiss = () => {
        if (!el.parentNode) return;
        el.classList.add('is-leaving');
        el.addEventListener('animationend', () => el.remove(), { once: true });
        if (timer) clearTimeout(timer);
    };
    close.addEventListener('click', dismiss);
    if (duration > 0) timer = setTimeout(dismiss, duration);

    return { dismiss };
}

/**
 * Write the footer status label (transient progress only).
 * @param {string} [message]
 */
function setStatus(message) {
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.innerText = message || '';
}

/**
 * Both: surface to the toast stack AND keep the footer in sync. Use this
 * for any state change a user genuinely needs to know about.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [kind]
 * @param {{ duration?: number }} [opts]
 */
function notify(message, kind = 'info', opts = {}) {
    setStatus(message);
    toast(message, kind, opts);
}

module.exports = { toast, setStatus, notify };
