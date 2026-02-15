import type { IpcRendererEvent } from 'electron';
import {
    contextBridge,
    ipcRenderer,
    webUtils,
} from 'electron';
import { installViteOutdatedOptimizeDepRecovery } from '@electron/preload/dev-recovery';
import { createElectronApi } from '@electron/preload/create-electron-api';

const PRELOAD_INSTALL_FLAG = '__preloadInstalled';
const preloadState = globalThis as Record<string, unknown>;

const preloadAlreadyInstalled = preloadState[PRELOAD_INSTALL_FLAG] === true;
if (preloadAlreadyInstalled) {
    console.debug('[Preload] Skipping duplicate installation (fast reload detected)');
}

if (!preloadAlreadyInstalled) {
    preloadState[PRELOAD_INSTALL_FLAG] = true;

    ipcRenderer.on('debug:log', (_event: IpcRendererEvent, data: {
        source: string;
        message: string;
        timestamp: string;
    }) => {
        console.log(`[${data.timestamp}] [${data.source}] ${data.message}`);
    });

    installViteOutdatedOptimizeDepRecovery();

    contextBridge.exposeInMainWorld('electronAPI', createElectronApi(ipcRenderer, webUtils));
}
