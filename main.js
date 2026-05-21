const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');
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

  // No theme-based icon swapping needed — teal icon works on both light and dark

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
  if (localServer) localServer.close();
});

// ── Theme helpers ──────────────────────────────────────────────────────────────

function isTaskbarDark() {
  // Windows has TWO theme settings: one for apps (window frames) and one for
  // the taskbar/tray. Electron's nativeTheme only reads the app setting.
  // We must read SystemUsesLightTheme from the registry to get the taskbar setting.
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v SystemUsesLightTheme',
      { encoding: 'utf8', timeout: 3000 },
    );
    // 0x0 = dark taskbar, 0x1 = light taskbar
    return out.includes('0x0');
  } catch {
    return nativeTheme.shouldUseDarkColors; // fallback
  }
}

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

function getTrayIcon() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.ico'));
    if (!icon.isEmpty()) return icon.resize({ width: 16, height: 16 });
  } catch {}
  console.warn('[Tray] No icon found — using empty');
  return nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(getTrayIcon());
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

// ── Port cache pre-warm ────────────────────────────────────────────────────────
// Run wmic lookups at startup so the first real print job has zero wmic delay.

function prewarmPortCache() {
  const { getPortNameForPrinter } = require('./printer');
  const courier = store.get('courierPrinter', '');
  const barcode = store.get('barcodePrinter', '');
  [courier, barcode].filter(Boolean).forEach((name) => {
    try { getPortNameForPrinter(name); } catch {}
  });
}

// ── Local HTTP server ──────────────────────────────────────────────────────────
// Listens on localhost:3010 so returnhub (browser on this PC) can print
// directly without a Firestore round-trip. ~50ms vs ~1s via the cloud.

const LOCAL_PORT = 3010;
let localServer = null;

function startLocalServer() {
  const certPath = path.join(__dirname, 'assets', 'cert.pem');
  const keyPath  = path.join(__dirname, 'assets', 'key.pem');

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.error('[LocalServer] cert.pem or key.pem not found — falling back to HTTP');
    localServer = require('http').createServer(handleRequest);
  } else {
    const sslOptions = {
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath),
    };
    localServer = https.createServer(sslOptions, handleRequest);
  }

  localServer.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log(`[LocalServer] Listening on https://local.reitrn.com:${LOCAL_PORT}`);
  });

  localServer.on('error', (err) => {
    console.error('[LocalServer] Failed to start:', err.message);
  });
}

