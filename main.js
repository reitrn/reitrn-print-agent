const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { startListening, stopListening } = require('./firebase-listener');
const { getInstalledPrinters, printRaw } = require('./printer');

const store = new Store();

let mainWindow = null;
let tray = null;
let isListening = false;
let connectionStatus = 'disconnected'; // 'connected' | 'connecting' | 'disconnected' | 'error'
let recentJobs = [];

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
    height: 620,
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
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch {
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

      const printerName = job.printer || store.get('defaultPrinter', '');
      if (!printerName) {
        console.warn('[Agent] No printer configured for job', job.id);
        return { success: false, error: 'No printer configured' };
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
  recentJobs = [job, ...recentJobs].slice(0, 20);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('jobs-update', recentJobs);
  }
}

// ── IPC ────────────────────────────────────────────────────────────────────────

ipcMain.handle('get-state', () => ({
  status: connectionStatus,
  printers: getInstalledPrinters(),
  defaultPrinter: store.get('defaultPrinter', ''),
  agentName: store.get('agentName', 'Warehouse PC'),
  autoStart: store.get('autoStart', true),
  recentJobs,
}));

ipcMain.handle('set-default-printer', (_, printerName) => {
  store.set('defaultPrinter', printerName);
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

ipcMain.handle('test-print', async (_, printerName) => {
  const tspl = [
    'SIZE 100 mm, 150 mm',  // <-- update if your label roll is a different size
    'GAP 3 mm, 0 mm',
    'DIRECTION 1',
    'SPEED 4',
    'DENSITY 8',
    'CLS',
    'TEXT 50,50,"3",0,1,1,"reitrn."',
    'TEXT 50,120,"2",0,1,1,"Print Agent Test"',
    'TEXT 50,180,"1",0,1,1,"Connected & working"',
    'PRINT 1,1',
    '',  // trailing \r\n so printer flushes the PRINT command
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
