import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_API_BASE = 'https://api.rwd.2bd.net';
const apiBase = String(process.env.REWIND_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
const supportedProjectExtensions = ['rwdproj', 'rwdplace', 'json'];
const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const sessionFile = path.join(app.getPath('userData'), 'session.json');
const projectDirectory = path.join(app.getPath('userData'), 'RewindProjects');

let windowRef;
let loginWindowRef;
let sessionCookie = '';
let currentUser = null;
let sessionLoaded = false;

app.setName('REWIND Studio');

protocol.registerSchemesAsPrivileged([
  { scheme: 'rewind', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

/* ------------------------------------------------------------------ */
/* Session persistence                                                 */
/* ------------------------------------------------------------------ */

async function loadSessionFile() {
  if (sessionLoaded) return;
  sessionLoaded = true;
  try {
    const saved = JSON.parse(await readFile(sessionFile, 'utf8'));
    sessionCookie = typeof saved.cookie === 'string' ? saved.cookie : '';
    currentUser = saved.user || null;
  } catch { /* First run or corrupt file: start signed out. */ }
}

async function persistSession() {
  try {
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ cookie: sessionCookie, user: currentUser }, null, 2), 'utf8');
  } catch (error) {
    console.warn('Could not persist the REWIND session:', error.message);
  }
}

function storeCookieFrom(response) {
  let changed = false;
  for (const raw of response.headers.getSetCookie?.() || []) {
    const first = raw.split(';', 1)[0];
    if (!first.startsWith('rewind_session=')) continue;
    const clear = /Max-Age=0/i.test(raw) || first === 'rewind_session=';
    const next = clear ? '' : first;
    if (next !== sessionCookie) { sessionCookie = next; changed = true; }
  }
  if (changed) persistSession();
}

/* ------------------------------------------------------------------ */
/* REWIND API bridge                                                   */
/* ------------------------------------------------------------------ */

async function apiCall(request = {}) {
  const route = String(request.path || '');
  if (!route.startsWith('/api/') || route.includes('..')) {
    return { ok: false, status: 0, error: 'Invalid REWIND API route.' };
  }
  const headers = { Accept: 'application/json', 'User-Agent': 'REWIND-Studio/0.2.0' };
  if (sessionCookie) headers.Cookie = sessionCookie;
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(`${apiBase}${route}`, {
      method: String(request.method || 'GET').toUpperCase(),
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: 'error',
      signal: AbortSignal.timeout(25_000)
    });
    storeCookieFrom(response);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error || `REWIND API request failed (${response.status}).`;
      return { ok: false, status: response.status, error: message };
    }
    return { ok: true, status: response.status, data };
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'The REWIND API did not respond in time.'
      : `Could not reach REWIND (${apiBase}). ${error.message || ''}`.trim();
    return { ok: false, status: 0, error: message };
  }
}

async function refreshSession() {
  await loadSessionFile();
  if (!sessionCookie) { currentUser = null; return { user: null, online: await apiOnline() }; }
  const result = await apiCall({ path: '/api/auth/me' });
  if (result.ok && result.data?.user) {
    currentUser = result.data.user;
    await persistSession();
  } else if (result.status === 401 || result.status === 404) {
    sessionCookie = ''; currentUser = null; await persistSession();
  }
  return { user: currentUser, online: result.ok || result.status > 0 };
}

async function apiOnline() {
  const result = await apiCall({ path: '/api/health' });
  return Boolean(result.ok);
}

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function broadcastAuth() {
  broadcast('auth:changed', { user: currentUser });
}

/* ------------------------------------------------------------------ */
/* Windows and menu                                                    */
/* ------------------------------------------------------------------ */

function sendCommand(command) {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('editor:command', command);
}

