'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedEvents = new Set([
  'test-started',
  'session-updated',
  'statistics-updated',
  'log-message',
  'test-finished',
  'test-stopped',
  'fatal-error'
]);

contextBridge.exposeInMainWorld('localVisitor', {
  startTest: (settings) => ipcRenderer.invoke('start-test', settings),
  stopTest: () => ipcRenderer.invoke('stop-test'),
  getTestState: () => ipcRenderer.invoke('get-test-state'),
  openLogsDirectory: () => ipcRenderer.invoke('open-logs-directory'),
  on: (eventName, listener) => {
    if (!allowedEvents.has(eventName) || typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(eventName, wrapped);
    return () => ipcRenderer.removeListener(eventName, wrapped);
  }
});

