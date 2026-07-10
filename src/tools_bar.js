// tools_bar.js
//
// Floating "Tools Bar" — a thin frameless window that docks itself to the
// bottom edge of Photoshop. Created on demand from the Tools tab.
//
// Behavior:
//   • Polls Photoshop's frontmost-document window bounds via AppleScript at
//     ~5 Hz. If the bar is bound to PS (the default), it repositions itself
//     to sit flush against PS's bottom edge with matching width.
//   • If Photoshop is minimized / not visible, the bar hides. When PS comes
//     back, the bar shows again.
//   • If Photoshop quits, the bar closes.
//   • Bar height is fixed (44 px) so the user can keep adding tools without
//     resizing logic.
//
// Why poll instead of subscribe: macOS doesn't give us a simple cross-app
// "window moved" event without writing a private AX-API helper. 200 ms
// polling is cheap, the user can't perceive a 200 ms lag while dragging
// PS's window, and the implementation stays portable.

const { BrowserWindow, screen, systemPreferences, shell, dialog, app } = require('electron')
const { exec } = require('child_process')
const path = require('path')

// Lightweight logger that flows through electron-log when available, so we
// have a real paper trail when something goes wrong with docking or the
// window unexpectedly closes. Falls back to console if telemetry/log isn't
// wired up yet (e.g. very early init order).
let _log = null
function log(...args) {
  try {
    if (!_log) _log = require('electron-log/main')
    _log.info('[tools-bar]', ...args)
  } catch {
    // eslint-disable-next-line no-console
    console.log('[tools-bar]', ...args)
  }
}

const BAR_HEIGHT = 44
const POLL_MS_ACTIVE = 200   // fast cadence while PS window is moving/resizing
const POLL_MS_IDLE = 1000    // relaxed cadence once bounds are stable
const IDLE_THRESHOLD = 8     // consecutive unchanged polls before backing off
const GONE_CONFIRM_TICKS = 5 // consecutive GONE polls before closing the bar
                             // (guards against first-launch automation-consent
                             // races that briefly report PS as missing)

let _barWin = null
let _pollHandle = null
let _lastPSBounds = null
let _hiddenByPS = false
let _idleTicks = 0   // consecutive unchanged polls; drives adaptive cadence
let _goneTicks = 0   // consecutive polls where PS reported missing
let _warnedNoAX = false // logged once per session if Accessibility is denied
// When the action-search dropdown is open the bar grows upward to make room
// for the result list. We track the requested extra height here and add it
// to the docked rectangle in dockToBounds().
let _expansionPx = 0

// Resolve the running Photoshop app name once. Cached because the disk lookup
// is mildly expensive and the answer doesn't change for the session.
let _psName = null
function getPSName() {
  if (_psName) return _psName
  try {
    // Ask the shared bridge so we always pick the same PS variant the rest
    // of the process talks to.
    _psName = require('./bridge').getBridge().getPhotoshopAppName()
  } catch {
    _psName = null
  }
  return _psName
}

// AppleScript that returns either:
//   "MIN"                  — Photoshop is minimized / no main document window
//   "GONE"                 — Photoshop is not running
//   "x y w h"              — frontmost STANDARD window bounds in screen px
//
// We probe System Events because Photoshop's own AppleScript dictionary
// doesn't expose live window geometry reliably.
//
// Critical: filter on `subrole is "AXStandardWindow"`. Photoshop's tool
// fly-outs (right-click on Marquee → "Rectangular / Elliptical / …") are
// also AXWindows but their subrole is "AXSystemFloatingWindow". Without
// the subrole filter the bar would snap itself to the fly-out's tiny
// rectangle — the exact bug we're fixing.
function buildBoundsScript(psName) {
  return `
on run
  tell application "System Events"
    if not (exists process "${psName}") then return "GONE"
    tell process "${psName}"
      try
        -- Walk every window once. We want the largest standard window that
        -- isn't minimized — that's the document window. Tool tips, fly-outs,
        -- and modal dialogs have other subroles (AXSystemFloatingWindow,
        -- AXSystemDialog, etc.) and get filtered out here.
        --
        -- Note: we used to early-return MIN when 'visible is false',
        -- but that flag is unreliable. macOS reports a process as
        -- visible=false while it is on a different Space, mid-focus
        -- transition, or fullscreen on a secondary display. The user had
        -- Photoshop on a left-side external display (x=-207) and the bar
        -- was hiding itself the instant it appeared because of that flag.
        -- We now decide based purely on whether a real document window
        -- exists.
        --
        -- A zero window count almost always means the app lacks
        -- Accessibility permission (the AX query for windows is gated by
        -- it). Photoshop running with a document always has at least one
        -- AXWindow. We surface this as a distinct status so the renderer
        -- can show a "Grant Accessibility permission" hint instead of
        -- silently disappearing.
        set _winCount to count of windows
        if _winCount is 0 then return "NOAX"
        set _best to missing value
        set _bestArea to 0
        repeat with _w in (every window)
          try
            if (subrole of _w is "AXStandardWindow") and (value of attribute "AXMinimized" of _w is false) then
              set _s to size of _w
              set _area to (item 1 of _s) * (item 2 of _s)
              if _area > _bestArea then
                set _best to _w
                set _bestArea to _area
              end if
            end if
          end try
        end repeat
        if _best is missing value then return "MIN"
        set p to position of _best
        set s to size of _best
        return ((item 1 of p) as integer) & " " & ((item 2 of p) as integer) & " " & ((item 1 of s) as integer) & " " & ((item 2 of s) as integer)
      on error
        return "MIN"
      end try
    end tell
  end tell
end run
`.trim()
}

