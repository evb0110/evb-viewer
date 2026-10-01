import {
    contextBridge,
    ipcRenderer,
    webUtils,
} from 'electron';
// Exposes the IPC bridge the renderer Sentry SDK uses. It only forwards to
// main, which drops everything unless diagnostics consent is granted.
import '@sentry/electron/preload';
import { createElectronApi } from '@electron/preload/createElectronApi';
import { markPreloadInstalled } from '@electron/preload/markPreloadInstalled';
import { installDebugLogListener } from '@electron/preload/installDebugLogListener';
import {
    createPreloadMainLogger,
    exposeStartupTraceFlag,
    tracePreload,
} from '@electron/preload/preloadLog';
import { installStartupOverlayLifecycle } from '@electron/preload/installStartupOverlayLifecycle';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
import { readHostResourceProfileArgument } from '@electron/preload/readHostResourceProfileArgument';
import { readHostEnvironmentArgument } from '@electron/preload/readHostEnvironmentArgument';
import { readDiagnosticsPolicyArgument } from '@electron/preload/readDiagnosticsPolicyArgument';
const preloadAlreadyInstalled = markPreloadInstalled();
if (preloadAlreadyInstalled) {
    console.debug('[Preload] Re-exposing bridge for duplicate installation (fast reload detected)');
}

tracePreload('preload installation started');
exposeStartupTraceFlag();
installDebugLogListener(ipcRenderer);

const forwardPreloadLogToMain = createPreloadMainLogger(ipcRenderer);

function isRendererAutomationFileOpenHelperEnabled() {
    return process.argv.includes('--evb-renderer-file-open-helper');
}

const deferredAutomationDocumentOpens = new Map<string, {
    promise: Promise<void>;
    release: () => void;
}>();
const electronApi = createElectronApi(ipcRenderer, webUtils, {
    diagnosticsPolicy: readDiagnosticsPolicyArgument(),
    hostEnvironment: readHostEnvironmentArgument(),
    resourceProfile: readHostResourceProfileArgument(),
    waitForDocumentOpenDirect: path =>
        deferredAutomationDocumentOpens.get(path)?.promise ?? Promise.resolve(),
});
contextBridge.exposeInMainWorld('electronAPI', electronApi);
tracePreload('electronAPI exposed to renderer');

if (isRendererAutomationFileOpenHelperEnabled()) {
    contextBridge.exposeInMainWorld('__allowRendererFileOpenForAutomation', (filePath: string) => {
        const path = typeof filePath === 'string' ? filePath : '';
        const automationFileOpenToken = globalThis.crypto.randomUUID();
        return ipcRenderer.invoke(
            DOCUMENTS_CHANNELS.registerRendererFileOpenToken,
            automationFileOpenToken,
        ).then(() => ipcRenderer.invoke(DOCUMENTS_CHANNELS.allowRendererFileOpen, {
            filePath: path,
            token: automationFileOpenToken,
        }));
    });
    contextBridge.exposeInMainWorld('__deferDocumentOpenForAutomation', (filePath: string) => {
        const path = typeof filePath === 'string' ? filePath : '';
        if (!path || deferredAutomationDocumentOpens.has(path)) {
            return false;
        }
        let release = () => {};
        const promise = new Promise<void>((resolve) => {
            release = resolve;
        });
        deferredAutomationDocumentOpens.set(path, {
            promise,
            release,
        });
        return true;
    });
    contextBridge.exposeInMainWorld('__releaseDocumentOpenForAutomation', (filePath: string) => {
        const path = typeof filePath === 'string' ? filePath : '';
        const deferred = deferredAutomationDocumentOpens.get(path);
        if (!deferred) {
            return false;
        }
        deferredAutomationDocumentOpens.delete(path);
        deferred.release();
        return true;
    });
    // Replays an update status through the renderer's own `updates:status`
    // subscription, which still validates it. Unpackaged Linux builds never
    // reach an update offer, so this is how E2E presents one.
    contextBridge.exposeInMainWorld('__emitUpdateStatusForAutomation', (status: unknown) => {
        ipcRenderer.emit(UPDATES_PLATFORM_FEATURE.events.onStatus.channel, {}, status);
    });
    tracePreload('automation file-open capability helper exposed');
}

installStartupOverlayLifecycle({
    tracePreload,
    forwardPreloadLogToMain,
});