function handleRequest(req, res) {
    // CORS + Chrome Private Network Access (required for https:// pages to reach localhost)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        courierPrinter:  store.get('courierPrinter', ''),
        barcodePrinter:  store.get('barcodePrinter', ''),
        agentName:       store.get('agentName', 'Warehouse PC'),
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/print') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const job = JSON.parse(body); // { data, type, role }
          const role        = job.role || 'barcode';
          const printerName = role === 'courier'
            ? store.get('courierPrinter', '')
            : store.get('barcodePrinter', '');

          if (!printerName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `No ${role} printer configured` }));
            return;
          }

          const localJobId = `local_${Date.now()}`;
          addRecentJob({ id: localJobId, printer: printerName, printerRole: role, status: 'printing', time: new Date() });

          // Respond immediately — don't make the browser wait for the physical print
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));

          // Print in the background
          const localData = renderJob({ ...job, printerRole: role }, printerName);
          printRaw(printerName, localData)
            .then(() => addRecentJob({ id: localJobId, printer: printerName, status: 'done', time: new Date() }))
            .catch((err) => {
              console.error('[LocalServer] Print failed:', err.message);
              addRecentJob({ id: localJobId, printer: printerName, status: 'error', time: new Date(), error: err.message });
            });
        } catch (err) {
          console.error('[LocalServer] Request error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
}

// ── Label builders ─────────────────────────────────────────────────────────────

function buildZPL(label, widthMm, heightMm) {
  const dpm = 8;
  const w = Math.round(widthMm * dpm);
  const h = Math.round(heightMm * dpm);
  const lines = [
    '^XA',
    `^PW${w}`,
    `^LL${h}`,
    '^CF0,32',
    `^FO20,20^FD${(label.title || '').slice(0, 30)}^FS`,
  ];
  if (label.subtitle) lines.push(`^CF0,24^FO20,60^FD${label.subtitle.slice(0, 30)}^FS`);
  if (label.sku)      lines.push(`^CF0,22^FO20,90^FD${label.sku}^FS`);
  if (label.price)    lines.push(`^CF0,52^FO${w - 120},20^FD${label.price}^FS`);
  if (label.barcode)  lines.push(`^FO20,${label.price || label.subtitle ? 130 : 70}^BCN,70,Y,N,N^FD${label.barcode}^FS`);
  lines.push('^XZ');
  return lines.join('\n');
}

function buildTSPL(label, widthMm, heightMm) {
  const lines = [
    `SIZE ${widthMm} mm, ${heightMm} mm`,
    'GAP 2 mm, 0 mm',
    'DIRECTION 0,0',
    'SPEED 4',
    'DENSITY 8',
    'CLS',
    `TEXT 10,10,"3",0,1,1,"${(label.title || '').slice(0, 28)}"`,
  ];
  if (label.subtitle) lines.push(`TEXT 10,50,"2",0,1,1,"${label.subtitle.slice(0, 30)}"`);
  if (label.sku)      lines.push(`TEXT 10,80,"2",0,1,1,"${label.sku}"`);
  if (label.price)    lines.push(`TEXT ${widthMm * 8 - 100},10,"4",0,1,1,"${label.price}"`);
  if (label.barcode)  lines.push(`BARCODE 10,${label.subtitle ? 120 : 80},"128",50,1,0,2,2,"${label.barcode}"`);
  lines.push('PRINT 1,1');
  lines.push('');
  return lines.join('\r\n');
}

function detectLang(printerName) {
  // TSC printer names typically contain TSC, TE2xx, TP2xx, TTP etc.
  // Everything else (Zebra, GK, ZD, ZT, LP) is ZPL.
  const name = (printerName || '').toUpperCase();
  if (name.includes('TSC') || name.includes('TTP') || /\bTE\d/.test(name) || /\bTP\d/.test(name)) {
    return 'tspl';
  }
  return 'zpl';
}

function renderJob(job, printerName) {
  const lang = detectLang(printerName);

  // returnhub sends both zpl + tspl — pick the right one
  if (job.zpl || job.tspl) {
    return lang === 'tspl' ? (job.tspl || job.zpl) : (job.zpl || job.tspl);
  }

  // Mobile app sends structured labelData — build here
  if (job.labelData) {
    const role   = job.printerRole || 'barcode';
    const width  = role === 'courier' ? 101.6 : 62;
    const height = role === 'courier' ? 152.4 : 35;
    return lang === 'tspl'
      ? buildTSPL(job.labelData, width, height)
      : buildZPL(job.labelData, width, height);
  }

  // Legacy pre-rendered string — pass through as-is
  return job.data || '';
}

// ── Agent ──────────────────────────────────────────────────────────────────────

function startAgent() {
  setStatus('connecting');
  startLocalServer();
  prewarmPortCache();

  startListening({
    onStatus: (status) => setStatus(status),
    onJob: async (job) => {
      // Route by role — fall back to legacy job.printer field for old jobs
      const role        = job.printerRole || 'barcode';
      const printerName = role === 'courier'
        ? (store.get('courierPrinter', '') || job.printer || '')
        : (store.get('barcodePrinter', '') || job.printer || '');

      if (!printerName) {
        console.warn(`[Agent] No ${role} printer configured for job`, job.id);
        addRecentJob({ id: job.id, printer: `${role} printer`, status: 'error', time: new Date(), error: `No ${role} printer configured` });
        return { success: false, error: `No ${role} printer configured` };
      }

      const data = renderJob(job, printerName);
      addRecentJob({ id: job.id, printer: printerName, printerRole: role, status: 'printing', time: new Date() });

      try {
        await printRaw(printerName, data);
        addRecentJob({ id: job.id, printer: printerName, status: 'done', time: new Date() });
        return { success: true };
      } catch (err) {
        console.error('[Agent] Print failed:', err);
        addRecentJob({ id: job.id, printer: printerName, status: 'error', time: new Date(), error: err.message });
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
  const existing = job.id ? recentJobs.findIndex((j) => j.id === job.id) : -1;
  if (existing >= 0) {
    // Update in place — keeps the list order and replaces 'printing' with 'done'/'error'
    recentJobs = recentJobs.map((j, i) => i === existing ? { ...j, ...job } : j);
  } else {
    recentJobs = [job, ...recentJobs].slice(0, 50);
  }
  store.set('recentJobs', recentJobs);
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
  const lang = detectLang(printerName);

  let data;
  if (lang === 'zpl') {
    data = isCourier
      ? ['^XA', '^PW812', '^LL1218', '^CF0,40', '^FO50,50^FDreitrn.^FS', '^CF0,28', '^FO50,110^FDCourier Printer Test^FS', '^FO50,160^FD4 x 6 inch label - OK^FS', '^XZ'].join('\n')
      : ['^XA', '^PW496', '^LL280', '^CF0,36', '^FO20,20^FDreitrn.^FS', '^CF0,22', '^FO20,70^FDBarcode Printer Test^FS', '^FO20,110^BCN,60,Y,N,N^FDTEST-001^FS', '^XZ'].join('\n');
  } else {
    data = isCourier
      ? ['SIZE 4 inch, 6 inch', 'GAP 3 mm, 0 mm', 'DIRECTION 0,0', 'SPEED 4', 'DENSITY 8', 'CLS', 'TEXT 50,50,"4",0,1,1,"reitrn."', 'TEXT 50,120,"2",0,1,1,"Courier Printer Test"', 'TEXT 50,165,"1",0,1,1,"4 x 6 inch label - OK"', 'PRINT 1,1', ''].join('\r\n')
      : ['SIZE 62 mm, 35 mm', 'GAP 2 mm, 0 mm', 'DIRECTION 0,0', 'SPEED 4', 'DENSITY 8', 'CLS', 'TEXT 8,5,"3",0,1,1,"reitrn."', 'TEXT 8,42,"1",0,1,1,"Barcode Printer Test"', 'BARCODE 8,65,"128",40,1,0,2,3,"TEST-001"', 'PRINT 1,1', ''].join('\r\n');
  }

  try {
    await printRaw(printerName, data);
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
