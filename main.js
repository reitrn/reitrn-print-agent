const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { startListening, stopListening } = require('./firebase-listener');
const { getInstalledPrinters, printRaw } = require('./printer');

const store = new Store();

let mainWindow = null;
let tray = null;
// Load persisted jobs immediately after store is ready
let recentJobs = (store.get('recentJobs', []) || []).map((j) => ({
  ...j,
  // Timestamps are serialised as strings — convert back to Date for display
  time: j.time ? new Date(j.time) : new Date(),
}));
let isListening = false;
let connectionStatus = 'disconnected'; // 'connected' | 'connecting' | 'disconnected' | 'error'

// ── App setup ──────────────────────────────────────────────────────────────────

app.setName('reitrn Print Agent');

// Prevent multiple instances
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('ready', () => {
  createTray();
  createWindow();
  startAgent();

  // Auto-launch with Windows
  app.setLoginItemSettings({
    openAtLogin: store.get('autoStart', true),
    name: 'reitrn Print Agent',
  });
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // Keep running in tray
});

app.on('before-quit', () => {
  stopListening();
});

// ── Window ─────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    resizable: false,
    title: 'reitrn Print Agent',
    backgroundColor: '#FFFFFF',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

// ── Tray ───────────────────────────────────────────────────────────────────────

function createTray() {
  // .ico is more reliable than .png for Windows system tray icons
  const iconPath = path.join(__dirname, 'assets', 'tray.ico');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      console.warn('[Tray] Icon loaded but is empty — check assets/tray.png exists');
      icon = nativeImage.createEmpty();
    } else {
      // Resize to standard Windows tray icon size
      icon = icon.resize({ width: 16, height: 16 });
      console.log('[Tray] Icon loaded OK from', iconPath);
    }
  } catch (e) {
    console.warn('[Tray] Failed to load icon:', e.message);
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('reitrn Print Agent');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayMenu() {
  const statusLabel = {
    connected: '● Connected',
    connecting: '◌ Connecting…',
    disconnected: '○ Disconnected',
    error: '✕ Error',
  }[connectionStatus] ?? '○ Disconnected';

  const menu = Menu.buildFromTemplate([
    { label: 'reitrn Print Agent', enabled: false },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    { label: 'Open', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0); } },
  ]);
  tray.setContextMenu(menu);
}

// ── Agent ──────────────────────────────────────────────────────────────────────

function startAgent() {
  setStatus('connecting');

  startListening({
    onStatus: (status) => setStatus(status),
    onJob: async (job) => {
      addRecentJob({ ...job, status: 'printing', time: new Date() });

      // Route by role — fall back to legacy job.printer field for old jobs
      const role        = job.printerRole || 'barcode';
      const printerName = role === 'courier'
        ? (store.get('courierPrinter', '') || job.printer || '')
        : (store.get('barcodePrinter', '') || job.printer || '');

      if (!printerName) {
        console.warn(`[Agent] No ${role} printer configured for job`, job.id);
        return { success: false, error: `No ${role} printer configured` };
      }

      try {
        await printRaw(printerName, job.data);
        addRecentJob({ ...job, status: 'done', time: new Date() });
        return { success: true };
      } catch (err) {
        console.error('[Agent] Print failed:', err);
        addRecentJob({ ...job, status: 'error', time: new Date(), error: err.message });
        return { success: false, error: err.message };
      }
    },
  });
}

function setStatus(status) {
  connectionStatus = status;
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', status);
  }
}

function addRecentJob(job) {
  recentJobs = [job, ...recentJobs].slice(0, 50);
  store.set('recentJobs', recentJobs); // persist across restarts
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('jobs-update', recentJobs);
  }
}

// ── IPC ────────────────────────────────────────────────────────────────────────

ipcMain.handle('get-state', () => ({
  status: connectionStatus,
  printers: getInstalledPrinters(),
  courierPrinter: store.get('courierPrinter', ''),
  barcodePrinter: store.get('barcodePrinter', ''),
  agentName: store.get('agentName', 'Warehouse PC'),
  autoStart: store.get('autoStart', true),
  recentJobs,
}));

ipcMain.handle('set-courier-printer', (_, name) => {
  store.set('courierPrinter', name);
  return true;
});

ipcMain.handle('set-barcode-printer', (_, name) => {
  store.set('barcodePrinter', name);
  return true;
});

ipcMain.handle('set-agent-name', (_, name) => {
  store.set('agentName', name.trim() || 'Warehouse PC');
  return true;
});

ipcMain.handle('set-auto-start', (_, enabled) => {
  store.set('autoStart', enabled);
  app.setLoginItemSettings({ openAtLogin: enabled, name: 'reitrn Print Agent' });
  return true;
});

ipcMain.handle('test-print', async (_, printerName, role) => {
  const isCourier = role === 'courier';

  const tspl = isCourier
    ? [
        'SIZE 4 inch, 6 inch',
        'GAP 3 mm, 0 mm',
        'DIRECTION 0,0',
        'SPEED 4',
        'DENSITY 8',
        'CLS',
        'TEXT 50,50,"4",0,1,1,"reitrn."',
        'TEXT 50,120,"2",0,1,1,"Courier Printer Test"',
        'TEXT 50,165,"1",0,1,1,"4 x 6 inch label - OK"',
        'PRINT 1,1',
        '',
      ].join('\r\n')
    : [
        'SIZE 62 mm, 35 mm',
        'GAP 2 mm, 0 mm',
        'DIRECTION 0,0',
        'SPEED 4',
        'DENSITY 8',
        'CLS',
        'TEXT 8,5,"3",0,1,1,"reitrn."',
        'TEXT 8,42,"1",0,1,1,"Barcode Printer Test"',
        'BARCODE 8,65,"128",40,1,0,2,3,"TEST-001"',
        'PRINT 1,1',
        '',
      ].join('\r\n');

  try {
    await printRaw(printerName, tspl);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('refresh-printers', () => {
  return getInstalledPrinters();
});

ipcMain.handle('minimize-to-tray', () => {
  mainWindow.hide();
});
