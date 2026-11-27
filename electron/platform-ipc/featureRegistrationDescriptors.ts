import {
    BrowserWindow,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
} from 'electron';
import type {TAgentService} from '@electron/features/agent/public';
import type {scanCleanupMainBindings} from '@electron/features/scan-cleanup/scanCleanupMainBindings';
import {
    DOCUMENTS_CHANNELS,
    DOCUMENTS_EVENT_CHANNELS,
} from '@electron/features/documents/contract';
import {DOCX_EXPORT_STREAM_CHANNELS} from '@contracts/docxExport';
import {
    DOCUMENT_PLATFORM_FEATURES,
    type DOCUMENT_FILES_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import {AGENT_PLATFORM_FEATURE} from '@contracts/agentPlatformFeature';
import {IMAGE_EXPORT_PLATFORM_FEATURE} from '@contracts/imageExportPlatformFeature';
import {OCR_PLATFORM_FEATURE} from '@contracts/ocrPlatformFeature';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import {SEARCH_PLATFORM_FEATURE} from '@contracts/searchPlatformFeature';
import {PAGE_OPS_PLATFORM_FEATURE} from '@contracts/pageOpsPlatformFeature';
import {SETTINGS_PLATFORM_FEATURE} from '@contracts/settingsPlatformFeature';
import {SHELL_PLATFORM_FEATURE} from '@contracts/shellPlatformFeature';
import {UPDATES_PLATFORM_FEATURE} from '@contracts/updatesPlatformFeature';
import {HOST_PLATFORM_FEATURE} from '@contracts/hostPlatformFeature';
import {DJVU_PLATFORM_FEATURE} from '@contracts/djvuPlatformFeature';
import {WINDOW_TABS_PLATFORM_FEATURE} from '@contracts/windowTabsPlatformFeature';
import type {
    TAnyDefinedPlatformFeature,
    TFeatureEventMap,
    TFeatureMainBindings,
} from '@contracts/platformFeature';
import type {ICoreIpcHandlerOptions} from '@electron/platform-ipc/registerCoreIpcHandlers';
import {registerCoreIpcHandlers} from '@electron/platform-ipc/registerCoreIpcHandlers';
import {RAW_IPC_HANDLER_DESCRIPTORS} from '@electron/platform-ipc/rawIpcRegistration';
import {
    createValidatedIpcMainEventRegistrar,
    createValidatedIpcMainRegistrar,
} from '@electron/platform-ipc/validatedIpcRegistrar';
import {onDocumentRevisionChanged} from '@electron/file-access/documentStore';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';

export type TLazyMainSubsystem = 'agent' | 'documents' | 'search' | 'djvu' | 'ocr';
export type TLoadUpdatesModule = () => Promise<typeof import('@electron/updates')>;

export interface IFeatureRegistrationContext {
    agentService?: TAgentService;
    coreIpcOptions?: ICoreIpcHandlerOptions;
    loadUpdatesModule?: TLoadUpdatesModule;
    onSubsystemLoaded?: (subsystem: TLazyMainSubsystem) => void;
    isSubsystemLoaded?: (subsystem: TLazyMainSubsystem) => boolean;
}

const featureRegistrationLogger = createLogger('feature-ipc');

type TDocumentsMainBindingsModule = typeof import('@electron/features/documents/documentsMainBindings');
type TDocumentsDirectInvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type TDocumentsDirectEventHandler = (event: IpcMainEvent, ...args: unknown[]) => void;

interface ILoadedDocumentsRuntime {
    readonly module: TDocumentsMainBindingsModule;
    readonly invokeHandlers: Map<string, TDocumentsDirectInvokeHandler>;
    readonly eventHandlers: Map<string, TDocumentsDirectEventHandler>;
}

export const DOCUMENTS_DIRECT_INVOKE_CHANNELS = [
    DOCUMENTS_CHANNELS.registerRendererFileOpenToken,
    DOCUMENTS_CHANNELS.registerRendererFileOpenTokens,
    DOCUMENTS_CHANNELS.allowRendererFileOpen,
    DOCUMENTS_CHANNELS.allowRendererFileOpenBatch,
    DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
    DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf,
    DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf,
    ...Object.values(DOCX_EXPORT_STREAM_CHANNELS),
] as const;

let documentsRuntimePromise: Promise<ILoadedDocumentsRuntime> | null = null;
let loadedDocumentsRuntime: ILoadedDocumentsRuntime | null = null;
let unsubscribePreloadRevisionBridge: (() => void) | null = null;

type TDocumentRevisionChangedPayload =
    TFeatureEventMap<typeof DOCUMENT_FILES_PLATFORM_FEATURE>[typeof DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged];

function installPreloadDocumentRevisionBridge(context: IFeatureRegistrationContext) {
    if (unsubscribePreloadRevisionBridge || loadedDocumentsRuntime) {
        return;
    }
    unsubscribePreloadRevisionBridge = onDocumentRevisionChanged((event) => {
        for (const window of BrowserWindow.getAllWindows?.() ?? []) {
            if (window.isDestroyed() || window.webContents.isDestroyed()) {
                continue;
            }
            try {
                window.webContents.send(
                    DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged,
                    event satisfies TDocumentRevisionChangedPayload,
                );
            } catch (error) {
                featureRegistrationLogger.debug(`Failed to send document revision event: ${getErrorMessage(error)}`);
            }
        }
        const reason = `Document revision changed: ${event.reason}`;
        if (context.isSubsystemLoaded?.('ocr')) {
            void import('@electron/features/ocr/public')
                .then(({cancelOcrJobsForWorkingCopy}) => cancelOcrJobsForWorkingCopy(event.documentRef, reason))
                .catch((error: unknown) => {
                    featureRegistrationLogger.warn(`Failed to invalidate OCR on document revision: ${getErrorMessage(error)}`);
                });
        }
        if (context.isSubsystemLoaded?.('search')) {
            void import('@electron/features/search/public')
                .then(({searchService}) => searchService.cancelRequestsForPdfPath(event.documentRef, reason))
                .catch((error: unknown) => {
                    featureRegistrationLogger.warn(`Failed to invalidate search on document revision: ${getErrorMessage(error)}`);
                });
        }
    });
}

function loadDocumentsRuntime(onSubsystemLoaded?: (subsystem: TLazyMainSubsystem) => void): Promise<ILoadedDocumentsRuntime> {
    onSubsystemLoaded?.('documents');
    documentsRuntimePromise ??= import('@electron/features/documents/documentsMainBindings').then((module) => {
        const invokeHandlers = new Map<string, TDocumentsDirectInvokeHandler>();
        const eventHandlers = new Map<string, TDocumentsDirectEventHandler>();
        module.registerDocumentsDirectIpc(
            {
                handle: (channel, handler) => {
                    invokeHandlers.set(channel, handler as TDocumentsDirectInvokeHandler);
                },
            },
            {
                on: (channel, handler) => {
                    eventHandlers.set(channel, handler);
                },
            },
        );
        if (invokeHandlers.size > 0) {
            const expectedChannels = new Set<string>(DOCUMENTS_DIRECT_INVOKE_CHANNELS);
            const unexpectedChannels = [...invokeHandlers.keys()].filter(channel => !expectedChannels.has(channel));
            const missingChannels = DOCUMENTS_DIRECT_INVOKE_CHANNELS.filter(channel => !invokeHandlers.has(channel));
            if (unexpectedChannels.length > 0 || missingChannels.length > 0) {
                throw new Error(
                    `documents-direct invoke channel mismatch (missing: ${missingChannels.join(', ') || 'none'}, unexpected: ${unexpectedChannels.join(', ') || 'none'})`,
                );
            }
        }
        // The canonical bridge and invalidation effects are now installed by
        // registerDocumentsDirectIpc; release the lightweight pre-load listener.
        unsubscribePreloadRevisionBridge?.();
        unsubscribePreloadRevisionBridge = null;
        const runtime: ILoadedDocumentsRuntime = {
            module,
            invokeHandlers,
            eventHandlers,
        };
        loadedDocumentsRuntime = runtime;
        return runtime;
    }).catch((error) => {
        documentsRuntimePromise = null;
        throw error;
    });
    return documentsRuntimePromise;
}

type TFeatureMainBindingRecord = Record<string, unknown>;

export interface IFeatureRegistrationDescriptor<TBindings extends TFeatureMainBindingRecord = TFeatureMainBindingRecord> {
    readonly name: string;
    readonly feature?: TAnyDefinedPlatformFeature;
    readonly create?: (context: IFeatureRegistrationContext) => Promise<TBindings>;
    readonly register?: (
        ipcMain: Electron.IpcMain,
        context: IFeatureRegistrationContext,
    ) => void;
    readonly disposeBindingKey?: keyof TBindings & string;
}

type TPlatformDescriptor<TBindings extends TFeatureMainBindingRecord = TFeatureMainBindingRecord> = IFeatureRegistrationDescriptor<TBindings> & {
    readonly feature: TAnyDefinedPlatformFeature;
    readonly create: (context: IFeatureRegistrationContext) => Promise<TBindings>;
};

type TScanCleanupMainBindings = typeof scanCleanupMainBindings;

const scanCleanupDescriptor: TPlatformDescriptor<TScanCleanupMainBindings> = {
    name: 'scan-cleanup',
    feature: SCAN_CLEANUP_PLATFORM_FEATURE,
    create: async () => {
        const {scanCleanupMainBindings} =
            await import('@electron/features/scan-cleanup/scanCleanupMainBindings');
        return scanCleanupMainBindings;
    },
    disposeBindingKey: 'disposeScanCleanupMainBindings',
};

const platformDescriptors: readonly TPlatformDescriptor[] = [
    {
        name: 'agent',
        feature: AGENT_PLATFORM_FEATURE,
        create: async ({
            agentService,
            onSubsystemLoaded,
        }) => {
            onSubsystemLoaded?.('agent');
            if (agentService) {
                return agentService;
            }
            const {createAgentService} = await import('@electron/features/agent/public');
            return createAgentService();
        },
    },
    {
        name: 'settings',
        feature: SETTINGS_PLATFORM_FEATURE,
        create: async ({
            agentService,
            isSubsystemLoaded,
        }) => {
            const {createSettingsMainBindings} =
                await import('@electron/features/settings/createSettingsMainBindings');
            const shutdownAssistant = agentService
                ? agentService.shutdownAssistant
                : async () => {
                    if (isSubsystemLoaded && !isSubsystemLoaded('agent')) {
                        return;
                    }
                    const {shutdownAgentAssistantIfLoaded} =
                        await import('@electron/features/agent/public');
                    await shutdownAgentAssistantIfLoaded();
                };
            return createSettingsMainBindings(shutdownAssistant);
        },
    },
    {
        name: 'shell',
        feature: SHELL_PLATFORM_FEATURE,
        create: async () => {
            const {shellMainBindings} = await import('@electron/features/shell/shellMainBindings');
            return shellMainBindings;
        },
    },
    {
        name: 'updates',
        feature: UPDATES_PLATFORM_FEATURE,
        create: async ({loadUpdatesModule}) => (
            await (loadUpdatesModule ? loadUpdatesModule() : import('@electron/updates'))
        ) satisfies TFeatureMainBindings<typeof UPDATES_PLATFORM_FEATURE, IpcMainInvokeEvent>,
    },
    {
        name: 'host',
        feature: HOST_PLATFORM_FEATURE,
        create: async () => {
            const {hostMainBindings} = await import('@electron/hostEnvironment');
            return hostMainBindings;
        },
    },
    {
        name: 'image-export',
        feature: IMAGE_EXPORT_PLATFORM_FEATURE,
        create: async () => {
            const {imageExportMainBindings} = await import('@electron/features/image-export/public');
            return imageExportMainBindings;
        },
    },
    {
        name: 'page-ops',
        feature: PAGE_OPS_PLATFORM_FEATURE,
        create: async () => {
            const {pageOpsMainBindings} = await import('@electron/features/page-ops/public');
            return pageOpsMainBindings;
        },
    },
    {
        name: 'ocr',
        feature: OCR_PLATFORM_FEATURE,
        create: async ({onSubsystemLoaded}) => {
            onSubsystemLoaded?.('ocr');
            const {ocrMainBindings} = await import('@electron/features/ocr/mainBindings');
            return ocrMainBindings;
        },
    },
    scanCleanupDescriptor,
    {
        name: 'search',
        feature: SEARCH_PLATFORM_FEATURE,
        create: async ({onSubsystemLoaded}) => {
            onSubsystemLoaded?.('search');
            const {prepareSearchMainBindings} = await import('@electron/features/search/public');
            return prepareSearchMainBindings();
        },
    },
    {
        name: 'djvu',
        feature: DJVU_PLATFORM_FEATURE,
        create: async ({onSubsystemLoaded}) => {
            onSubsystemLoaded?.('djvu');
            const {default: prepareDjvuMainBindings} =
                await import('@electron/features/djvu/mainBindings');
            return prepareDjvuMainBindings();
        },
    },
];

const documentDescriptors: readonly TPlatformDescriptor[] = DOCUMENT_PLATFORM_FEATURES.map(feature => ({
    name: feature.path.join('.'),
    feature,
    create: async ({onSubsystemLoaded}) => (await loadDocumentsRuntime(onSubsystemLoaded)).module.documentsMainBindings,
}));

export const FEATURE_REGISTRATION_DESCRIPTORS: readonly IFeatureRegistrationDescriptor[] = [
    ...documentDescriptors,
    {
        name: 'documents-direct',
        register: (ipcMain, context) => {
            installPreloadDocumentRevisionBridge(context);
            const allowedChannels = new Set<string>([
                ...Object.values(DOCUMENTS_CHANNELS),
                ...Object.values(DOCX_EXPORT_STREAM_CHANNELS),
            ]);
            const invokeRegistrar = createValidatedIpcMainRegistrar(ipcMain, {
                allowedChannels,
                lazyCodecs: async () => (await loadDocumentsRuntime(context.onSubsystemLoaded)).module.DOCUMENTS_DIRECT_ARG_DECODERS,
            });
            for (const channel of DOCUMENTS_DIRECT_INVOKE_CHANNELS) {
                invokeRegistrar.handle(channel, async (event, ...args: unknown[]) => {
                    const runtime = await loadDocumentsRuntime(context.onSubsystemLoaded);
                    const handler = runtime.invokeHandlers.get(channel);
                    if (!handler) {
                        throw new Error(`Lazy documents-direct IPC handler was not registered: ${channel}`);
                    }
                    return handler(event, ...args);
                });
            }
            const eventRegistrar = createValidatedIpcMainEventRegistrar(ipcMain, {allowedChannels});
            eventRegistrar.on(DOCUMENTS_CHANNELS.fileSavePdfDataPort, (event, ...args: unknown[]) => {
                if (loadedDocumentsRuntime) {
                    loadedDocumentsRuntime.eventHandlers.get(DOCUMENTS_CHANNELS.fileSavePdfDataPort)?.(event, ...args);
                    return;
                }
                void loadDocumentsRuntime(context.onSubsystemLoaded).then(
                    (runtime) => {
                        runtime.eventHandlers.get(DOCUMENTS_CHANNELS.fileSavePdfDataPort)?.(event, ...args);
                    },
                    (error: unknown) => {
                        for (const port of event.ports ?? []) {
                            try {
                                port.close();
                            } catch {
                                // Ignore port cleanup failures after load error.
                            }
                        }
                        featureRegistrationLogger.warn(
                            `[ipc] failed to load ${DOCUMENTS_CHANNELS.fileSavePdfDataPort}: ${getErrorMessage(error)}`,
                        );
                    },
                );
            });
        },
    },
    {
        name: 'window-tabs',
        feature: WINDOW_TABS_PLATFORM_FEATURE,
        register: (ipcMain, context) => registerCoreIpcHandlers(ipcMain, context.coreIpcOptions ?? {}),
    },
    ...platformDescriptors,
];

export {RAW_IPC_HANDLER_DESCRIPTORS};
export {platformDescriptors};
