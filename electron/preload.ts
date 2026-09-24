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
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import { createCodecIpcInvoker } from '@electron/preload/ipcClient';
import { readHostResourceProfileArgument } from '@electron/preload/readHostResourceProfileArgument';
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
    return process.env.EVB_AUTOMATION_USER_DATA_DIR
        && process.env.EVB_AUTOMATION_SESSION_NAME
        && process.env.EVB_ENABLE_RENDERER_FILE_OPEN_HELPER === '1';
}

const deferredAutomationDocumentOpens = new Map<string, {
    promise: Promise<void>;
    release: () => void;
}>();
const electronApi = createElectronApi(ipcRenderer, webUtils, {
    diagnosticsPolicy: readDiagnosticsPolicyArgument(),
    resourceProfile: readHostResourceProfileArgument(),
    waitForDocumentOpenDirect: path =>
        deferredAutomationDocumentOpens.get(path)?.promise ?? Promise.resolve(),
});
contextBridge.exposeInMainWorld('electronAPI', electronApi);
tracePreload('electronAPI exposed to renderer');

if (isRendererAutomationFileOpenHelperEnabled()) {
    const invokeDocuments = createCodecIpcInvoker<IDocumentsInvokeMap>(ipcRenderer, DOCUMENTS_IPC_CODECS);
    contextBridge.exposeInMainWorld('__allowRendererFileOpenForAutomation', (filePath: string) => {
        const path = typeof filePath === 'string' ? filePath : '';
        const automationFileOpenToken = globalThis.crypto.randomUUID();
        return invokeDocuments(
            DOCUMENTS_CHANNELS.registerRendererFileOpenToken,
            automationFileOpenToken,
        ).then(() => invokeDocuments(DOCUMENTS_CHANNELS.allowRendererFileOpen, {
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
    tracePreload('automation file-open capability helper exposed');
}

installStartupOverlayLifecycle({
    tracePreload,
    forwardPreloadLogToMain,
});
