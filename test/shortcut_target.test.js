'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { isTextEntry, controlOwnsKey } = require('../src/shortcut_target')

// Plain stand-ins for DOM nodes. `kb` = focus arrived from the keyboard,
// which is what `:focus-visible` reports in a real window.
const node = (tagName, type, kb = false) => ({
  tagName, type, matches: (sel) => sel === ':focus-visible' && kb,
})
const input = (type, kb) => node('INPUT', type, kb)
const key = (k, mods = {}) => ({ key: k, ...mods })
const cmd = (k) => key(k, { metaKey: true })

// ─── the reported bug ────────────────────────────────────────────────────────
// Clicking a slider or checkbox leaves it focused. Every shortcut then died
// until the user clicked somewhere neutral.

test('a focused slider does NOT swallow tool shortcuts', () => {
  assert.equal(controlOwnsKey(input('range'), key('t')), false)
  assert.equal(controlOwnsKey(input('range'), key('v')), false)
  assert.equal(controlOwnsKey(input('range'), cmd('s')), false)
})

test('a focused checkbox does NOT swallow tab switching or navigation', () => {
  assert.equal(controlOwnsKey(input('checkbox'), cmd('2')), false)
  assert.equal(controlOwnsKey(input('checkbox'), key('k')), false)
  assert.equal(controlOwnsKey(input('checkbox'), key('Backspace')), false)
})

test('a focused colour picker does NOT swallow shortcuts', () => {
  assert.equal(controlOwnsKey(input('color'), key('t')), false)
})

test('after a MOUSE click, Space goes back to the app (the hand tool)', () => {
  assert.equal(controlOwnsKey(input('range', false), key(' ')), false)
  assert.equal(controlOwnsKey(input('checkbox', false), key(' ')), false)
  assert.equal(controlOwnsKey(node('BUTTON', undefined, false), key(' ')), false)
})

// ─── what controls legitimately keep ─────────────────────────────────────────

test('a KEYBOARD-focused checkbox or button keeps Space, so it can be activated', () => {
  // Otherwise a keyboard user could never tick a checkbox.
  assert.equal(controlOwnsKey(input('checkbox', true), key(' ')), true)
  assert.equal(controlOwnsKey(node('BUTTON', undefined, true), key(' ')), true)
  assert.equal(controlOwnsKey(input('radio', true), key(' ')), true)
})

test('a focused slider keeps the arrow keys — that is how it is operated', () => {
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(controlOwnsKey(input('range'), key(k)), true, k)
  }
})

test('a focused select keeps arrows and letters (type-ahead)', () => {
  const sel = node('SELECT')
  assert.equal(controlOwnsKey(sel, key('ArrowDown')), true)
  assert.equal(controlOwnsKey(sel, key('b')), true, 'type-ahead to "BlackDelights"')
  assert.equal(controlOwnsKey(sel, cmd('s')), false, 'but not app commands')
})

test('a checkbox does not keep the arrow keys', () => {
  assert.equal(controlOwnsKey(input('checkbox'), key('ArrowRight')), false)
})

// ─── text fields ─────────────────────────────────────────────────────────────

test('a text field keeps every plain key, including Space and Backspace', () => {
  for (const k of ['t', 'v', 'k', '1', ' ', 'Backspace', 'Delete', 'ArrowLeft', '?']) {
    assert.equal(controlOwnsKey(input('text'), key(k)), true, JSON.stringify(k))
    assert.equal(controlOwnsKey(node('TEXTAREA'), key(k)), true, JSON.stringify(k))
  }
})

test('a text field keeps the text-editing chords', () => {
  for (const k of ['a', 'c', 'v', 'x', 'z', 'Z']) {
    assert.equal(controlOwnsKey(input('text'), cmd(k)), true, `⌘${k}`)
  }
})

test('a text field does NOT keep app commands like save, export and tab switching', () => {
  // Before, ⌘S in a caption field did nothing at all.
  for (const k of ['s', 'e', 'o', '1', '2', '=', '-', '0', 'd']) {
    assert.equal(controlOwnsKey(input('text'), cmd(k)), false, `⌘${k}`)
  }
})

test('a number field counts as text entry', () => {
  // The editor's X / Y / W / H / Size boxes: typing "5" must not pick a tool.
  assert.equal(isTextEntry(input('number')), true)
  assert.equal(controlOwnsKey(input('number'), key('5')), true)
})

test('contentEditable counts as text entry', () => {
  assert.equal(controlOwnsKey({ tagName: 'DIV', isContentEditable: true }, key('t')), true)
})

test('an input with no type attribute is a text field', () => {
  assert.equal(isTextEntry({ tagName: 'INPUT' }), true)
})

test('isTextEntry is false for operated controls', () => {
  for (const t of ['range', 'checkbox', 'radio', 'color', 'button', 'file', 'submit']) {
    assert.equal(isTextEntry(input(t)), false, t)
  }
  assert.equal(isTextEntry(node('SELECT')), false)
  assert.equal(isTextEntry(node('BUTTON')), false)
})

// ─── always the app's ────────────────────────────────────────────────────────

test('Escape is never owned by a control', () => {
  for (const t of [input('text'), node('TEXTAREA'), node('SELECT'), input('range')]) {
    assert.equal(controlOwnsKey(t, key('Escape')), false)
  }
})

test('no target, or a plain element, owns nothing', () => {
  assert.equal(controlOwnsKey(null, key('t')), false)
  assert.equal(controlOwnsKey(node('DIV'), key(' ')), false)
  assert.equal(controlOwnsKey(node('BODY'), cmd('z')), false)
})

test('a throwing matches() is treated as mouse focus, not an exception', () => {
  const weird = { tagName: 'BUTTON', matches: () => { throw new Error('unsupported selector') } }
  assert.equal(controlOwnsKey(weird, key(' ')), false)
})
