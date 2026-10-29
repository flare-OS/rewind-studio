const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('rewindDesktop', {
  getConfig: () => invoke('app:config'),
  apiRequest: request => invoke('api:request', request),

  authStatus: () => invoke('auth:status'),
  login: credentials => invoke('auth:login', credentials),
  logout: () => invoke('auth:logout'),
  openLogin: () => invoke('auth:open'),
  closeWindow: () => invoke('window:close'),

  openProject: () => invoke('project:open'),
  saveProject: payload => invoke('project:save', payload),
  exportProject: payload => invoke('project:export', payload),

  listLocalProjects: () => invoke('local:list'),
  saveLocalProject: payload => invoke('local:save', payload),
  readLocalProject: filePath => invoke('local:read', filePath),
  deleteLocalProject: filePath => invoke('local:delete', filePath),

  pickSkybox: () => invoke('skybox:pick'),
  uploadAsset: payload => invoke('asset:upload', payload),

  openExternal: url => invoke('app:open-external', url),
  relaunch: () => invoke('app:relaunch'),

  onCommand: callback => {
    const handler = (_event, command) => callback(command);
    ipcRenderer.on('editor:command', handler);
    return () => ipcRenderer.removeListener('editor:command', handler);
  },
  onAuthChanged: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('auth:changed', handler);
    return () => ipcRenderer.removeListener('auth:changed', handler);
  }
});
