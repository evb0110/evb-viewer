import type {TAgentService} from '@electron/features/agent/createAgentService';
import type {scanCleanupMainBindings} from '@electron/features/scan-cleanup/scanCleanupMainBindings';
import {
    DOCUMENTS_DIRECT_ARG_DECODERS,
    documentsMainBindings,
    registerDocumentsDirectIpc,
} from '@electron/features/documents/documentsMainBindings';
import {DOCUMENTS_CHANNELS} from '@electron/features/documents/contract';
import {DOCX_EXPORT_STREAM_CHANNELS} from '@contracts/docxExport';
import {DOCUMENT_PLATFORM_FEATURES} from '@contracts/documentsPlatformFeature';
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
        create: ({agentService}) => Promise.resolve(agentService),
    },
    {
        name: 'settings',
        feature: SETTINGS_PLATFORM_FEATURE,
        create: async ({agentService}) => {
            const {createSettingsMainBindings} =
                await import('@electron/features/settings/createSettingsMainBindings');
            return createSettingsMainBindings(agentService.shutdownAssistant);
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
        create: () => import('@electron/updates'),
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
        create: async () => {
            const {ocrMainBindings} = await import('@electron/features/ocr/mainBindings');
            return ocrMainBindings;
        },
    },
    scanCleanupDescriptor,
    {
        name: 'search',
        feature: SEARCH_PLATFORM_FEATURE,
        create: async () => {
            const {prepareSearchMainBindings} = await import('@electron/features/search/public');
            return prepareSearchMainBindings();
        },
    },
    {
        name: 'djvu',
        feature: DJVU_PLATFORM_FEATURE,
        create: async () => {
            const {prepareDjvuMainBindings} =
                await import('@electron/features/djvu/mainBindings');
            return prepareDjvuMainBindings();
        },
    },
];

const documentDescriptors: readonly TPlatformDescriptor[] = DOCUMENT_PLATFORM_FEATURES.map(feature => ({
    name: feature.path.join('.'),
    feature,
    create: () => Promise.resolve(documentsMainBindings),
}));

export const FEATURE_REGISTRATION_DESCRIPTORS: readonly IFeatureRegistrationDescriptor[] = [
    ...documentDescriptors,
    {
        name: 'documents-direct',
        register: (ipcMain) => {
            const allowedChannels = new Set<string>([
                ...Object.values(DOCUMENTS_CHANNELS),
                ...Object.values(DOCX_EXPORT_STREAM_CHANNELS),
            ]);
            registerDocumentsDirectIpc(
                createValidatedIpcMainRegistrar(ipcMain, {
                    allowedChannels,
                    codecs: DOCUMENTS_DIRECT_ARG_DECODERS,
                }),
                createValidatedIpcMainEventRegistrar(ipcMain, {allowedChannels}),
            );
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
