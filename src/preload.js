const { contextBridge, ipcRenderer } = require('electron');

// Every call resolves to { ok, data } or { ok: false, error, code }.
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: call('state:get'),
  connect: call('auth:connect'),
  openTokenPage: call('auth:tokenPage'),
  logout: call('auth:logout'),
  assignedIssues: call('issues:assigned'),
  searchIssues: call('issues:search'),
  start: call('timer:start'),
  stop: call('timer:stop'),
  updateMemo: call('timer:memo'),
  retry: call('entry:retry'),
  removeEntry: call('entry:remove'),
  openIssue: call('issue:open'),
  hide: call('window:hide'),
  showMenu: call('menu:show'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onShown: (cb) => ipcRenderer.on('window:shown', () => cb()),
  onToast: (cb) => ipcRenderer.on('toast', (_e, t) => cb(t)),
});
