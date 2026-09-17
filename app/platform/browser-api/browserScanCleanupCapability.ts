import type { IScanCleanupCapability } from '@contracts/electronApiScanCleanup';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';
import { createJobId } from '@contracts/shared';
import {
    cloneScanCleanupPreferenceValue,
    createDefaultScanCleanupSettingsFile,
    type IScanCleanupDocumentOverrideEntry,
    type IScanCleanupSettingsFile,
    type IScanCleanupSettingsUpdateRequest,
} from '@contracts/scanCleanupSettings';

const BROWSER_SCAN_CLEANUP_UNAVAILABLE = 'Scan Cleanup is unavailable in the browser; use the desktop app.';
const browserSettingsFile = createDefaultScanCleanupSettingsFile();

function applyBrowserDocumentSettings(
    document: NonNullable<IScanCleanupSettingsUpdateRequest['document']>,
) {
    const sourceSha256 = document.sourceSha256.toLowerCase();
    const patch = cloneScanCleanupPreferenceValue(document.patch);
    const previous = browserSettingsFile.documentOverrides[sourceSha256];
    const nextEntry: IScanCleanupDocumentOverrideEntry = {
        ...(previous ?? {}),
        lastUsedAtMs: Date.now(),
    };
    const resetToEmptyOverrides = patch.resetOverrides === true
        && (patch.overrides === undefined || Object.keys(patch.overrides).length === 0);
    if (resetToEmptyOverrides) {
        Reflect.deleteProperty(nextEntry, 'overrides');
        Reflect.deleteProperty(nextEntry, 'pageOverrideDefaults');
    } else if (patch.overrides !== undefined) {
        nextEntry.overrides = cloneScanCleanupPreferenceValue(patch.overrides);
    }
    if (patch.pageOverrideDefaults !== undefined && !resetToEmptyOverrides) {
        nextEntry.pageOverrideDefaults = cloneScanCleanupPreferenceValue(patch.pageOverrideDefaults);
    }
    if (patch.marginsMm !== undefined) {
        nextEntry.marginsMm = cloneScanCleanupPreferenceValue(patch.marginsMm);
    }
    if (patch.outputMode !== undefined) {
        nextEntry.outputMode = patch.outputMode;
    }
    const hasDocumentValues = nextEntry.overrides !== undefined
        || nextEntry.pageOverrideDefaults !== undefined
        || nextEntry.marginsMm !== undefined
        || nextEntry.outputMode !== undefined;
    if (hasDocumentValues) {
        browserSettingsFile.documentOverrides[sourceSha256] = nextEntry;
    } else {
        Reflect.deleteProperty(browserSettingsFile.documentOverrides, sourceSha256);
    }
}

function cloneBrowserSettingsFile(): IScanCleanupSettingsFile {
    return cloneScanCleanupPreferenceValue(browserSettingsFile);
}

export const browserScanCleanupCapability: IScanCleanupCapability = {
    preview() {
        return Promise.reject(new Error(BROWSER_SCAN_CLEANUP_UNAVAILABLE));
    },
    resolvePlacementAnchorCalibration() {
        return Promise.reject(new Error(BROWSER_SCAN_CLEANUP_UNAVAILABLE));
    },
    cancelPreview() {
        return Promise.resolve(false);
    },
    detectAll() {
        return Promise.resolve({
            started: false,
            jobId: createJobId('browser-scan-cleanup-unavailable'),
            error: BROWSER_SCAN_CLEANUP_UNAVAILABLE,
            errorCode: 'tools-unavailable',
        });
    },
    cancelDetection() {
        return Promise.resolve(false);
    },
    getDetectionJobState() {
        return Promise.resolve(null);
    },
    subscribeDetectionJob() {
        return Promise.resolve(null);
    },
    start() {
        return Promise.resolve({
            started: false,
            jobId: createJobId('browser-scan-cleanup-unavailable'),
            error: BROWSER_SCAN_CLEANUP_UNAVAILABLE,
            errorCode: 'tools-unavailable',
        });
    },
    cancel() {
        return Promise.resolve(false);
    },
    getJobState() {
        return Promise.resolve(null);
    },
    subscribeJob() {
        return Promise.resolve(null);
    },
    reconnectJob() {
        return Promise.resolve(null);
    },
    pruneGeneratedOutputs() {
        return Promise.resolve(0);
    },
    getSettings() {
        return Promise.resolve(cloneBrowserSettingsFile());
    },
    updateSettings(request) {
        if (request.settings !== undefined && request.settingsPatch !== undefined) {
            return Promise.reject(new Error('Scan-cleanup settings and settingsPatch cannot be supplied together'));
        }
        if (request.settings !== undefined) {
            browserSettingsFile.settings = cloneScanCleanupPreferenceValue(request.settings);
        }
        if (request.settingsPatch !== undefined) {
            const settingsPatch = cloneScanCleanupPreferenceValue(request.settingsPatch);
            browserSettingsFile.settings = {
                ...browserSettingsFile.settings,
                ...settingsPatch,
                ...(settingsPatch.marginsMm === undefined
                    ? {}
                    : {marginsMm: cloneScanCleanupPreferenceValue(settingsPatch.marginsMm)}),
            };
        }
        if (request.document !== undefined) {
            applyBrowserDocumentSettings(request.document);
        }
        return Promise.resolve(cloneBrowserSettingsFile());
    },
    onPreviewRaw: noopUnsubscribe,
    onJobState: noopUnsubscribe,
    onDetectionJobState: noopUnsubscribe,
};
