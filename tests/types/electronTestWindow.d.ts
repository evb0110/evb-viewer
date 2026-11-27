import type { IElectronAPI } from '@contracts/electronApi';

// E2E `page.evaluate(...)` callbacks and unit-test window harnesses read or
// assign `window.electronAPI` directly. Declare `Window.electronAPI` only in
// `tests/tsconfig.json` so production `app/` code cannot bypass
// `getRawElectronPlatformApi()`.
declare global {
    interface Window {
        electronAPI?: IElectronAPI;
    }
}

export {};
