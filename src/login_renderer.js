// All privileged calls go through the loginAPI contextBridge surface
// (src/login_preload.js) — this window runs with contextIsolation and no
// Node access.

// Remember the last successfully-authenticated email so "Retry" can re-run
// the license check after the owner activates the account — without forcing
// a full re-sign-in (the rough edge users hit).
let lastSignedInEmail = null;

function setStatus(msg, type = '') {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.className = 'status ' + type;
}

function setLoading(loading, label) {
  const btn = document.getElementById('btnGoogle');
  btn.disabled = loading;
  if (loading) {
    btn.innerHTML = '<span class="spinner"></span> ' + (label || 'Signing in...');
  } else {
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFF" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"/></svg> Sign in with Google`;
  }
}

// Shared post-auth path: run the license check for an email and either launch
// the app or show the appropriate restricted screen.
async function checkAndProceed(email, name) {
  setStatus('Checking subscription...', 'checking');
  document.getElementById('statusMsg').innerHTML = '<span class="spinner"></span> Checking subscription...';
  const licenseResult = await window.loginAPI.checkLicense(email);
  if (licenseResult.allowed) {
    setStatus('✓ Access granted! Loading app...', '');
    const launch = await window.loginAPI.launchApp({
      daysLeft: licenseResult.daysLeft,
      email,
      name: name || '',
      offline: licenseResult.offline || false
    });
    // R4: launch-app re-verifies the saved license. If that fails, don't
    // leave the user staring at a "Loading app..." that never arrives.
    if (launch && launch.ok === false) {
      showExpiredScreen({ reason: launch.reason || 'error' }, email);
      return false;
    }
    return true;
  }
  showExpiredScreen(licenseResult, email);
  return false;
}

async function signInWithGoogle() {
  setLoading(true);
  setStatus('Opening Google sign in...', 'checking');
  try {
    const result = await window.loginAPI.googleSignIn();
    if (result.error) {
      setStatus(result.error, 'error');
      setLoading(false);
      return;
    }
    lastSignedInEmail = result.email;
    await checkAndProceed(result.email, result.name);
    // M4: whatever the outcome, the button must not stay stuck spinning.
    setLoading(false);
  } catch(e) {
    setStatus('Something went wrong. Please try again.', 'error');
    setLoading(false);
  }
}

// M5: re-check the license for the already-authenticated account. Lets a user
// who was just activated get in WITHOUT re-doing the whole Google sign-in.
async function retryActivation() {
  if (!lastSignedInEmail) { switchAccount(); return; }
  const btn = document.getElementById('btnRetry');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const ok = await checkAndProceed(lastSignedInEmail, null);
    if (!ok) {
      // Still not allowed — bounce back to the restricted screen (already shown).
      btn.disabled = false;
      btn.textContent = original;
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function showExpiredScreen(licenseResult, email) {
  document.getElementById('loginView').style.display = 'none'
  document.getElementById('expiredScreen').style.display = 'block'
  const badge = document.getElementById('daysBadge')
  const retryBtn = document.getElementById('btnRetry')

  // The Retry button only makes sense when activation is the pending issue.
  const showRetry = licenseResult.reason === 'not_activated';
  if (retryBtn) retryBtn.style.display = showRetry ? 'block' : 'none';

  if (licenseResult.reason === 'not_activated') {
    document.getElementById('expiredMsg').textContent = 'Your account isn\u2019t activated yet. Once Creative Hubb activates it, tap “I\u2019ve been activated — Retry”.'
    badge.style.display = 'none'
  } else if (licenseResult.reason === 'expired') {
    document.getElementById('expiredMsg').textContent = 'Your subscription has expired. Please contact Creative Hubb to renew.'
    badge.textContent = 'SUBSCRIPTION EXPIRED'
    badge.style.display = 'inline-block'
  } else if (licenseResult.reason === 'wrong_machine') {
    const where = licenseResult.registeredMachineName ? (' (registered to “' + licenseResult.registeredMachineName + '”)') : '';
    document.getElementById('expiredMsg').textContent = 'This license is already in use on another device' + where + '. Contact Creative Hubb to move it to this machine.'
    badge.textContent = 'DEVICE NOT AUTHORIZED'
    badge.style.display = 'inline-block'
  } else if (licenseResult.reason === 'wrong_account') {
    document.getElementById('expiredMsg').textContent = 'Your saved offline license belongs to a different account. Connect to the internet to sign in with this account.'
    badge.style.display = 'none'
  } else if (licenseResult.reason === 'no_internet') {
    document.getElementById('expiredMsg').textContent = 'No internet connection and no saved license on this device. Please connect to the internet to sign in.'
    badge.textContent = 'NO CONNECTION'
    badge.style.display = 'inline-block'
  } else {
    document.getElementById('expiredMsg').textContent = 'No subscription found for ' + email + '. Please contact Creative Hubb.'
    badge.style.display = 'none'
  }
}

function openWhatsApp() {
  window.loginAPI.openWhatsApp();
}

// M1: switching account from the login screen just resets the view in place.
// The main process sign-out handler is now singleton-safe, so this no longer
// spawns a second login window.
function switchAccount() {
  document.getElementById('loginView').style.display = 'block';
  document.getElementById('expiredScreen').style.display = 'none';
  const retryBtn = document.getElementById('btnRetry');
  if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = '↻ I\u2019ve been activated — Retry'; }
  lastSignedInEmail = null;
  setLoading(false);
  setStatus('');
  window.loginAPI.signOut();
}

// R7: the login window is frameless, so give the user an explicit way to quit
// the app — essential when sign-in is impossible (e.g. no internet on first run).
function quitApp() {
  window.loginAPI.quitApp();
}

// Buttons are wired here (not via inline onclick) so the page satisfies a
// script-src 'self' CSP.
document.getElementById('btnQuit').addEventListener('click', quitApp);
document.getElementById('btnGoogle').addEventListener('click', signInWithGoogle);
document.getElementById('btnRetry').addEventListener('click', retryActivation);
document.getElementById('btnContact').addEventListener('click', openWhatsApp);
document.getElementById('btnSwitch').addEventListener('click', switchAccount);
