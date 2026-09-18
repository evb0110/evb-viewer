import type {
    IHostCapability,
    IHostEnvironmentSnapshot,
    IHostZenModeState,
    THostPlatform,
} from '@contracts/hostPlatformFeature';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

function detectBrowserPlatform(): THostPlatform {
    if (typeof navigator === 'undefined') {
        return 'linux';
    }
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac') || ua.includes('darwin')) {
        return 'darwin';
    }
    if (ua.includes('win')) {
        return 'win32';
    }
    return 'linux';
}

function snapshotBrowserHostEnvironment(): IHostEnvironmentSnapshot {
    return {
        platform: detectBrowserPlatform(),
        osScaleFactor: 1,
    };
}

function snapshotBrowserZenMode(): IHostZenModeState {
    if (typeof document === 'undefined') {
        return {
            active: false,
            supported: false,
        };
    }

    return {
        active: Boolean(document.fullscreenElement),
        supported: Boolean(document.fullscreenEnabled),
    };
}

async function setBrowserZenMode(active: boolean): Promise<IHostZenModeState> {
    if (typeof document === 'undefined') {
        return snapshotBrowserZenMode();
    }

    if (active) {
        if (!document.fullscreenEnabled || document.fullscreenElement) {
            return snapshotBrowserZenMode();
        }

        await document.documentElement.requestFullscreen();
        return snapshotBrowserZenMode();
    }

    if (document.fullscreenElement) {
        await document.exitFullscreen();
    }
    return snapshotBrowserZenMode();
}

function onBrowserZenModeChange(callback: (state: IHostZenModeState) => void) {
    if (typeof document === 'undefined') {
        return noopUnsubscribe();
    }

    const handleFullscreenChange = () => {
        callback(snapshotBrowserZenMode());
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
        document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
}

export const browserHostCapability = {
    getResourceProfile: () => null,
    getEnvironment() {
        return Promise.resolve(snapshotBrowserHostEnvironment());
    },
    onEnvironmentChange: noopUnsubscribe,
    getZenModeState() {
        return Promise.resolve(snapshotBrowserZenMode());
    },
    setZenMode(active) {
        return setBrowserZenMode(active);
    },
    onZenModeChange: onBrowserZenModeChange,
    // A page cannot see scroll sequence boundaries; the viewport falls back to packet timing.
    onWheelScrollSequenceChange: noopUnsubscribe,
    // The browser workspace has no app profile to write a bundle into, so the
    // capability answers honestly instead of pretending it captured one.
    writeBugReportBundle() {
        return Promise.resolve({
            directoryName: '',
            screenshotWritten: false,
            written: false,
        });
    },
} satisfies IHostCapability;
