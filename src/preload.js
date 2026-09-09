const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agente', {
    leerConfig: () => ipcRenderer.invoke('config:leer'),
    guardarToken: (datos) => ipcRenderer.invoke('config:guardarToken', datos),
    descubrir: () => ipcRenderer.invoke('descubrir'),
    probarImpresora: (imp) => ipcRenderer.invoke('probarImpresora', imp),
    resumen: () => ipcRenderer.invoke('motor:resumen'),

    alHallar: (cb) => ipcRenderer.on('descubrir:hallada', (_e, imp) => cb(imp)),
    alCambiarEstado: (cb) => ipcRenderer.on('motor:estado', (_e, d) => cb(d)),
    alTrabajo: (cb) => ipcRenderer.on('motor:trabajo', (_e, d) => cb(d)),
    alWs: (cb) => ipcRenderer.on('motor:ws', (_e, d) => cb(d)),
    alSinImpresora: (cb) => ipcRenderer.on('motor:sin-impresora', (_e, d) => cb(d)),
});
