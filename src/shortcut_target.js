// @ts-check
// shortcut_target.js — should a global keyboard shortcut yield to whatever
// control currently has focus?
//
// Both the main window and the Page Editor used to answer this with one
// yes/no "is the user typing?" test that counted EVERY <input> and <select> as
// a text field. Range sliders, checkboxes and colour pickers are inputs too,
// and in Chromium clicking one leaves it focused — so dragging an opacity
// slider or ticking a checkbox silently switched off every shortcut in the
// window until the user happened to click somewhere neutral. That was the
// "keyboard shortcuts aren't working" report.
//
// The right question is per KEY, not per control:
//   - a text field owns printable characters, Backspace, the arrows and the
//     text-editing chords (⌘A ⌘C ⌘V ⌘X ⌘Z) — but not ⌘S, ⌘E or ⌘1;
//   - a slider or radio group owns the arrows, and nothing else;
//   - a <select> owns the arrows and letters (type-ahead);
//   - a checkbox, button or link owns Space only when it was reached from the
//     KEYBOARD — Space is how a keyboard user activates it, but after a mouse
//     click it should go back to being a shortcut (the editor's hand tool).
//
// Loaded two ways like editor_geometry.js: required by the main-window bundle
// and the test suite, and pulled into the context-isolated Page Editor as a
// plain <script>.

;(function (/** @type {any} */ root) {
    'use strict'

    // <input> types the user types characters into. Anything else (range,
    // checkbox, radio, color, button, file…) is operated, not typed into.
    const TEXT_INPUT_TYPES = new Set([
        '', 'text', 'search', 'email', 'url', 'tel', 'password', 'number',
        'date', 'time', 'datetime-local', 'month', 'week',
    ])

    // ⌘/Ctrl chords a text field needs for itself. Everything else with a
    // modifier is an app command and must still work while typing.
    const TEXT_EDIT_CHORDS = new Set([
        'a', 'c', 'v', 'x', 'z', 'y',
        'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'backspace', 'delete',
    ])

    // Controls a keyboard user activates with Space.
    const SPACE_ACTIVATED = new Set(['BUTTON', 'A', 'SUMMARY'])
    const SPACE_ACTIVATED_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'])

    /**
     * @typedef {{
     *   tagName?: string,
     *   type?: string,
     *   isContentEditable?: boolean,
     *   matches?: (sel: string) => boolean,
     * } | null | undefined} KeyTarget
     * @typedef {{ key: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean }} KeyLike
     */

    /** @param {KeyTarget} t */
    function inputType(t) {
        return String((t && t.type) || '').toLowerCase()
    }

    /**
     * True when the target is a control the user types characters into.
     * @param {KeyTarget} t
     * @returns {boolean}
     */
    function isTextEntry(t) {
        if (!t) return false
        if (t.isContentEditable) return true
        if (t.tagName === 'TEXTAREA') return true
        if (t.tagName === 'INPUT') return TEXT_INPUT_TYPES.has(inputType(t))
        return false
    }

    /**
     * Was focus put here by the keyboard? `:focus-visible` is the browser's
     * own heuristic for exactly that. Plain objects in tests report it
     * directly via `matches`.
     * @param {KeyTarget} t
     */
    function keyboardFocused(t) {
        try { return !!(t && typeof t.matches === 'function' && t.matches(':focus-visible')) }
        catch (_) { return false }
    }

    /**
     * Should a global shortcut leave this keystroke to the focused control?
     *
     * @param {KeyTarget} t the event target
     * @param {KeyLike} e the key event
     * @returns {boolean} true = the control needs it, skip the shortcut
     */
    function controlOwnsKey(t, e) {
        if (!t || !e) return false
        const key = String(e.key || '')
        const lower = key.toLowerCase()
        const chord = !!(e.metaKey || e.ctrlKey)
        const tag = t.tagName || ''
        const type = inputType(t)

        // Escape always belongs to the app (close menu, clear selection,
        // leave a tool) — no control uses it for anything we'd break.
        if (key === 'Escape') return false

        if (isTextEntry(t)) {
            if (chord) return TEXT_EDIT_CHORDS.has(lower)
            // Everything unmodified is typing: characters, Space, Backspace,
            // arrows, Home/End…
            return true
        }

        if (chord) return false

        const arrow = key.startsWith('Arrow')
        if (arrow) {
            if (tag === 'SELECT') return true
            if (tag === 'INPUT' && (type === 'range' || type === 'radio')) return true
            return false
        }

        // Type-ahead: a focused <select> jumps to the option starting with
        // the letter pressed.
        if (tag === 'SELECT' && key.length === 1 && key !== ' ') return true

        if (key === ' ' || key === 'Spacebar') {
            const activated = SPACE_ACTIVATED.has(tag)
                || tag === 'SELECT'
                || (tag === 'INPUT' && SPACE_ACTIVATED_INPUTS.has(type))
            // Only when the keyboard put focus there. After a mouse click the
            // control has done its job and Space goes back to the app.
            return activated && keyboardFocused(t)
        }

        return false
    }

    const api = { isTextEntry, controlOwnsKey }

    if (typeof module !== 'undefined' && module.exports) module.exports = api
    if (root) root.ShortcutTarget = api
})(typeof window !== 'undefined' ? window : null)
