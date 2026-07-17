// license_flow.js — license verification + the login/launch/sign-out IPC.
//
// Extracted from app.js (Phase: app.js split). verifyLicense is exported
// (not just registered) because the boot auto-login path in app.js runs the
// exact same logic — boot must re-verify online so a deactivated/expired
// account doesn't keep opening from a stale local file.

const { app, ipcMain } = require('electron')
const os = require('os')
const guards = require('../ipc_guards')
const session = require('./session')
const { teardownAuthFlow } = require('./auth_flow')
const {
  firestorePath, firestoreAuthHeaders, emailToUserKey, safeJsonParse,
} = require('./firestore_rest')

// ── CHECK LICENSE ──────────────────────────────────────────
// Online-first license verification with an offline fallback.
async function verifyLicense(email) {
  const { machineId } = require('node-machine-id')
  const { saveLicense, getDaysRemaining, clearLicense, validateOfflineLicense } = require('../license')

  try {
    const currentMachineId = await machineId()

    // ── Try online check first ──────────────────────────
    try {
      const https = require('https')
      const userKey = emailToUserKey(email)
      const authHeaders = await firestoreAuthHeaders()

      // No valid Firebase session (offline, or refresh token gone) → skip the
      // online read and fall through to the offline license check, rather than
      // firing an unauthenticated request the tightened rules would reject and
      // mis-read as "not activated".
      const doc = authHeaders.Authorization ? await new Promise((resolve) => {
        https.get({ hostname: 'firestore.googleapis.com', path: firestorePath(`/users/${userKey}`), headers: authHeaders }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => resolve(safeJsonParse(data, null)))
        }).on('error', () => resolve(null))
      }) : null

      if (doc && doc.fields) {
        const activated = doc.fields.activated?.booleanValue
        if (!activated) {
          clearLicense()
          return { allowed: false, reason: 'not_activated' }
        }

        const expiresOn = doc.fields.expiresOn?.timestampValue
        if (!expiresOn) {
          clearLicense()
          return { allowed: false, reason: 'not_activated' }
        }

        const expiry = new Date(expiresOn)
        if (expiry <= new Date()) {
          clearLicense()
          return { allowed: false, reason: 'expired' }
        }

        // ── Check machine lock ──────────────────────────
        const registeredMachine = doc.fields.machineId?.stringValue

        // C1: if the license is already bound to a DIFFERENT machine, deny
        // here on the online path too (previously only the offline branch
        // enforced this, so the lock was effectively unenforced online).
        if (registeredMachine && registeredMachine !== currentMachineId) {
          clearLicense()
          return {
            allowed: false,
            reason: 'wrong_machine',
            registeredMachineName: doc.fields.machineName?.stringValue || ''
          }
        }

        if (!registeredMachine) {
          const updateData = JSON.stringify({
            fields: {
              ...doc.fields,
              machineId: { stringValue: currentMachineId },
              machineName: { stringValue: os.hostname() }
            }
          })
          await new Promise((res) => {
            const req = https.request({
              hostname: 'firestore.googleapis.com',
              path: firestorePath(`/users/${userKey}`, ['machineId', 'machineName']),
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(updateData), ...authHeaders }
            }, (response) => {
              let data = ''
              response.on('data', chunk => data += chunk)
              response.on('end', () => res(safeJsonParse(data, {})))
            })
            req.write(updateData)
            req.end()
          })
        }

        const daysLeft = getDaysRemaining(expiresOn)

        // ── Save license locally ────────────────────────
        // When the owner's activation stamped this record with an Ed25519
        // signature, save the exact signed strings (licExpiresOn/licActivatedOn)
        // so the offline verifier checks the same bytes that were signed —
        // Firestore's own timestamp formatting must not drift the signature.
        // Unsigned (legacy) records fall back to the timestamp fields.
        const sig = doc.fields.sig?.stringValue
        const savedActivatedOn = doc.fields.activatedOn?.timestampValue || new Date().toISOString()
        saveLicense({
          email,
          name: doc.fields.name?.stringValue || '',
          machineId: currentMachineId,
          expiresOn: sig ? (doc.fields.licExpiresOn?.stringValue || expiresOn) : expiresOn,
          activatedOn: sig ? (doc.fields.licActivatedOn?.stringValue || savedActivatedOn) : savedActivatedOn,
          sig
        })

        return { allowed: true, daysLeft, email }
      }

      // R5: the doc fetch succeeded but the user has no record yet (404 /
      // empty). That's "not activated", NOT "no internet". Only fall through
      // to the offline branch when the fetch itself failed (doc === null).
      if (doc !== null && !(doc && doc.fields)) {
        return { allowed: false, reason: 'not_activated' }
      }
    } catch(e) {
      console.log('Online check failed, trying offline...', e.message)
    }

    // ── Offline check (only reached when the online fetch errored) ──────
    // Shared validator keeps boot auto-login and this path in lockstep (R2).
    return validateOfflineLicense(currentMachineId, email)

  } catch(e) {
    return { allowed: false, reason: 'error', message: e.message }
  }
}

