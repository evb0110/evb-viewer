import type {TAgentService} from '@electron/features/agent/createAgentService';
import type {scanCleanupMainBindings} from '@electron/features/scan-cleanup/scanCleanupMainBindings';
import {registerDocumentsIpcAdapter} from '@electron/features/documents/registerDocumentsIpcAdapter';
import {
    registerDocumentRevisionEventBridge,
    registerDocumentRevisionInvalidationEffects,
} from '@electron/features/documents/public';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {DOCUMENTS_IPC_CODECS} from '@electron/features/documents/documentsIpcCodecs';
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_PLATFORM_FEATURES,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import {AGENT_PLATFORM_FEATURE} from '@contracts/agentPlatformFeature';
import {IMAGE_EXPORT_PLATFORM_FEATURE} from '@contracts/imageExportPlatformFeature';
import {OCR_PLATFORM_FEATURE} from '@contracts/ocrPlatformFeature';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {SEARCH_PLATFORM_FEATURE} from '@contracts/searchPlatformFeature';
import {PAGE_OPS_PLATFORM_FEATURE} from '@contracts/pageOpsPlatformFeature';
import {SETTINGS_PLATFORM_FEATURE} from '@contracts/settingsPlatformFeature';
import {SHELL_PLATFORM_FEATURE} from '@contracts/shellPlatformFeature';
import {UPDATES_PLATFORM_FEATURE} from '@contracts/updatesPlatformFeature';
import {HOST_PLATFORM_FEATURE} from '@contracts/hostPlatformFeature';
import {DJVU_PLATFORM_FEATURE} from '@contracts/djvuPlatformFeature';
import {WINDOW_TABS_PLATFORM_FEATURE} from '@contracts/windowTabsPlatformFeature';
import type {TAnyDefinedPlatformFeature} from '@contracts/platformFeature';
import type {ICoreIpcHandlerOptions} from '@electron/platform-ipc/registerCoreIpcHandlers';
import {registerCoreIpcHandlers} from '@electron/platform-ipc/registerCoreIpcHandlers';
import {RAW_IPC_HANDLER_DESCRIPTORS} from '@electron/platform-ipc/rawIpcRegistration';
import {
    createValidatedIpcMainEventRegistrar,
    createValidatedIpcMainRegistrar,
} from '@electron/platform-ipc/validatedIpcRegistrar';
export interface IFeatureRegistrationContext {
    agentService: TAgentService;
    coreIpcOptions?: ICoreIpcHandlerOptions;
}

type TFeatureMainBindingRecord = Record<string, unknown>;

export interface IFeatureRegistrationDescriptor<TBindings extends TFeatureMainBindingRecord = TFeatureMainBindingRecord> {
    readonly name: string;
    readonly startOrder: number;
    readonly kind: 'documents' | 'platform' | 'core';
    readonly feature?: TAnyDefinedPlatformFeature;
    readonly create?: (context: IFeatureRegistrationContext) => Promise<TBindings>;
    readonly register?: (
        ipcMain: Electron.IpcMain,
        context: IFeatureRegistrationContext,
    ) => (() => Promise<void>) | undefined;
    readonly lifecycle: {
        readonly create: string;
        readonly ipcRegistration: string;
        readonly shutdown: string;
    };
    readonly disposeBindingKey?: keyof TBindings & string;
}

type TPlatformDescriptor<TBindings extends TFeatureMainBindingRecord = TFeatureMainBindingRecord> = IFeatureRegistrationDescriptor<TBindings> & {
    readonly kind: 'platform';
    readonly feature: TAnyDefinedPlatformFeature;
    readonly create: (context: IFeatureRegistrationContext) => Promise<TBindings>;
};

type TScanCleanupMainBindings = typeof scanCleanupMainBindings;

const scanCleanupDescriptor: TPlatformDescriptor<TScanCleanupMainBindings> = {
    name: 'scan-cleanup',
    startOrder: 18,
    kind: 'platform',
    feature: SCAN_CLEANUP_PLATFORM_FEATURE,
    create: async () => {
        const {scanCleanupMainBindings} =
            await import('@electron/features/scan-cleanup/scanCleanupMainBindings');
        return scanCleanupMainBindings;
    },
    lifecycle: {
        create: 'scanCleanupMainBindings',
        ipcRegistration: 'registerPlatformFeatureHandlers',
        shutdown: 'disposeScanCleanupMainBindingsIfLoaded',
    },
    disposeBindingKey: 'disposeScanCleanupMainBindings',
};

