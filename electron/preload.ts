import type {IpcRendererEvent} from 'electron';
import {
    contextBridge,
    ipcRenderer,
} from 'electron';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from 'electron/ipc-types';

contextBridge.exposeInMainWorld('electronAPI', {
    openPdfDialog: () => ipcRenderer.invoke('dialog:openPdf'),
    readFile: (path: string) => ipcRenderer.invoke('file:read', path),
    writeFile: (path: string, data: Uint8Array) => ipcRenderer.invoke('file:write', path, data),
    setWindowTitle: (title: string) => ipcRenderer.invoke('window:setTitle', title),

    onMenuOpenPdf: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:openPdf', handler);
        return () => ipcRenderer.removeListener('menu:openPdf', handler);
    },
    onMenuSave: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:save', handler);
        return () => ipcRenderer.removeListener('menu:save', handler);
    },
    onMenuZoomIn: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:zoomIn', handler);
        return () => ipcRenderer.removeListener('menu:zoomIn', handler);
    },
    onMenuZoomOut: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:zoomOut', handler);
        return () => ipcRenderer.removeListener('menu:zoomOut', handler);
    },
    onMenuActualSize: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:actualSize', handler);
        return () => ipcRenderer.removeListener('menu:actualSize', handler);
    },
    onMenuFitWidth: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:fitWidth', handler);
        return () => ipcRenderer.removeListener('menu:fitWidth', handler);
    },
    onMenuFitHeight: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:fitHeight', handler);
        return () => ipcRenderer.removeListener('menu:fitHeight', handler);
    },
    onMenuAbout: (callback: IMenuEventCallback): IMenuEventUnsubscribe => {
        const handler = (_event: IpcRendererEvent) => callback();
        ipcRenderer.on('menu:about', handler);
        return () => ipcRenderer.removeListener('menu:about', handler);
    },
});