function createLoginWindow() {
  if (loginWindowRef && !loginWindowRef.isDestroyed()) {
    loginWindowRef.show();
    loginWindowRef.focus();
    return { opened: true };
  }
  loginWindowRef = new BrowserWindow({
    width: 480,
    height: 660,
    minWidth: 400,
    minHeight: 560,
    parent: windowRef,
    resizable: true,
    maximizable: false,
    backgroundColor: '#101118',
    title: 'Sign in to REWIND',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  loginWindowRef.loadURL('rewind://app/login.html');
  loginWindowRef.on('closed', () => { loginWindowRef = undefined; });
  return { opened: true };
}

function makeMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Experience', accelerator: 'Ctrl+N', click: () => sendCommand('new') },
        { label: 'Open Project…', accelerator: 'Ctrl+O', click: () => sendCommand('open') },
        { label: 'Save', accelerator: 'Ctrl+S', click: () => sendCommand('save') },
        { label: 'Save As…', accelerator: 'Ctrl+Shift+S', click: () => sendCommand('save-as') },
        { type: 'separator' },
        { label: 'Export Place…', accelerator: 'Ctrl+E', click: () => sendCommand('export') },
        { label: 'Import Place…', click: () => sendCommand('import') },
        { type: 'separator' },
        { label: 'Home', accelerator: 'Alt+H', click: () => sendCommand('home') },
        { label: 'Studio Settings…', accelerator: 'Ctrl+,', click: () => sendCommand('settings') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'Ctrl+Z', click: () => sendCommand('undo') },
        { label: 'Redo', accelerator: 'Ctrl+Y', click: () => sendCommand('redo') },
        { type: 'separator' },
        { label: 'Delete Selection', accelerator: 'Delete', click: () => sendCommand('delete') }
      ]
    },
    {
      label: 'Home',
      submenu: [
        { label: 'Select', accelerator: 'Q', click: () => sendCommand('tool:select') },
        { label: 'Move', accelerator: 'W', click: () => sendCommand('tool:move') },
        { label: 'Rotate', accelerator: 'E', click: () => sendCommand('tool:rotate') },
        { label: 'Scale', accelerator: 'R', click: () => sendCommand('tool:scale') },
        { type: 'separator' },
        { label: 'Insert Part', click: () => sendCommand('insert:block') },
        { label: 'Add Local Project', click: () => sendCommand('local:save') }
      ]
    },
    {
      label: 'Model',
      submenu: [
        { label: 'Insert Block', click: () => sendCommand('insert:block') },
        { label: 'Insert Sphere', click: () => sendCommand('insert:sphere') },
        { label: 'Insert Cylinder', click: () => sendCommand('insert:cylinder') },
        { label: 'Insert Wedge', click: () => sendCommand('insert:wedge') },
        { label: 'Insert Torus', click: () => sendCommand('insert:torus') },
        { label: 'Insert Spawn', click: () => sendCommand('insert:spawn') },
        { label: 'Insert Point Light', click: () => sendCommand('insert:light') }
      ]
    },
    {
      label: 'Test',
      submenu: [
        { label: 'Play', accelerator: 'F5', click: () => sendCommand('play') },
        { label: 'Run', accelerator: 'F8', click: () => sendCommand('run') },
        { label: 'Stop', accelerator: 'Shift+F5', click: () => sendCommand('stop') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Explorer', click: () => sendCommand('focus:explorer') },
        { label: 'Properties', click: () => sendCommand('focus:properties') },
        { label: 'Output', click: () => sendCommand('focus:output') },
        { label: 'Environment', click: () => sendCommand('focus:environment') },
        { label: 'Local Projects', click: () => sendCommand('focus:local') }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'REWIND Website', click: () => shell.openExternal('https://rwd.2bd.net') },
        { label: 'API Status', click: () => sendCommand('api:status') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  windowRef = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#11131a',
    title: 'REWIND Studio',
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windowRef.once('ready-to-show', () => {
    if (windowRef && !windowRef.isDestroyed()) windowRef.show();
  });
  await windowRef.loadURL('rewind://app/index.html');
  if (!windowRef.isVisible()) windowRef.show();
  windowRef.on('closed', () => { windowRef = undefined; });
}

/* ------------------------------------------------------------------ */
/* Local project library                                               */
/* ------------------------------------------------------------------ */

function safeProjectName(value) {
  return String(value || 'Untitled Place')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Untitled Place';
}

function isInsideProjectLibrary(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(projectDirectory, resolved);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function listLocalProjects() {
  await mkdir(projectDirectory, { recursive: true });
  const entries = await readdir(projectDirectory, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!supportedProjectExtensions.includes(path.extname(entry.name).slice(1).toLowerCase())) continue;
    const filePath = path.join(projectDirectory, entry.name);
    try {
      const info = await stat(filePath);
      const text = await readFile(filePath, 'utf8');
      const data = JSON.parse(text);
      projects.push({
        filePath,
        fileName: entry.name,
        name: data.name || path.basename(entry.name, path.extname(entry.name)),
        description: data.description || '',
        remotePlaceId: data.remotePlaceId || null,
        updatedAt: info.mtime.toISOString(),
        size: info.size,
        objectCount: data.place?.objects?.length || 0
      });
    } catch { /* Ignore files that are not valid project JSON. */ }
  }
  projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return projects;
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('app:config', async () => ({
    apiBase,
    version: app.getVersion(),
    platform: process.platform,
    projectDirectory
  }));

  ipcMain.handle('api:request', async (_event, request) => apiCall(request || {}));

  ipcMain.handle('auth:status', async () => {
    const result = await refreshSession();
    broadcastAuth();
    return result;
  });

  ipcMain.handle('auth:login', async (_event, credentials = {}) => {
    const result = await apiCall({
      path: '/api/auth/login',
      method: 'POST',
      body: { username: String(credentials.username || ''), password: String(credentials.password || '') }
    });
    if (!result.ok) return result;
    currentUser = result.data?.user || null;
    await persistSession();
    broadcastAuth();
    return { ok: true, user: currentUser };
  });

  ipcMain.handle('auth:logout', async () => {
    await apiCall({ path: '/api/auth/logout', method: 'POST', body: {} });
    sessionCookie = ''; currentUser = null; await persistSession();
    broadcastAuth();
    return { ok: true };
  });

  ipcMain.handle('auth:open', async () => createLoginWindow());
  ipcMain.handle('window:close', async event => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    owner?.close();
    return { ok: true };
  });

  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog(windowRef, {
      title: 'Open REWIND project',
      properties: ['openFile'],
      filters: [
        { name: 'REWIND Project', extensions: supportedProjectExtensions.slice(0, 2) },
        { name: 'JSON', extensions: ['json'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const project = JSON.parse(await readFile(filePath, 'utf8'));
    return { filePath, project };
  });

  ipcMain.handle('project:save', async (_event, { project, filePath, saveAs = false, defaultDirectory = null } = {}) => {
    let destination = saveAs ? null : filePath;
    if (!destination) {
      await mkdir(projectDirectory, { recursive: true });
      const base = path.join(defaultDirectory || projectDirectory, `${safeProjectName(project?.name)}.rwdproj`);
      const result = await dialog.showSaveDialog(windowRef, {
        title: 'Save REWIND project',
        defaultPath: base,
        filters: [{ name: 'REWIND Project', extensions: ['rwdproj'] }]
      });
      if (result.canceled || !result.filePath) return null;
      destination = result.filePath;
    }
    await writeFile(destination, JSON.stringify(project, null, 2), 'utf8');
    return { filePath: destination };
  });

  ipcMain.handle('project:export', async (_event, { project, defaultName } = {}) => {
    const result = await dialog.showSaveDialog(windowRef, {
      title: 'Export REWIND place',
      defaultPath: path.join(app.getPath('documents'), `${safeProjectName(defaultName || project?.name)}.rwdplace`),
      filters: [{ name: 'REWIND Place', extensions: ['rwdplace'] }]
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, JSON.stringify(project, null, 2), 'utf8');
    return { filePath: result.filePath };
  });

  ipcMain.handle('local:list', async () => listLocalProjects());

  ipcMain.handle('local:save', async (_event, { project, fileName = null } = {}) => {
    await mkdir(projectDirectory, { recursive: true });
    const name = safeProjectName(fileName ? path.basename(fileName, path.extname(fileName)) : project?.name);
    const destination = path.join(projectDirectory, `${name}.rwdproj`);
    await writeFile(destination, JSON.stringify(project, null, 2), 'utf8');
    return { filePath: destination };
  });

  ipcMain.handle('local:read', async (_event, filePath) => {
    if (!filePath || !isInsideProjectLibrary(filePath)) throw new Error('That project is outside the local project library.');
    const project = JSON.parse(await readFile(filePath, 'utf8'));
    return { filePath, project };
  });

  ipcMain.handle('local:delete', async (_event, filePath) => {
    if (!filePath || !isInsideProjectLibrary(filePath)) throw new Error('That project is outside the local project library.');
    await unlink(filePath);
    return { ok: true };
  });

  ipcMain.handle('skybox:pick', async () => {
    const result = await dialog.showOpenDialog(windowRef, {
      title: 'Choose six skybox images (px, nx, py, ny, pz, nz)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Skybox images', extensions: imageExtensions }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    if (result.filePaths.length !== 6) throw new Error('Select exactly six images: right, left, top, bottom, front, back.');
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    const images = [];
    let total = 0;
    for (const filePath of result.filePaths) {
      const info = await stat(filePath);
      total += info.size;
      if (info.size > 12 * 1024 * 1024 || total > 48 * 1024 * 1024) throw new Error('Skybox images must be smaller than 12 MB each and 48 MB total.');
      const extension = path.extname(filePath).slice(1).toLowerCase();
      const data = await readFile(filePath);
      images.push(`data:${mime[extension] || 'application/octet-stream'};base64,${data.toString('base64')}`);
    }
    return { images };
  });

  ipcMain.handle('asset:upload', async (_event, { assetType = 'game_icon' } = {}) => {
    const result = await dialog.showOpenDialog(windowRef, {
      title: `Choose a ${assetType.replaceAll('_', ' ')}`,
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: imageExtensions }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const info = await stat(filePath);
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const mimeType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[extension] || 'application/octet-stream';
    const name = path.basename(filePath).slice(0, 100);
    const created = await apiCall({
      path: '/api/assets',
      method: 'POST',
      body: { assetType, name, mimeType, byteSize: info.size }
    });
    if (!created.ok) return created;
    const upload = await fetch(created.data.uploadUrl, {
      method: 'PUT',
      headers: created.data.uploadHeaders,
      body: await readFile(filePath)
    });
    if (!upload.ok) return { ok: false, status: upload.status, error: `Asset upload failed (${upload.status}).` };
    return { ok: true, asset: created.data.asset };
  });

  ipcMain.handle('app:open-external', async (_event, url) => {
    const value = String(url || '');
    if (!/^https?:\/\//i.test(value)) throw new Error('Only web links can be opened.');
    await shell.openExternal(value);
    return { ok: true };
  });

  ipcMain.handle('app:relaunch', async () => {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  await loadSessionFile();

  await protocol.handle('rewind', async request => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.resolve(app.getAppPath(), relative);
    const relativeToRoot = path.relative(app.getAppPath(), target);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const bytes = await readFile(target);
      const extension = path.extname(target).toLowerCase();
      const types = {
        '.css': 'text/css',
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.cjs': 'text/javascript',
        '.json': 'application/json',
        '.map': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.woff2': 'font/woff2',
        '.wasm': 'application/wasm'
      };
      return new Response(bytes, {
        headers: {
          'Content-Type': `${types[extension] || 'application/octet-stream'}; charset=utf-8`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpc();
  makeMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
