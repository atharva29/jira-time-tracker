const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  screen,
  globalShortcut,
} = require('electron');
const path = require('path');

const store = require('./store');
const auth = require('./auth');
const jira = require('./jira');
const tracker = require('./tracker');

const WIDTH = 360;
const HEIGHT = 560;
const SHORTCUT = 'Control+Option+J';
const ASSETS = path.join(__dirname, '..', '..', 'assets');

let tray = null;
let win = null;
let lastHiddenAt = 0;
let ticker = null;
const icons = {};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init);
}

function init() {
  app.dock?.hide();

  // Menu-bar apps have no visible menu, but macOS still needs an Edit menu
  // for ⌘C / ⌘V / ⌘X / ⌘A to work inside text fields (e.g. pasting the API token).
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));

  icons.idle = loadIcon('trayTemplate.png');
  icons.running = loadIcon('trayRunningTemplate.png');

  tray = new Tray(icons.idle);
  tray.setToolTip('Jira Time Tracker');
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));

  createWindow();
  registerIpc();
  tracker.events.on('change', broadcast);
  updateTray();

  globalShortcut.register(SHORTCUT, toggleWindow);

  // One-time cleanup of state from the old OAuth-based sign-in.
  for (const key of ['tokens', 'sites', 'oauthClient']) if (store.get(key) !== undefined) store.set(key, undefined);
  if (!auth.getCredentials()) store.set('site', undefined);

  // Retry anything that failed to log last time.
  if (auth.isAuthenticated()) tracker.retryFailed().catch(() => {});

  // Packaged app: start at login by default (user can turn it off in the menu).
  if (app.isPackaged && !store.get('loginItemInitialized')) {
    app.setLoginItemSettings({ openAtLogin: true });
    store.set('loginItemInitialized', true);
  }

  // Opened by the user (double-click / Spotlight): show the popover right away.
  // Opened at login: stay quietly in the menu bar.
  const openedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
  if (!openedAtLogin || process.argv.includes('--show')) {
    win.webContents.once('did-finish-load', () => setTimeout(showWindow, 150));
  }
}

app.on('activate', () => showWindow()); // re-opening the app from Finder/Spotlight

function loadIcon(name) {
  const img = nativeImage.createFromPath(path.join(ASSETS, name));
  img.setTemplateImage(true);
  return img;
}

// ---------- Popover window ----------

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('blur', () => {
    if (win.webContents.isDevToolsOpened()) return;
    hideWindow();
  });

  // Links open in the real browser, never inside the popover.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function toggleWindow() {
  if (win.isVisible()) return hideWindow();
  // A click on the tray icon blurs (and hides) the window first; don't reopen it.
  if (Date.now() - lastHiddenAt < 250) return;
  showWindow();
}

function showWindow() {
  positionWindow();
  win.show();
  win.focus();
  win.webContents.send('window:shown');
}

function hideWindow() {
  if (!win.isVisible()) return;
  win.hide();
  lastHiddenAt = Date.now();
}

function positionWindow() {
  const t = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: t.x, y: t.y });
  const area = display.workArea;
  let x = Math.round(t.x + t.width / 2 - WIDTH / 2);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - WIDTH - 8));
  const y = t.height ? Math.round(t.y + t.height + 4) : area.y + 4;
  win.setPosition(x, y, false);
}

// ---------- Tray ----------

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function updateTray() {
  const timer = tracker.getTimer();
  if (timer) {
    tray.setImage(icons.running);
    const label = ` ${formatElapsed(Date.now() - timer.startedAt)}`;
    tray.setTitle(store.get('showKeyInMenuBar', true) ? `${label} · ${timer.issue.key}` : label, {
      fontType: 'monospacedDigit',
    });
    tray.setToolTip(`Tracking ${timer.issue.key}: ${timer.issue.summary}`);
    if (!ticker) ticker = setInterval(updateTray, 1000);
  } else {
    clearInterval(ticker);
    ticker = null;
    tray.setImage(icons.idle);
    tray.setTitle('');
    tray.setToolTip('Jira Time Tracker');
  }
}

