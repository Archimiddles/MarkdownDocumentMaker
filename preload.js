'use strict';
// Narrow, explicit bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  // A dropped File -> its real path. A File made up by page script
  // gives '', so the page cannot invent a path.
  openDropped: (file) => {
    let p = '';
    try { p = webUtils.getPathForFile(file); } catch { /* not a real file */ }
    return ipcRenderer.invoke('open-dropped', p);
  },
  resumeDocument: () => ipcRenderer.invoke('resume-document'),
  forgetDocument: () => ipcRenderer.invoke('forget-document'),
  saveAnnotations: (data, docId) => ipcRenderer.invoke('save-annotations', data, docId),
  saveAnnotationsSync: (data, docId) => ipcRenderer.sendSync('save-annotations-sync', data, docId),
  exportAnnotatedMd: (text, name) => ipcRenderer.invoke('export-annotated-md', text, name),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
  onMenu: (callback) => {
    ipcRenderer.on('menu', (_event, action) => callback(action));
  },
  platform: process.platform,
});
