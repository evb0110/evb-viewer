type TElectronPlatformApi = NonNullable<Window['electronAPI']>;

function getElectronWindow(): Window | null {
    if (typeof window === 'undefined') {
        return null;
    }

    return window;
}

export function getRawElectronPlatformApi(): TElectronPlatformApi | undefined {
    return getElectronWindow()?.electronAPI;
}

export function hasElectronPlatformBridge() {
    return getRawElectronPlatformApi() !== undefined;
}
