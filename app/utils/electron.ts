export function getElectronAPI() {
    if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('Electron API not available');
    }
    return window.electronAPI;
}
