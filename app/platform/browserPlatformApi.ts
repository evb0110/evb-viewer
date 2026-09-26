import type { IPlatformApi } from '@contracts/platformApi';
import { inspectAllowedExternalUrl } from '@contracts/externalUrl';
import type { SHELL_PLATFORM_FEATURE } from '@contracts/shellPlatformFeature';
import type {
    TFeatureBrowserBindings,
    TFeatureSyncBindings,
} from '@contracts/platformFeature';
import type { SYSTEM_PLATFORM_FEATURE } from '@contracts/systemPlatformFeature';
import { browserWindowTabsCapability } from '@app/platform/browserWindowTabs';
import {
    browserAgentCapability,
    browserDjvuCapability,
    browserHostCapability,
    browserOcrCapability,
    browserScanCleanupCapability,
    browserSettingsCapability,
    createBrowserDocumentsCapability,
    createBrowserSearchCapability,
} from '@app/platform/browser-api/public';
import { BrowserLogger } from '@app/utils/browserLogger';

const {
    capability: browserSearchCapability,
    clearSearchCaches,
} = createBrowserSearchCapability();

const browserDocumentCapabilities = createBrowserDocumentsCapability({clearSearchCaches});
const browserSystemSyncBindings = {getMemoryInfo: () => null} satisfies TFeatureSyncBindings<typeof SYSTEM_PLATFORM_FEATURE>;
const browserSystemApi: IPlatformApi['system'] = {
    ...browserSystemSyncBindings,
    onShutdownSaveFlushRequest: () => () => {},
    onWindowCloseRequest: () => () => {},
};
const browserShellApi: IPlatformApi['shell'] = { openExternal(url: string) {
    if (typeof window === 'undefined') {
        return Promise.resolve(undefined);
    }

    const decision = inspectAllowedExternalUrl(url);
    if (!decision.ok) {
        BrowserLogger.warn('shell', 'Blocked external URL', {
            protocol: decision.protocol ?? null,
            reason: decision.reason,
            url,
        });
        return Promise.resolve(undefined);
    }

    const openedWindow = window.open(decision.normalizedUrl, '_blank', 'noopener,noreferrer');
    if (!openedWindow) {
        BrowserLogger.warn('shell', 'Failed to open external URL', { url: decision.normalizedUrl });
    }

    return Promise.resolve(undefined);
} } satisfies TFeatureBrowserBindings<typeof SHELL_PLATFORM_FEATURE>;

export const browserPlatformApi = {
    documentPicker: browserDocumentCapabilities.documentPicker,
    documentOpen: browserDocumentCapabilities.documentOpen,
    documentWorkingCopy: browserDocumentCapabilities.documentWorkingCopy,
    documentFiles: browserDocumentCapabilities.documentFiles,
    documentPdf: browserDocumentCapabilities.documentPdf,
    documentRecentFiles: browserDocumentCapabilities.documentRecentFiles,
    documentWindow: browserDocumentCapabilities.documentWindow,
    documentMenu: browserDocumentCapabilities.documentMenu,
    pageOps: browserDocumentCapabilities.pageOps,
    imageExport: browserDocumentCapabilities.imageExport,
    ocr: browserOcrCapability,
    scanCleanup: browserScanCleanupCapability,
    search: browserSearchCapability,
    djvu: browserDjvuCapability,
    settings: browserSettingsCapability,
    system: browserSystemApi,
    windowTabs: browserWindowTabsCapability,
    shell: browserShellApi,
    host: browserHostCapability,
    agent: browserAgentCapability,
} satisfies IPlatformApi;
