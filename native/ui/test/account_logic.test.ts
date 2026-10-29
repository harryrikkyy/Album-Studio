import test from 'node:test'
import assert from 'node:assert/strict'
import { explainBlocked, expiryNote, subscriptionLine, type Account } from '../src/account_logic.ts'

const blocked = (reason: Account['reason'], extra: Partial<Account> = {}): Account => ({
  state: 'blocked',
  configured: true,
  reason,
  email: 'ana@studio.in',
  ...extra,
})

test('every reason an account can’t open says what to do', () => {
  assert.match(explainBlocked(blocked('not_activated')).text, /signed in as ana@studio\.in/)
  assert.match(explainBlocked(blocked('wrong_machine', { machineName: 'Studio iMac' })).text, /“Studio iMac”/)
  assert.match(explainBlocked(blocked('wrong_machine')).text, /another computer/)
  assert.equal(
    explainBlocked(blocked('wrong_account')).retry,
    false,
    'checking again cannot fix another account’s licence',
  )
  assert.equal(explainBlocked(blocked('error', { message: 'Firestore said no' })).text, 'Firestore said no')
  for (const r of ['not_activated', 'expired', 'wrong_machine', 'no_internet', 'error'] as const)
    assert.equal(explainBlocked(blocked(r)).retry, true, r)
})

test('the subscription’s end is mentioned in its last week only', () => {
  assert.equal(expiryNote(8), null)
  assert.equal(expiryNote(undefined), null)
  assert.match(expiryNote(7)!, /in 7 days/)
  assert.match(expiryNote(1)!, /in 1 day\./)
  assert.match(expiryNote(0)!, /today/)
  const ok: Account = { state: 'allowed', configured: true, email: 'a@b.c', daysLeft: 23 }
  assert.equal(subscriptionLine(ok), 'Active, 23 days left')
  assert.match(subscriptionLine({ ...ok, offline: true, daysLeft: 400 }), /^Active, over a year left · .*offline/)
})