function fetchPSBounds() {
  const psName = getPSName()
  if (!psName) return Promise.resolve({ status: 'GONE' })
  return new Promise((resolve) => {
    const script = buildBoundsScript(psName)
    // Pass the script via -e lines so we don't need to write to disk.
    const args = script.split('\n').map((line) => `-e ${JSON.stringify(line)}`).join(' ')
    exec(`osascript ${args}`, { timeout: 1500 }, (err, stdout, stderr) => {
      if (err) {
        // Log the *real* osascript error. macOS automation denials surface
        // as exit code 1 with a "-1743" / "Not authorized to send Apple
        // events" message; surfacing it tells us at a glance whether the
        // bar's blank state is permission, AppleScript hiccup, or PS quit.
        log('osascript err:', err.message, 'stderr:', (stderr || '').trim())
        resolve({ status: 'ERR', error: err.message })
        return
      }
      const out = stdout.trim()
      if (out === 'MIN') return resolve({ status: 'MIN' })
      if (out === 'GONE') return resolve({ status: 'GONE' })
      if (out === 'NOAX') return resolve({ status: 'NOAX' })
      // Format is "x, y, w, h" because AppleScript joins integers with comma+space.
      const nums = out.split(/[,\s]+/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
      if (nums.length < 4) {
        log('unparseable bounds:', JSON.stringify(out))
        return resolve({ status: 'ERR', error: 'unparseable: ' + out })
      }
      const [x, y, w, h] = nums
      resolve({ status: 'OK', x, y, w, h })
    })
  })
}

function dockToBounds(b) {
  if (!_barWin || _barWin.isDestroyed()) return
  // Convert Photoshop's screen-space coordinates (origin: top-left of the
  // primary display, in DIPs on macOS) directly to our window position.
  // Place the bar so its TOP edge sits on PS's BOTTOM edge — but if a
  // dropdown is open (`_expansionPx > 0`), grow upward by that amount so
  // the bar's BOTTOM edge stays glued to PS's bottom edge.
  const dispBounds = screen.getDisplayMatching({
    x: b.x, y: b.y, width: b.w, height: b.h,
  }).workArea

  const totalH = BAR_HEIGHT + _expansionPx
  let targetX = b.x
  let targetY = b.y + b.h - _expansionPx
  let targetW = b.w

  // If the docked position would push the bar off-screen below, flip it
  // above PS instead (rare, but handles full-height windows on small
  // displays).
  if (targetY + totalH > dispBounds.y + dispBounds.height) {
    targetY = b.y - totalH
  }

  // Clamp the bar to the display PS lives on. dispBounds is in screen
  // coordinates and CAN have a negative origin when the user has a second
  // display to the left of the primary (this was the bug: PS reported
  // x = -207 on a left-side external display, the bar tried to dock at
  // x = -207, and the old clamp only checked the right edge — leaving the
  // bar partially or fully off-screen so the user "couldn't find it").
  // Now clamp on both sides so the bar always lands on the same display
  // as Photoshop, even when the display has a negative origin.
  const dispLeft  = dispBounds.x
  const dispRight = dispBounds.x + dispBounds.width
  if (targetX < dispLeft) {
    targetW -= (dispLeft - targetX)
    targetX = dispLeft
  }
  if (targetX + targetW > dispRight) {
    targetW = dispRight - targetX
  }
  if (targetW < 200) targetW = 200

  const cur = _barWin.getBounds()
  // Only call setBounds when something genuinely changed. The poller fires
  // every 200 ms; rewriting bounds with identical values still triggers an
  // OS-level window event that can steal focus from the bar's input fields.
  // Skipping the no-op writes is critical for the action search dropdown to
  // stay focused while Photoshop is the frontmost app.
  if (
    cur.x !== targetX ||
    cur.y !== targetY ||
    cur.width !== targetW ||
    cur.height !== totalH
  ) {
    log('dock', { ps: b, disp: dispBounds, target: { x: targetX, y: targetY, w: targetW, h: totalH } })
    _barWin.setBounds(
      { x: targetX, y: targetY, width: targetW, height: totalH },
      false
    )
  }
  // showInactive is fine when first appearing, but calling it repeatedly
  // can take focus away from input fields inside the bar. Only show if the
  // window is currently hidden.
  if (!_barWin.isVisible()) _barWin.showInactive()
}

/**
 * Renderer-side request to grow the bar upward (e.g., to host an open
 * dropdown). Pass 0 to collapse back to the bar's native height.
 */
function setBarHeight(extraPx) {
  _expansionPx = Math.max(0, Math.min(600, parseInt(extraPx, 10) || 0))
  if (_lastPSBounds) dockToBounds(_lastPSBounds)
}

async function _poll() {
  if (!_barWin || _barWin.isDestroyed()) return
  const r = await fetchPSBounds()
  if (r.status === 'OK') {
    // Sanity guard: a real document window is at least ~400×300 on the
    // smallest reasonable display setup. Anything below that is almost
    // certainly a transient fly-out / tooltip / modal that the AXStandard
    // window filter let through. Keep the last-known-good bounds and skip
    // the update.
    const looksReal = r.w >= 400 && r.h >= 300
    // Also reject sudden dramatic shrinks — if PS reported 1800×1200 last
    // tick and 480×360 this tick, that's a UI transition, not a real
    // resize. Re-check on the next poll.
    const dramaticShrink = _lastPSBounds && (
      r.w < _lastPSBounds.w * 0.5 || r.h < _lastPSBounds.h * 0.5
    )
    if (!looksReal || dramaticShrink) {
      // Fall back to the last known position so the bar doesn't dart
      // around when fly-outs appear and disappear.
      if (_lastPSBounds) dockToBounds(_lastPSBounds)
      return
    }
    // Track stability for adaptive polling: unchanged bounds → idle.
    if (_lastPSBounds &&
        _lastPSBounds.x === r.x && _lastPSBounds.y === r.y &&
        _lastPSBounds.w === r.w && _lastPSBounds.h === r.h) {
      _idleTicks++
    } else {
      _idleTicks = 0
    }
    _hiddenByPS = false
    _lastPSBounds = r
    _goneTicks = 0
    dockToBounds(r)
  } else if (r.status === 'MIN') {
    _idleTicks++ // minimized is a stable state — fine to poll slowly
    _goneTicks = 0
    if (!_hiddenByPS) {
      log('PS reported MIN, hiding bar')
      _hiddenByPS = true
      try { _barWin.hide() } catch (_) {}
    }
  } else if (r.status === 'NOAX') {
    // Accessibility permission denied for this app. Don't hide the bar —
    // it can't dock without AX, but the user still needs to see it (and
    // the buttons still work) so they can grant the permission. Log once
    // per state transition.
    _idleTicks++
    _goneTicks = 0
    if (!_warnedNoAX) {
      _warnedNoAX = true
      log('AX permission denied — bar cannot dock to Photoshop. Grant Accessibility in System Settings → Privacy & Security → Accessibility for this app.')
    }
    if (!_barWin.isVisible()) {
      try { _barWin.showInactive() } catch (_) {}
    }
  } else if (r.status === 'GONE') {
    // Only close once we've seen PS reported missing several polls in a
    // row. A single GONE is unreliable: at first launch the macOS Apple-
    // events (automation) consent is still pending, so System Events can
    // momentarily answer as if the process isn't there. Closing on the
    // first GONE was what made the bar "appear for a second then vanish".
    _goneTicks++
    log('PS reported GONE', { ticks: _goneTicks, threshold: GONE_CONFIRM_TICKS })
    if (_goneTicks >= GONE_CONFIRM_TICKS) {
      log('GONE threshold hit — closing bar')
      closeToolsBar()
    }
    return
  } else {
    // ERR — transient AppleScript hiccup, or automation permission not yet
    // granted. Keep the bar where it is (and visible) instead of darting or
    // closing; the next poll retries once the user approves the prompt.
    log('poll ERR:', r.error)
    _goneTicks = 0
    if (_lastPSBounds) dockToBounds(_lastPSBounds)
  }
}

function startPolling() {
  if (_pollHandle) return
  // ⚡ Task 6.1: adaptive interval. Poll fast (200ms) while PS bounds are
  // changing, back off to 1s when stable. Over an 8-hour session this cuts
  // osascript child-process spawns by ~5× without any perceptible lag — the
  // moment bounds change we drop back to the fast cadence.
  _scheduleNextPoll(POLL_MS_ACTIVE)
  _poll()
}

function _scheduleNextPoll(delay) {
  if (_pollHandle) clearTimeout(_pollHandle)
  _pollHandle = setTimeout(async () => {
    await _poll()
    // Decide the next cadence based on whether bounds moved recently.
    const delayNext = _idleTicks >= IDLE_THRESHOLD ? POLL_MS_IDLE : POLL_MS_ACTIVE
    _scheduleNextPoll(delayNext)
  }, delay)
}

function stopPolling() {
  if (_pollHandle) {
    clearTimeout(_pollHandle)
    _pollHandle = null
  }
}

// Apple's Accessibility (AX) trust check. Calling with prompt:true triggers
// the official macOS prompt the first time, which has an "Open System
// Settings" button that takes the user straight to the right pane. After
// that, repeat calls return the cached state. We also fall back to opening
// our own dialog with a deep link to the Settings URL because the system
// prompt can be dismissed silently and is one-shot per session.
let _axPromptedThisSession = false
function ensureAccessibilityPermission() {
  if (process.platform !== 'darwin') return true
  try {
    if (systemPreferences.isTrustedAccessibilityClient(false)) return true
  } catch (e) {
    log('AX trust check failed:', e.message)
    return true // fail open — let polling try, NOAX log will surface it
  }
  // Not trusted. Trigger the OS prompt (only meaningful once per launch
  // before the user has acted on it) and show our own dialog so they have
  // a clear path even if they missed the system one.
  try {
    systemPreferences.isTrustedAccessibilityClient(true)
  } catch (_) {}
  if (_axPromptedThisSession) return false
  _axPromptedThisSession = true
  log('AX not trusted — showing in-app prompt')
  // Non-blocking: don't gate the bar's window creation on the user's
  // response. The bar will operate in NOAX mode (visible, undocked) until
  // the user grants and reopens.
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Accessibility permission needed',
      message: 'Allow Album Toolkit to dock the Tools Bar to Photoshop',
      detail:
        'macOS requires Accessibility permission for the bar to read ' +
        "Photoshop's window position and follow it. The bar will work " +
        "without it, but won't stay attached to Photoshop.\n\n" +
        'Click "Open System Settings", then enable Album Toolkit Pro ' +
        'under Privacy & Security → Accessibility. Quit and reopen the ' +
        'app after granting.',
      buttons: ['Open System Settings', 'Skip for now'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        shell
          .openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
          )
          .catch((e) => log('failed to open settings url:', e.message))
      }
    })
    .catch((e) => log('AX dialog error:', e.message))
  return false
}

