import {AGENT_PLATFORM_FEATURE} from '@contracts/agentPlatformFeature';
import {DJVU_PLATFORM_FEATURE} from '@contracts/djvuPlatformFeature';
import {DOCUMENT_PLATFORM_FEATURES} from '@contracts/documentsPlatformFeature';
import {HOST_PLATFORM_FEATURE} from '@contracts/hostPlatformFeature';
import { OCR_PLATFORM_FEATURE } from '@contracts/ocrPlatformFeature';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import {IMAGE_EXPORT_PLATFORM_FEATURE} from '@contracts/imageExportPlatformFeature';
import {PAGE_OPS_PLATFORM_FEATURE} from '@contracts/pageOpsPlatformFeature';
import {SYSTEM_PLATFORM_FEATURE} from '@contracts/systemPlatformFeature';
import {UPDATES_PLATFORM_FEATURE} from '@contracts/updatesPlatformFeature';
import {WINDOW_TABS_PLATFORM_FEATURE} from '@contracts/windowTabsPlatformFeature';
import type {TPlatformBackend} from '@contracts/platformManifest';
import {SEARCH_PLATFORM_FEATURE} from '@contracts/searchPlatformFeature';
import {SETTINGS_PLATFORM_FEATURE} from '@contracts/settingsPlatformFeature';
import {SHELL_PLATFORM_FEATURE} from '@contracts/shellPlatformFeature';
import type {
    TPlatformMethodKind,
    IPlatformMethodDescriptor,
    IPlatformCapabilityDescriptor,
    IPlatformApiDescriptor,
} from '@contracts/platformDescriptorTypes';

export type {
    TPlatformMethodKind,
    TBrowserPlatformLazyMode,
    IPlatformMethodDescriptor,
    IPlatformCapabilityDescriptor,
    IPlatformApiDescriptor,
} from '@contracts/platformDescriptorTypes';

const requiredEverywhere = {
    browser: true,
    electron: true,
} as const satisfies Record<TPlatformBackend, boolean>;
const requiredInElectron = {
    browser: false,
    electron: true,
} as const satisfies Record<TPlatformBackend, boolean>;
const requiredInBrowser = {
    browser: true,
    electron: false,
} as const satisfies Record<TPlatformBackend, boolean>;

const legacyMethodPaths = [
    [
        'settings',
        'getDebugLogs',
    ],
    [
        'settings',
        'onDebugLog',
    ],
    [
        'settings',
        'rendererLog',
    ],
    [
        'system',
        'onShutdownSaveFlushRequest',
    ],
    [
        'system',
        'onWindowCloseRequest',
    ],
    [
        'updates',
        'onMenuCheckForUpdates',
    ],
    [
        'windowTabs',
        'notifyRendererReady',
    ],
] as const;

function resolveLegacyMethodKind(path: readonly string[]): TPlatformMethodKind {
    const methodName = path.at(-1);
    if (methodName?.startsWith('on')) {
        return 'event';
    }
    if (methodName === 'notifyRendererReady' || methodName === 'rendererLog') {
        return 'void';
    }
    return 'async';
}

function createLegacyMethodDescriptor(path: readonly string[]): IPlatformMethodDescriptor {
    return {
        path,
        kind: resolveLegacyMethodKind(path),
        required: path.join('.') === 'updates.onMenuCheckForUpdates'
            ? requiredInElectron
            : requiredEverywhere,
        browserLazy: 'forwarded',
    };
}

const legacyCapabilities: readonly IPlatformCapabilityDescriptor[] = [
    {
        path: ['ocr'],
        required: requiredEverywhere,
    },
    {
        path: [
            'manifest',
            'capabilities',
            'documents',
            'folderPicker',
        ],
        required: requiredInElectron,
        manifestPath: [
            'documents',
            'folderPicker',
        ],
    },
    {
        path: [
            'manifest',
            'capabilities',
            'documents',
            'nativePaths',
        ],
        required: requiredInElectron,
        manifestPath: [
            'documents',
            'nativePaths',
        ],
    },
    {
        path: [
            'manifest',
            'capabilities',
            'documents',
            'browserDocumentRefs',
        ],
        required: requiredInBrowser,
        manifestPath: [
            'documents',
            'browserDocumentRefs',
        ],
    },
    {
        path: [
            'manifest',
            'capabilities',
            'documents',
            'nativePrint',
        ],
        required: requiredInElectron,
        manifestPath: [
            'documents',
            'nativePrint',
        ],
    },
    {
        path: [
            'manifest',
            'capabilities',
            'documents',
            'nativeOpenInDefaultApp',
        ],
        required: requiredInElectron,
        manifestPath: [
            'documents',
            'nativeOpenInDefaultApp',
        ],
    },
    {
        path: [
            'manifest',
            'capabilities',
            'documents',
            'structuredSaveResult',
        ],
        required: requiredEverywhere,
        manifestPath: [
            'documents',
            'structuredSaveResult',
        ],
    },
];

