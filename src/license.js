const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SECRET_KEY = process.env.LICENSE_SECRET_KEY || 'CH-TOOLKIT-PRO-2025-SECRET'
// Security: the fallback secret is in source, so any offline license signed
// with it is forgeable. Warn at startup so a production build never ships
// without a real LICENSE_SECRET_KEY in the environment / .env.
if (!process.env.LICENSE_SECRET_KEY) {
  console.warn('[license] WARNING: LICENSE_SECRET_KEY not set — using insecure fallback. Set it in .env before distributing.')
}
const LICENSE_FILE = path.join(os.homedir(), '.ch_toolkit_license')

function generateChecksum(data) {
  return crypto.createHmac('sha256', SECRET_KEY).update(JSON.stringify(data)).digest('hex')
}

function saveLicense(licenseData) {
  const data = {
    email: licenseData.email,
    name: licenseData.name,
    machineId: licenseData.machineId,
    expiresOn: licenseData.expiresOn,
    activatedOn: licenseData.activatedOn,
    savedAt: new Date().toISOString()
  }
  const checksum = generateChecksum(data)
  const payload = { ...data, checksum }
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(payload), 'utf8')
}

function loadLicense() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return null
    const payload = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'))
    const { checksum, ...data } = payload
    const expectedChecksum = generateChecksum(data)
    if (checksum !== expectedChecksum) {
      console.log('License tampered!')
      return null
    }
    return data
  } catch(e) { return null }
}

function getDaysRemaining(expiresOn) {
  const expiry = new Date(expiresOn)
  const now = new Date()
  const ms = expiry - now
  if (ms <= 0) return 0          // already expired — never report a phantom day
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

function clearLicense() {
  try { fs.unlinkSync(LICENSE_FILE) } catch(e) {}
}

// Single source of truth for offline license validation. Used by both the
// boot auto-login path and the check-license offline fallback so the rules
// (account match, machine lock, expiry) can never drift apart (R2).
//   - currentMachineId: the machine id of this device
//   - email: optional; when provided, the saved license must belong to it
// Returns the same { allowed, reason, ... } shape as check-license.
function validateOfflineLicense(currentMachineId, email) {
  const localLicense = loadLicense()
  if (!localLicense) {
    return { allowed: false, reason: 'no_internet' }
  }
  if (email && localLicense.email !== email) {
    return { allowed: false, reason: 'wrong_account' }
  }
  if (localLicense.machineId !== currentMachineId) {
    return { allowed: false, reason: 'wrong_machine' }
  }
  const daysLeft = getDaysRemaining(localLicense.expiresOn)
  if (daysLeft <= 0) {
    clearLicense()
    return { allowed: false, reason: 'expired' }
  }
  return { allowed: true, daysLeft, offline: true, email: localLicense.email }
}

module.exports = { saveLicense, loadLicense, getDaysRemaining, clearLicense, validateOfflineLicense }