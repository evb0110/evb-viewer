import path from 'node:path';
import {
    GENERATED_RUST_NATIVE_TOOL_PROTOCOLS,
    type IGeneratedRustNativeToolCapability,
    type IGeneratedRustNativeToolProtocol,
} from '@contracts/nativeToolProtocols';
import { BUNDLED_OCR_LANGUAGE_CODES } from '@contracts/ocrLanguages';

export const NATIVE_RESOURCE_PLATFORMS = [
    'darwin',
    'linux',
    'win32',
] as const;

export const NATIVE_RESOURCE_ARCHES = [
    'x64',
    'arm64',
] as const;

export const ELECTRON_BUILDER_PLATFORM_KEYS = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
} as const satisfies Record<TNativeResourcePlatform, string>;

export type TNativeResourcePlatform = typeof NATIVE_RESOURCE_PLATFORMS[number];
export type TNativeResourceArch = typeof NATIVE_RESOURCE_ARCHES[number];
export type TNativeResourcePlatformArch = `${TNativeResourcePlatform}-${TNativeResourceArch}`;
export type TNativeResourcePathType = 'directory' | 'file';

export const NATIVE_TOOL_RESOURCE_FAMILY_IDS = [
    'tesseract',
    'poppler',
    'qpdf',
    'djvulibre',
    'pdf-image-combine',
    'pdf-page-ops',
    'pdf-print-dialog',
    'pdf-search',
    'scan-cleanup',
] as const;

export type TNativeToolResourceFamilyId = typeof NATIVE_TOOL_RESOURCE_FAMILY_IDS[number];
export type TGeneratedNativeToolResourceFamilyId = Extract<
    TNativeToolResourceFamilyId,
    'pdf-image-combine' | 'pdf-page-ops' | 'pdf-search' | 'scan-cleanup'
>;

export interface INativeResourceTarget {
    arch: TNativeResourceArch;
    exeSuffix: '' | '.exe';
    platform: TNativeResourcePlatform;
    platformArch: TNativeResourcePlatformArch;
}

export interface INativeToolResourceFamily {
    id: TNativeToolResourceFamilyId;
    label: string;
    packagedEntries: readonly IPackagedNativeResourceEntry[];
    packageFiltersByPlatform?: Partial<Record<TNativeResourcePlatform, readonly string[]>>;
    sourceRootSegments: readonly string[];
    stagedRootSegments: readonly string[];
}

export interface IPackagedNativeResourceEntry {
    id: string;
    label: string;
    pathSegments: readonly string[];
    platforms?: readonly TNativeResourcePlatform[];
    skip?: Partial<Record<TNativeResourcePlatform, string>>;
    type: TNativeResourcePathType;
}

export interface IGlobalPackagedResource {
    filters?: readonly string[];
    id: string;
    label: string;
    sourceSegments: readonly string[];
    stagedSegments: readonly string[];
    type: TNativeResourcePathType;
}

export interface IGeneratedNativeToolResource {
    binaryName: string;
    crateName: string;
    familyId: TGeneratedNativeToolResourceFamilyId;
    stagingName: string;
}

export type TNativeSourceMatrixCheckEntry =
    | {
        kind: 'required';
        label: string;
        path: string;
        type: TNativeResourcePathType;
    }
    | {
        kind: 'skip';
        label: string;
        reason: string;
    };

export const NATIVE_RESOURCE_PLATFORM_ARCHES = [
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
    'win32-x64',
    'win32-arm64',
] as const satisfies readonly TNativeResourcePlatformArch[];

const GENERATED_NATIVE_TOOL_FAMILY_LABELS: Record<TGeneratedNativeToolResourceFamilyId, string> = {
    'pdf-image-combine': 'PDF image combine native tool',
    'pdf-page-ops': 'PDF page ops native tool',
    'pdf-search': 'PDF search native tool',
    'scan-cleanup': 'Scan cleanup native tool',
};

function packagedBinary(
    id: string,
    platforms?: readonly TNativeResourcePlatform[],
    skip?: Partial<Record<TNativeResourcePlatform, string>>,
): IPackagedNativeResourceEntry {
    return {
        id,
        label: `${id} binary`,
        pathSegments: [
            'bin',
            `${id}{exeSuffix}`,
        ],
        ...(platforms ? {platforms} : {}),
        ...(skip ? {skip} : {}),
        type: 'file',
    };
}

