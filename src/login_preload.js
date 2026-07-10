// login_preload.js — bridge for the login window.
//
// Runs in an isolated preload context (contextIsolation:true, nodeIntegration:
// false) with Node access, and exposes ONLY the auth/license IPC calls the
// login screen needs over a frozen contextBridge surface. The renderer can no
// longer `require('electron')` or reach any Node module directly.
const { contextBridge, ipcRenderer, shell } = require('electron')

contextBridge.exposeInMainWorld('loginAPI', {
  checkLicense: (email) => ipcRenderer.invoke('check-license', email),
  launchApp: (payload) => ipcRenderer.invoke('launch-app', payload),
  googleSignIn: () => ipcRenderer.invoke('google-sign-in'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  // The URL is baked in here so the renderer cannot open arbitrary links.
  openWhatsApp: () => shell.openExternal(
    'https://wa.me/8885640573?text=Hi, I need to activate Creative Hubb Album Toolkit Pro'),
})
