const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['wake', 'mic', 'interrupt', 'hint', 'repeat', 'next', 'library', 'replay', 'mute', 'board']);
contextBridge.exposeInMainWorld('mishengDesktop', Object.freeze({
  expanded: value => ipcRenderer.invoke('pet:expanded', value === true),
  hitAreas: rects => ipcRenderer.send('pet:hit-areas', rects),
  drag: phase => { if (phase === 'start' || phase === 'stop') ipcRenderer.send('pet:drag', phase); },
  menu: () => ipcRenderer.send('pet:menu'),
  state: state => ipcRenderer.send('pet:state', { ready: state.ready === true, recording: state.recording === true }),
  onAction: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, action) => { if (actions.has(action)) callback(action); };
    ipcRenderer.on('pet:action', listener); return () => ipcRenderer.removeListener('pet:action', listener);
  },
  onDrag: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, moved, direction) => callback(moved === true, ['left', 'right'].includes(direction) ? direction : null);
    ipcRenderer.on('pet:dragged', listener); return () => ipcRenderer.removeListener('pet:dragged', listener);
  }
}));