function packagedPath(
    id: string,
    label: string,
    type: TNativeResourcePathType,
    platforms: readonly TNativeResourcePlatform[],
    ...pathSegments: string[]
): IPackagedNativeResourceEntry {
    return {
        id,
        label,
        pathSegments,
        platforms,
        type,
    };
}

export const NATIVE_TOOL_RESOURCE_FAMILIES: readonly INativeToolResourceFamily[] = [
    {
        id: 'tesseract',
        label: 'Tesseract native tools',
        packagedEntries: [
            packagedBinary('tesseract'),
            packagedBinary('unpaper', [
                'darwin',
                'linux',
            ], {win32: 'not bundled on Windows'}),
        ],
        sourceRootSegments: [
            'resources',
            'tesseract',
        ],
        stagedRootSegments: ['tesseract'],
    },
    {
        id: 'poppler',
        label: 'Poppler native tools',
        packagedEntries: [
            ...[
                'pdfinfo',
                'pdftoppm',
                'pdftotext',
            ].map(binary => packagedBinary(binary)),
            packagedBinary('pdftocairo', ['win32']),
            packagedPath(
                'poppler-data',
                'poppler data directory',
                'directory',
                [
                    'linux',
                    'win32',
                ],
                'share',
                'poppler',
            ),
            packagedPath(
                'fontconfig-directory',
                'fontconfig directory',
                'directory',
                ['linux'],
                'etc',
                'fonts',
            ),
            packagedPath(
                'fontconfig-configuration',
                'fontconfig configuration',
                'file',
                ['linux'],
                'etc',
                'fonts',
                'fonts.conf',
            ),
        ],
        packageFiltersByPlatform: {win32: [
            '**/*',
            '!share/poppler/CMakeLists.txt',
            '!share/poppler/Makefile',
            '!share/poppler/README',
            '!share/poppler/poppler-data.pc',
            '!share/poppler/poppler-data.pc.in',
        ]},
        sourceRootSegments: [
            'resources',
            'poppler',
        ],
        stagedRootSegments: ['poppler'],
    },
    {
        id: 'qpdf',
        label: 'qpdf native tools',
        packagedEntries: [packagedBinary('qpdf')],
        sourceRootSegments: [
            'resources',
            'qpdf',
        ],
        stagedRootSegments: ['qpdf'],
    },
    {
        id: 'djvulibre',
        label: 'DjVuLibre native tools',
        packagedEntries: [
            'ddjvu',
            'djvused',
            'djvudump',
        ].map(binary => packagedBinary(binary)),
        sourceRootSegments: [
            'resources',
            'djvulibre',
        ],
        stagedRootSegments: ['djvulibre'],
    },
    {
        id: 'pdf-print-dialog',
        label: 'macOS PDF print dialog helper',
        packagedEntries: [packagedBinary('pdf-print-dialog', ['darwin'])],
        sourceRootSegments: [
            '.tmp',
            'pdf-print-dialog',
        ],
        stagedRootSegments: ['pdf-print-dialog'],
    },
    ...GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.map(tool => ({
        id: tool.resourceFamilyId,
        label: GENERATED_NATIVE_TOOL_FAMILY_LABELS[tool.resourceFamilyId],
        packagedEntries: [packagedBinary(tool.binaryName)],
        sourceRootSegments: [
            '.tmp',
            tool.stagingName,
        ],
        stagedRootSegments: [tool.stagingName],
    })),
] as const;

export const GLOBAL_PACKAGED_RESOURCES: readonly IGlobalPackagedResource[] = [
    {
        filters: BUNDLED_OCR_LANGUAGE_CODES.map(code => `${code}.traineddata`),
        id: 'tessdata',
        label: 'tessdata directory',
        sourceSegments: [
            'resources',
            'tesseract',
            'tessdata',
        ],
        stagedSegments: [
            'tesseract',
            'tessdata',
        ],
        type: 'directory',
    },
    {
        id: 'application-resource-icon',
        label: 'application resource icon',
        sourceSegments: [
            'resources',
            'icon.png',
        ],
        stagedSegments: ['icon.png'],
        type: 'file',
    },
    {
        id: 'third-party-notices',
        label: 'third-party license notices',
        sourceSegments: [
            'resources',
            'third-party-notices',
        ],
        stagedSegments: ['third-party-notices'],
        type: 'directory',
    },
] as const;

