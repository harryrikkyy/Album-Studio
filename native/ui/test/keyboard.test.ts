import test from 'node:test'
import assert from 'node:assert/strict'
import { shortcutsSuspended } from '../src/ui/keyboard.ts'

test('a modal, IME composition, consumed event, or locked account cannot trigger global commands', () => {
  const key = { defaultPrevented: false, isComposing: false }
  assert.equal(shortcutsSuspended(key, false, true), false)
  assert.equal(shortcutsSuspended(key, true, true), true)
  assert.equal(shortcutsSuspended(key, false, false), true)
  assert.equal(shortcutsSuspended({ ...key, isComposing: true }, false, true), true)
  assert.equal(shortcutsSuspended({ ...key, defaultPrevented: true }, false, true), true)
})
