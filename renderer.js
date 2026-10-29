/* REWIND Studio renderer — local-first desktop editor. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const desktop = window.rewindDesktop;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = 'rewind.studio.settings.v2';
const DEFAULT_SETTINGS = {
  render: {
    quality: 'high', antialias: true, shadows: true, shadowMap: '1024', bloom: true,
    bloomStrength: 0.35, toneMapping: 'ACESFilmic', exposure: 1.05, fov: 55,
    pixelRatio: 1, fog: true, showGrid: true, showAxes: true
  },
  sky: {
    preset: 'studio', elevation: 28, azimuth: 140, sunIntensity: 3, ambientIntensity: 2.3,
    turbidity: 7, rayleigh: 2, stars: false
  },
  appearance: { theme: 'midnight', accent: '#8d7dff', font: 'DM Sans', mono: 'DM Mono', compact: false },
  editor: {
    showHints: true, snap: true, snapIncrement: 1, rotationSnap: 15,
    autoSave: true, autoSaveMinutes: 5, confirmDelete: true, gridSize: '100'
  }
};

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function mergeSettings(base, saved) {
  const output = Array.isArray(base) ? [...base] : { ...base };
  if (!saved || typeof saved !== 'object') return output;
  for (const [key, value] of Object.entries(saved)) {
    const current = output[key];
    if (current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object') {
      output[key] = mergeSettings(current, value);
    } else if (key in output && (typeof value === typeof output[key] || value === null)) {
      output[key] = value;
    }
  }
  return output;
}

let settings = cloneDefaults();
try {
  settings = mergeSettings(DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
} catch { /* Ignore a damaged settings blob. */ }

function getSetting(path) {
  return String(path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), settings);
}

function setSetting(path, value, { persist = true } = {}) {
  const parts = String(path).split('.');
  const last = parts.pop();
  let target = settings;
  for (const part of parts) target = target[part] ||= {};
  target[last] = value;
  if (persist) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Storage can be full. */ }
  }
}

const THEME_ACCENTS = { midnight: '#8d7dff', graphite: '#d7d7d7', nebula: '#b18cff', daylight: '#6957e2' };

function adjustHex(hex, amount) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return hex;
  const channels = [0, 2, 4].map(index => clamp(parseInt(value.slice(index, index + 2), 16) + amount, 0, 255));
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function applyAppearance() {
  const root = document.documentElement;
  const appearance = settings.appearance;
  root.dataset.theme = appearance.theme || 'midnight';
  root.style.setProperty('--accent', appearance.accent || THEME_ACCENTS[appearance.theme] || '#8d7dff');
  root.style.setProperty('--accent-2', adjustHex(appearance.accent || '#8d7dff', -22));
  root.style.setProperty('--accent-soft', `${appearance.accent || '#8d7dff'}26`);
  root.style.setProperty('--font-ui', `'${appearance.font || 'DM Sans'}', 'Segoe UI', system-ui, sans-serif`);
  root.style.setProperty('--font-display', `'Space Grotesk', '${appearance.font || 'DM Sans'}', 'Segoe UI', sans-serif`);
  root.style.setProperty('--font-mono', `'${appearance.mono || 'DM Mono'}', 'Cascadia Code', Consolas, monospace`);
  document.body.classList.toggle('compact', Boolean(appearance.compact));
}

function syncSettingsInputs() {
  $$('[data-setting]').forEach(input => {
    const value = getSetting(input.dataset.setting);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
    if (input.tagName === 'OUTPUT' || input.type === 'range') {
      const output = $(`[data-value="${input.dataset.setting}"]`);
      if (output) output.textContent = formatSettingValue(value);
    }
  });
}

function formatSettingValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number * 100) / 100) : String(value ?? '');
}

/* ------------------------------------------------------------------ */
/* Studio state                                                        */
/* ------------------------------------------------------------------ */

const APP = {
  config: { apiBase: 'https://api.rwd.2bd.net', version: '0.2.0', projectDirectory: '' },
  user: null,
  online: false,
  view: 'home',
  page: 'home',
  booted: false
};

let localProjects = [];
let cloudPlaces = [];
let assetCatalog = [];
let rewindAccount = null;
let loginPrompted = false;
let bootStarted = false;

const TEMPLATES = [
  {
    id: 'baseplate', icon: '▦', name: 'Baseplate', summary: 'Flat sandbox with a spawn point and studio lighting.',
    build() {
      return {
        objects: [
          record('block', 'Baseplate', [0, -0.5, 0], [64, 1, 64], '#4a5165'),
          record('spawn', 'SpawnLocation', [0, 0.12, 6], [5, 0.3, 5], '#4bd6a2'),
          record('light', 'PointLight', [0, 9, 0], [1, 1, 1], '#ffe4a8')
        ],
        environment: { preset: 'studio', elevation: 30, azimuth: 145 }
      };
    }
  },
  {
    id: 'obby', icon: '◈', name: 'Obby', summary: 'Floating checkpoints over a bright void.',
    build() {
      return {
        objects: [
          record('block', 'StartPad', [0, 0, 0], [8, 1, 8], '#6a5acd'),
          record('spawn', 'SpawnLocation', [0, 0.66, 1], [5, 0.3, 5], '#4bd6a2'),
          record('block', 'Step 1', [0, 2, -7], [5, 1, 5], '#7a68e8'),
          record('block', 'Step 2', [4, 4, -12], [4, 1, 4], '#e8b25f'),
          record('block', 'Step 3', [-1, 6, -18], [4, 1, 4], '#e86f8c'),
          record('block', 'FinishPad', [0, 7, -26], [10, 1, 10], '#4bd6a2'),
          record('sphere', 'Orb', [0, 10, -26], [2, 2, 2], '#ffe36e')
        ],
        environment: { preset: 'day', elevation: 44, azimuth: 120 }
      };
    }
  },
  {
    id: 'showcase', icon: '✦', name: 'Showcase', summary: 'Neon gallery with a reflective floor and night sky.',
    build() {
      return {
        objects: [
          record('plane', 'Gallery Floor', [0, 0, 0], [40, 0.2, 40], '#24243a', { material: 'Glass' }),
          record('cylinder', 'Pillar A', [-9, 3, -9], [2, 6, 2], '#5c5cff', { material: 'Neon' }),
          record('cylinder', 'Pillar B', [9, 3, -9], [2, 6, 2], '#ff67c8', { material: 'Neon' }),
          record('torus', 'Halo', [0, 6, 0], [8, 8, 8], '#9a7dff', { material: 'Neon' }),
          record('sphere', 'Centerpiece', [0, 2.2, 0], [3.4, 3.4, 3.4], '#f2e9ff'),
          record('spawn', 'SpawnLocation', [0, 0.3, 12], [5, 0.3, 5], '#4bd6a2'),
          record('light', 'Rim Light', [0, 8, 8], [1, 1, 1], '#b7a5ff')
        ],
        environment: { preset: 'nebula', elevation: 8, azimuth: 210, fog: true, fogFar: 90, bloom: true, bloomStrength: 0.75, stars: true }
      };
    }
  },
  {
    id: 'tycoon', icon: '▦', name: 'Tycoon', summary: 'Starter plot with a dropper and purchase pad.',
    build() {
      return {
        objects: [
          record('block', 'Plot', [0, -0.5, 0], [44, 1, 44], '#5b6a52'),
          record('spawn', 'SpawnLocation', [0, 0.15, 12], [5, 0.3, 5], '#4bd6a2'),
          record('block', 'Dropper', [0, 6, -10], [6, 4, 6], '#8a8f9e'),
          record('sphere', 'Ore', [0, 2, -10], [1.4, 1.4, 1.4], '#ffd45e', { material: 'Neon' }),
          record('block', 'Upgrade Pad', [-12, 0.1, 0], [6, 0.4, 6], '#5f8dff'),
          record('block', 'Shop', [12, 2, 0], [8, 4, 8], '#b9805a'),
          record('light', 'Plot Light', [0, 12, 6], [1, 1, 1], '#ffe4b0')
        ],
        environment: { preset: 'day', elevation: 38, azimuth: 155 }
      };
    }
  },
  {
    id: 'hangout', icon: '☕', name: 'Hangout', summary: 'Cozy social patio at golden hour.',
    build() {
      return {
        objects: [
          record('cylinder', 'Patio', [0, -0.2, 0], [26, 0.4, 26], '#c8a077'),
          record('spawn', 'SpawnLocation', [0, 0.15, 8], [5, 0.3, 5], '#4bd6a2'),
          record('block', 'Bench A', [-7, 1, -3], [6, 0.6, 1.6], '#7d5a3c'),
          record('block', 'Bench B', [7, 1, -3], [6, 0.6, 1.6], '#7d5a3c'),
          record('cylinder', 'Table', [0, 1.1, -5], [4, 2.2, 4], '#8c6a4b'),
          record('sphere', 'Lamp', [0, 5, -5], [1.2, 1.2, 1.2], '#ffdca8', { material: 'Neon' }),
          record('light', 'Warm Light', [0, 5, -5], [1, 1, 1], '#ffbc73'),
          record('bean', 'Bean', [-3, 0.9, 4], [1, 1, 1], '#efb75d')
        ],
        environment: { preset: 'sunset', elevation: 12, azimuth: 250, bloom: true, bloomStrength: 0.5 }
      };
    }
  }
];

function record(kind, name, position, size, color, extra = {}) {
  return {
    id: newId(), kind, name, position: [...position], size: [...size], color,
    rotation: [0, 0, 0], material: 'SmoothPlastic', transparency: 0,
    anchored: true, visible: true, castShadow: true,
    ...extra
  };
}

/* ------------------------------------------------------------------ */
/* UI primitives                                                       */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function toast(message, level = 'info', timeout = 3600) {
  const host = $('#toast-host');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${level}`;
  node.textContent = message;
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

function output(text, level = 'log') {
  const lines = $('#output-lines');
  if (!lines) return;
  const muted = lines.querySelector('.output-muted');
  if (muted) muted.remove();
  const line = document.createElement('div');
  line.className = `output-line ${level}`;
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  lines.append(line);
  while (lines.childElementCount > 400) lines.firstElementChild?.remove();
  lines.scrollTop = lines.scrollHeight;
  $('#output-count').textContent = String(lines.querySelectorAll('.output-line').length);
}

function setLoading(text, visible = true, progress = null) {
  const overlay = $('#loading-overlay');
  overlay.classList.toggle('hidden', !visible);
  $('#loading-text').textContent = text || 'Loading…';
  if (progress != null) $('#loading-bar').style.width = `${clamp(progress * 100, 0, 100)}%`;
}

function setSplash(status, progress) {
  $('#splash-status').textContent = status;
  $('#splash-percent').textContent = `${Math.round(clamp(progress, 0, 1) * 100)}%`;
  $('#splash-bar').style.width = `${clamp(progress, 0, 1) * 100}%`;
}

function avatarMarkup(user, size = 'avatar-sm') {
  const label = String(user?.username || '?').slice(0, 1).toUpperCase();
  const url = typeof user?.avatar === 'string' && /^https?:\/\//i.test(user.avatar) ? user.avatar : '';
  return `<span class="avatar ${size}">${url ? `<img src="${escapeHtml(url)}" alt="">` : escapeHtml(label)}</span>`;
}

function formatDate(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return 'just now';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(value) {
  const date = new Date(value || 0).getTime();
  if (!date) return 'unknown';
  const minutes = Math.round((Date.now() - date) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : formatDate(value);
}

function bytesLabel(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 104857.6) / 10} MB`;
}

/* ------------------------------------------------------------------ */
/* REWIND API                                                          */
/* ------------------------------------------------------------------ */

async function api(path, method = 'GET', bodyValue) {
  const result = await desktop.apiRequest({ path, method, body: bodyValue });
  if (!result?.ok) throw new Error(result?.error || 'The REWIND API request failed.');
  return result.data;
}

async function apiTry(path, method = 'GET', bodyValue) {
  const result = await desktop.apiRequest({ path, method, body: bodyValue });
  return result || { ok: false, error: 'No response from REWIND.' };
}

function setApiStatus(text, state = '') {
  $('#api-status').textContent = text;
  $('#api-dot').className = `api-dot ${state}`.trim();
}