export const GENERATED_NATIVE_TOOL_RESOURCES = GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.map(tool => ({
    binaryName: tool.binaryName,
    crateName: tool.crateName,
    familyId: tool.resourceFamilyId,
    stagingName: tool.stagingName,
})) satisfies readonly IGeneratedNativeToolResource[];

export function getGeneratedNativeToolResource(toolId: string) {
    const resource = GENERATED_NATIVE_TOOL_RESOURCES.find(tool => tool.familyId === toolId);
    if (!resource) {
        throw new Error(`Unknown generated native tool: ${toolId}`);
    }
    return resource;
}

export function getPackagedNativeToolFamilies() {
    return NATIVE_TOOL_RESOURCE_FAMILIES.map((family) => {
        const generated = GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.find(
            (tool: IGeneratedRustNativeToolProtocol) => tool.resourceFamilyId === family.id,
        );
        return {
            binaryName: generated?.binaryName ?? null,
            id: family.id,
            label: family.label,
            packagedEntries: family.packagedEntries,
            ...('packageFiltersByPlatform' in family
                ? {packageFiltersByPlatform: family.packageFiltersByPlatform}
                : {}),
            protocolCapabilities: generated && 'capabilities' in generated
                ? generated.capabilities.map((capability: IGeneratedRustNativeToolCapability) => capability.name)
                : null,
            protocolVersion: generated?.protocolVersion ?? null,
            sourceRootSegments: family.sourceRootSegments,
            stagedRootSegments: family.stagedRootSegments,
        };
    });
}

export function isNativeResourcePlatform(value: string): value is TNativeResourcePlatform {
    return (NATIVE_RESOURCE_PLATFORMS as readonly string[]).includes(value);
}

export function isNativeResourceArch(value: string): value is TNativeResourceArch {
    return (NATIVE_RESOURCE_ARCHES as readonly string[]).includes(value);
}

export function getNativeExecutableSuffix(platform: TNativeResourcePlatform) {
    return platform === 'win32' ? '.exe' : '';
}

export function parseNativeResourcePlatformArch(tag: string): INativeResourceTarget {
    const segments = tag.split('-');
    const platform = segments[0];
    const arch = segments[1];

    if (segments.length !== 2 || !platform || !arch) {
        throw new Error(`Unsupported native resource platform/arch tag: ${tag}`);
    }
    if (!isNativeResourcePlatform(platform)) {
        throw new Error(`Unsupported native resource platform in tag: ${tag}`);
    }
    if (!isNativeResourceArch(arch)) {
        throw new Error(`Unsupported native resource architecture in tag: ${tag}`);
    }

    return {
        arch,
        exeSuffix: getNativeExecutableSuffix(platform),
        platform,
        platformArch: `${platform}-${arch}`,
    };
}

export function getNativeSourceMatrixCheckEntries(tag: string): TNativeSourceMatrixCheckEntry[] {
    const target = parseNativeResourcePlatformArch(tag);
    return NATIVE_TOOL_RESOURCE_FAMILIES.flatMap(family => (
        family.packagedEntries.flatMap((entry): TNativeSourceMatrixCheckEntry[] => {
            const skipReason = entry.skip?.[target.platform];
            if (skipReason) {
                return [{
                    kind: 'skip',
                    label: entry.id,
                    reason: skipReason,
                }];
            }
            if (entry.platforms && !entry.platforms.includes(target.platform)) {
                return [];
            }
            const relativePath = entry.pathSegments
                .map(segment => segment.replaceAll('{exeSuffix}', target.exeSuffix));
            return [{
                kind: 'required',
                label: entry.label.endsWith(' binary') ? entry.id : entry.label,
                path: path.posix.join(
                    ...family.sourceRootSegments,
                    target.platformArch,
                    ...relativePath,
                ),
                type: entry.type,
            }];
        })
    ));
}
