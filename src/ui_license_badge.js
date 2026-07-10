// ── LICENSE BADGE ──────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const { ipcRenderer } = require('electron')
      const license = await ipcRenderer.invoke('get-license')
      if (!license) return

      const badge = document.createElement('div')
      badge.id = 'licenseBadge'
      badge.className = 'license-badge'
      badge.innerHTML = '<span id="licenseDot" class="license-badge__dot">●</span><span id="licenseText" class="license-badge__text">Loading...</span><span id="signOutBtn" class="license-badge__signout" role="button" tabindex="0">SIGN OUT</span>'

      // Dock the badge into the top nav so it never overlaps tab content.
      // Falls back to the body if the nav isn't present (e.g. license badge
      // is rendered before DOMContentLoaded in some race conditions).
      const navActions = document.querySelector('.nav-actions')
      if (navActions) navActions.insertBefore(badge, navActions.firstChild)
      else document.body.appendChild(badge)

      document.getElementById('signOutBtn').addEventListener('click', async () => {
          if (confirm('Sign out of Creative Hubb Album Toolkit Pro?')) {
              await ipcRenderer.invoke('sign-out')
          }
      })

      const text = document.getElementById('licenseText')
      const dot = document.getElementById('licenseDot')

      // Status colors
      if (license.daysLeft > 7) {
        dot.style.color = '#22c55e'
        text.style.color = '#22c55e'
        text.textContent = license.daysLeft + ' days remaining'
      } else if (license.daysLeft > 3) {
        dot.style.color = '#f59e0b'
        text.style.color = '#f59e0b'
        text.textContent = license.daysLeft + ' days remaining ⚠'
      } else {
        dot.style.color = '#e31c1c'
        text.style.color = '#e31c1c'
        text.textContent = license.daysLeft + ' days remaining !'
      }

      if (license.offline) text.textContent += ' (offline)'

    } catch(e) { console.log('Badge error:', e) }
  })