function openToolsBar() {
  if (_barWin && !_barWin.isDestroyed()) {
    log('openToolsBar: reusing existing window')
    _barWin.show()
    return _barWin
  }

  // Accessibility permission is what lets us read Photoshop's window
  // bounds via System Events — without it, every poll comes back as
  // "no windows found" and the bar can't dock. Apple does NOT auto-prompt
  // for Accessibility the way it does for Apple-events automation, but
  // they do expose a native API (AXIsProcessTrustedWithOptions / Electron's
  // systemPreferences.isTrustedAccessibilityClient) that triggers the
  // official prompt the first time. We also show our own dialog with a
  // direct shortcut to the right Settings pane so users don't have to
  // hunt for it.
  ensureAccessibilityPermission()

  log('openToolsBar: creating window, displays:',
    screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, work: d.workArea }))
  )
  _barWin = new BrowserWindow({
    width: 600,
    height: BAR_HEIGHT,
    frame: false,
    // Transparent so the area above the bar (used as host surface for the
    // dropdown when expanded) doesn't paint as a dark rectangle over the
    // canvas. Only .bar and .dropdown CSS rules paint backgrounds.
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Note: `skipTaskbar` was previously true here. On macOS that combined
    // with `transparent` + `frame:false` + `alwaysOnTop:floating` was
    // implicitly demoting the whole app to "accessory" activation policy,
    // which made the main app vanish from Cmd+Tab and lose its Dock
    // active-dot the instant the bar opened. macOS has no taskbar so the
    // option had no functional benefit anyway.
    alwaysOnTop: true,
    hasShadow: false, // a transparent window with hasShadow paints a stray box around the empty area
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Album Studio Tools',
  })
  // Frameless transparent windows on macOS can still swallow mouse clicks
  // in their empty area, which would prevent the user from clicking on
  // Photoshop's canvas where our window happens to overlap. Initially we
  // ignore mouse events globally; the renderer flips this OFF whenever the
  // pointer enters the bar or the dropdown, and back ON when it leaves.
  _barWin.setIgnoreMouseEvents(true, { forward: true })

  // Float above Photoshop. 'floating' level keeps us above PS document
  // windows but below system modals like screenshot capture.
  _barWin.setAlwaysOnTop(true, 'floating')
  _barWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  _barWin.loadFile(path.join(__dirname, 'tools_bar.html'))

  _barWin.once('ready-to-show', () => {
    log('ready-to-show')
    _barWin.showInactive() // don't steal focus from PS
    // Defensively re-assert that we are a regular dock app. Opening a
    // transparent always-on-top floating window on macOS can implicitly
    // flip the app's activation policy to 'accessory', which removes us
    // from Cmd+Tab and the Dock indicator while leaving the app running
    // in Mission Control. Forcing 'regular' here keeps the main app a
    // first-class citizen no matter what the bar window does.
    if (process.platform === 'darwin') {
      try { app.setActivationPolicy('regular') } catch (_) {}
      try { if (app.dock && !app.dock.isVisible()) app.dock.show() } catch (_) {}
    }
    startPolling()
  })

  // Surface every reason the window could die so we stop guessing why the
  // bar "vanishes after a second" in packaged builds. unresponsive +
  // render-process-gone are the two paths that close the window without
  // going through closeToolsBar().
  _barWin.webContents.on('render-process-gone', (_e, details) => {
    log('render-process-gone:', details)
  })
  _barWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('did-fail-load:', { code, desc, url })
  })
  _barWin.on('unresponsive', () => log('window unresponsive'))
  _barWin.on('responsive', () => log('window responsive'))
  _barWin.on('hide', () => log('window hide'))
  _barWin.on('show', () => log('window show'))
  _barWin.on('close', () => log('window close event'))

  _barWin.on('closed', () => {
    log('window closed (cleanup)')
    stopPolling()
    _barWin = null
    _hiddenByPS = false
    _lastPSBounds = null
    _goneTicks = 0
  })

  return _barWin
}

function closeToolsBar() {
  if (_barWin && !_barWin.isDestroyed()) {
    try { _barWin.close() } catch (_) {}
  }
  stopPolling()
  _barWin = null
}

function isOpen() {
  return !!(_barWin && !_barWin.isDestroyed())
}

/**
 * Renderer-side toggle: when the pointer enters the visible chrome (bar or
 * an open dropdown), we disable click-through; when it leaves, we re-enable
 * it so the user can click Photoshop through the empty space the bar's
 * window covers.
 */
function setInteractive(interactive) {
  if (!_barWin || _barWin.isDestroyed()) return
  if (interactive) _barWin.setIgnoreMouseEvents(false)
  else _barWin.setIgnoreMouseEvents(true, { forward: true })
}

module.exports = {
  openToolsBar,
  closeToolsBar,
  isOpen,
  setBarHeight,
  setInteractive,
}
