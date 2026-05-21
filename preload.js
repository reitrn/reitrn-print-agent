const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reitrn', {
  getState:          ()       => ipcRenderer.invoke('get-state'),
  setDefaultPrinter: (name)   => ipcRenderer.invoke('set-default-printer', name),
  setAgentName:      (name)   => ipcRenderer.invoke('set-agent-name', name),
  setAutoStart:      (val)    => ipcRenderer.invoke('set-auto-start', val),
  setLabelSize:      (size)   => ipcRenderer.invoke('set-label-size', size),
  testPrint:         (name)   => ipcRenderer.invoke('test-print', name),
  refreshPrinters:   ()       => ipcRenderer.invoke('refresh-printers'),
  minimizeToTray:    ()       => ipcRenderer.invoke('minimize-to-tray'),

  onStatusUpdate: (cb) => ipcRenderer.on('status-update', (_, s) => cb(s)),
  onJobsUpdate:   (cb) => ipcRenderer.on('jobs-update',   (_, j) => cb(j)),
});