function registerLicenseHandlers() {
  ipcMain.handle('check-license', (event, email) => verifyLicense(guards.reqString(email, 'email', 'check-license', { max: 320 })))

  // ── LAUNCH MAIN APP ────────────────────────────────────────
  // R4: don't blindly trust the renderer's licenseInfo (it could be forged by
  // a tampered renderer). check-license always persists a verified license on
  // success, so re-validate against that saved file here before opening the app.
  ipcMain.handle('launch-app', async (event, licenseInfo) => {
    licenseInfo = licenseInfo === undefined || licenseInfo === null ? {} : guards.reqObject(licenseInfo, 'licenseInfo', 'launch-app')
    try {
      const { machineId } = require('node-machine-id')
      const { validateOfflineLicense } = require('../license')
      const currentMachineId = await machineId()
      const verified = validateOfflineLicense(currentMachineId, licenseInfo && licenseInfo.email)
      if (!verified.allowed) {
        // No trustworthy saved license — refuse to launch.
        return { ok: false, reason: verified.reason }
      }
      session.setLicense({
        allowed: true,
        daysLeft: verified.daysLeft,
        email: verified.email,
        name: (licenseInfo && licenseInfo.name) || '',
        offline: !!licenseInfo && !!licenseInfo.offline
      })
      if (licenseInfo && licenseInfo.email) session.setUser({ email: licenseInfo.email })
    } catch (e) {
      return { ok: false, reason: 'error', message: e.message }
    }

    session.createMainWindow(session.getLicense())
    const loginWindow = session.getLoginWindow()
    if (loginWindow) {
      loginWindow.close()
      session.setLoginWindow(null)
    }
    return { ok: true }
  })

  ipcMain.handle('get-license', () => {
    return session.getLicense()
  })

  // ── SIGN OUT ───────────────────────────────────────────────
  // Returns to the login screen. Guarded against the "two login windows" race:
  // if a login window already exists (e.g. switch-account was clicked from the
  // login screen itself), focus it instead of spawning another.
  ipcMain.handle('sign-out', () => {
    session.setUser(null)
    session.setLicense(null)
    // The local license file is what drives boot auto-login. If we don't remove
    // it, the next `npm start` silently re-opens the app for the signed-out
    // account. Explicit sign-out must mean "show the login window next time".
    try { require('../license').clearLicense() } catch (_) {}
    // Tear down any in-flight auth flow so a stale window/server can't linger.
    try { teardownAuthFlow() } catch (_) {}

    const loginWindow = session.getLoginWindow()
    const mainWindow = session.getMainWindow()
    if (loginWindow && !loginWindow.isDestroyed()) {
      // Already on (or have) a login window — just focus it.
      loginWindow.focus()
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.close(); session.setMainWindow(null) }
      return
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close()
      session.setMainWindow(null)
    }
    session.createLoginWindow()
  })

  // ── QUIT APP ───────────────────────────────────────────────
  // R7: lets the frameless login window quit the app outright. Essential when
  // sign-in is impossible (no internet on first run, or user just wants to exit).
  ipcMain.handle('quit-app', () => {
    app.quit()
  })
}

module.exports = { verifyLicense, registerLicenseHandlers }
