'use strict';
// Narrow, explicit bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('planPrinter', {
  openMarkdown: (opts) => ipcRenderer.invoke('open-markdown', opts || {}),
  saveMarkdown: (text, suggestedName) => ipcRenderer.invoke('save-markdown', text, suggestedName),
  exportPdf: (opts) => ipcRenderer.invoke('export-pdf', opts || {}),
  print: () => ipcRenderer.invoke('print'),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  loadSample: () => ipcRenderer.invoke('load-sample'),
  hasClaudePlans: () => ipcRenderer.invoke('has-claude-plans'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  onMenu: (callback) => {
    ipcRenderer.on('menu', (_event, action) => callback(action));
  },
  platform: process.platform,
});
