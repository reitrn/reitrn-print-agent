const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reitrn', {
  getState:          ()             => ipcRenderer.invoke('get-state'),
  setCourierPrinter: (name)         => ipcRenderer.invoke('set-courier-printer', name),
  setBarcodePrinter: (name)         => ipcRenderer.invoke('set-barcode-printer', name),
  setCourierLang:    (lang)         => ipcRenderer.invoke('set-courier-lang', lang),
  setBarcodeLang:    (lang)         => ipcRenderer.invoke('set-barcode-lang', lang),
  setAgentName:      (name)         => ipcRenderer.invoke('set-agent-name', name),
  setAutoStart:      (val)          => ipcRenderer.invoke('set-auto-start', val),
  testPrint:         (name, role)   => ipcRenderer.invoke('test-print', name, role),
  refreshPrinters:   ()             => ipcRenderer.invoke('refresh-printers'),
  minimizeToTray:    ()             => ipcRenderer.invoke('minimize-to-tray'),

  onStatusUpdate: (cb) => ipcRenderer.on('status-update', (_, s) => cb(s)),
  onJobsUpdate:   (cb) => ipcRenderer.on('jobs-update',   (_, j) => cb(j)),
});