async function refreshApiStatus() {
  const result = await apiTry('/api/health');
  APP.online = Boolean(result.ok);
  APP.config.apiBase = APP.config.apiBase || 'https://api.rwd.2bd.net';
  setApiStatus(
    result.ok ? `Online · ${APP.config.apiBase.replace(/^https?:\/\//, '')}` : 'Offline · working locally',
    result.ok ? 'online' : 'offline'
  );
  return result.ok;
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

function applyUser(user) {
  APP.user = user || null;
  const signedIn = Boolean(APP.user);
  const name = signedIn ? APP.user.username : 'Sign in';
  $('#account-name').textContent = name;
  $('#account-avatar').outerHTML = avatarMarkup(APP.user, 'avatar-sm').replace('class="avatar avatar-sm"', 'class="avatar avatar-sm" id="account-avatar"');
  $('#home-avatar').outerHTML = avatarMarkup(APP.user, 'avatar-lg').replace('class="avatar avatar-lg"', 'class="avatar avatar-lg" id="home-avatar"');
  $('#home-name').textContent = signedIn ? APP.user.username : 'Guest';
  $('#home-handle').textContent = signedIn ? `@${APP.user.username} · ${APP.user.role || 'creator'}` : 'Not signed in · local mode';
  $('#home-profile-action').title = signedIn ? 'Open account page' : 'Sign in to REWIND';
  $('#account-chip').title = signedIn ? `Signed in as ${APP.user.username}` : 'Sign in to REWIND';
  $('#publish').disabled = !signedIn;
  renderAccountPage();
  if (signedIn) {
    refreshExperiences();
    loadAssetCatalog();
  } else {
    cloudPlaces = [];
    renderExperiences();
    $('#account-info').innerHTML = signedOutAccountMarkup();
  }
}

function signedOutAccountMarkup() {
  return `<article class="account-hero"><span class="avatar avatar-xl">?</span><div><h2>You are signed out</h2><p>Sign in to sync cloud places, upload assets, and publish experiences. Local projects always work offline.</p></div></article>
    <div class="account-stats"><article class="stat-card"><span>LOCAL PROJECTS</span><b>${localProjects.length}</b></article><article class="stat-card"><span>CLOUD PLACES</span><b>—</b></article><article class="stat-card"><span>PLAN</span><b>Guest</b></article></div>
    <div class="dialog-actions"><button class="primary" id="account-signin">Sign in to REWIND</button></div>`;
}

async function requestLogin({ quiet = false } = {}) {
  if (!desktop) return;
  const result = await desktop.openLogin();
  if (!quiet && result?.opened) output('Opened the REWIND sign-in window.', 'log');
}

async function refreshAuth({ promptIfSignedOut = false } = {}) {
  try {
    const result = await desktop.authStatus();
    applyUser(result?.user || null);
    if (result?.user) loginPrompted = true;
    if (!result?.user && promptIfSignedOut && !loginPrompted) {
      loginPrompted = true;
      await sleep(600);
      await requestLogin({ quiet: true });
    }
    return result?.user || null;
  } catch (error) {
    applyUser(null);
    output(`Account check failed: ${error.message}`, 'warn');
    return null;
  }
}

async function signOut() {
  try {
    await desktop.logout();
    applyUser(null);
    toast('Signed out of REWIND.', 'success');
    output('Signed out. Local projects remain available.', 'success');
    setLoading('Signing out…', true, 0.4);
    setTimeout(() => setLoading('', false), 350);
  } catch (error) {
    toast(`Could not sign out: ${error.message}`, 'error');
  }
}
/* ------------------------------------------------------------------ */
/* Home hub                                                            */
/* ------------------------------------------------------------------ */

function showHomePage(page = 'home') {
  APP.page = page;
  $$('.home-page').forEach(section => section.classList.add('hidden'));
  const target = $(`#${page}-page`);
  if (target) target.classList.remove('hidden');
  $$('[data-home-page]').forEach(button => button.classList.toggle('active', button.dataset.homePage === page));
  if (page === 'settings') syncSettingsInputs();
  if (page === 'local') renderLocalProjects();
  if (page === 'account') renderAccountPage();
  if (page === 'experiences') renderExperiences();
  $('.home-main')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function setView(view) {
  APP.view = view;
  document.body.dataset.view = view;
  const home = view === 'home';
  $('#home-screen').classList.toggle('hidden', !home);
  $('#editor-screen').classList.toggle('hidden', home);
  $('#view-home').classList.toggle('active', home);
  $('#view-editor').classList.toggle('active', !home);
  $('#view-editor').classList.toggle('hidden', false);
  $$('.project-tab, #open-project, #save-project, #export-project, #publish').forEach(node => node.classList.toggle('hidden', home));
  $('#view-home').classList.toggle('hidden', false);
  if (home) {
    $('#project-tab').classList.add('hidden');
    $('#open-project').classList.add('hidden');
    $('#save-project').classList.add('hidden');
    $('#export-project').classList.add('hidden');
    $('#publish').classList.add('hidden');
    renderHome();
  } else {
    $('#project-tab').classList.remove('hidden');
    $('#open-project').classList.remove('hidden');
    $('#save-project').classList.remove('hidden');
    $('#export-project').classList.remove('hidden');
    $('#publish').classList.remove('hidden');
    requestAnimationFrame(() => resizeViewport());
  }
}

function renderTemplates() {
  const host = $('#template-strip');
  if (!host) return;
  host.innerHTML = TEMPLATES.map(template => `
    <button class="template-card" data-template="${template.id}">
      <i>${template.icon}</i>
      <b>${escapeHtml(template.name)}</b>
      <small>${escapeHtml(template.summary)}</small>
    </button>`).join('');
  host.querySelectorAll('[data-template]').forEach(button => {
    button.onclick = () => openCreateDialog(button.dataset.template);
  });
}

function experienceCover(place) {
  const image = place.thumbnail_url || place.icon_url || '';
  if (image) return `<div class="experience-cover"><img src="${escapeHtml(image)}" alt=""><span class="experience-privacy">${escapeHtml(place.privacy || 'private')}</span></div>`;
  const letter = String(place.name || 'E').slice(0, 1).toUpperCase();
  return `<div class="experience-cover"><span>${escapeHtml(letter)}</span><span class="experience-privacy">${escapeHtml(place.privacy || 'private')}</span></div>`;
}

function experienceCard(place) {
  const parts = Number(place.scene?.objects?.length) || 0;
  return `<article class="experience-card" data-cloud-place="${escapeHtml(place.id)}" tabindex="0">
    ${experienceCover(place)}
    <button class="card-action" data-open-cloud="${escapeHtml(place.id)}">Open in Studio</button>
    <div class="experience-meta"><b>${escapeHtml(place.name || 'Untitled')}</b><small>${place.published ? 'Published' : 'Draft'} · ${parts} parts · ${formatRelative(place.updated_at || place.created_at)}</small></div>
  </article>`;
}

function renderExperiences() {
  renderHomeExperiences();
  const host = $('#experiences-list');
  const empty = $('#experiences-empty');
  if (!host) return;
  $('#experience-count').textContent = String(cloudPlaces.length);
  if (!APP.user) {
    host.innerHTML = '';
    empty.classList.remove('hidden');
    empty.innerHTML = `<b>Sign in to see your experiences</b><span>Cloud places appear here after you sign in. Your local projects are always available from the Local Projects tab.</span><button class="primary" data-signin>Sign in</button>`;
    empty.querySelector('[data-signin]')?.addEventListener('click', () => requestLogin());
    return;
  }
  if (!cloudPlaces.length) {
    host.innerHTML = '';
    empty.classList.remove('hidden');
    empty.innerHTML = `<b>No experiences yet</b><span>Create a new experience to publish your first REWIND world, or keep building locally.</span><button class="primary" data-create>Create experience</button>`;
    empty.querySelector('[data-create]')?.addEventListener('click', () => openCreateDialog());
    return;
  }
  empty.classList.add('hidden');
  host.innerHTML = cloudPlaces.map(experienceCard).join('');
  host.querySelectorAll('[data-cloud-place]').forEach(card => {
    card.addEventListener('dblclick', () => openCloudPlace(card.dataset.cloudPlace));
    card.addEventListener('keydown', event => { if (event.key === 'Enter') openCloudPlace(card.dataset.cloudPlace); });
  });
  host.querySelectorAll('[data-open-cloud]').forEach(button => {
    button.onclick = event => { event.stopPropagation(); openCloudPlace(button.dataset.openCloud); };
  });
}

function renderHomeExperiences() {
  const host = $('#home-experience-grid');
  if (!host) return;
  if (!APP.user) {
    host.innerHTML = `<div class="empty-state"><b>Your experiences, in the cloud</b><span>Sign in to load your REWIND places. Everything you make is also saved locally.</span><button class="subtle" data-signin>Sign in</button></div>`;
    host.querySelector('[data-signin]')?.addEventListener('click', () => requestLogin());
    return;
  }
  if (!cloudPlaces.length) {
    host.innerHTML = `<div class="empty-state"><b>No cloud experiences yet</b><span>Publish your first place to see it here.</span><button class="subtle" data-create>Create experience</button></div>`;
    host.querySelector('[data-create]')?.addEventListener('click', () => openCreateDialog());
    return;
  }
  host.innerHTML = cloudPlaces.slice(0, 4).map(experienceCard).join('');
  host.querySelectorAll('[data-open-cloud]').forEach(button => {
    button.onclick = event => { event.stopPropagation(); openCloudPlace(button.dataset.openCloud); };
  });
  host.querySelectorAll('[data-cloud-place]').forEach(card => {
    card.addEventListener('dblclick', () => openCloudPlace(card.dataset.cloudPlace));
  });
}

async function refreshExperiences() {
  if (!APP.user) { renderExperiences(); return; }
  const host = $('#experiences-list');
  if (host && APP.page === 'experiences') host.innerHTML = '<div class="empty-state"><b>Loading cloud places…</b><span>Talking to the REWIND API.</span></div>';
  const result = await apiTry('/api/places');
  if (!result.ok) {
    if (result.status === 401) {
      APP.user = null;
      applyUser(null);
    } else {
      output(`Could not load experiences: ${result.error}`, 'warn');
      if (host && APP.page === 'experiences') host.innerHTML = `<div class="empty-state"><b>Could not load experiences</b><span>${escapeHtml(result.error || 'Unknown error')}</span><button class="subtle" data-retry>Retry</button></div>`;
      host?.querySelector('[data-retry]')?.addEventListener('click', refreshExperiences);
    }
    return;
  }
  cloudPlaces = Array.isArray(result.data?.places) ? result.data.places : [];
  renderExperiences();
}

async function openCloudPlace(placeId) {
  const place = cloudPlaces.find(item => item.id === placeId);
  if (!place) return;
  const scene = place.scene && typeof place.scene === 'object' ? place.scene : {};
  const project = {
    format: 'rewind-project', version: 2, name: place.name || 'Cloud Place',
    description: place.description || '', genre: place.genre || 'All', privacy: place.privacy || 'private',
    remotePlaceId: place.id, iconAssetId: place.icon_asset_id || null, thumbnailAssetId: place.thumbnail_asset_id || null,
    savedAt: new Date().toISOString(),
    place: {
      objects: Array.isArray(scene.objects) ? scene.objects : [],
      ui: Array.isArray(scene.ui) ? scene.ui : [],
      scripts: Array.isArray(scene.scripts) ? scene.scripts : []
    },
    environment: scene.environment || null,
    settings: scene.settings || { gravity: 18 }
  };
  await loadProject(project, { filePath: null, cloud: true });
  toast(`Opened ${project.name} from REWIND.`, 'success');
}

/* ------------------------------------------------------------------ */
/* Local projects                                                      */
/* ------------------------------------------------------------------ */

function localActions(project) {
  return `<div class="row-actions">
    <button title="Open project" data-open-local="${escapeHtml(project.filePath)}">▶</button>
    <button title="Export place" data-export-local="${escapeHtml(project.filePath)}">⇩</button>
    <button title="Delete project" data-delete-local="${escapeHtml(project.filePath)}">✕</button>
  </div>`;
}

function bindLocalActions(root) {
  root.querySelectorAll('[data-open-local]').forEach(button => {
    button.onclick = event => { event.stopPropagation(); openLocalProject(button.dataset.openLocal); };
  });
  root.querySelectorAll('[data-export-local]').forEach(button => {
    button.onclick = async event => {
      event.stopPropagation();
      try {
        const loaded = await desktop.readLocalProject(button.dataset.exportLocal);
        const result = await desktop.exportProject({ project: loaded.project, defaultName: loaded.project.name });
        if (result) toast(`Exported ${result.filePath.split(/[\\/]/).pop()}`, 'success');
      } catch (error) { toast(`Export failed: ${error.message}`, 'error'); }
    };
  });
  root.querySelectorAll('[data-delete-local]').forEach(button => {
    button.onclick = async event => {
      event.stopPropagation();
      const project = localProjects.find(item => item.filePath === button.dataset.deleteLocal);
      if (!confirm(`Delete "${project?.name || 'this project'}" from the local library?`)) return;
      try {
        await desktop.deleteLocalProject(button.dataset.deleteLocal);
        toast('Local project deleted.', 'success');
        await refreshLocalProjects();
      } catch (error) { toast(`Could not delete: ${error.message}`, 'error'); }
    };
  });
}

function renderHomeLocal() {
  const host = $('#home-local-grid');
  if (!host) return;
  if (!localProjects.length) {
    host.innerHTML = `<div class="empty-state"><b>No local projects yet</b><span>Start from a template or create a blank place. Files are stored on this computer.</span><button class="subtle" data-new-local>New local project</button></div>`;
    host.querySelector('[data-new-local]')?.addEventListener('click', () => openCreateDialog());
    return;
  }
  host.innerHTML = localProjects.slice(0, 3).map(project => `
    <article class="local-card" data-local-row="${escapeHtml(project.filePath)}">
      <span class="local-icon">▦</span>
      <div><b>${escapeHtml(project.name)}</b><small>${project.objectCount} parts · ${formatRelative(project.updatedAt)}</small></div>
      ${localActions(project)}
    </article>`).join('');
  bindLocalActions(host);
  host.querySelectorAll('[data-local-row]').forEach(card => {
    card.addEventListener('dblclick', () => openLocalProject(card.dataset.localRow));
  });
}

function renderLocalProjects() {
  renderHomeLocal();
  const dock = $('#local-dock-list');
  if (dock) {
    dock.innerHTML = localProjects.length
      ? localProjects.slice(0, 12).map(project => `
        <div class="local-dock-row" data-local-dock="${escapeHtml(project.filePath)}">
          <div><b>${escapeHtml(project.name)}</b><small>${project.objectCount} parts · ${formatRelative(project.updatedAt)}</small></div>
          <button title="Open">▶</button>
        </div>`).join('')
      : '<div class="asset-note">No saved local projects yet.</div>';
    dock.querySelectorAll('[data-local-dock]').forEach(row => {
      row.querySelector('button').onclick = () => openLocalProject(row.dataset.localDock);
    });
  }
  const host = $('#local-projects-list');
  if (!host) return;
  $('#local-count').textContent = String(localProjects.length);
  if (!localProjects.length) {
    host.innerHTML = `<div class="empty-state"><b>Your local library is empty</b><span>Projects are saved as <code>.rwdproj</code> JSON files in your REWIND Studio app-data folder. They open without an internet connection.</span><button class="primary" data-new-local>Create a local project</button></div>`;
    host.querySelector('[data-new-local]')?.addEventListener('click', () => openCreateDialog());
    return;
  }
  host.innerHTML = localProjects.map(project => `
    <article class="local-row" data-local-row="${escapeHtml(project.filePath)}">
      <span class="local-icon">▦</span>
      <div>
        <b>${escapeHtml(project.name)}${project.remotePlaceId ? ' <span class="file-type cloud">CLOUD LINK</span>' : ''}</b>
        <small>${project.objectCount} parts · saved ${formatRelative(project.updatedAt)} · ${bytesLabel(project.size)} · ${escapeHtml(project.fileName)}</small>
      </div>
      ${localActions(project)}
    </article>`).join('');
  bindLocalActions(host);
  host.querySelectorAll('[data-local-row]').forEach(row => {
    row.addEventListener('dblclick', () => openLocalProject(row.dataset.localRow));
  });
}

async function refreshLocalProjects() {
  try {
    localProjects = await desktop.listLocalProjects();
  } catch (error) {
    localProjects = [];
    output(`Could not list local projects: ${error.message}`, 'warn');
  }
  renderLocalProjects();
  return localProjects;
}

async function openLocalProject(filePath) {
  try {
    const loaded = await desktop.readLocalProject(filePath);
    await loadProject(loaded.project, { filePath });
  } catch (error) {
    toast(`Could not open project: ${error.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Account page                                                        */
/* ------------------------------------------------------------------ */

function renderAccountPage() {
  const host = $('#account-info');
  if (!host) return;
  if (!APP.user) {
    host.innerHTML = signedOutAccountMarkup();
    host.querySelector('#account-signin')?.addEventListener('click', () => requestLogin());
    return;
  }
  const account = rewindAccount?.account || {};
  const plan = account.plan || 'free';
  const entitlements = rewindAccount?.entitlements || {};
  host.innerHTML = `
    <div>
      <article class="account-hero">
        ${avatarMarkup(APP.user, 'avatar-xl')}
        <div><h2>${escapeHtml(APP.user.username)}</h2><p>@${escapeHtml(APP.user.username)} · ${escapeHtml(APP.user.role || 'user')} · ${escapeHtml(plan)} plan</p></div>
      </article>
      <div class="account-stats">
        <article class="stat-card"><span>CLOUD EXPERIENCES</span><b>${cloudPlaces.length}</b></article>
        <article class="stat-card"><span>LOCAL PROJECTS</span><b>${localProjects.length}</b></article>
        <article class="stat-card"><span>ORBS</span><b>${Number(account.orbs) || 0}</b></article>
      </div>
    </div>
    <div class="account-side">
      <article class="settings-card">
        <h3><span>◈</span>Plan &amp; entitlements</h3>
        <div class="account-row"><span>Plan</span><b>${escapeHtml(plan)}</b></div>
        <div class="account-row"><span>Daily Orbs</span><b>${entitlements.daily ?? '—'}</b></div>
        <div class="account-row"><span>Friends</span><b>${entitlements.friends === null ? 'Unlimited' : entitlements.friends ?? '—'}</b></div>
        <div class="account-row"><span>Assets</span><b>${entitlements.assets ? 'Enabled' : 'Not included'}</b></div>
        <div class="settings-actions"><button class="subtle" id="account-open-web">Manage on rwd.2bd.net ↗</button></div>
      </article>
      <article class="settings-card">
        <h3><span>◐</span>Session</h3>
        <p class="settings-note">The Studio stores its session on this computer. Signing out removes the saved cookie.</p>
        <div class="settings-actions"><button class="subtle" id="account-signout">Sign out</button></div>
      </article>
    </div>`;
  host.querySelector('#account-open-web')?.addEventListener('click', () => desktop.openExternal('https://rwd.2bd.net/account'));
  host.querySelector('#account-signout')?.addEventListener('click', signOut);
}

async function loadAccountPage() {
  if (!APP.user) { renderAccountPage(); return; }
  const result = await apiTry('/api/account');
  if (result.ok) rewindAccount = result.data;
  renderAccountPage();
}

async function openAccountPage() {
  showHomePage('account');
  setView('home');
  renderAccountPage();
  loadAccountPage();
}

/* ------------------------------------------------------------------ */
/* Local project persistence                                           */
/* ------------------------------------------------------------------ */

function projectSnapshot() {
  return {
    format: 'rewind-project',
    version: 2,
    name: ($('#project-title').value || 'Untitled Place').trim() || 'Untitled Place',
    description: projectMeta.description || '',
    genre: projectMeta.genre || 'All',
    privacy: projectMeta.privacy || 'private',
    iconAssetId: projectMeta.iconAssetId || null,
    thumbnailAssetId: projectMeta.thumbnailAssetId || null,
    remotePlaceId: projectMeta.remotePlaceId || null,
    savedAt: new Date().toISOString(),
    place: {
      objects: sceneState.records.map(copyRecord),
      ui: sceneState.uiItems.map(item => ({ ...item })),
      scripts: sceneState.scripts.map(item => ({ ...item }))
    },
    environment: { ...sceneState.environment, customSkybox: sceneState.environment.customSkybox || null },
    settings: { gravity: 18, spawn: findSpawnPoint().toArray(), snap: settings.editor.snapIncrement }
  };
}

function copyRecord(item) {
  return {
    ...item,
    position: [...(item.position || [0, 0, 0])],
    size: [...(item.size || [1, 1, 1])],
    rotation: [...(item.rotation || [0, 0, 0])]
  };
}

async function saveProject({ saveAs = false } = {}) {
  if (!sceneState.active) { toast('Open a project before saving.', 'warn'); return false; }
  const project = projectSnapshot();
  try {
    setLoading('Saving project…', true, 0.5);
    let result;
    if (projectMeta.filePath && !saveAs) {
      result = await desktop.saveProject({ project, filePath: projectMeta.filePath });
    } else if (projectMeta.filePath && saveAs) {
      result = await desktop.saveProject({ project, filePath: projectMeta.filePath, saveAs: true });
    } else {
      result = await desktop.saveProject({ project, filePath: null, saveAs: true });
    }
    if (!result) { setLoading('', false); return false; }
    projectMeta.filePath = result.filePath;
    markSaved();
    await refreshLocalProjects();
    output(`Saved ${result.filePath}`, 'success');
    toast('Project saved.', 'success');
    return true;
  } catch (error) {
    output(`Save failed: ${error.message}`, 'error');
    toast(`Save failed: ${error.message}`, 'error');
    return false;
  } finally {
    setLoading('', false);
  }
}

async function exportProject() {
  if (!sceneState.active) { toast('Open a project before exporting.', 'warn'); return; }
  try {
    const project = projectSnapshot();
    const result = await desktop.exportProject({ project, defaultName: project.name });
    if (!result) return;
    output(`Exported place to ${result.filePath}`, 'success');
    toast(`Place exported: ${result.filePath.split(/[\\/]/).pop()}`, 'success');
  } catch (error) {
    toast(`Export failed: ${error.message}`, 'error');
  }
}

async function openProjectFile() {
  try {
    const result = await desktop.openProject();
    if (!result) return;
    await loadProject(result.project, { filePath: result.filePath });
  } catch (error) {
    toast(`Could not open project: ${error.message}`, 'error');
  }
}

async function saveCurrentLocal() {
  if (!sceneState.active) { toast('Open a project first.', 'warn'); return; }
  const project = projectSnapshot();
  try {
    const result = await desktop.saveLocalProject({ project });
    projectMeta.filePath = result.filePath;
    markSaved();
    await refreshLocalProjects();
    output(`Saved to local library: ${result.filePath}`, 'success');
    toast('Saved to the local library.', 'success');
  } catch (error) {
    toast(`Could not save locally: ${error.message}`, 'error');
  }
}
/* ------------------------------------------------------------------ */
/* Engine state                                                        */
/* ------------------------------------------------------------------ */

const sceneState = {
  active: false,
  records: [],
  uiItems: [],
  scripts: [],
  selected: null,
  selectedUi: null,
  currentScriptId: null,
  environment: {
    preset: 'studio', elevation: 28, azimuth: 140, sunIntensity: 3, ambientIntensity: 2.3,
    turbidity: 7, rayleigh: 2, stars: false, fog: true, fogFar: 140,
    bloom: true, bloomStrength: 0.35, exposure: 1.05, customSkybox: null
  },
  history: [],
  historyIndex: -1,
  objectMap: new Map(),
  tool: 'select'
};

const projectMeta = {
  filePath: null,
  remotePlaceId: null,
  description: '',
  genre: 'All',
  privacy: 'private',
  iconAssetId: null,
  thumbnailAssetId: null
};

const SKY_PRESETS = {
  studio: { elevation: 28, azimuth: 140, turbidity: 7, rayleigh: 2, sunIntensity: 3, ambientIntensity: 2.3, stars: false },
  day: { elevation: 52, azimuth: 160, turbidity: 4, rayleigh: 1.2, sunIntensity: 4.2, ambientIntensity: 2.8, stars: false },
  sunset: { elevation: 8, azimuth: 250, turbidity: 12, rayleigh: 2.4, sunIntensity: 2.6, ambientIntensity: 1.6, stars: false },
  night: { elevation: -6, azimuth: 200, turbidity: 2, rayleigh: 3, sunIntensity: 0.6, ambientIntensity: 0.55, stars: true },
  nebula: { elevation: 6, azimuth: 220, turbidity: 16, rayleigh: 3.2, sunIntensity: 1.4, ambientIntensity: 1.1, stars: true },
  void: { elevation: -10, azimuth: 180, turbidity: 1, rayleigh: 0.4, sunIntensity: 0.25, ambientIntensity: 0.35, stars: true }
};

const MATERIAL_LIBRARY = {
  SmoothPlastic: { roughness: 0.62, metalness: 0.03 },
  Metal: { roughness: 0.28, metalness: 0.92 },
  Wood: { roughness: 0.86, metalness: 0 },
  Concrete: { roughness: 0.95, metalness: 0 },
  Glass: { roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.35 },
  Neon: { roughness: 0.5, metalness: 0, emissive: true }
};

let renderer;
let scene;
let camera;
let orbit;
let transform;
let composer;
let bloomPass;
let sky;
let sunLight;
let hemiLight;
let gridHelper;
let axesHelper;
let stars;
let selectionBox;
let workspace;
let viewportEl;
let canvasEl;
let blockMesh;
let engineReady = false;
let playState = null;
let player = null;
let playerVelocity = new THREE.Vector3();
let playerYaw = 0;
let savedCamera = null;
let playHeartbeatTimer = null;
let autoSaveTimer = null;
let scriptSyncTimer = null;
let historyTimer = null;
let pointer = new THREE.Vector2();
let raycaster = new THREE.Raycaster();
const keys = new Set();
let lastFrameTime = performance.now();

function initEngine() {
  if (engineReady) return;
  canvasEl = $('#scene-canvas');
  viewportEl = $('#viewport-wrap');
  renderer = new THREE.WebGLRenderer({
    canvas: canvasEl,
    antialias: settings.render.antialias !== false,
    alpha: false,
    powerPreference: 'high-performance'
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = settings.render.shadows !== false;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor('#101118');
  renderer.toneMapping = toneMappingValue(settings.render.toneMapping);
  renderer.toneMappingExposure = Number(settings.render.exposure) || 1.05;

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#9fb7d6', 40, Number(sceneState.environment.fogFar) || 140);

  camera = new THREE.PerspectiveCamera(Number(settings.render.fov) || 55, 1, 0.05, 3000);
  camera.position.set(14, 11, 16);

  orbit = new OrbitControls(camera, canvasEl);
  orbit.target.set(0, 1.4, 0);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.075;
  orbit.maxPolarAngle = Math.PI * 0.495;
  orbit.minDistance = 1;
  orbit.maxDistance = 600;
  orbit.update();

  hemiLight = new THREE.HemisphereLight('#d7e3ff', '#423a52', Number(sceneState.environment.ambientIntensity) || 2.3);
  scene.add(hemiLight);

  sunLight = new THREE.DirectionalLight('#fff3dd', Number(sceneState.environment.sunIntensity) || 3);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(Number(settings.render.shadowMap) || 1024, Number(settings.render.shadowMap) || 1024);
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 260;
  sunLight.shadow.camera.left = -90;
  sunLight.shadow.camera.right = 90;
  sunLight.shadow.camera.top = 90;
  sunLight.shadow.camera.bottom = -90;
  sunLight.shadow.bias = -0.0006;
  scene.add(sunLight);
  scene.add(sunLight.target);

  sky = new Sky();
  sky.scale.setScalar(450000);
  scene.add(sky);

  stars = createStars();
  scene.add(stars);

  workspace = new THREE.Group();
  workspace.name = 'Workspace';
  scene.add(workspace);

  gridHelper = new THREE.GridHelper(Number(settings.editor.gridSize) || 100, 100, '#5d5a75', '#343442');
  gridHelper.position.y = 0.002;
  scene.add(gridHelper);

  axesHelper = new THREE.AxesHelper(4);
  scene.add(axesHelper);

  selectionBox = new THREE.BoxHelper(new THREE.Object3D(), '#b6a6ff');
  selectionBox.visible = false;
  selectionBox.material.depthTest = false;
  selectionBox.material.transparent = true;
  selectionBox.material.opacity = 0.9;
  scene.add(selectionBox);

  transform = new TransformControls(camera, canvasEl);
  transform.setSize(0.8);
  scene.add(transform.getHelper());
  transform.addEventListener('dragging-changed', event => {
    orbit.enabled = !event.value && !playState;
  });
  transform.addEventListener('objectChange', syncTransformToRecord);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), Number(sceneState.environment.bloomStrength) || 0.35, 0.65, 0.86);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();

  applyEnvironment({ applySkyPreset: false });
  applyRenderSettings({ toastAntiAlias: false });
  updateEnvironmentControls();
  syncSettingsInputs();

  new ResizeObserver(() => resizeViewport()).observe(viewportEl);
  window.addEventListener('resize', resizeViewport);
  resizeViewport();
  bindViewportEvents();
  bindKeyboard();
  engineReady = true;
  renderLoop();
  output('Viewport engine ready.', 'success');
}

function toneMappingValue(name) {
  return {
    ACESFilmic: THREE.ACESFilmicToneMapping,
    Reinhard: THREE.ReinhardToneMapping,
    Cineon: THREE.CineonToneMapping,
    Linear: THREE.LinearToneMapping,
    None: THREE.NoToneMapping
  }[name] ?? THREE.ACESFilmicToneMapping;
}

function applyRenderSettings({ toastAntiAlias = false } = {}) {
  if (!renderer) return;
  const render = settings.render;
  const scale = clamp(Number(render.pixelRatio) || 1, 0.5, 2);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * scale);
  renderer.shadowMap.enabled = Boolean(render.shadows);
  if (sunLight) {
    const size = Number(render.shadowMap) || 1024;
    if (sunLight.shadow.mapSize.x !== size) {
      sunLight.shadow.mapSize.set(size, size);
      sunLight.shadow.map?.dispose();
      sunLight.shadow.map = null;
    }
    sunLight.castShadow = Boolean(render.shadows);
  }
  renderer.toneMapping = toneMappingValue(render.toneMapping);
  renderer.toneMappingExposure = Number(render.exposure) || 1.05;
  if (camera) {
    camera.fov = Number(render.fov) || 55;
    camera.updateProjectionMatrix();
  }
  if (gridHelper) gridHelper.visible = Boolean(render.showGrid);
  if (axesHelper) axesHelper.visible = Boolean(render.showAxes);
  if (bloomPass) {
    bloomPass.enabled = Boolean(sceneState.environment.bloom) && Boolean(render.bloom);
    bloomPass.strength = Number(sceneState.environment.bloomStrength) || 0.35;
  }
  updateEnvironmentFog();
  syncToggleButtons();
  if (toastAntiAlias) toast('Restart Studio to apply anti-aliasing.', 'info');
  resizeViewport();
}

function applyQualityPreset(quality) {
  const presets = {
    low: { pixelRatio: 0.65, shadows: false, shadowMap: '512', bloom: false },
    medium: { pixelRatio: 0.85, shadows: true, shadowMap: '1024', bloom: false },
    high: { pixelRatio: 1, shadows: true, shadowMap: '2048', bloom: true },
    ultra: { pixelRatio: 1.5, shadows: true, shadowMap: '4096', bloom: true }
  };
  const preset = presets[quality];
  if (!preset) return;
  for (const [key, value] of Object.entries(preset)) setSetting(`render.${key}`, value);
  applyRenderSettings();
  syncSettingsInputs();
}

function applyEnvironment({ applySkyPreset = true, rebuildSkybox = false } = {}) {
  const env = sceneState.environment;
  if (!engineReady) return;
  if (applySkyPreset && env.preset !== 'custom' && SKY_PRESETS[env.preset]) {
    Object.assign(env, SKY_PRESETS[env.preset], { preset: env.preset });
  }
  if (env.customSkybox && rebuildSkybox) loadCustomSkybox(env.customSkybox, { silent: true });
  else if (!env.customSkybox) clearCustomSkybox({ silent: true });

  const phi = THREE.MathUtils.degToRad(90 - Number(env.elevation));
  const theta = THREE.MathUtils.degToRad(Number(env.azimuth));
  if (sky) {
    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = Number(env.turbidity) || 7;
    uniforms.rayleigh.value = Number(env.rayleigh) || 2;
    uniforms.mieCoefficient.value = 0.004;
    uniforms.mieDirectionalG.value = 0.82;
    uniforms.sunPosition.value.setFromSphericalCoords(1, phi, theta);
    sky.visible = !env.customSkybox;
  }
  if (sunLight) {
    const sunDirection = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    sunLight.position.copy(sunDirection.multiplyScalar(140));
    sunLight.target.position.set(0, 0, 0);
    sunLight.intensity = Number(env.sunIntensity) || 3;
    sunLight.castShadow = Boolean(settings.render.shadows);
  }
  if (hemiLight) hemiLight.intensity = Number(env.ambientIntensity) || 2.3;
  if (stars) stars.visible = Boolean(env.stars);
  if (bloomPass) {
    bloomPass.enabled = Boolean(env.bloom) && Boolean(settings.render.bloom);
    bloomPass.strength = Number(env.bloomStrength) || 0.35;
  }
  if (renderer) renderer.toneMappingExposure = Number(env.exposure) || 1.05;
  updateEnvironmentFog();
  updateEnvironmentControls();
}

function updateEnvironmentFog() {
  if (!scene) return;
  const env = sceneState.environment;
  const enabled = Boolean(env.fog) && Boolean(settings.render.fog);
  scene.fog = enabled ? new THREE.Fog(scene.background?.isColor ? scene.background.getHex() : '#9fb7d6', 35, Number(env.fogFar) || 140) : null;
}

function createStars() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(1800 * 3);
  for (let index = 0; index < 1800; index += 1) {
    const radius = 320 + Math.random() * 500;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = Math.abs(radius * Math.cos(phi)) + 20;
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: '#e6ecff', size: 1.5, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false });
  return new THREE.Points(geometry, material);
}

let customSkyboxTexture = null;

function loadCustomSkybox(images, { silent = false } = {}) {
  if (!Array.isArray(images) || images.length !== 6) return;
  const loader = new THREE.TextureLoader();
  Promise.all(images.map(url => new Promise(resolve => loader.load(url, resolve, undefined, () => resolve(null)))))
    .then(textures => {
      if (textures.some(texture => !texture)) throw new Error('One or more skybox images could not be read.');
      textures.forEach(texture => { texture.colorSpace = THREE.SRGBColorSpace; });
      const cube = new THREE.CubeTexture(textures.map(texture => texture.image));
      cube.colorSpace = THREE.SRGBColorSpace;
      cube.needsUpdate = true;
      customSkyboxTexture?.dispose();
      customSkyboxTexture = cube;
      scene.background = cube;
      scene.environment = cube;
      if (sky) sky.visible = false;
      if (!silent) toast('Custom skybox applied.', 'success');
    })
    .catch(error => {
      if (!silent) toast(error.message, 'error');
      sceneState.environment.customSkybox = null;
      applyEnvironment({ applySkyPreset: false });
    });
}

function clearCustomSkybox({ silent = true } = {}) {
  customSkyboxTexture?.dispose();
  customSkyboxTexture = null;
  if (scene) {
    scene.background = null;
    scene.environment = null;
  }
  if (sky) sky.visible = true;
  if (!silent) toast('Custom skybox cleared.', 'success');
}

/* ------------------------------------------------------------------ */
/* Geometry and scene objects                                          */
/* ------------------------------------------------------------------ */

function createWedgeGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.5);
  shape.lineTo(0.5, -0.5);
  shape.lineTo(-0.5, 0.5);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geometry.translate(0, 0, -0.5);
  geometry.computeVertexNormals();
  return geometry;
}

function geometryFor(kind) {
  switch (kind) {
    case 'sphere': return new THREE.SphereGeometry(0.5, 32, 20);
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 28);
    case 'wedge': return createWedgeGeometry();
    case 'torus': return new THREE.TorusGeometry(0.36, 0.14, 16, 36);
    case 'plane': return new THREE.BoxGeometry(1, 0.08, 1);
    case 'spawn': return new THREE.CylinderGeometry(0.5, 0.5, 0.16, 32);
    case 'pyramid': return new THREE.ConeGeometry(0.5, 1, 4);
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

function materialFor(recordValue) {
  const preset = MATERIAL_LIBRARY[recordValue.material] || MATERIAL_LIBRARY.SmoothPlastic;
  const color = new THREE.Color(recordValue.color || '#8877f0');
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: preset.roughness,
    metalness: preset.metalness,
    transparent: preset.transparent || Number(recordValue.transparency) > 0,
    opacity: preset.transparent ? Math.min(preset.opacity, 1 - Number(recordValue.transparency || 0)) : 1 - Number(recordValue.transparency || 0)
  });
  if (preset.emissive) {
    material.emissive.copy(color);
    material.emissiveIntensity = 1.35;
  }
  material.side = THREE.DoubleSide;
  return material;
}

function makeMesh(recordValue) {
  if (recordValue.kind === 'model') {
    const group = new THREE.Group();
    group.name = recordValue.name;
    group.userData.recordId = recordValue.id;
    group.position.fromArray(recordValue.position || [0, 0, 0]);
    group.scale.fromArray(recordValue.size || [1, 1, 1]);
    group.rotation.fromArray(recordValue.rotation || [0, 0, 0]);
    group.visible = recordValue.visible !== false;
    workspace.add(group);
    sceneState.objectMap.set(recordValue.id, group);
    if (recordValue.assetUrl) {
      new GLTFLoader().load(recordValue.assetUrl, gltf => {
        if (!sceneState.objectMap.has(recordValue.id)) return;
        gltf.scene.traverse(node => {
          if (node.isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
            node.userData.recordId = recordValue.id;
          }
        });
        group.add(gltf.scene);
        output(`Loaded community model: ${recordValue.name}`, 'success');
      }, undefined, error => output(`Could not load ${recordValue.name}: ${error.message || 'invalid model'}`, 'error'));
    }
    return group;
  }

  if (recordValue.kind === 'bean') {
    const group = new THREE.Group();
    group.name = recordValue.name;
    group.userData.recordId = recordValue.id;
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.34, 0.46, 8, 18),
      new THREE.MeshStandardMaterial({ color: recordValue.color || '#efb75d', roughness: 0.72 })
    );
    body.position.y = 0.05;
    body.castShadow = true;
    body.userData.recordId = recordValue.id;
    group.add(body);
    const face = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 20, 14),
      new THREE.MeshStandardMaterial({ color: '#f4d7b3', roughness: 0.8 })
    );
    face.position.set(0, 0.72, 0);
    face.userData.recordId = recordValue.id;
    group.add(face);
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: '#292127' });
    for (const x of [-0.08, 0.08]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), eyeMaterial);
      eye.position.set(x, 0.76, 0.2);
      eye.userData.recordId = recordValue.id;
      group.add(eye);
    }
    group.position.fromArray(recordValue.position || [0, 0.9, 0]);
    group.scale.fromArray(recordValue.size || [1, 1, 1]);
    group.rotation.fromArray(recordValue.rotation || [0, 0, 0]);
    group.visible = recordValue.visible !== false;
    workspace.add(group);
    sceneState.objectMap.set(recordValue.id, group);
    return group;
  }

  const mesh = new THREE.Mesh(geometryFor(recordValue.kind), materialFor(recordValue));
  mesh.name = recordValue.name;
  mesh.userData.recordId = recordValue.id;
  mesh.position.fromArray(recordValue.position || [0, 0.5, 0]);
  mesh.scale.fromArray(recordValue.size || [1, 1, 1]);
  mesh.rotation.fromArray(recordValue.rotation || [0, 0, 0]);
  mesh.visible = recordValue.visible !== false;
  mesh.castShadow = recordValue.castShadow !== false && recordValue.kind !== 'light';
  mesh.receiveShadow = recordValue.kind !== 'light';
  if (recordValue.kind === 'pyramid') mesh.rotation.y += Math.PI / 4;
  if (recordValue.kind === 'spawn') mesh.position.y = Math.max(0.08, mesh.position.y);
  if (recordValue.kind === 'light') {
    const point = new THREE.PointLight(recordValue.color || '#ffe3a1', 14, 16, 1.8);
    point.castShadow = false;
    mesh.add(point);
    mesh.material.emissive = new THREE.Color(recordValue.color || '#ffe3a1');
    mesh.material.emissiveIntensity = 2;
  }
  workspace.add(mesh);
  sceneState.objectMap.set(recordValue.id, mesh);
  return mesh;
}

function disposeObject(object) {
  object.traverse(node => {
    if (node.geometry) node.geometry.dispose();
    if (Array.isArray(node.material)) node.material.forEach(material => material.dispose());
    else node.material?.dispose();
  });
}

function rebuildWorkspace() {
  if (!workspace) return;
  transform?.detach();
  for (const object of sceneState.objectMap.values()) {
    disposeObject(object);
    workspace.remove(object);
  }
  sceneState.objectMap.clear();
  for (const item of sceneState.records) {
    if (!sceneState.objectMap.has(item.id)) makeMesh(item);
  }
  updateCounts();
  updateSelectionBox();
}

function updateCounts() {
  const count = sceneState.records.length + sceneState.uiItems.length;
  $('#scene-count').textContent = `${count} ${count === 1 ? 'object' : 'objects'}`;
  const files = localProjects.length;
  $('#local-count').textContent = String(files);
}

function findSpawnPoint() {
  const spawn = sceneState.records.find(item => item.kind === 'spawn');
  if (spawn) return new THREE.Vector3(spawn.position[0], Math.max(0, spawn.position[1] + 0.08), spawn.position[2]);
  return new THREE.Vector3(0, 0, 0);
}

let lastGridSize = null;

function updateGrid() {
  if (!scene || !gridHelper) return;
  const size = Number(settings.editor.gridSize) || 100;
  if (size === lastGridSize) return;
  lastGridSize = size;
  scene.remove(gridHelper);
  gridHelper.geometry.dispose();
  gridHelper.material.dispose();
  gridHelper = new THREE.GridHelper(size, Math.min(200, size), '#5d5a75', '#343442');
  gridHelper.position.y = 0.002;
  gridHelper.visible = Boolean(settings.render.showGrid);
  scene.add(gridHelper);
}

function syncToggleButtons() {
  const gridOn = Boolean(settings.render.showGrid);
  const axesOn = Boolean(settings.render.showAxes);
  $('#toggle-grid')?.classList.toggle('active', gridOn);
  $('#toggle-grid-2')?.classList.toggle('active', gridOn);
  $('#toggle-axes')?.classList.toggle('active', axesOn);
  $('#toggle-axes-2')?.classList.toggle('active', axesOn);
  $('#viewport-hint')?.classList.toggle('hidden', !settings.editor.showHints);
}

function resizeViewport() {
  if (!renderer || !camera || !viewportEl) return;
  const rect = viewportEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  renderer.setSize(rect.width, rect.height, false);
  composer?.setSize(rect.width, rect.height);
  bloomPass?.setSize(rect.width, rect.height);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  $('#camera-readout').textContent = `${camera.fov}° · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
}

function frameAll() {
  if (!workspace || !camera) return;
  const box = new THREE.Box3();
  let hasContent = false;
  for (const object of sceneState.objectMap.values()) {
    if (!object.visible) continue;
    box.expandByObject(object);
    hasContent = true;
  }
  if (!hasContent) box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(20, 4, 20));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 4) * 1.1;
  const direction = new THREE.Vector3(0.85, 0.68, 1).normalize();
  orbit.target.copy(center);
  camera.position.copy(center).addScaledVector(direction, radius * 1.9);
  camera.near = 0.05;
  camera.far = Math.max(600, radius * 12);
  camera.updateProjectionMatrix();
  orbit.update();
  output('Framed all objects in the viewport.', 'log');
}

function updateSelectionBox() {
  if (!selectionBox) return;
  const target = sceneState.selected ? sceneState.objectMap.get(sceneState.selected.id) : null;
  if (!target) { selectionBox.visible = false; return; }
  selectionBox.setFromObject(target);
  selectionBox.visible = true;
}

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const now = performance.now();
  const delta = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  if (playState && !playState.paused) updatePlayer(delta);
  else if (orbit) orbit.update();
  if (sceneState.selected) updateSelectionBox();
  if (composer && bloomPass?.enabled) composer.render();
  else renderer.render(scene, camera);
}
/* ------------------------------------------------------------------ */
/* Selection, tools, and properties                                    */
/* ------------------------------------------------------------------ */

function selectRecord(recordValue) {
  if (!recordValue) return;
  sceneState.selected = recordValue;
  sceneState.selectedUi = null;
  setUiMode(false);
  if (playState) return;
  if (sceneState.tool === 'select') transform.detach();
  else {
    const object = sceneState.objectMap.get(recordValue.id);
    if (object) transform.attach(object);
  }
  updateSelectionBox();
  renderTree();
  showProperties();
  updateSelectionStatus();
}

function selectUi(item) {
  sceneState.selectedUi = item;
  sceneState.selected = null;
  transform?.detach();
  selectionBox && (selectionBox.visible = false);
  setUiMode(true);
  renderTree();
  showProperties();
  renderUiPreview();
  updateSelectionStatus();
}

function clearSelection() {
  sceneState.selected = null;
  sceneState.selectedUi = null;
  transform?.detach();
  if (selectionBox) selectionBox.visible = false;
  renderTree();
  showProperties();
  updateSelectionStatus();
}

function updateSelectionStatus() {
  const target = sceneState.selected || sceneState.selectedUi;
  if (!target) {
    $('#selection-status').textContent = 'No selection';
    $('#coord-status').textContent = 'X 0.0 · Y 0.0 · Z 0.0';
    return;
  }
  $('#selection-status').textContent = `${target.name} · ${target.kind}`;
  const position = target.position || [0, 0, 0];
  $('#coord-status').textContent = `X ${Number(position[0] || 0).toFixed(1)} · Y ${Number(position[1] || 0).toFixed(1)} · Z ${Number(position[2] || 0).toFixed(1)}`;
}

function setTool(tool) {
  sceneState.tool = tool;
  $$('[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === tool));
  if (!transform) return;
  transform.setMode(tool === 'scale' ? 'scale' : tool === 'rotate' ? 'rotate' : 'translate');
  transform.translationSnap = settings.editor.snap ? Number(settings.editor.snapIncrement) || 1 : null;
  transform.rotationSnap = THREE.MathUtils.degToRad(Number(settings.editor.rotationSnap) || 15);
  transform.enabled = tool !== 'select' && Boolean(sceneState.selected) && !playState;
  if (tool === 'select' || !sceneState.selected || playState) transform.detach();
  else {
    const object = sceneState.objectMap.get(sceneState.selected.id);
    if (object) transform.attach(object);
  }
}

function syncTransformToRecord() {
  const recordValue = sceneState.selected;
  if (!recordValue || !transform) return;
  const object = sceneState.objectMap.get(recordValue.id);
  if (!object) return;
  recordValue.position = object.position.toArray().map(value => Number(value.toFixed(3)));
  recordValue.size = object.scale.toArray().map(value => Number(value.toFixed(3)));
  recordValue.rotation = object.rotation.toArray().slice(0, 3).map(value => Number(value.toFixed(4)));
  updateSelectionBox();
  updateSelectionStatus();
  showProperties();
  markDirty();
  pushHistory();
}

function propertyRow(label, content) {
  return `<div class="property-row" data-property-label="${escapeHtml(String(label).toLowerCase())}"><label>${escapeHtml(label)}</label>${content}</div>`;
}

function textProperty(label, prop, value) {
  return propertyRow(label, `<input data-prop="${prop}" type="text" value="${escapeHtml(value)}" spellcheck="false">`);
}

function numberProperty(label, prop, value, step = 0.1) {
  return propertyRow(label, `<input data-prop="${prop}" type="number" step="${step}" value="${Number(value || 0).toFixed(2)}">`);
}

function vectorGroup(label, prop, values, count = 3) {
  const axes = ['X', 'Y', 'Z'].slice(0, count);
  return `<div class="property-group">${label}</div>` + axes.map((axis, index) =>
    numberProperty(axis, `${prop}.${index}`, values[index] ?? 0, prop === 'rotation' ? 1 : 0.1)
  ).join('');
}

function checkboxProperty(label, prop, value) {
  return propertyRow(label, `<input data-prop="${prop}" type="checkbox" ${value ? 'checked' : ''}>`);
}

function colorProperty(label, prop, value) {
  return propertyRow(label, `<input data-prop="${prop}" type="color" value="${escapeHtml(value || '#8877f0')}">`);
}

function showProperties() {
  const body = $('#properties-body');
  const target = sceneState.selected || sceneState.selectedUi;
  if (!body) return;
  $('#class-name').textContent = target?.kind || '—';
  if (!target) {
    body.innerHTML = '<div class="properties-empty">Select an instance in the viewport or Explorer to inspect its properties.</div>';
    return;
  }
  const isUi = Boolean(sceneState.selectedUi);
  const position = target.position || [0, 0, 0];
  const size = target.size || [1, 1, 1];
  const rotation = (target.rotation || [0, 0, 0]).map(value => THREE.MathUtils.radToDeg(value));
  let html = `<div class="property-group">INSTANCE</div>${textProperty('Name', 'name', target.name)}`;
  html += `<div class="property-group">${isUi ? 'LAYOUT' : 'TRANSFORM'}</div>`;
  html += vectorGroup('Position', 'position', position, isUi ? 2 : 3);
  html += vectorGroup('Size', 'size', size, isUi ? 2 : 3);
  if (!isUi) html += vectorGroup('Rotation (deg)', 'rotation', rotation, 3);
  if (isUi) {
    html += textProperty('Text', 'text', target.text || '');
    if (target.kind === 'ImageLabel') html += textProperty('Image URL', 'imageUrl', target.imageUrl || '');
    html += colorProperty('Background', 'color', target.color || '#6155b7');
    html += checkboxProperty('Visible', 'visible', target.visible !== false);
  } else {
    html += colorProperty('Color', 'color', target.color || '#8877f0');
    html += propertyRow('Material', `<select data-prop="material">${Object.keys(MATERIAL_LIBRARY).map(name => `<option value="${name}" ${target.material === name ? 'selected' : ''}>${name}</option>`).join('')}</select>`);
    html += propertyRow('Transparency', `<input data-prop="transparency" type="range" min="0" max="0.9" step="0.05" value="${Number(target.transparency) || 0}">`);
    html += checkboxProperty('Anchored', 'anchored', target.anchored !== false);
    html += checkboxProperty('Visible', 'visible', target.visible !== false);
    html += checkboxProperty('Cast shadow', 'castShadow', target.castShadow !== false);
    if (target.kind === 'spawn') html += `<div class="property-group">SPAWN</div><div class="property-row"><label>Player start</label><span style="font-size:8px;color:var(--muted)">SpawnLocation</span></div>`;
  }
  body.innerHTML = html;
}

function propertyNumeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function applyProperty(target, prop, input) {
  if (!target) return;
  const isUi = Boolean(sceneState.selectedUi);
  if (prop.startsWith('position.') || prop.startsWith('size.') || prop.startsWith('rotation.')) {
    const [field, indexString] = prop.split('.');
    const index = Number(indexString);
    const value = prop.startsWith('rotation.') ? THREE.MathUtils.degToRad(propertyNumeric(input.value)) : propertyNumeric(input.value);
    target[field] = [...(target[field] || [0, 0, 0])];
    target[field][index] = value;
    if (!isUi) {
      const object = sceneState.objectMap.get(target.id);
      if (object) {
        object.position.fromArray(target.position || [0, 0, 0]);
        object.scale.fromArray(target.size || [1, 1, 1]);
        object.rotation.fromArray(target.rotation || [0, 0, 0]);
      }
    }
  } else if (prop === 'visible' || prop === 'anchored' || prop === 'castShadow') {
    target[prop] = input.checked;
    if (!isUi) {
      const object = sceneState.objectMap.get(target.id);
      if (object) {
        if (prop === 'visible') object.visible = input.checked;
        else object.traverse?.(node => { if (node.isMesh && prop === 'castShadow') node.castShadow = input.checked; });
      }
    }
  } else if (prop === 'transparency' || prop === 'opacity') {
    target.transparency = Number(input.value) || 0;
    const object = sceneState.objectMap.get(target.id);
    object?.traverse?.(node => {
      if (!node.isMesh || !node.material) return;
      node.material.transparent = target.transparency > 0;
      node.material.opacity = 1 - target.transparency;
      node.material.needsUpdate = true;
    });
  } else if (prop === 'color') {
    target.color = input.value;
    if (isUi) renderUiPreview();
    else {
      const object = sceneState.objectMap.get(target.id);
      object?.traverse?.(node => {
        if (!node.isMesh || !node.material?.color) return;
        node.material.color.set(target.color);
        if (node.material.emissive) node.material.emissive.set(target.color);
      });
    }
  } else if (prop === 'material') {
    target.material = input.value;
    if (!isUi) {
      const object = sceneState.objectMap.get(target.id);
      if (object?.isMesh) {
        const oldMaterial = object.material;
        object.material = materialFor(target);
        oldMaterial.dispose();
      }
    }
  } else if (prop === 'name') {
    target.name = input.value || target.kind || 'Instance';
    if (!isUi) {
      const object = sceneState.objectMap.get(target.id);
      if (object) object.name = target.name;
    }
  } else {
    target[prop] = input.value;
    if (isUi && prop === 'imageUrl') renderUiPreview();
  }
  updateSelectionBox();
  renderTree();
  if (isUi) renderUiPreview();
  updateSelectionStatus();
  markDirty();
  pushHistory();
}

/* ------------------------------------------------------------------ */
/* Explorer                                                            */
/* ------------------------------------------------------------------ */

function treeRow(item, isUi, depth = 0) {
  const selected = isUi ? sceneState.selectedUi?.id === item.id : sceneState.selected?.id === item.id;
  const icon = isUi ? (item.kind === 'TextLabel' ? 'T' : item.kind === 'TextButton' ? 'B' : item.kind === 'ImageLabel' ? '▧' : '▭')
    : item.kind === 'sphere' ? '●' : item.kind === 'light' ? '☼' : item.kind === 'spawn' ? '⌂' : item.kind === 'bean' ? '♟' : item.kind === 'torus' ? '◎' : '▰';
  return `<div class="tree-row ${selected ? 'selected' : ''}" style="padding-left:${9 + depth * 8}px" ${isUi ? `data-tree-ui="${item.id}"` : `data-tree-record="${item.id}"`}>
    <span class="tree-chevron"></span><span class="tree-icon">${icon}</span><span class="tree-name">${escapeHtml(item.name)}</span>
  </div>`;
}

function renderTree() {
  if (!treeViewReady()) return;
  const filter = ($('#tree-search').value || '').trim().toLowerCase();
  const matches = item => !filter || `${item.name} ${item.kind}`.toLowerCase().includes(filter);
  const records = sceneState.records.filter(matches);
  const uiItems = sceneState.uiItems.filter(matches);
  const html = `
    <div class="tree-row tree-root"><span class="tree-chevron">▾</span><span class="tree-icon">⌂</span><span class="tree-name">Workspace</span></div>
    <div class="tree-children">${records.length ? records.map(item => treeRow(item, false)).join('') : '<div class="tree-empty">Empty workspace</div>'}</div>
    <div class="tree-row tree-root"><span class="tree-chevron">▾</span><span class="tree-icon">▧</span><span class="tree-name">StarterGui</span></div>
    <div class="tree-children">${uiItems.length ? uiItems.map(item => treeRow(item, true)).join('') : '<div class="tree-empty">No interface elements</div>'}</div>
    <div class="tree-row tree-root"><span class="tree-chevron">▸</span><span class="tree-icon">☼</span><span class="tree-name">Lighting</span></div>
    <div class="tree-row tree-root"><span class="tree-chevron">▸</span><span class="tree-icon">▦</span><span class="tree-name">ReplicatedStorage</span></div>
    <div class="tree-row tree-root"><span class="tree-chevron">▸</span><span class="tree-icon">⌘</span><span class="tree-name">ServerScriptService</span></div>`;
  $('#tree-view').innerHTML = html;
  $$('[data-tree-record]', $('#tree-view')).forEach(row => {
    row.onclick = () => selectRecord(sceneState.records.find(item => item.id === row.dataset.treeRecord));
  });
  $$('[data-tree-ui]', $('#tree-view')).forEach(row => {
    row.onclick = () => selectUi(sceneState.uiItems.find(item => item.id === row.dataset.treeUi));
  });
}

const treeViewReady = () => Boolean($('#tree-view'));

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function historySnapshot() {
  const environment = { ...sceneState.environment };
  delete environment.customSkybox;
  return JSON.stringify({
    records: sceneState.records,
    uiItems: sceneState.uiItems,
    scripts: sceneState.scripts,
    name: $('#project-title').value,
    environment
  });
}

function pushHistory({ immediate = false } = {}) {
  const commit = () => {
    const snapshot = historySnapshot();
    if (sceneState.history[sceneState.historyIndex] === snapshot) return;
    sceneState.history = sceneState.history.slice(0, sceneState.historyIndex + 1);
    sceneState.history.push(snapshot);
    if (sceneState.history.length > 80) sceneState.history.shift();
    sceneState.historyIndex = sceneState.history.length - 1;
  };
  clearTimeout(historyTimer);
  if (immediate) commit();
  else historyTimer = setTimeout(commit, 140);
}

function restoreHistory(offset) {
  clearTimeout(historyTimer);
  const next = sceneState.historyIndex + offset;
  if (next < 0 || next >= sceneState.history.length) {
    output('Nothing to undo or redo.', 'log');
    return;
  }
  sceneState.historyIndex = next;
  try {
    const value = JSON.parse(sceneState.history[next]);
    const customSkybox = sceneState.environment.customSkybox;
    sceneState.records = value.records || [];
    sceneState.uiItems = value.uiItems || [];
    sceneState.scripts = value.scripts || [];
    if (value.environment) Object.assign(sceneState.environment, value.environment);
    sceneState.environment.customSkybox = customSkybox;
    $('#project-title').value = value.name || 'Untitled Place';
    sceneState.selected = null;
    sceneState.selectedUi = null;
    transform?.detach();
    rebuildWorkspace();
    renderTree();
    renderUiPreview();
    renderScripts();
    showProperties();
    applyEnvironment({ applySkyPreset: false, rebuildSkybox: true });
    updateCounts();
    markDirty();
    output(offset < 0 ? 'Undid the last change.' : 'Redid the change.', 'log');
  } catch (error) {
    output(`Could not restore history: ${error.message}`, 'error');
  }
}

function markDirty() {
  if (!sceneState.active) return;
  $('#dirty-dot').classList.remove('saved');
  $('#save-project').textContent = 'Save *';
}

function markSaved() {
  $('#dirty-dot').classList.add('saved');
  $('#save-project').textContent = 'Save';
}

/* ------------------------------------------------------------------ */
/* UI preview                                                          */
/* ------------------------------------------------------------------ */

function setUiMode(on) {
  const enabled = Boolean(on);
  viewportEl?.classList.toggle('ui-mode', enabled);
  $('#ui-preview')?.classList.toggle('hidden', !enabled);
  if (enabled) {
    transform?.detach();
    if (!playState) setModeLabel('UI EDITOR');
    if (settings.editor.showHints) $('#viewport-hint').textContent = 'Drag UI elements · edit exact values in Properties';
  } else if (!playState) {
    setModeLabel('EDIT MODE');
    if (settings.editor.showHints) $('#viewport-hint').textContent = 'Right-drag orbit · scroll zoom · click to select · Q/W/E/R tools';
  }
  renderUiPreview();
}

function renderUiPreview() {
  const host = $('#ui-elements');
  if (!host) return;
  host.innerHTML = sceneState.uiItems.map(item => {
    const selected = sceneState.selectedUi?.id === item.id;
    const left = (Number(item.position?.[0]) || 0) / 12.8;
    const top = (Number(item.position?.[1]) || 0) / 7.2;
    const width = (Number(item.size?.[0]) || 200) / 12.8;
    const height = (Number(item.size?.[1]) || 60) / 7.2;
    const background = item.kind === 'TextLabel' ? '' : `background:${escapeHtml(item.color || '#6155b7')}cc;`;
    return `<div class="ui-node ${selected ? 'selected' : ''}" data-ui-node="${escapeHtml(item.id)}" data-kind="${escapeHtml(item.kind)}"
      style="left:${left}%;top:${top}%;width:${width}%;height:${height}%;${background}${item.visible === false ? 'display:none;' : ''}">
      ${item.kind === 'ImageLabel' && item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}">` : escapeHtml(item.text || item.name)}
    </div>`;
  }).join('');

  host.querySelectorAll('[data-ui-node]').forEach(node => {
    node.addEventListener('pointerdown', event => {
      const item = sceneState.uiItems.find(candidate => candidate.id === node.dataset.uiNode);
      if (!item) return;
      event.stopPropagation();
      if (playState) {
        if (item.kind === 'TextButton') output(`${item.name} clicked.`, 'success');
        return;
      }
      selectUi(item);
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const start = [...item.position];
      const rect = $('#ui-preview').getBoundingClientRect();
      const move = pointerEvent => {
        item.position[0] = clamp(start[0] + (pointerEvent.clientX - startX) * 1280 / rect.width, 0, 1280 - item.size[0]);
        item.position[1] = clamp(start[1] + (pointerEvent.clientY - startY) * 720 / rect.height, 0, 720 - item.size[1]);
        renderUiPreview();
        showProperties();
        updateSelectionStatus();
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        markDirty();
        pushHistory();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
    });
  });
}
/* ------------------------------------------------------------------ */
/* Viewport input                                                      */
/* ------------------------------------------------------------------ */

function updateCameraReadout() {
  if (!camera) return;
  const label = $('#camera-mode-label');
  if (label) label.textContent = 'Perspective ▾';
  const readout = $('#camera-readout');
  if (readout) readout.textContent = `${camera.fov}° · ${Math.round(camera.position.distanceTo(orbit.target))} m`;
}

function bindViewportEvents() {
  canvasEl.addEventListener('pointerdown', event => {
    if (playState || event.button !== 0 || transform?.dragging || transform?.axis) return;
    const rect = canvasEl.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(workspace.children, true);
    if (!hits.length) { clearSelection(); return; }
    let object = hits[0].object;
    let recordId = object.userData.recordId;
    while (!recordId && object.parent) {
      object = object.parent;
      recordId = object.userData.recordId;
    }
    const recordValue = sceneState.records.find(item => item.id === recordId);
    if (recordValue) selectRecord(recordValue);
  });

  canvasEl.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (playState) return;
    $$('.viewport-menu').forEach(menu => menu.remove());
    const menu = document.createElement('div');
    menu.className = 'viewport-menu';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.innerHTML = `
      <button data-menu-insert="block">Insert block</button>
      <button data-menu-insert="sphere">Insert sphere</button>
      <button data-menu-insert="cylinder">Insert cylinder</button>
      <button data-menu-insert="spawn">Insert spawn</button>
      <button data-menu-ui="TextLabel">Insert text label</button>
      <button data-menu-ui="TextButton">Insert button</button>
      <button data-menu-frame>Frame all</button>
      <button data-menu-delete>Delete selection</button>`;
    document.body.append(menu);
    const dismiss = pointerEvent => {
      if (menu.contains(pointerEvent.target)) return;
      menu.remove();
      document.removeEventListener('pointerdown', dismiss);
    };
    setTimeout(() => document.addEventListener('pointerdown', dismiss), 0);
    menu.querySelectorAll('[data-menu-insert]').forEach(button => {
      button.onclick = () => { addObject(button.dataset.menuInsert); menu.remove(); };
    });
    menu.querySelectorAll('[data-menu-ui]').forEach(button => {
      button.onclick = () => { addUi(button.dataset.menuUi); menu.remove(); };
    });
    menu.querySelector('[data-menu-frame]').onclick = () => { frameAll(); menu.remove(); };
    menu.querySelector('[data-menu-delete]').onclick = () => { removeSelected(); menu.remove(); };
  });

  orbit.addEventListener('change', updateCameraReadout);
  orbit.addEventListener('end', updateCameraReadout);

  canvasEl.addEventListener('wheel', () => updateCameraReadout(), { passive: true });
}

function bindKeyboard() {
  window.addEventListener('keydown', event => {
    const tag = document.activeElement?.tagName;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.activeElement?.isContentEditable;
    if (event.code === 'Escape' && playState) { stopPlay(); return; }
    if (typing || APP.view !== 'editor') return;
    if (event.code === 'Delete' || event.code === 'Backspace') { event.preventDefault(); removeSelected(); return; }
    if (event.ctrlKey || event.metaKey) {
      if (event.code === 'KeyZ') { event.preventDefault(); restoreHistory(-1); }
      if (event.code === 'KeyY') { event.preventDefault(); restoreHistory(1); }
      return;
    }
    if (event.code === 'F5') { event.preventDefault(); startPlay($('#test-mode').value); return; }
    if (event.code === 'F8') { event.preventDefault(); startPlay('run'); return; }
    if (event.code === 'KeyQ') setTool('select');
    if (event.code === 'KeyW') setTool('move');
    if (event.code === 'KeyE') setTool('rotate');
    if (event.code === 'KeyR') setTool('scale');
    if (['KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft'].includes(event.code) && playState) event.preventDefault();
    keys.add(event.code);
  });
  window.addEventListener('keyup', event => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());
}

/* ------------------------------------------------------------------ */
/* Play mode                                                           */
/* ------------------------------------------------------------------ */

let luauWorker = null;
let luauReady = false;
let luauInitTimer = null;
let luauRunCounter = 0;
const luauPending = new Map();

function makePlayerRig() {
  const group = new THREE.Group();
  group.name = 'TestPlayer';
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.34, 0.46, 6, 16),
    new THREE.MeshStandardMaterial({ color: '#e7b25d', roughness: 0.8 })
  );
  body.position.y = 0.73;
  body.castShadow = true;
  group.add(body);
  const face = new THREE.Mesh(
    new THREE.SphereGeometry(0.23, 20, 14),
    new THREE.MeshStandardMaterial({ color: '#f4d7b3', roughness: 0.8 })
  );
  face.position.set(0, 1.3, 0);
  group.add(face);
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: '#292127' });
  for (const x of [-0.085, 0.085]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 8), eyeMaterial);
    eye.position.set(x, 1.34, 0.2);
    group.add(eye);
  }
  return group;
}

function setModeLabel(text) {
  $('#mode-label').textContent = String(text || '').toUpperCase();
}

function startPlay(kind = 'play') {
  if (!sceneState.active || playState) return;
  playState = { kind, paused: false };
  savedCamera = { position: camera.position.clone(), target: orbit.target.clone() };
  orbit.enabled = false;
  transform.detach();
  transform.enabled = false;
  viewportEl.classList.add('playing');
  setUiMode(false);
  if (kind !== 'run') {
    player = makePlayerRig();
    if (kind === 'here') {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      player.position.set(camera.position.x + forward.x * 3, findSpawnPoint().y, camera.position.z + forward.z * 3);
    } else {
      player.position.copy(findSpawnPoint());
    }
    playerVelocity.set(0, 0, 0);
    playerYaw = 0;
    scene.add(player);
    if (sceneState.uiItems.length) {
      $('#ui-preview').classList.remove('hidden');
      orbit.enabled = false;
    }
  }
  $$('.play-button').forEach(button => { button.disabled = true; });
  $$('.stop-button').forEach(button => { button.disabled = false; });
  $('#test-mode').disabled = true;
  $('#test-mode-alt').disabled = true;
  setModeLabel(kind === 'run' ? 'RUNNING' : 'PLAYTEST');
  if (settings.editor.showHints) $('#viewport-hint').textContent = 'WASD move · Space jump · Shift run · Esc stop';
  output(kind === 'run' ? 'Run started. Server scripts are executing in the Luau sandbox.' : 'Playtest started. WASD to move, Space to jump, Esc to stop.', 'success');
  runProjectScripts(kind);
  if (kind !== 'run') joinPlaySession();
}

function stopPlay() {
  if (!playState) return;
  playState = null;
  clearInterval(playHeartbeatTimer);
  playHeartbeatTimer = null;
  if (player) {
    scene.remove(player);
    disposeObject(player);
    player = null;
  }
  playerVelocity.set(0, 0, 0);
  if (luauPending.size) resetLuauWorker();
  $('#ui-preview').classList.toggle('hidden', !viewportEl.classList.contains('ui-mode'));
  if (savedCamera) {
    camera.position.copy(savedCamera.position);
    orbit.target.copy(savedCamera.target);
    savedCamera = null;
  }
  orbit.enabled = true;
  orbit.update();
  viewportEl.classList.remove('playing');
  $$('.play-button').forEach(button => { button.disabled = false; });
  $$('.stop-button').forEach(button => { button.disabled = true; });
  $('#test-mode').disabled = false;
  $('#test-mode-alt').disabled = false;
  setModeLabel('EDIT MODE');
  if (settings.editor.showHints) $('#viewport-hint').textContent = 'Right-drag orbit · scroll zoom · click to select · Q/W/E/R tools';
  output('Playtest stopped. Editor scene restored.', 'success');
}

function updatePlayer(delta) {
  if (!player || !playState) return;
  const forward = new THREE.Vector3(-Math.sin(playerYaw), 0, -Math.cos(playerYaw));
  const right = new THREE.Vector3(Math.cos(playerYaw), 0, -Math.sin(playerYaw));
  const move = new THREE.Vector3();
  if (keys.has('KeyW')) move.add(forward);
  if (keys.has('KeyS')) move.sub(forward);
  if (keys.has('KeyD')) move.add(right);
  if (keys.has('KeyA')) move.sub(right);
  if (move.lengthSq()) move.normalize().multiplyScalar((keys.has('ShiftLeft') ? 8 : 5) * delta);

  const candidate = player.position.clone().add(move);
  const radius = 0.34;
  const height = 1.5;
  for (const recordValue of sceneState.records) {
    if (!recordValue.anchored || recordValue.kind === 'light' || recordValue.kind === 'bean' || recordValue.kind === 'spawn') continue;
    const object = sceneState.objectMap.get(recordValue.id);
    if (!object || !object.visible) continue;
    const box = new THREE.Box3().setFromObject(object);
    const overlapsXZ = candidate.x + radius > box.min.x && candidate.x - radius < box.max.x && candidate.z + radius > box.min.z && candidate.z - radius < box.max.z;
    if (overlapsXZ && candidate.y < box.max.y && candidate.y + height > box.min.y) {
      const testX = player.position.x + move.x;
      if (testX - radius < box.max.x && testX + radius > box.min.x && player.position.z - radius < box.max.z && player.position.z + radius > box.min.z) candidate.x = player.position.x;
      const testZ = player.position.z + move.z;
      if (candidate.x - radius < box.max.x && candidate.x + radius > box.min.x && testZ - radius < box.max.z && testZ + radius > box.min.z) candidate.z = player.position.z;
    }
    if (overlapsXZ && playerVelocity.y <= 0 && player.position.y >= box.max.y - 0.08 && candidate.y < box.max.y) {
      candidate.y = box.max.y;
      playerVelocity.y = 0;
    }
  }

  const spawn = findSpawnPoint();
  const groundTop = sceneState.records.reduce((top, recordValue) => {
    if (recordValue.kind === 'spawn') return Math.max(top, recordValue.position[1] + 0.08);
    if (recordValue.kind === 'block' && recordValue.size[0] >= 20 && recordValue.size[2] >= 20) {
      return Math.max(top, recordValue.position[1] + recordValue.size[1] / 2);
    }
    return top;
  }, spawn.y);
  const grounded = player.position.y <= groundTop + 0.015;
  if (grounded && playerVelocity.y < 0) playerVelocity.y = 0;
  if (grounded && keys.has('Space')) { playerVelocity.y = 7.4; keys.delete('Space'); }
  playerVelocity.y -= 18 * delta;
  candidate.y += playerVelocity.y * delta;
  if (candidate.y < groundTop) { candidate.y = groundTop; playerVelocity.y = 0; }
  player.position.copy(candidate);
  if (move.lengthSq()) playerYaw = Math.atan2(-move.x, -move.z);

  const follow = new THREE.Vector3(Math.sin(playerYaw) * 5, 3.1, Math.cos(playerYaw) * 5);
  camera.position.lerp(player.position.clone().add(follow), Math.min(1, delta * 5));
  camera.lookAt(player.position.x, player.position.y + 1, player.position.z);
}

/* ------------------------------------------------------------------ */
/* Luau execution                                                      */
/* ------------------------------------------------------------------ */

const runningScripts = new Map();

function runProjectScripts(mode = 'play') {
  const scripts = mode === 'run'
    ? sceneState.scripts.filter(script => script.type === 'ServerScript')
    : sceneState.scripts.filter(script => script.type !== 'ModuleScript');
  if (!scripts.length) {
    output('No Luau scripts to run. Add one from the Scripts dock.', 'warn');
    return;
  }
  const contextObjects = sceneState.records.map(item => ({
    name: item.name, kind: item.kind, position: item.position, size: item.size, anchored: item.anchored
  }));
  for (const script of scripts) {
    executeScript(script, { objects: contextObjects, scope: mode });
  }
}

function resetLuauWorker(reason = '') {
  if (luauWorker) {
    try { luauWorker.terminate(); } catch { /* Already stopped. */ }
  }
  luauWorker = null;
  luauReady = false;
  clearTimeout(luauInitTimer);
  luauInitTimer = null;
  for (const entry of luauPending.values()) {
    clearTimeout(entry.timer);
    if (reason) output(`[${entry.name}] ${reason}`, 'warn');
  }
  luauPending.clear();
  runningScripts.clear();
}

function ensureLuauWorker() {
  if (luauWorker) return;
  luauWorker = new Worker(new URL('./script-worker.js', import.meta.url), { type: 'module' });
  luauReady = false;
  let statusShown = false;
  luauInitTimer = setTimeout(() => {
    output('The Luau runtime is taking longer than expected to start. Stopping it.', 'error');
    resetLuauWorker();
  }, 60000);

  luauWorker.onmessage = event => {
    const data = event.data || {};
    if (data.type === 'status') {
      if (!statusShown) {
        statusShown = true;
        output(data.text || 'Starting the Luau runtime…', 'log');
      }
      return;
    }
    if (data.type === 'ready') {
      clearTimeout(luauInitTimer);
      luauInitTimer = null;
      luauReady = true;
      output('Luau virtual machine ready.', 'success');
      for (const entry of luauPending.values()) {
        if (!entry.sent) sendLuauRun(entry);
      }
      return;
    }
    if (data.type === 'init-error') {
      output(`Luau runtime failed to start: ${data.message}`, 'error');
      resetLuauWorker();
      return;
    }
    const entry = luauPending.get(data.id);
    if (!entry) return;
    if (data.type === 'output') {
      output(`[${entry.name}] ${data.text}`, data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'log');
    }
    if (data.type === 'done') {
      clearTimeout(entry.timer);
      luauPending.delete(data.id);
      runningScripts.delete(entry.id);
      output(`[${entry.name}] finished.`, 'success');
    }
  };

  luauWorker.onerror = event => {
    const message = event.message || 'the Luau worker failed';
    for (const entry of luauPending.values()) {
      clearTimeout(entry.timer);
      output(`[${entry.name}] Luau error: ${message}`, 'error');
    }
    resetLuauWorker();
  };
}

function sendLuauRun(entry) {
  if (!luauWorker || !luauReady || entry.sent) return;
  entry.sent = true;
  entry.timer = setTimeout(() => {
    output(`[${entry.name}] stopped after the 5 second preview limit.`, 'warn');
    resetLuauWorker();
  }, 5000);
  luauWorker.postMessage({
    id: entry.id,
    source: entry.script.source,
    name: entry.name,
    type: entry.script.type,
    context: { ...entry.context, scriptName: entry.name, scriptType: entry.script.type }
  });
}

function executeScript(script, context = {}) {
  ensureLuauWorker();
  const id = `luau-${++luauRunCounter}`;
  const entry = {
    id,
    script,
    context,
    name: script.name || 'Script',
    sent: false,
    timer: null
  };
  luauPending.set(id, entry);
  runningScripts.set(id, luauWorker);
  output(`[${script.type}] ${entry.name} queued.`, 'log');
  if (luauReady) sendLuauRun(entry);
}

async function joinPlaySession() {
  if (!APP.user || !projectMeta.remotePlaceId) return;
  const pulse = async () => {
    const result = await apiTry('/api/multiplayer', 'POST', { action: 'heartbeat', placeId: projectMeta.remotePlaceId });
    if (result.ok) {
      const players = result.data?.players;
      if (Number.isFinite(players)) output(`REWIND session: ${players} player${players === 1 ? '' : 's'} connected.`, 'log');
    } else {
      output(`Play session heartbeat failed: ${result.error}`, 'warn');
      clearInterval(playHeartbeatTimer);
      playHeartbeatTimer = null;
    }
  };
  await pulse();
  if (playState) playHeartbeatTimer = setInterval(pulse, 30000);
}

function scheduleServerScriptSync(script) {
  if (!APP.user || !projectMeta.remotePlaceId || script.type !== 'ServerScript') return;
  clearTimeout(scriptSyncTimer);
  scriptSyncTimer = setTimeout(async () => {
    const result = await apiTry('/api/multiplayer', 'POST', {
      action: 'save_script',
      placeId: projectMeta.remotePlaceId,
      name: script.name,
      scriptType: 'server',
      source: script.source
    });
    if (result.ok) output(`Server script "${script.name}" synced to REWIND.`, 'success');
    else output(`Server script sync failed: ${result.error}`, 'warn');
  }, 1200);
}
/* ------------------------------------------------------------------ */
/* Scene editing                                                       */
/* ------------------------------------------------------------------ */

const OBJECT_NAMES = {
  block: 'Part', sphere: 'Sphere', cylinder: 'Cylinder', wedge: 'Wedge', torus: 'Torus',
  plane: 'Platform', spawn: 'SpawnLocation', bean: 'Bean', light: 'PointLight', pyramid: 'Pyramid', model: 'Model'
};

function addObject(kind, { position = null, silent = false } = {}) {
  if (!sceneState.active) { toast('Open a project first.', 'warn'); return null; }
  if (playState) return null;
  const base = kind === 'spawn' ? [0, 0.12, 0] : kind === 'light' ? [0, 4, 0] : [0, 0.5, 0];
  const offset = position || [base[0] + (Math.random() - 0.5) * 2, base[1], base[2] + (Math.random() - 0.5) * 2];
  const size = kind === 'spawn' ? [5, 0.24, 5] : kind === 'plane' ? [6, 0.2, 6] : [1, 1, 1];
  const color = kind === 'spawn' ? '#4bd6a2' : kind === 'light' ? '#ffe291' : kind === 'bean' ? '#efb75d' : '#8877f0';
  const primitive = record(kind, OBJECT_NAMES[kind] || 'Part', offset, size, color);
  if (kind === 'spawn') primitive.position[1] = Math.max(0.12, primitive.position[1]);
  sceneState.records.push(primitive);
  makeMesh(primitive);
  selectRecord(primitive);
  renderTree();
  updateCounts();
  markDirty();
  pushHistory();
  if (!silent) output(`Inserted ${primitive.name} into Workspace.`, 'success');
  return primitive;
}

function addUi(kind) {
  if (!sceneState.active || playState) return null;
  const item = {
    id: newId(),
    kind,
    name: kind,
    text: kind === 'TextLabel' ? 'Label' : kind === 'TextButton' ? 'Button' : '',
    imageUrl: '',
    position: [360 + sceneState.uiItems.length * 16, 180 + sceneState.uiItems.length * 16],
    size: kind === 'TextButton' ? [180, 48] : kind === 'TextLabel' ? [220, 48] : [260, 150],
    visible: true,
    color: '#6155b7'
  };
  sceneState.uiItems.push(item);
  selectUi(item);
  renderTree();
  renderUiPreview();
  markDirty();
  pushHistory();
  output(`Inserted ${item.name} into StarterGui.`, 'success');
  return item;
}

function addGround() {
  if (!sceneState.active) return;
  const ground = record('block', 'Baseplate', [0, -0.5, 0], [80, 1, 80], '#46506b');
  sceneState.records.push(ground);
  rebuildWorkspace();
  selectRecord(ground);
  renderTree();
  updateCounts();
  markDirty();
  pushHistory();
  output('Added a baseplate to Workspace.', 'success');
}

function duplicateSelection() {
  const source = sceneState.selected;
  if (!source) { toast('Select a part to duplicate.', 'warn'); return; }
  const copy = record(source.kind, `${source.name} Copy`, [
    source.position[0] + 2, source.position[1], source.position[2] + 2
  ], source.size, source.color, {
    rotation: [...(source.rotation || [0, 0, 0])],
    material: source.material,
    transparency: source.transparency,
    anchored: source.anchored,
    visible: source.visible,
    castShadow: source.castShadow,
    assetUrl: source.assetUrl
  });
  sceneState.records.push(copy);
  makeMesh(copy);
  selectRecord(copy);
  renderTree();
  updateCounts();
  markDirty();
  pushHistory();
  output(`Duplicated ${source.name}.`, 'success');
}

function removeSelected() {
  if (playState) return;
  const target = sceneState.selected;
  const uiTarget = sceneState.selectedUi;
  if (!target && !uiTarget) return;
  if (settings.editor.confirmDelete && !confirm(`Delete ${target?.name || uiTarget?.name}?`)) return;
  if (target) {
    const index = sceneState.records.findIndex(item => item.id === target.id);
    if (index >= 0) sceneState.records.splice(index, 1);
    const object = sceneState.objectMap.get(target.id);
    if (object) {
      transform.detach();
      workspace.remove(object);
      disposeObject(object);
      sceneState.objectMap.delete(target.id);
    }
  } else if (uiTarget) {
    const index = sceneState.uiItems.findIndex(item => item.id === uiTarget.id);
    if (index >= 0) sceneState.uiItems.splice(index, 1);
  }
  sceneState.selected = null;
  sceneState.selectedUi = null;
  transform?.detach();
  selectionBox && (selectionBox.visible = false);
  renderTree();
  renderUiPreview();
  showProperties();
  updateCounts();
  updateSelectionStatus();
  markDirty();
  pushHistory();
  output('Deleted the selected instance.', 'log');
}

/* ------------------------------------------------------------------ */
/* Script editor                                                       */
/* ------------------------------------------------------------------ */

const LUAU_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'type', 'export'
]);

const LUAU_GLOBALS = new Set([
  'game', 'workspace', 'script', 'task', 'wait', 'print', 'warn', 'error', 'tick', 'time', 'typeof',
  'Vector3', 'Vector2', 'CFrame', 'Color3', 'Instance', 'Enum', 'math', 'string', 'table', 'os',
  'pairs', 'ipairs', 'next', 'select', 'tostring', 'tonumber', 'require', 'assert', 'pcall', 'xpcall',
  'coroutine', 'bit32', 'utf8', 'self', 'GetService', 'Connect', 'Spawn', 'Delay'
]);

const SCRIPT_TEMPLATES = {
  client: `-- Client script\nlocal players = game:GetService("Players")\nlocal player = players.LocalPlayer\n\nprint("Hello from", player.Name)\n`,
  server: `-- Server script\nlocal Players = game:GetService("Players")\n\nPlayers.PlayerAdded:Connect(function(player)\n\tprint(player.Name, "joined the experience")\nend)\n`,
  leaderstats: `local Players = game:GetService("Players")\n\nPlayers.PlayerAdded:Connect(function(player)\n\tlocal stats = Instance.new("Folder")\n\tstats.Name = "leaderstats"\n\tstats.Parent = player\n\n\tlocal coins = Instance.new("IntValue")\n\tcoins.Name = "Coins"\n\tcoins.Value = 0\n\tcoins.Parent = stats\nend)\n`,
  part: `local part = Instance.new("Part")\npart.Name = "SpawnedPart"\npart.Size = Vector3.new(4, 1, 4)\npart.Position = Vector3.new(0, 4, 0)\npart.Color = Color3.fromRGB(141, 125, 255)\npart.Anchored = true\npart.Parent = workspace\nprint("Created", part.Name)\n`,
  datastore: `local DataStoreService = game:GetService("DataStoreService")\nlocal store = DataStoreService:GetDataStore("PlayerData")\n\nlocal success, value = pcall(function()\n\treturn store:GetAsync("example-key")\nend)\nprint("DataStore preview:", success, value)\n`,
  marketplace: `local MarketplaceService = game:GetService("MarketplaceService")\nlocal player = game:GetService("Players").LocalPlayer\n\nMarketplaceService:PromptGamePassPurchase(player, 0)\n`,
  tween: `local TweenService = game:GetService("TweenService")\n\nlocal part = workspace:FindFirstChild("Part")\nif part then\n\tlocal tween = TweenService:Create(part, TweenInfo.new(1), { Position = Vector3.new(0, 10, 0) })\n\ttween:Play()\nend\nprint("Tween started")\n`
};

function renderScripts() {
  const host = $('#script-list');
  if (!host) return;
  host.innerHTML = sceneState.scripts.length
    ? sceneState.scripts.map(script => `<button class="script-row ${script.id === sceneState.currentScriptId ? 'active' : ''}" data-script="${escapeHtml(script.id)}"><b>${escapeHtml(script.name)}</b><small>${script.type === 'ServerScript' ? 'SERVER' : script.type === 'ModuleScript' ? 'MODULE' : 'CLIENT'}</small></button>`).join('')
    : '<div class="asset-note">No scripts yet. Select + New to add a client or server script.</div>';
  host.querySelectorAll('[data-script]').forEach(button => {
    button.onclick = () => selectScript(button.dataset.script);
  });
  updateScriptEditor();
}

function currentScript() {
  return sceneState.scripts.find(script => script.id === sceneState.currentScriptId) || null;
}

function updateScriptEditor() {
  const script = currentScript();
  const source = $('#script-source');
  if (!$('#script-name')) return;
  if (!script) {
    $('#script-name').value = 'Script';
    $('#script-type').value = 'LocalScript';
    if (source) source.value = '';
  } else {
    $('#script-name').value = script.name;
    $('#script-type').value = script.type;
    if (source && source.value !== script.source) source.value = script.source;
  }
  renderHighlight();
  updateGutter();
  updateScriptTypeRibbon();
}

function selectScript(id) {
  saveScript({ silent: true });
  const script = sceneState.scripts.find(item => item.id === id);
  if (!script) return;
  sceneState.currentScriptId = id;
  renderScripts();
  renderHighlight();
  updateGutter();
  output(`Editing ${script.name} (${script.type}).`, 'log');
}

function saveScript({ silent = false, sync = false } = {}) {
  const nameInput = $('#script-name');
  const typeInput = $('#script-type');
  const sourceInput = $('#script-source');
  if (!nameInput || !typeInput || !sourceInput) return null;
  const name = nameInput.value.trim() || 'Script';
  const type = typeInput.value;
  const source = sourceInput.value;
  let script = currentScript();
  if (!script) {
    if (!source && silent) return null;
    script = { id: newId(), name, type, source };
    sceneState.scripts.push(script);
    sceneState.currentScriptId = script.id;
  } else {
    Object.assign(script, { name, type, source });
  }
  renderScripts();
  markDirty();
  pushHistory();
  if (sync) scheduleServerScriptSync(script);
  if (!silent) output(`Saved script ${script.name}.`, 'success');
  return script;
}

function newScript() {
  if (currentScript()) saveScript({ silent: true });
  const script = {
    id: newId(),
    name: `Script${sceneState.scripts.length + 1}`,
    type: 'LocalScript',
    source: 'print("Hello from REWIND")\n'
  };
  sceneState.scripts.push(script);
  sceneState.currentScriptId = script.id;
  renderScripts();
  renderHighlight();
  updateGutter();
  markDirty();
  pushHistory();
  output('Created a new Luau script.', 'success');
  $('#script-source')?.focus();
}

function updateScriptTypeRibbon() {
  const type = $('#script-type')?.value;
  const ribbon = $('#script-type-ribbon');
  if (ribbon && type) ribbon.value = type;
}

function updateGutter() {
  const source = $('#script-source');
  const gutter = $('#script-gutter');
  if (!source || !gutter) return;
  const lines = source.value.split('\n').length;
  gutter.textContent = Array.from({ length: lines }, (_, index) => index + 1).join('\n');
  gutter.scrollTop = source.scrollTop;
}

function highlightLuau(source) {
  const keywords = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'for', 'function', 'if', 'in', 'local', 'not', 'or', 'repeat', 'return', 'then', 'until', 'while', 'continue']);
  const globals = new Set(['game', 'workspace', 'script', 'task', 'wait', 'print', 'warn', 'error', 'tick', 'time', 'Vector3', 'Vector2', 'CFrame', 'Color3', 'Instance', 'Enum', 'math', 'string', 'table', 'os', 'pairs', 'ipairs', 'tostring', 'tonumber', 'require', 'pcall', 'self']);
  let html = '';
  let index = 0;
  const text = String(source || '');
  const push = (className, value) => { html += className ? `<span class="${className}">${escapeHtml(value)}</span>` : escapeHtml(value); };
  while (index < text.length) {
    const char = text[index];
    if (char === '-' && text[index + 1] === '-') {
      let end = text.indexOf('\n', index);
      if (end < 0) end = text.length;
      push('syntax-comment', text.slice(index, end));
      index = end;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === char) { end += 1; break; }
        if (text[end] === '\n') break;
        end += 1;
      }
      push('syntax-string', text.slice(index, end));
      index = end;
      continue;
    }
    if (char === '[' && text[index + 1] === '[') {
      let end = text.indexOf(']]', index + 2);
      end = end < 0 ? text.length : end + 2;
      push('syntax-string', text.slice(index, end));
      index = end;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text[index + 1] || ''))) {
      let end = index + 1;
      while (end < text.length && /[0-9a-fA-FxX._]/.test(text[end])) end += 1;
      push('syntax-number', text.slice(index, end));
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
      const word = text.slice(index, end);
      const next = text.slice(end).match(/^\s*\(/);
      if (keywords.has(word)) push('syntax-keyword', word);
      else if (globals.has(word)) push(next ? 'syntax-function' : 'syntax-global', word);
      else if (next) push('syntax-function', word);
      else push('', word);
      index = end;
      continue;
    }
    push('', char);
    index += 1;
  }
  return html;
}

function renderHighlight() {
  const source = $('#script-source');
  const highlight = $('#script-highlight');
  if (!source || !highlight) return;
  highlight.innerHTML = `${highlightLuau(source.value)}\n`;
  highlight.scrollTop = source.scrollTop;
  highlight.scrollLeft = source.scrollLeft;
}

function formatScriptSource() {
  const source = $('#script-source');
  if (!source) return;
  const lines = source.value.replace(/\t/g, '    ').split('\n').map(line => line.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  source.value = `${lines.join('\n')}\n`;
  saveScript({ silent: true });
  renderHighlight();
  updateGutter();
  output('Formatted script whitespace.', 'success');
}

function insertScriptTemplate(templateId) {
  const template = SCRIPT_TEMPLATES[templateId];
  if (!template) return;
  const source = $('#script-source');
  if (!currentScript()) {
    saveScript({ silent: true });
    if (!currentScript()) {
      sceneState.scripts.push({ id: newId(), name: `Script${sceneState.scripts.length + 1}`, type: 'LocalScript', source: '' });
      sceneState.currentScriptId = sceneState.scripts.at(-1).id;
    }
  }
  const position = source.selectionStart ?? source.value.length;
  source.value = `${source.value.slice(0, position)}${template}${source.value.slice(position)}`;
  saveScript({ silent: true });
  renderHighlight();
  updateGutter();
  renderScripts();
  output('Inserted a Luau template.', 'success');
}

const SUGGESTIONS = [...LUAU_GLOBALS, ...LUAU_KEYWORDS].sort((a, b) => a.localeCompare(b));

function updateSuggestions() {
  const source = $('#script-source');
  const host = $('#script-suggestions');
  if (!source || !host) return;
  const before = source.value.slice(0, source.selectionStart);
  const word = (before.match(/[A-Za-z_][A-Za-z0-9_]*$/) || [''])[0];
  if (word.length < 2) { host.classList.add('hidden'); return; }
  const options = SUGGESTIONS.filter(option => option.toLowerCase().startsWith(word.toLowerCase()) && option !== word).slice(0, 7);
  if (!options.length) { host.classList.add('hidden'); return; }
  host.innerHTML = options.map(option => `<button type="button" data-suggestion="${option}">${option}</button>`).join('');
  host.classList.remove('hidden');
  host.querySelectorAll('[data-suggestion]').forEach(button => {
    button.onmousedown = event => {
      event.preventDefault();
      const start = source.selectionStart - word.length;
      source.value = `${source.value.slice(0, start)}${button.dataset.suggestion}${source.value.slice(source.selectionStart)}`;
      const caret = start + button.dataset.suggestion.length;
      source.setSelectionRange(caret, caret);
      host.classList.add('hidden');
      saveScript({ silent: true });
      renderHighlight();
      updateGutter();
      source.focus();
    };
  });
}
/* ------------------------------------------------------------------ */
/* Project lifecycle                                                   */
/* ------------------------------------------------------------------ */

function normalizeRecord(item) {
  return {
    id: item.id || newId(),
    kind: item.kind || 'block',
    name: item.name || OBJECT_NAMES[item.kind] || 'Part',
    position: Array.isArray(item.position) ? item.position.slice(0, 3).map(Number) : [0, 0.5, 0],
    size: Array.isArray(item.size) ? item.size.slice(0, 3).map(Number) : [1, 1, 1],
    rotation: Array.isArray(item.rotation) ? item.rotation.slice(0, 3).map(Number) : [0, 0, 0],
    color: item.color || '#8877f0',
    material: MATERIAL_LIBRARY[item.material] ? item.material : 'SmoothPlastic',
    transparency: clamp(Number(item.transparency) || 0, 0, 1),
    anchored: item.anchored !== false,
    visible: item.visible !== false,
    castShadow: item.castShadow !== false,
    assetUrl: item.assetUrl || null
  };
}

function normalizeUi(item) {
  return {
    id: item.id || newId(),
    kind: item.kind || 'Frame',
    name: item.name || item.kind || 'Frame',
    text: item.text || '',
    imageUrl: item.imageUrl || '',
    position: Array.isArray(item.position) ? item.position.slice(0, 2).map(Number) : [360, 180],
    size: Array.isArray(item.size) ? item.size.slice(0, 2).map(Number) : [200, 80],
    visible: item.visible !== false,
    color: item.color || '#6155b7'
  };
}

function normalizeScript(item) {
  return {
    id: item.id || newId(),
    name: item.name || 'Script',
    type: ['LocalScript', 'ServerScript', 'ModuleScript'].includes(item.type) ? item.type : 'LocalScript',
    source: String(item.source || '')
  };
}

function environmentDefaults(overrides = {}) {
  const skyDefaults = settings.sky;
  return {
    preset: skyDefaults.preset || 'studio',
    elevation: Number(skyDefaults.elevation) || 28,
    azimuth: Number(skyDefaults.azimuth) || 140,
    sunIntensity: Number(skyDefaults.sunIntensity) || 3,
    ambientIntensity: Number(skyDefaults.ambientIntensity) || 2.3,
    turbidity: Number(skyDefaults.turbidity) || 7,
    rayleigh: Number(skyDefaults.rayleigh) || 2,
    stars: Boolean(skyDefaults.stars),
    fog: Boolean(settings.render.fog),
    fogFar: 140,
    bloom: Boolean(settings.render.bloom),
    bloomStrength: Number(settings.render.bloomStrength) || 0.35,
    exposure: Number(settings.render.exposure) || 1.05,
    customSkybox: null,
    ...overrides
  };
}

function templateProject(templateId, name) {
  const template = TEMPLATES.find(item => item.id === templateId) || TEMPLATES[0];
  const built = template.build();
  return {
    format: 'rewind-project',
    version: 2,
    name: name || template.name,
    description: template.summary,
    genre: 'All',
    privacy: 'private',
    iconAssetId: null,
    thumbnailAssetId: null,
    remotePlaceId: null,
    savedAt: new Date().toISOString(),
    place: {
      objects: built.objects.map(normalizeRecord),
      ui: [],
      scripts: []
    },
    environment: environmentDefaults({ ...built.environment }),
    settings: { gravity: 18, spawn: [0, 0, 0] }
  };
}

async function loadProject(project, { filePath = null, cloud = false } = {}) {
  if (!project || typeof project !== 'object') throw new Error('This file is not a REWIND project.');
  if (project.format && project.format !== 'rewind-project') throw new Error('This file is not a REWIND project.');
  const place = project.place && typeof project.place === 'object' ? project.place : project;
  if (!place || (!Array.isArray(place.objects) && !Array.isArray(place.ui) && !Array.isArray(place.scripts))) {
    throw new Error('This project does not contain a scene.');
  }
  stopPlay();
  sceneState.active = true;
  sceneState.records = Array.isArray(place.objects) ? place.objects.map(normalizeRecord) : [];
  sceneState.uiItems = Array.isArray(place.ui) ? place.ui.map(normalizeUi) : [];
  sceneState.scripts = Array.isArray(place.scripts) ? place.scripts.map(normalizeScript) : [];
  sceneState.selected = null;
  sceneState.selectedUi = null;
  sceneState.currentScriptId = sceneState.scripts[0]?.id || null;
  projectMeta.filePath = filePath;
  projectMeta.remotePlaceId = project.remotePlaceId || null;
  projectMeta.description = project.description || '';
  projectMeta.genre = project.genre || 'All';
  projectMeta.privacy = project.privacy || 'private';
  projectMeta.iconAssetId = project.iconAssetId || null;
  projectMeta.thumbnailAssetId = project.thumbnailAssetId || null;

  sceneState.environment = environmentDefaults(project.environment || {});
  if (project.environment?.customSkybox) sceneState.environment.customSkybox = project.environment.customSkybox;
  $('#project-title').value = project.name || 'Untitled Place';
  document.title = `${$('#project-title').value} · REWIND Studio`;
  $('#file-type').textContent = cloud ? 'CLOUD' : 'LOCAL';
  $('#remote-badge').classList.toggle('hidden', !projectMeta.remotePlaceId);
  $('#ribbon-state').textContent = projectMeta.remotePlaceId ? 'Cloud place' : 'Local project';

  applyEnvironment({ applySkyPreset: false, rebuildSkybox: Boolean(sceneState.environment.customSkybox) });
  rebuildWorkspace();
  renderTree();
  renderUiPreview();
  renderScripts();
  showProperties();
  updateCounts();
  updateSelectionStatus();
  markSaved();
  sceneState.history = [];
  sceneState.historyIndex = -1;
  pushHistory({ immediate: true });
  setView('editor');
  applyRenderSettings();
  frameAll();
  output(`Opened ${project.name || 'Untitled Place'} · ${sceneState.records.length} parts, ${sceneState.uiItems.length} UI, ${sceneState.scripts.length} scripts.`, 'success');
  return true;
}

function resetSceneState() {
  stopPlay();
  sceneState.records = [];
  sceneState.uiItems = [];
  sceneState.scripts = [];
  sceneState.selected = null;
  sceneState.selectedUi = null;
  sceneState.currentScriptId = null;
  sceneState.history = [];
  sceneState.historyIndex = -1;
  projectMeta.filePath = null;
  projectMeta.remotePlaceId = null;
  projectMeta.description = '';
  projectMeta.genre = 'All';
  projectMeta.privacy = 'private';
  projectMeta.iconAssetId = null;
  projectMeta.thumbnailAssetId = null;
}

async function createLocalProject(templateId = 'baseplate', name = 'Untitled Place') {
  const project = templateProject(templateId, name);
  try {
    const result = await desktop.saveLocalProject({ project });
    projectMeta.filePath = result.filePath;
    await refreshLocalProjects();
    await loadProject(project, { filePath: result.filePath });
    toast('Local project created.', 'success');
    return project;
  } catch (error) {
    toast(`Could not create the project: ${error.message}`, 'error');
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Create / publish dialogs                                            */
/* ------------------------------------------------------------------ */

const createDialogState = { template: 'baseplate', iconAssetId: null, iconUrl: '' };

function renderCreateTemplates() {
  const host = $('#create-templates');
  if (!host) return;
  host.innerHTML = TEMPLATES.map(template => `
    <button type="button" class="create-template ${template.id === createDialogState.template ? 'selected' : ''}" data-create-template="${template.id}">
      <b>${template.icon} ${escapeHtml(template.name)}</b><small>${escapeHtml(template.summary)}</small>
    </button>`).join('');
  host.querySelectorAll('[data-create-template]').forEach(button => {
    button.onclick = () => {
      createDialogState.template = button.dataset.createTemplate;
      renderCreateTemplates();
    };
  });
}

function openCreateDialog(templateId = 'baseplate') {
  createDialogState.template = TEMPLATES.some(item => item.id === templateId) ? templateId : 'baseplate';
  createDialogState.iconAssetId = null;
  createDialogState.iconUrl = '';
  renderCreateTemplates();
  const template = TEMPLATES.find(item => item.id === createDialogState.template);
  $('#create-name').value = template ? `${template.name} Experience` : 'My New Experience';
  $('#create-description').value = template?.summary || '';
  $('#create-genre').value = 'All';
  $('#create-privacy').value = 'private';
  $('#create-message').textContent = APP.user ? '' : 'Sign in to publish to REWIND, or create the place locally.';
  $('#create-message').classList.remove('error');
  $('#create-icon-preview').innerHTML = template?.icon || '▦';
  $('#create-dialog').showModal();
}

async function chooseCreateIcon() {
  const result = await desktop.uploadAsset({ assetType: 'game_icon' });
  if (!result) return;
  if (!result.ok) {
    $('#create-message').textContent = result.error || 'Icon upload failed.';
    $('#create-message').classList.add('error');
    return;
  }
  createDialogState.iconAssetId = result.asset?.id || null;
  createDialogState.iconUrl = result.asset?.public_url || '';
  if (createDialogState.iconUrl) {
    $('#create-icon-preview').innerHTML = `<img src="${escapeHtml(createDialogState.iconUrl)}" alt="">`;
  }
  $('#create-message').textContent = 'Icon uploaded. It will appear on the experience card.';
}

async function createExperience() {
  const name = $('#create-name').value.trim();
  if (!name) { $('#create-message').textContent = 'Enter an experience name.'; return; }
  if (!APP.user) {
    $('#create-message').textContent = 'Sign in to create a cloud experience. You can also create it locally.';
    await requestLogin();
    return;
  }
  const submit = $('#create-submit');
  submit.disabled = true;
  submit.textContent = 'Creating…';
  $('#create-message').textContent = 'Creating the experience on REWIND…';
  $('#create-message').classList.remove('error');
  try {
    const project = templateProject(createDialogState.template, name);
    project.description = $('#create-description').value.trim();
    project.genre = $('#create-genre').value.trim() || 'All';
    project.privacy = $('#create-privacy').value;
    project.iconAssetId = createDialogState.iconAssetId;
    const payload = {
      name: project.name,
      description: project.description,
      genre: project.genre,
      privacy: project.privacy,
      iconAssetId: project.iconAssetId || null,
      scene: {
        version: 2,
        objects: project.place.objects,
        ui: project.place.ui,
        scripts: project.place.scripts,
        environment: project.environment,
        settings: project.settings
      }
    };
    const data = await api('/api/places', 'POST', payload);
    project.remotePlaceId = data.place?.id || null;
    if (project.remotePlaceId && project.privacy !== 'private') {
      try { await api('/api/places', 'PATCH', { id: project.remotePlaceId, privacy: project.privacy }); }
      catch (error) { output(`Place created, but visibility could not be applied: ${error.message}`, 'warn'); }
    }
    projectMeta.remotePlaceId = project.remotePlaceId;
    const saved = await desktop.saveLocalProject({ project });
    await refreshLocalProjects();
    await loadProject(project, { filePath: saved.filePath });
    $('#create-dialog').close();
    refreshExperiences();
    toast(`Created ${project.name} on REWIND.`, 'success');
    output(`Created cloud experience ${project.remotePlaceId || ''}.`, 'success');
  } catch (error) {
    $('#create-message').textContent = error.message;
    $('#create-message').classList.add('error');
    output(`Create experience failed: ${error.message}`, 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Create experience';
  }
}

function openPublishDialog() {
  if (!sceneState.active) { toast('Open a project first.', 'warn'); return; }
  $('#publish-name').value = $('#project-title').value.trim() || 'Untitled Place';
  $('#publish-description').value = projectMeta.description || '';
  $('#publish-genre').value = projectMeta.genre || 'All';
  $('#publish-privacy').value = projectMeta.privacy || 'private';
  $('#publish-message').textContent = projectMeta.remotePlaceId ? 'This project is linked to a cloud place. Publishing updates it.' : 'Publishing creates a new place on your account.';
  $('#publish-message').classList.remove('error');
  $('#publish-dialog').showModal();
}

async function publishProject() {
  if (!APP.user) {
    $('#publish-message').textContent = 'Sign in to publish. Your progress is still saved locally.';
    await requestLogin();
    return;
  }
  const submit = $('#publish-submit');
  submit.disabled = true;
  submit.textContent = 'Publishing…';
  $('#publish-message').textContent = 'Saving place to REWIND…';
  $('#publish-message').classList.remove('error');
  try {
    saveScript({ silent: true });
    const project = projectSnapshot();
    project.name = $('#publish-name').value.trim() || project.name;
    project.description = $('#publish-description').value.trim();
    project.genre = $('#publish-genre').value.trim() || 'All';
    project.privacy = $('#publish-privacy').value;
    project.remotePlaceId = projectMeta.remotePlaceId;
    const scene = {
      version: 2,
      objects: project.place.objects,
      ui: project.place.ui,
      scripts: project.place.scripts,
      environment: project.environment,
      settings: project.settings
    };
    const payload = {
      name: project.name,
      description: project.description,
      genre: project.genre,
      privacy: project.privacy,
      iconAssetId: projectMeta.iconAssetId || null,
      thumbnailAssetId: projectMeta.thumbnailAssetId || null,
      scene
    };
    const data = projectMeta.remotePlaceId
      ? await api('/api/places', 'PUT', { ...payload, id: projectMeta.remotePlaceId })
      : await api('/api/places', 'POST', payload);
    const placeId = data.place?.id || projectMeta.remotePlaceId;
    projectMeta.remotePlaceId = placeId;
    project.remotePlaceId = placeId;
    projectMeta.description = project.description;
    projectMeta.genre = project.genre;
    projectMeta.privacy = project.privacy;
    $('#project-title').value = project.name;
    $('#remote-badge').classList.remove('hidden');
    $('#ribbon-state').textContent = 'Cloud place';
    const savedProject = projectSnapshot();
    if (projectMeta.filePath) {
      await desktop.saveProject({ project: savedProject, filePath: projectMeta.filePath });
    } else {
      const saved = await desktop.saveLocalProject({ project: savedProject });
      projectMeta.filePath = saved.filePath;
      await refreshLocalProjects();
    }
    markSaved();
    $('#publish-dialog').close();
    $('#publish-message').textContent = 'Published to REWIND.';
    toast(`Published ${project.name}.`, 'success');
    output(`Published ${project.name} · ${placeId}.`, 'success');
    refreshExperiences();
  } catch (error) {
    $('#publish-message').textContent = error.message;
    $('#publish-message').classList.add('error');
    output(`Publish failed: ${error.message}`, 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Publish place';
  }
}

/* ------------------------------------------------------------------ */
/* Environment controls                                                */
/* ------------------------------------------------------------------ */

function updateEnvironmentControls() {
  const env = sceneState.environment;
  const values = {
    'env-preset': env.preset, 'env-elevation': env.elevation, 'env-azimuth': env.azimuth,
    'env-turbidity': env.turbidity, 'env-sun': env.sunIntensity, 'env-ambient': env.ambientIntensity,
    'env-exposure': env.exposure, 'env-fog-far': env.fogFar, 'env-bloom-strength': env.bloomStrength,
    'sky-preset': env.preset, 'sun-elevation': env.elevation, 'fog-far': env.fogFar,
    'bloom-strength': env.bloomStrength
  };
  for (const [id, value] of Object.entries(values)) {
    const input = $(`#${id}`);
    if (input && document.activeElement !== input) input.value = value;
  }
  const outputs = {
    'env-elevation-value': env.elevation, 'env-azimuth-value': env.azimuth, 'env-turbidity-value': env.turbidity,
    'env-sun-value': env.sunIntensity, 'env-ambient-value': env.ambientIntensity, 'env-exposure-value': env.exposure,
    'env-fog-far-value': env.fogFar, 'env-bloom-strength-value': env.bloomStrength,
    'sun-elevation-value': env.elevation, 'fog-far-value': env.fogFar, 'bloom-strength-value': env.bloomStrength
  };
  for (const [id, value] of Object.entries(outputs)) {
    const node = $(`#${id}`);
    if (node) node.textContent = formatSettingValue(value);
  }
  $('#env-fog') && ($('#env-fog').checked = Boolean(env.fog));
  $('#env-stars') && ($('#env-stars').checked = Boolean(env.stars));
  $('#env-bloom') && ($('#env-bloom').checked = Boolean(env.bloom));
}

function setEnvironmentValue(key, value, { fromPreset = false } = {}) {
  sceneState.environment[key] = value;
  if (!fromPreset && key !== 'preset') sceneState.environment.preset = 'custom';
  applyEnvironment({ applySkyPreset: false });
  markDirty();
  pushHistory();
}

function chooseSkyPreset(preset) {
  if (preset === 'custom') {
    pickCustomSkybox();
    return;
  }
  sceneState.environment.preset = preset;
  Object.assign(sceneState.environment, SKY_PRESETS[preset] || {});
  sceneState.environment.customSkybox = null;
  clearCustomSkybox();
  applyEnvironment({ applySkyPreset: false });
  markDirty();
  pushHistory();
}

async function pickCustomSkybox() {
  try {
    const result = await desktop.pickSkybox();
    if (!result?.images?.length) { updateEnvironmentControls(); return; }
    sceneState.environment.customSkybox = result.images;
    sceneState.environment.preset = 'custom';
    loadCustomSkybox(result.images);
    updateEnvironmentControls();
    markDirty();
    pushHistory();
    output('Applied a six-image custom skybox.', 'success');
  } catch (error) {
    toast(`Skybox failed: ${error.message}`, 'error');
    updateEnvironmentControls();
  }
}

function randomizeEnvironment() {
  const presets = ['day', 'sunset', 'night', 'nebula'];
  const preset = presets[Math.floor(Math.random() * presets.length)];
  sceneState.environment.preset = preset;
  Object.assign(sceneState.environment, SKY_PRESETS[preset]);
  sceneState.environment.azimuth = Math.round(Math.random() * 360);
  sceneState.environment.sunIntensity = Math.round((1 + Math.random() * 4) * 10) / 10;
  sceneState.environment.bloomStrength = Math.round((0.2 + Math.random() * 0.8) * 100) / 100;
  sceneState.environment.customSkybox = null;
  clearCustomSkybox();
  applyEnvironment({ applySkyPreset: false });
  markDirty();
  pushHistory();
  output(`Randomized the environment (${preset}).`, 'success');
}
/* ------------------------------------------------------------------ */
/* Community assets                                                    */
/* ------------------------------------------------------------------ */

async function loadAssetCatalog() {
  const host = $('#asset-catalog');
  if (!host) return;
  if (!APP.user) {
    host.innerHTML = '<div class="asset-note">Sign in to load REWIND assets. Local parts are always available in the Create tab.</div>';
    return;
  }
  host.innerHTML = '<div class="asset-note">Loading approved community assets…</div>';
  const result = await apiTry('/api/assets?catalog=true');
  if (!result.ok) {
    host.innerHTML = `<div class="asset-note">${escapeHtml(result.error || 'Could not load assets.')}</div>`;
    return;
  }
  assetCatalog = Array.isArray(result.data?.assets) ? result.data.assets : [];
  renderAssetCatalog();
}

function renderAssetCatalog() {
  const host = $('#asset-catalog');
  if (!host) return;
  const filter = ($('#catalog-search').value || '').trim().toLowerCase();
  const items = assetCatalog.filter(asset => !filter || `${asset.name} ${asset.asset_type}`.toLowerCase().includes(filter));
  if (!items.length) {
    host.innerHTML = '<div class="asset-note">No matching approved assets. Uploads appear in the catalog after moderation.</div>';
    return;
  }
  host.innerHTML = items.map(asset => {
    const thumb = asset.public_url && ['game_icon', 'game_thumbnail', 'decal'].includes(asset.asset_type)
      ? `<img src="${escapeHtml(asset.public_url)}" alt="">`
      : asset.asset_type === 'audio' ? '♫' : asset.asset_type === 'model' ? '◇' : '▧';
    const action = asset.asset_type === 'model' ? 'Insert model' : asset.asset_type === 'audio' ? 'Copy URL' : 'Use in UI';
    return `<article class="asset-card">
      <div class="asset-thumb">${thumb}</div>
      <b>${escapeHtml(asset.name)}</b>
      <small>${escapeHtml(asset.asset_type)} · ${bytesLabel(asset.byte_size)}</small>
      <button class="subtle" data-asset="${escapeHtml(asset.id)}">${action}</button>
    </article>`;
  }).join('');
  host.querySelectorAll('[data-asset]').forEach(button => {
    button.onclick = () => useAsset(assetCatalog.find(asset => asset.id === button.dataset.asset));
  });
}

function useAsset(asset) {
  if (!asset || !sceneState.active) { toast('Open a project first.', 'warn'); return; }
  if (asset.asset_type === 'model') {
    if (!asset.public_url) { toast('This model has no public download URL.', 'warn'); return; }
    const item = record('model', asset.name, [0, 0.5, 0], [1, 1, 1], '#ffffff', { assetUrl: asset.public_url, material: 'SmoothPlastic' });
    sceneState.records.push(item);
    makeMesh(item);
    selectRecord(item);
    renderTree();
    updateCounts();
    markDirty();
    pushHistory();
    output(`Inserted community model ${asset.name}.`, 'success');
  } else if (asset.asset_type === 'audio') {
    navigator.clipboard?.writeText(asset.public_url || '');
    toast(asset.public_url ? 'Audio URL copied.' : 'This audio asset has no public URL.', asset.public_url ? 'success' : 'warn');
  } else {
    const item = addUi('ImageLabel');
    if (!item) return;
    item.name = asset.name || 'ImageLabel';
    item.imageUrl = asset.public_url || '';
    renderUiPreview();
    showProperties();
    renderTree();
    markDirty();
    pushHistory();
    output(`Added ${asset.name} to StarterGui.`, 'success');
  }
}

/* ------------------------------------------------------------------ */
/* Settings page                                                       */
/* ------------------------------------------------------------------ */

function openSettingsPage() {
  showHomePage('settings');
  setView('home');
  syncSettingsInputs();
}

function resetSettings() {
  if (!confirm('Reset all Studio settings to their defaults?')) return;
  settings = cloneDefaults();
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Ignore storage errors. */ }
  applyAppearance();
  applyRenderSettings();
  syncSettingsInputs();
  sceneState.environment = environmentDefaults(sceneState.environment.customSkybox ? { customSkybox: sceneState.environment.customSkybox, preset: 'custom' } : {});
  applyEnvironment({ applySkyPreset: false });
  updateEnvironmentControls();
  toast('Studio settings reset.', 'success');
}

function bindSettingInputs() {
  $$('[data-setting]').forEach(input => {
    const path = input.dataset.setting;
    const updateOutput = () => {
      const output = $(`[data-value="${path}"]`);
      if (output) output.textContent = formatSettingValue(input.type === 'checkbox' ? input.checked : input.value);
    };
    input.addEventListener('input', updateOutput);
    input.addEventListener('change', () => {
      let value;
      if (input.type === 'checkbox') value = input.checked;
      else if (input.type === 'range') value = Number(input.value);
      else value = input.value;
      setSetting(path, value);
      updateOutput();
      if (path === 'render.quality') applyQualityPreset(value);
      else if (path === 'render.antialias') applyRenderSettings({ toastAntiAlias: true });
      else if (path.startsWith('render.')) applyRenderSettings();
      else if (path.startsWith('appearance.')) applyAppearance();
      else if (path === 'editor.snapIncrement' || path === 'editor.rotationSnap' || path === 'editor.snap') setTool(sceneState.tool);
      else if (path === 'editor.gridSize') { lastGridSize = null; updateGrid(); }
      else if (path === 'editor.showHints') syncToggleButtons();
      if (path.startsWith('sky.') && !sceneState.active) {
        sceneState.environment = environmentDefaults();
        applyEnvironment({ applySkyPreset: false });
        updateEnvironmentControls();
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Docks & view controls                                               */
/* ------------------------------------------------------------------ */

function selectLeftTab(tab) {
  $$('[data-left-tab]').forEach(button => button.classList.toggle('selected', button.dataset.leftTab === tab));
  $$('.dock-page').forEach(page => page.classList.add('hidden'));
  $(`#left-${tab}`)?.classList.remove('hidden');
  $('#toolbox-sub').textContent = tab === 'local' ? 'Local' : tab === 'environment' ? 'Sky' : tab === 'scripts' ? 'Luau' : tab === 'assets' ? 'Cloud' : 'Local';
  if (tab === 'ui') setUiMode(true);
  else if (tab !== 'scripts' && !playState) setUiMode(false);
  if (tab === 'environment') updateEnvironmentControls();
}

function openLocalDock() {
  if (!sceneState.active) { showHomePage('local'); setView('home'); return; }
  setView('editor');
  selectLeftTab('local');
}

function openEnvironmentDock() {
  if (!sceneState.active) openSettingsPage();
  else { setView('editor'); selectLeftTab('environment'); }
}

function focusExplorer() {
  setView('editor');
  $('#tree-search')?.focus();
}

function focusProperties() {
  setView('editor');
  $('#property-search')?.focus();
}

function focusOutput() {
  $('.output-dock')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#output-lines')?.focus?.();
}

function clearOutput() {
  const lines = $('#output-lines');
  if (!lines) return;
  lines.innerHTML = '<div class="output-muted">Output, Luau messages, and playtest events appear here.</div>';
  $('#output-count').textContent = '0';
}

/* ------------------------------------------------------------------ */
/* Global UI bindings                                                  */
/* ------------------------------------------------------------------ */

function bindHomeUi() {
  $$('[data-home-page]').forEach(button => {
    button.onclick = () => showHomePage(button.dataset.homePage);
  });
  $$('[data-home-jump]').forEach(button => {
    button.onclick = () => showHomePage(button.dataset.homeJump);
  });
  $('#view-home').onclick = () => setView('home');
  $('#view-editor').onclick = () => sceneState.active ? setView('editor') : toast('Open or create a project to enter the editor.', 'warn');
  $('#brand-home').onclick = () => setView('home');

  const create = () => openCreateDialog();
  ;['#home-create', '#create-experience', '#nav-create'].forEach(selector => { const node = $(selector); if (node) node.onclick = create; });
  ;['#home-open', '#local-open-file', '#open-project'].forEach(selector => { const node = $(selector); if (node) node.onclick = openProjectFile; });
  $('#home-browse-local').onclick = () => showHomePage('local');
  $('#new-local-project').onclick = create;
  $('#local-refresh').onclick = refreshLocalProjects;
  $('#local-dock-refresh').onclick = refreshLocalProjects;
  $('#local-dock-save').onclick = saveCurrentLocal;
  $('#local-dock-open').onclick = openProjectFile;
  $('#refresh-experiences').onclick = refreshExperiences;
  $('#account-manage').onclick = () => desktop.openExternal('https://rwd.2bd.net/account');
  $('#nav-web').onclick = () => desktop.openExternal('https://rwd.2bd.net');
  $('#app-version').onclick = () => {
    $('#about-version').textContent = `Version ${APP.config.version} · ${APP.config.apiBase}`;
    $('#about-api').textContent = APP.config.apiBase.replace(/^https?:\/\//, '');
    $('#about-dialog').showModal();
  };
  $('#account-chip').onclick = () => APP.user ? openAccountPage() : requestLogin();
  $('#home-profile').onclick = event => {
    if (event.target.closest('#home-profile-action')) return;
    APP.user ? openAccountPage() : requestLogin();
  };
  $('#home-profile-action').onclick = () => APP.user ? openAccountPage() : requestLogin();
  $('#open-settings').onclick = openSettingsPage;
  $('#settings-close').onclick = () => { showHomePage('home'); setView('home'); };
  $('#settings-reset').onclick = resetSettings;
  $('#settings-restart').onclick = () => desktop.relaunch();
  $('#refresh-assets').onclick = loadAssetCatalog;
  $('#catalog-search').oninput = renderAssetCatalog;

  $$('[data-close-dialog]').forEach(button => {
    button.onclick = () => button.closest('dialog')?.close();
  });
  $('#create-icon').onclick = chooseCreateIcon;
  $('#create-form').addEventListener('submit', event => {
    event.preventDefault();
    createExperience();
  });
  $('#create-local').onclick = async () => {
    const button = $('#create-local');
    button.disabled = true;
    try {
      await createLocalProject(createDialogState.template, $('#create-name').value.trim() || 'Untitled Place');
      $('#create-dialog').close();
    } catch (error) {
      $('#create-message').textContent = error.message;
      $('#create-message').classList.add('error');
    } finally {
      button.disabled = false;
    }
  };
  $('#publish').onclick = openPublishDialog;
  $('#publish-submit').onclick = publishProject;
}

function bindEditorUi() {
  $$('[data-ribbon]').forEach(tab => {
    tab.onclick = () => {
      $$('[data-ribbon]').forEach(button => button.classList.toggle('active', button === tab));
      $$('[data-ribbon-page]').forEach(page => page.classList.toggle('active', page.dataset.ribbonPage === tab.dataset.ribbon));
      if (tab.dataset.ribbon === 'ui') selectLeftTab('ui');
      if (tab.dataset.ribbon === 'script') selectLeftTab('scripts');
      if (tab.dataset.ribbon === 'environment') selectLeftTab('environment');
      if (tab.dataset.ribbon === 'home' || tab.dataset.ribbon === 'model') setUiMode(false);
    };
  });

  $$('[data-left-tab]').forEach(tab => {
    tab.onclick = () => selectLeftTab(tab.dataset.leftTab);
  });

  document.addEventListener('click', event => {
    const insert = event.target.closest('[data-insert]');
    if (insert && !insert.dataset.menuInsert) { addObject(insert.dataset.insert); return; }
    const ui = event.target.closest('[data-ui]');
    if (ui && !ui.dataset.menuUi) { addUi(ui.dataset.ui); return; }
    const tool = event.target.closest('[data-tool]');
    if (tool && tool.dataset.tool) { setTool(tool.dataset.tool); return; }
  });

  $('#play').onclick = () => startPlay($('#test-mode').value);
  $('#play-alt').onclick = () => startPlay($('#test-mode-alt').value);
  $$('.stop-button').forEach(button => { button.onclick = stopPlay; });
  $('#test-mode').onchange = () => { $('#test-mode-alt').value = $('#test-mode').value; };
  $('#test-mode-alt').onchange = () => { $('#test-mode').value = $('#test-mode-alt').value; };

  $('#undo').onclick = () => restoreHistory(-1);
  $('#redo').onclick = () => restoreHistory(1);
  $('#add-object').onclick = () => addObject('block');
  $('#duplicate-selection').onclick = duplicateSelection;
  $$('#add-ground').forEach(button => { button.onclick = addGround; });
  $('#camera-home').onclick = frameAll;
  $('#camera-home-2').onclick = frameAll;

  const toggleGrid = () => {
    setSetting('render.showGrid', !settings.render.showGrid);
    applyRenderSettings();
    syncSettingsInputs();
  };
  const toggleAxes = () => {
    setSetting('render.showAxes', !settings.render.showAxes);
    applyRenderSettings();
    syncSettingsInputs();
  };
  $('#toggle-grid').onclick = toggleGrid;
  $('#toggle-grid-2').onclick = toggleGrid;
  $('#toggle-axes').onclick = toggleAxes;
  $('#toggle-axes-2').onclick = toggleAxes;

  const toggleUiPreview = () => {
    const on = !viewportEl.classList.contains('ui-mode');
    if (on) selectLeftTab('ui');
    setUiMode(on);
  };
  $('#toggle-ui-preview').onclick = toggleUiPreview;
  $('#ui-toggle-preview').onclick = toggleUiPreview;
  $('#ui-delete').onclick = () => sceneState.selectedUi ? removeSelected() : toast('Select a UI element first.', 'warn');

  $('#view-explorer').onclick = focusExplorer;
  $('#view-properties').onclick = focusProperties;
  $('#view-environment').onclick = openEnvironmentDock;
  $('#view-local').onclick = openLocalDock;
  $('#view-settings').onclick = openSettingsPage;
  $('#model-open-settings').onclick = openSettingsPage;
  $('#environment-open-settings').onclick = openSettingsPage;
  $('#env-open-graphics').onclick = openSettingsPage;
  $('#focus-output').onclick = focusOutput;
  $('#clear-output-ribbon').onclick = clearOutput;
  $('#run-all-scripts').onclick = () => startPlay('run');
  $('#new-viewport').onclick = () => toast('Multiple viewport tabs are coming in a future Studio update.', 'info');

  $('#clear-output').onclick = clearOutput;
  $('#toggle-output').onclick = () => $('.output-dock').classList.toggle('collapsed');
  $('#tree-search').oninput = renderTree;
  const propertiesBody = $('#properties-body');
  propertiesBody.addEventListener('change', event => {
    const input = event.target.closest('[data-prop]');
    if (!input) return;
    applyProperty(sceneState.selected || sceneState.selectedUi, input.dataset.prop, input);
  });
  propertiesBody.addEventListener('input', event => {
    const input = event.target.closest('[data-prop]');
    if (!input || !['range', 'color'].includes(input.type)) return;
    applyProperty(sceneState.selected || sceneState.selectedUi, input.dataset.prop, input);
  });
  $('#property-search').oninput = event => {
    const filter = event.target.value.trim().toLowerCase();
    $$('#properties-body .property-row').forEach(row => {
      row.style.display = !filter || row.dataset.propertyLabel?.includes(filter) ? '' : 'none';
    });
  };
  $('#asset-search').oninput = event => {
    const filter = event.target.value.trim().toLowerCase();
    $$('#left-create .insert-list button').forEach(button => {
      button.hidden = Boolean(filter) && !button.textContent.toLowerCase().includes(filter);
    });
  };

  $('#new-script').onclick = newScript;
  $('#new-script-ribbon').onclick = newScript;
  $('#save-script').onclick = () => saveScript({ sync: true });
  const runScript = () => { const script = saveScript({ silent: true }); if (script) executeScript(script, { objects: sceneState.records }); };
  $('#run-script').onclick = runScript;
  $('#run-script-ribbon').onclick = runScript;
  $('#format-script').onclick = formatScriptSource;
  $('#script-template').onchange = event => {
    insertScriptTemplate(event.target.value);
    event.target.value = '';
  };
  $('#script-type-ribbon').onchange = event => {
    $('#script-type').value = event.target.value;
    saveScript({ sync: true });
  };
  $('#script-type').onchange = () => { updateScriptTypeRibbon(); saveScript({ sync: true }); };
  $('#script-name').onchange = () => saveScript();
  const source = $('#script-source');
  source.addEventListener('input', () => {
    renderHighlight();
    updateGutter();
    updateSuggestions();
    saveScript({ silent: true });
  });
  source.addEventListener('scroll', () => {
    const highlight = $('#script-highlight');
    if (highlight) { highlight.scrollTop = source.scrollTop; highlight.scrollLeft = source.scrollLeft; }
    const gutter = $('#script-gutter');
    if (gutter) gutter.scrollTop = source.scrollTop;
    $('#script-suggestions')?.classList.add('hidden');
  });
  source.addEventListener('keydown', event => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = source.selectionStart;
      const end = source.selectionEnd;
      source.value = `${source.value.slice(0, start)}    ${source.value.slice(end)}`;
      source.setSelectionRange(start + 4, start + 4);
      renderHighlight();
      updateGutter();
      saveScript({ silent: true });
    }
    if (event.key === 'Escape') $('#script-suggestions')?.classList.add('hidden');
  });
  source.addEventListener('blur', () => $('#script-suggestions')?.classList.add('hidden'));

  $('#env-preset').onchange = event => chooseSkyPreset(event.target.value);
  $('#sky-preset').onchange = event => chooseSkyPreset(event.target.value);
  $('#env-randomize').onclick = randomizeEnvironment;
  $('#env-custom-skybox').onclick = pickCustomSkybox;
  $('#env-clear-skybox').onclick = () => {
    sceneState.environment.customSkybox = null;
    sceneState.environment.preset = settings.sky.preset || 'studio';
    clearCustomSkybox();
    applyEnvironment({ applySkyPreset: true });
    markDirty();
    pushHistory();
  };

  const envBindings = [
    ['#env-elevation', 'elevation', Number], ['#env-azimuth', 'azimuth', Number], ['#env-turbidity', 'turbidity', Number],
    ['#env-sun', 'sunIntensity', Number], ['#env-ambient', 'ambientIntensity', Number], ['#env-exposure', 'exposure', Number],
    ['#env-fog-far', 'fogFar', Number], ['#env-bloom-strength', 'bloomStrength', Number],
    ['#sun-elevation', 'elevation', Number], ['#fog-far', 'fogFar', Number], ['#bloom-strength', 'bloomStrength', Number]
  ];
  for (const [selector, key, convert] of envBindings) {
    const input = $(selector);
    if (!input) continue;
    input.addEventListener('input', () => {
      setEnvironmentValue(key, convert(input.value));
      updateEnvironmentControls();
    });
  }
  $('#env-fog').onchange = event => { setEnvironmentValue('fog', event.target.checked); updateEnvironmentControls(); };
  $('#env-stars').onchange = event => { setEnvironmentValue('stars', event.target.checked); updateEnvironmentControls(); };
  $('#env-bloom').onchange = event => { setEnvironmentValue('bloom', event.target.checked); updateEnvironmentControls(); };

  $('#project-title').addEventListener('input', () => {
    document.title = `${$('#project-title').value || 'Untitled Place'} · REWIND Studio`;
    markDirty();
    pushHistory();
  });
  $('#save-project').onclick = () => saveProject();
  $('#export-project').onclick = exportProject;
}

/* ------------------------------------------------------------------ */
/* Menu commands                                                       */
/* ------------------------------------------------------------------ */

async function handleCommand(command) {
  if (!command) return;
  if (command === 'new') { openCreateDialog(); return; }
  if (command === 'open' || command === 'import') { openProjectFile(); return; }
  if (command === 'save') { await saveProject(); return; }
  if (command === 'save-as') { await saveProject({ saveAs: true }); return; }
  if (command === 'export') { await exportProject(); return; }
  if (command === 'home') { setView('home'); return; }
  if (command === 'settings') { openSettingsPage(); return; }
  if (command === 'delete') { removeSelected(); return; }
  if (command === 'local:save') { await saveCurrentLocal(); return; }
  if (command === 'api:status') { await refreshApiStatus(); toast(APP.online ? 'REWIND API is online.' : 'REWIND API is unreachable. Local mode is active.', APP.online ? 'success' : 'warn'); return; }
  if (command.startsWith('tool:')) { setTool(command.slice(5)); if (APP.view !== 'editor') setView('editor'); return; }
  if (command.startsWith('insert:')) { addObject(command.slice(7)); return; }
  if (command === 'play') { startPlay($('#test-mode').value); return; }
  if (command === 'run') { startPlay('run'); return; }
  if (command === 'stop') { stopPlay(); return; }
  if (command === 'undo') { restoreHistory(-1); return; }
  if (command === 'redo') { restoreHistory(1); return; }
  if (command === 'focus:output') { focusOutput(); return; }
  if (command === 'focus:explorer') { focusExplorer(); return; }
  if (command === 'focus:properties') { focusProperties(); return; }
  if (command === 'focus:environment') { openEnvironmentDock(); return; }
  if (command === 'focus:local') { openLocalDock(); return; }
}
/* ------------------------------------------------------------------ */
/* Home render & autosave                                              */
/* ------------------------------------------------------------------ */

function renderHome() {
  renderTemplates();
  renderExperiences();
  renderLocalProjects();
  renderAccountPage();
  updateCounts();
  $('#experience-count').textContent = String(cloudPlaces.length);
  $('#local-count').textContent = String(localProjects.length);
}

let lastAutoSave = Date.now();

function startAutoSave() {
  setInterval(async () => {
    if (!settings.editor.autoSave || !sceneState.active) return;
    if ($('#dirty-dot').classList.contains('saved')) return;
    const minutes = Number(settings.editor.autoSaveMinutes) || 5;
    if (Date.now() - lastAutoSave < minutes * 60000) return;
    lastAutoSave = Date.now();
    try {
      const project = projectSnapshot();
      const fileName = projectMeta.filePath ? projectMeta.filePath.split(/[\\/]/).pop() : null;
      const result = await desktop.saveLocalProject({ project, fileName });
      projectMeta.filePath ||= result.filePath;
      markSaved();
      await refreshLocalProjects();
      output(`Auto-saved ${project.name}.`, 'log');
    } catch (error) {
      output(`Auto-save failed: ${error.message}`, 'warn');
    }
  }, 30000);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  if (bootStarted) return;
  bootStarted = true;
  applyAppearance();
  try {
    setSplash('Starting the studio engine…', 0.06);
    await sleep(140);
    if (desktop) {
      APP.config = { ...APP.config, ...(await desktop.getConfig()) };
    }
    $('#splash-version').textContent = `v${APP.config.version}`;
    $('#app-version').textContent = `REWIND Studio v${APP.config.version}`;
    $('#about-version').textContent = `Version ${APP.config.version}`;
    $('#about-api').textContent = APP.config.apiBase.replace(/^https?:\/\//, '');

    setSplash('Loading your local library…', 0.24);
    await sleep(150);
    await refreshLocalProjects();

    setSplash('Checking your REWIND account…', 0.48);
    await sleep(150);
    await refreshAuth();

    setSplash('Preparing the 3D viewport…', 0.68);
    await sleep(180);
    initEngine();

    setSplash('Applying Studio preferences…', 0.84);
    bindHomeUi();
    bindEditorUi();
    bindSettingInputs();
    syncSettingsInputs();
    applyAppearance();
    applyRenderSettings();
    applyEnvironment({ applySkyPreset: false });
    updateEnvironmentControls();

    setSplash('Ready to build.', 1);
    renderHome();
    showHomePage('home');
    await refreshApiStatus();
    await sleep(320);

    $('#splash').classList.add('hidden');
    $('#app').classList.remove('hidden');
    document.body.dataset.view = 'home';
    APP.booted = true;
    setModeLabel('EDIT MODE');
    updateSelectionStatus();
    syncToggleButtons();
    renderTree();
    renderScripts();
    showProperties();
    output(`REWIND Studio ${APP.config.version} ready. Projects save locally; sign in to publish.`, 'success');
    if (!APP.user) {
      loginPrompted = true;
      setTimeout(() => requestLogin({ quiet: true }), 800);
    }
    startAutoSave();
  } catch (error) {
    console.error(error);
    setSplash(`Could not finish loading: ${error.message}`, 1);
    output(`Startup error: ${error.message}`, 'error');
    setTimeout(() => {
      $('#splash').classList.add('hidden');
      $('#app').classList.remove('hidden');
    }, 1400);
  }
}

if (desktop) {
  desktop.onCommand(handleCommand);
  desktop.onAuthChanged(payload => {
    const user = payload?.user || null;
    const changed = (user?.id || null) !== (APP.user?.id || null);
    applyUser(user);
    if (changed && user) {
      toast(`Signed in as @${user.username}.`, 'success');
      output(`REWIND account connected: @${user.username}.`, 'success');
      loadAccountPage();
    }
  });
}

window.addEventListener('beforeunload', event => {
  if (sceneState.active && !$('#dirty-dot').classList.contains('saved')) {
    event.preventDefault();
    event.returnValue = '';
  }
});

boot();