const platformDescriptors: readonly TPlatformDescriptor[] = [
    {
        name: 'agent',
        startOrder: 10,
        kind: 'platform',
        feature: AGENT_PLATFORM_FEATURE,
        create: ({agentService}) => Promise.resolve(agentService),
        lifecycle: {
            create: 'createAgentService',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'agentService.shutdownAssistant',
        },
    },
    {
        name: 'settings',
        startOrder: 11,
        kind: 'platform',
        feature: SETTINGS_PLATFORM_FEATURE,
        create: async ({agentService}) => {
            const {createSettingsMainBindings} =
                await import('@electron/features/settings/createSettingsMainBindings');
            return createSettingsMainBindings(agentService.shutdownAssistant);
        },
        lifecycle: {
            create: 'createSettingsMainBindings',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'settings save disables assistant through shutdownAssistant',
        },
    },
    {
        name: 'shell',
        startOrder: 12,
        kind: 'platform',
        feature: SHELL_PLATFORM_FEATURE,
        create: async () => {
            const {shellMainBindings} = await import('@electron/features/shell/shellMainBindings');
            return shellMainBindings;
        },
        lifecycle: {
            create: 'shellMainBindings',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'sender cleanup and rate-limit state are local to the binding',
        },
    },
    {
        name: 'updates',
        startOrder: 13,
        kind: 'platform',
        feature: UPDATES_PLATFORM_FEATURE,
        create: () => import('@electron/updates'),
        lifecycle: {
            create: 'import(@electron/updates)',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'shutdownUpdates',
        },
    },
    {
        name: 'host',
        startOrder: 14,
        kind: 'platform',
        feature: HOST_PLATFORM_FEATURE,
        create: async () => {
            const {hostMainBindings} = await import('@electron/hostEnvironment');
            return hostMainBindings;
        },
        lifecycle: {
            create: 'hostMainBindings',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'host display watcher and window attachment are owned by bootstrap',
        },
    },
    {
        name: 'image-export',
        startOrder: 15,
        kind: 'platform',
        feature: IMAGE_EXPORT_PLATFORM_FEATURE,
        create: async () => {
            const {imageExportMainBindings} = await import('@electron/features/image-export/public');
            return imageExportMainBindings;
        },
        lifecycle: {
            create: 'imageExportMainBindings',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'main-operation cancellation and scratch cleanup',
        },
    },
    {
        name: 'page-ops',
        startOrder: 16,
        kind: 'platform',
        feature: PAGE_OPS_PLATFORM_FEATURE,
        create: async () => {
            const {pageOpsMainBindings} = await import('@electron/features/page-ops/public');
            return pageOpsMainBindings;
        },
        lifecycle: {
            create: 'pageOpsMainBindings',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'main-operation cancellation and critical-operation drain',
        },
    },
    {
        name: 'ocr',
        startOrder: 17,
        kind: 'platform',
        feature: OCR_PLATFORM_FEATURE,
        create: async () => {
            const {ocrMainBindings} = await import('@electron/features/ocr/mainBindings');
            return ocrMainBindings;
        },
        lifecycle: {
            create: 'ocrMainBindings',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'shutdownOcrJobManager',
        },
    },
    scanCleanupDescriptor,
    {
        name: 'search',
        startOrder: 19,
        kind: 'platform',
        feature: SEARCH_PLATFORM_FEATURE,
        create: async () => {
            const {prepareSearchMainBindings} = await import('@electron/features/search/public');
            return prepareSearchMainBindings();
        },
        lifecycle: {
            create: 'prepareSearchMainBindings',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'searchWorkerService.shutdown',
        },
    },
    {
        name: 'djvu',
        startOrder: 20,
        kind: 'platform',
        feature: DJVU_PLATFORM_FEATURE,
        create: async () => {
            const {prepareDjvuMainBindings} =
                await import('@electron/features/djvu/mainBindings');
            return prepareDjvuMainBindings();
        },
        lifecycle: {
            create: 'prepareDjvuMainBindings',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'shutdownDjvuConversions then performDjvuViewingShutdownCleanup',
        },
    },
];

const documentDescriptors: readonly IFeatureRegistrationDescriptor[] = DOCUMENT_PLATFORM_FEATURES.map((feature, index) => ({
    name: feature.path.join('.'),
    startOrder: index + 1,
    kind: 'documents',
    feature,
    lifecycle: {
        create: 'createDocumentsService',
        ipcRegistration: 'registerDocumentsIpcAdapter',
        shutdown: 'serialized PDF persistence and sender cleanup',
    },
}));

export const FEATURE_REGISTRATION_DESCRIPTORS: readonly IFeatureRegistrationDescriptor[] = [
    ...documentDescriptors,
    {
        name: 'window-tabs',
        startOrder: 9,
        kind: 'core',
        feature: WINDOW_TABS_PLATFORM_FEATURE,
        register: (ipcMain, context) => {
            registerCoreIpcHandlers(ipcMain, context.coreIpcOptions ?? {});
            return undefined;
        },
        lifecycle: {
            create: 'registerCoreIpcHandlers',
            ipcRegistration: 'registerPlatformFeatureHandlers',
            shutdown: 'workspace checkpoint and window-close handshake',
        },
    },
    ...platformDescriptors,
];

export {RAW_IPC_HANDLER_DESCRIPTORS};

export function registerDocumentFeatureAdapters(ipcMain: Electron.IpcMain) {
    const channelSet = new Set([
        ...Object.values(DOCUMENTS_CHANNELS),
        ...DOCUMENT_PLATFORM_FEATURES.flatMap(feature => [...feature.invokeChannelSet]),
    ]);
    const codecs = {
        ...DOCUMENTS_IPC_CODECS,
        ...DOCUMENT_PICKER_PLATFORM_FEATURE.ipcCodecs,
        ...DOCUMENT_OPEN_PLATFORM_FEATURE.ipcCodecs,
        ...DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.ipcCodecs,
        ...DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs,
        ...DOCUMENT_PDF_PLATFORM_FEATURE.ipcCodecs,
        ...DOCUMENT_RECENT_FILES_PLATFORM_FEATURE.ipcCodecs,
        ...DOCUMENT_WINDOW_PLATFORM_FEATURE.ipcCodecs,
        ...DOCUMENT_MENU_PLATFORM_FEATURE.ipcCodecs,
    };
    registerDocumentsIpcAdapter(
        createValidatedIpcMainRegistrar<IDocumentsInvokeMap>(ipcMain, {
            allowedChannels: channelSet,
            codecs,
        }),
        undefined,
        {eventRegistrar: createValidatedIpcMainEventRegistrar(ipcMain, {allowedChannels: channelSet})},
    );
    registerDocumentRevisionEventBridge();
    registerDocumentRevisionInvalidationEffects();
}

export {platformDescriptors};