export const LEGACY_PLATFORM_API_DESCRIPTOR_WITHOUT_MIGRATED_FEATURES = {
    capabilities: legacyCapabilities,
    methods: legacyMethodPaths.map(path => createLegacyMethodDescriptor(path)),
} as const satisfies IPlatformApiDescriptor;

export const PLATFORM_FEATURE_REGISTRY = [
    ...DOCUMENT_PLATFORM_FEATURES,
    AGENT_PLATFORM_FEATURE,
    SEARCH_PLATFORM_FEATURE,
    DJVU_PLATFORM_FEATURE,
    OCR_PLATFORM_FEATURE,
    SCAN_CLEANUP_PLATFORM_FEATURE,
    IMAGE_EXPORT_PLATFORM_FEATURE,
    PAGE_OPS_PLATFORM_FEATURE,
    SETTINGS_PLATFORM_FEATURE,
    SHELL_PLATFORM_FEATURE,
    UPDATES_PLATFORM_FEATURE,
    HOST_PLATFORM_FEATURE,
    SYSTEM_PLATFORM_FEATURE,
    WINDOW_TABS_PLATFORM_FEATURE,
] as const;

interface IMigratedPlatformFeature {
    platformDescriptors: IPlatformApiDescriptor;
    invokeChannels: Readonly<Record<string, string>>;
    eventChannels: Readonly<Record<string, string>>;
}

function addUniquePlatformValues(
    seen: Set<string>,
    values: Iterable<string>,
    label: string,
) {
    for (const value of values) {
        if (seen.has(value)) {
            throw new Error(`Duplicate ${label}: ${value}`);
        }
        seen.add(value);
    }
}

function mergePlatformDescriptors(
    supplements: readonly IPlatformApiDescriptor[],
    features: readonly IMigratedPlatformFeature[],
): IPlatformApiDescriptor {
    const capabilities = new Map<string, IPlatformCapabilityDescriptor>();
    const methods: IPlatformMethodDescriptor[] = [];
    const methodPaths = new Set<string>();
    for (const supplement of supplements) {
        for (const descriptor of supplement.capabilities) {
            capabilities.set(descriptor.path.join('.'), descriptor);
        }
        addUniquePlatformValues(
            methodPaths,
            supplement.methods.map(descriptor => descriptor.path.join('.')),
            'platform method path',
        );
        methods.push(...supplement.methods);
    }
    const channels = new Set<string>();
    for (const feature of features) {
        for (const descriptor of feature.platformDescriptors.capabilities) {
            const path = descriptor.path.join('.');
            const existing = capabilities.get(path);
            if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
                throw new Error(`Conflicting platform capability path: ${path}`);
            }
            capabilities.set(path, descriptor);
        }
        addUniquePlatformValues(
            methodPaths,
            feature.platformDescriptors.methods.map(({path}) => path.join('.')),
            'platform method path',
        );
        addUniquePlatformValues(channels, new Set([
            ...Object.values(feature.invokeChannels),
            ...Object.values(feature.eventChannels),
        ]), 'migrated platform channel');
        methods.push(...feature.platformDescriptors.methods);
    }
    return {
        capabilities: [...capabilities.values()],
        methods,
    };
}

export const PLATFORM_API_DESCRIPTOR = mergePlatformDescriptors(
    [LEGACY_PLATFORM_API_DESCRIPTOR_WITHOUT_MIGRATED_FEATURES],
    PLATFORM_FEATURE_REGISTRY,
);

export function getPlatformMethodDescriptor(path: readonly string[]) {
    const formattedPath = path.join('.');
    return PLATFORM_API_DESCRIPTOR.methods.find(descriptor => descriptor.path.join('.') === formattedPath);
}