function buildMenu() {
  const timer = tracker.getTimer();
  const site = store.get('site');
  const signedIn = auth.isAuthenticated();
  const user = store.get('user');
  return Menu.buildFromTemplate([
    { label: 'Open Tracker', accelerator: SHORTCUT, click: showWindow },
    ...(timer
      ? [
          { type: 'separator' },
          { label: `Stop & log ${timer.issue.key}`, click: () => stopTimer({}) },
          { label: 'Discard current session', click: () => stopTimer({ discard: true }) },
        ]
      : []),
    { type: 'separator' },
    {
      label: 'Show task key in menu bar',
      type: 'checkbox',
      checked: store.get('showKeyInMenuBar', true),
      click: (item) => {
        store.set('showKeyInMenuBar', item.checked);
        updateTray();
      },
    },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    ...(site && signedIn
      ? [
          { type: 'separator' },
          { label: `Signed in as ${user?.email || user?.displayName || 'you'}`, enabled: false },
          { label: `Open ${site.name}.atlassian.net`, click: () => shell.openExternal(site.url) },
          { label: timer ? 'Sign out (stop the timer first)' : 'Sign out', enabled: !timer, click: signOut },
        ]
      : []),
    { type: 'separator' },
    { label: 'Quit', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}

// ---------- State + IPC ----------

function appState() {
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  return {
    authenticated: auth.isAuthenticated(),
    authNotice: store.get('authNotice', null),
    lastSite: store.get('lastSite', ''),
    lastEmail: store.get('lastEmail', ''),
    site: store.get('site', null),
    user: store.get('user', null),
    timer: tracker.getTimer(),
    today: tracker.history().filter((e) => e.endedAt >= startOfDay),
    recent: store.get('recentIssues', []),
    shortcut: '⌃⌥J',
  };
}

function broadcast() {
  updateTray();
  if (win && !win.isDestroyed()) win.webContents.send('state', appState());
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[${channel}]`, err);
      if (err.code === 'AUTH_REQUIRED') setImmediate(broadcast);
      return { ok: false, error: err.message || String(err), code: err.code || null };
    }
  });
}

// Validate site + email + API token against Jira, then store them.
async function connect({ site, email, token } = {}) {
  const cleanEmail = String(email || '').trim();
  const cleanToken = String(token || '').trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(cleanEmail)) throw new Error('Enter the email you use to log in to Jira');
  if (!cleanToken) throw new Error('Paste your Jira API token');
  const target = auth.normalizeSite(site);

  const user = await jira.verify(target, { email: cleanEmail, token: cleanToken });

  auth.saveCredentials({ email: cleanEmail, token: cleanToken });
  store.set('site', target);
  store.set('user', { ...user, email: user.email || cleanEmail });
  store.set('lastSite', target.url.replace(/^https:\/\//, ''));
  store.set('lastEmail', cleanEmail);
  store.set('authNotice', undefined);
  broadcast();
  tracker.retryFailed().catch(() => {});
  return user;
}

function signOut() {
  if (tracker.getTimer()) throw new Error('Stop the timer before signing out');
  auth.clearCredentials();
  for (const key of ['site', 'user', 'authNotice']) store.set(key, undefined);
  tracker.clearAll();
  broadcast();
}

async function stopTimer(opts) {
  try {
    return await tracker.stop(opts);
  } catch (e) {
    console.error('stop failed', e);
  }
}

function registerIpc() {
  handle('state:get', appState);
  handle('auth:connect', connect);
  handle('auth:logout', signOut);
  handle('auth:tokenPage', () => shell.openExternal(auth.TOKEN_PAGE_URL));
  handle('issues:assigned', () => jira.assignedIssues());
  handle('issues:search', (q) => jira.searchIssues(String(q || '')));
  handle('timer:start', (issue, memo) => tracker.start(issue, memo));
  handle('timer:stop', (opts) => tracker.stop(opts || {}));
  handle('timer:memo', (memo) => tracker.updateMemo(memo));
  handle('entry:retry', (id) => tracker.push(id));
  handle('entry:remove', (id) => tracker.removeEntry(id));
  handle('issue:open', (key) => {
    const site = store.get('site');
    if (site && /^[A-Z][A-Z0-9_]*-\d+$/i.test(key)) shell.openExternal(`${site.url}/browse/${key}`);
  });
  handle('window:hide', hideWindow);
  handle('menu:show', () => {
    const menu = buildMenu();
    menu.popup({ window: win });
  });
}

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
