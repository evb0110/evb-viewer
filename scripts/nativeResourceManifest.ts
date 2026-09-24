import path from 'node:path';
import { BUNDLED_OCR_LANGUAGE_CODES } from '@contracts/ocrLanguages';
import {TESSERACT_PDF_FONT_FILE_NAME} from '@scripts/tesseractPdfFont';

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
    type: TNativeResourcePathType;
}

export interface IGlobalPackagedResource {
    filters?: readonly string[];
    id: string;
    label: string;
    requiredFiles?: readonly string[];
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

export interface INativeSourceMatrixCheckEntry {
    kind: 'required';
    label: string;
    path: string;
    type: TNativeResourcePathType;
}

export const NATIVE_RESOURCE_PLATFORM_ARCHES = [
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
    'win32-x64',
    'win32-arm64',
] as const satisfies readonly TNativeResourcePlatformArch[];

const NATIVE_TOOLS = [
    {
        crateName: 'pdf-image-combine',
        label: 'PDF image combine native tool',
    },
    {
        crateName: 'pdf-page-ops',
        label: 'PDF page ops native tool',
    },
    {
        crateName: 'pdf-search',
        label: 'PDF search native tool',
    },
    {
        crateName: 'scan-cleanup',
        label: 'Scan cleanup native tool',
    },
] as const satisfies ReadonlyArray<{
    crateName: TGeneratedNativeToolResourceFamilyId;
    label: string
}>;

function packagedBinary(
    id: string,
    platforms?: readonly TNativeResourcePlatform[],
): IPackagedNativeResourceEntry {
    return {
        id,
        label: `${id} binary`,
        pathSegments: [
            'bin',
            `${id}{exeSuffix}`,
        ],
        ...(platforms ? {platforms} : {}),
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
        packagedEntries: [packagedBinary('tesseract')],
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
    ...NATIVE_TOOLS.map(tool => ({
        id: tool.crateName,
        label: tool.label,
        packagedEntries: [packagedBinary(`evb-${tool.crateName}`)],
        sourceRootSegments: [
            '.tmp',
            tool.crateName,
        ],
        stagedRootSegments: [tool.crateName],
    })),
] as const;

export const GLOBAL_PACKAGED_RESOURCES: readonly IGlobalPackagedResource[] = [
    {
        filters: BUNDLED_OCR_LANGUAGE_CODES.map(code => `${code}.traineddata`),
        id: 'tessdata',
        label: 'tessdata directory',
        requiredFiles: [TESSERACT_PDF_FONT_FILE_NAME],
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

export const GENERATED_NATIVE_TOOL_RESOURCES = NATIVE_TOOLS.map(tool => ({
    binaryName: `evb-${tool.crateName}`,
    crateName: tool.crateName,
    familyId: tool.crateName,
    stagingName: tool.crateName,
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
        const generated = GENERATED_NATIVE_TOOL_RESOURCES.find(tool => tool.familyId === family.id);
        return {
            binaryName: generated?.binaryName ?? null,
            id: family.id,
            label: family.label,
            packagedEntries: family.packagedEntries,
            ...('packageFiltersByPlatform' in family
                ? {packageFiltersByPlatform: family.packageFiltersByPlatform}
                : {}),
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

export function getNativeSourceMatrixCheckEntries(tag: string): INativeSourceMatrixCheckEntry[] {
    const target = parseNativeResourcePlatformArch(tag);
    return NATIVE_TOOL_RESOURCE_FAMILIES.flatMap(family => (
        family.packagedEntries.flatMap((entry): INativeSourceMatrixCheckEntry[] => {
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
