export function hasElectronAPI() {
    return typeof window !== 'undefined' && Boolean(window.electronAPI);
}

export function getElectronAPI() {
    if (!hasElectronAPI()) {
        throw new Error('Electron API not available');
    }
    return window.electronAPI;
}
