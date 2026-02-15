import type { IElectronAPI } from '@app/types/electron-api';

declare global {
    interface Window {
        electronAPI: IElectronAPI;
        __openFileDirect?: (path: string) => Promise<void>;
        __appReady?: boolean;
        __logLevel?: unknown;
    }
}

export {};
