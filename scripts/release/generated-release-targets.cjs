'use strict'; /* eslint-disable @stylistic/array-bracket-newline, @stylistic/array-element-newline, @stylistic/object-curly-newline, @stylistic/object-property-newline, @stylistic/indent */
/** @type {TManifest} */
const manifest = JSON.parse(String.raw`{
    "electronBuilderPlatformKeys": {
        "darwin": "mac",
        "linux": "linux",
        "win32": "win"
    },
    "families": [
        {
            "binaryName": null,
            "id": "tesseract",
            "label": "Tesseract native tools",
            "packagedEntries": [
                {
                    "id": "tesseract",
                    "label": "tesseract binary",
                    "pathSegments": [
                        "bin",
                        "tesseract{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "unpaper",
                    "label": "unpaper binary",
                    "pathSegments": [
                        "bin",
                        "unpaper{exeSuffix}"
                    ],
                    "platforms": [
                        "darwin",
                        "linux"
                    ],
                    "skip": {
                        "win32": "not bundled on Windows"
                    },
                    "type": "file"
                }
            ],
            "protocolCapabilities": null,
            "protocolVersion": null,
            "sourceRootSegments": [
                "resources",
                "tesseract"
            ],
            "stagedRootSegments": [
                "tesseract"
            ]
        },
        {
            "binaryName": null,
            "id": "poppler",
            "label": "Poppler native tools",
            "packagedEntries": [
                {
                    "id": "pdfinfo",
                    "label": "pdfinfo binary",
                    "pathSegments": [
                        "bin",
                        "pdfinfo{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "pdftoppm",
                    "label": "pdftoppm binary",
                    "pathSegments": [
                        "bin",
                        "pdftoppm{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "pdftotext",
                    "label": "pdftotext binary",
                    "pathSegments": [
                        "bin",
                        "pdftotext{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "pdftocairo",
                    "label": "pdftocairo binary",
                    "pathSegments": [
                        "bin",
                        "pdftocairo{exeSuffix}"
                    ],
                    "platforms": [
                        "win32"
                    ],
                    "type": "file"
                },
                {
                    "id": "poppler-data",
                    "label": "poppler data directory",
                    "pathSegments": [
                        "share",
                        "poppler"
                    ],
                    "platforms": [
                        "linux",
                        "win32"
                    ],
                    "type": "directory"
                },
                {
                    "id": "fontconfig-directory",
                    "label": "fontconfig directory",
                    "pathSegments": [
                        "etc",
                        "fonts"
                    ],
                    "platforms": [
                        "linux"
                    ],
                    "type": "directory"
                },
                {
                    "id": "fontconfig-configuration",
                    "label": "fontconfig configuration",
                    "pathSegments": [
                        "etc",
                        "fonts",
                        "fonts.conf"
                    ],
                    "platforms": [
                        "linux"
                    ],
                    "type": "file"
                }
            ],
            "packageFiltersByPlatform": {
                "win32": [
                    "**/*",
                    "!share/poppler/CMakeLists.txt",
                    "!share/poppler/Makefile",
                    "!share/poppler/README",
                    "!share/poppler/poppler-data.pc",
                    "!share/poppler/poppler-data.pc.in"
                ]
            },
            "protocolCapabilities": null,
            "protocolVersion": null,
            "sourceRootSegments": [
                "resources",
                "poppler"
            ],
            "stagedRootSegments": [
                "poppler"
            ]
        },
        {
            "binaryName": null,
            "id": "qpdf",
            "label": "qpdf native tools",
            "packagedEntries": [
                {
                    "id": "qpdf",
                    "label": "qpdf binary",
                    "pathSegments": [
                        "bin",
                        "qpdf{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolCapabilities": null,
            "protocolVersion": null,
            "sourceRootSegments": [
                "resources",
                "qpdf"
            ],
            "stagedRootSegments": [
                "qpdf"
            ]
        },
        {
            "binaryName": null,
            "id": "djvulibre",
            "label": "DjVuLibre native tools",
            "packagedEntries": [
                {
                    "id": "ddjvu",
                    "label": "ddjvu binary",
                    "pathSegments": [
                        "bin",
                        "ddjvu{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "djvused",
                    "label": "djvused binary",
                    "pathSegments": [
                        "bin",
                        "djvused{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "djvudump",
                    "label": "djvudump binary",
                    "pathSegments": [
                        "bin",
                        "djvudump{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolCapabilities": null,
            "protocolVersion": null,
            "sourceRootSegments": [
                "resources",
                "djvulibre"
            ],
            "stagedRootSegments": [
                "djvulibre"
            ]
        },
        {
            "binaryName": null,
            "id": "pdf-print-dialog",
            "label": "macOS PDF print dialog helper",
            "packagedEntries": [
                {
                    "id": "pdf-print-dialog",
                    "label": "pdf-print-dialog binary",
                    "pathSegments": [
                        "bin",
                        "pdf-print-dialog{exeSuffix}"
                    ],
                    "platforms": [
                        "darwin"
                    ],
                    "type": "file"
                }
            ],
            "protocolCapabilities": null,
            "protocolVersion": null,
            "sourceRootSegments": [
                ".tmp",
                "pdf-print-dialog"
            ],
            "stagedRootSegments": [
                "pdf-print-dialog"
            ]
        },
        {
            "binaryName": "evb-pdf-image-combine",
            "id": "pdf-image-combine",
            "label": "PDF image combine native tool",
            "packagedEntries": [
                {
                    "id": "evb-pdf-image-combine",
                    "label": "evb-pdf-image-combine binary",
                    "pathSegments": [
                        "bin",
                        "evb-pdf-image-combine{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolCapabilities": null,
            "protocolVersion": 4,
            "sourceRootSegments": [
                ".tmp",
                "pdf-image-combine"
            ],
            "stagedRootSegments": [
                "pdf-image-combine"
            ]
        },
        {
            "binaryName": "evb-pdf-page-ops",
            "id": "pdf-page-ops",
            "label": "PDF page ops native tool",
            "packagedEntries": [
                {
                    "id": "evb-pdf-page-ops",
                    "label": "evb-pdf-page-ops binary",
                    "pathSegments": [
                        "bin",
                        "evb-pdf-page-ops{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolCapabilities": null,
            "protocolVersion": 1,
            "sourceRootSegments": [
                ".tmp",
                "pdf-page-ops"
            ],
            "stagedRootSegments": [
                "pdf-page-ops"
            ]
        },
        {
            "binaryName": "evb-pdf-search",
            "id": "pdf-search",
            "label": "PDF search native tool",
            "packagedEntries": [
                {
                    "id": "evb-pdf-search",
                    "label": "evb-pdf-search binary",
                    "pathSegments": [
                        "bin",
                        "evb-pdf-search{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolCapabilities": null,
            "protocolVersion": 1,
            "sourceRootSegments": [
                ".tmp",
                "pdf-search"
            ],
            "stagedRootSegments": [
                "pdf-search"
            ]
        },
        {
            "binaryName": "evb-scan-cleanup",
            "id": "scan-cleanup",
            "label": "Scan cleanup native tool",
            "packagedEntries": [
                {
                    "id": "evb-scan-cleanup",
                    "label": "evb-scan-cleanup binary",
                    "pathSegments": [
                        "bin",
                        "evb-scan-cleanup{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolCapabilities": [
                "manifest-v3",
                "structured-warning-events"
            ],
            "protocolVersion": 10,
            "sourceRootSegments": [
                ".tmp",
                "scan-cleanup"
            ],
            "stagedRootSegments": [
                "scan-cleanup"
            ]
        }
    ],
    "globalResources": [
        {
            "filters": [
                "eng.traineddata",
                "rus.traineddata"
            ],
            "id": "tessdata",
            "label": "tessdata directory",
            "sourceSegments": [
                "resources",
                "tesseract",
                "tessdata"
            ],
            "stagedSegments": [
                "tesseract",
                "tessdata"
            ],
            "type": "directory"
        },
        {
            "id": "application-resource-icon",
            "label": "application resource icon",
            "sourceSegments": [
                "resources",
                "icon.png"
            ],
            "stagedSegments": [
                "icon.png"
            ],
            "type": "file"
        },
        {
            "id": "third-party-notices",
            "label": "third-party license notices",
            "sourceSegments": [
                "resources",
                "third-party-notices"
            ],
            "stagedSegments": [
                "third-party-notices"
            ],
            "type": "directory"
        }
    ],
    "platformArches": [
        "darwin-x64",
        "darwin-arm64",
        "linux-x64",
        "linux-arm64",
        "win32-x64",
        "win32-arm64"
    ],
    "schemaVersion": 1,
    "signing": {
        "entitlementsPathSegments": [
            "build",
            "entitlements.mac.plist"
        ],
        "executableRoots": [
            [
                "tesseract"
            ],
            [
                "poppler"
            ],
            [
                "qpdf"
            ],
            [
                "djvulibre"
            ],
            [
                "pdf-print-dialog"
            ],
            [
                "pdf-image-combine"
            ],
            [
                "pdf-page-ops"
            ],
            [
                "pdf-search"
            ],
            [
                "scan-cleanup"
            ]
        ],
        "platforms": [
            "darwin"
        ]
    }
}`);
/** @typedef {{id: string, label: string, pathSegments: string[], platforms?: string[], skip?: Record<string, string>, type: string}} TPackagedEntry */
/** @typedef {{binaryName: string | null, id: string, label: string, packagedEntries: TPackagedEntry[], packageFiltersByPlatform?: Record<string, string[]>, protocolCapabilities: string[] | null, protocolVersion: number | null, sourceRootSegments: string[], stagedRootSegments: string[]}} TFamily */
/** @typedef {{filters?: string[], id: string, label: string, sourceSegments: string[], stagedSegments: string[], type: string}} TGlobalResource */
/** @typedef {{entitlementsPathSegments: string[], executableRoots: unknown[][], platforms: string[]}} TSigning */
/** @typedef {{electronBuilderPlatformKeys: Record<string, string>, families: TFamily[], globalResources: TGlobalResource[], platformArches: string[], schemaVersion: number, signing: TSigning}} TManifest */

/** @param {unknown} item @returns {item is Record<string, unknown>} */
function isRecord(item) {
    return item !== null && typeof item === 'object' && !Array.isArray(item);
}

/** @param {unknown} item @returns {item is string} */
function isNonEmptyString(item) {
    return typeof item === 'string' && item.length > 0;
}

/** @param {unknown} item @returns {item is string[]} */
function isStringList(item) {
    return Array.isArray(item) && item.length > 0 && item.every(isNonEmptyString);
}

/** @param {unknown} item @returns {item is string[]} */
function isPathList(item) {
    return isStringList(item) && item.every(part => !['.', '..'].includes(part) && !/[\\/:]/u.test(part));
}

/** @param {unknown} item @returns {item is 'directory' | 'file'} */
function isResourceType(item) {
    return item === 'directory' || item === 'file';
}

/** @param {TManifest} value @returns {TManifest} */
function assertManifest(value) {
    const record = isRecord, string = isNonEmptyString;
    const strings = isStringList;
    const paths = isPathList;
    const resourceType = isResourceType, platforms = new Set(['darwin', 'linux', 'win32']), platformArches = new Set(['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']);
    /** @param {unknown} item @param {Set<string>} allowed @returns {boolean} */
    const allowedList = (item, allowed) => strings(item) && new Set(item).size === item.length && item.every(part => allowed.has(part)), builderKeys = {darwin: 'mac', linux: 'linux', win32: 'win'};
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.families) || value.families.length === 0) throw new Error('[release manifest] Invalid root'); if (!allowedList(value.platformArches, platformArches) || value.platformArches.length !== platformArches.size) throw new Error('[release manifest] Invalid platformArches');
    if (!record(value.electronBuilderPlatformKeys) || Object.keys(value.electronBuilderPlatformKeys).length !== platforms.size || Object.entries(builderKeys).some(([platform, key]) => value.electronBuilderPlatformKeys[platform] !== key)) throw new Error('[release manifest] Invalid electronBuilderPlatformKeys');
    const familyIds = new Set(), entryIds = new Set(), familyRoots = new Set(); for (const family of value.families) {
        if (!record(family) || !string(family.id) || !string(family.label) || familyIds.has(family.id) || !paths(family.sourceRootSegments) || !paths(family.stagedRootSegments) || familyRoots.has(family.stagedRootSegments.join('/')) || !Array.isArray(family.packagedEntries) || family.packagedEntries.length === 0) throw new Error('[release manifest] Invalid family'); familyIds.add(family.id); familyRoots.add(family.stagedRootSegments.join('/'));
        const hasBinary = string(family.binaryName); const protocolVersion = family.protocolVersion; const protocolCapabilities = family.protocolCapabilities; if (!(family.binaryName === null || hasBinary) || (hasBinary ? typeof protocolVersion !== 'number' || !Number.isSafeInteger(protocolVersion) || protocolVersion < 1 : protocolVersion !== null) || !(protocolCapabilities === null || strings(protocolCapabilities))) throw new Error('[release manifest] Invalid family protocol');
        if (family.packageFiltersByPlatform !== undefined && (!record(family.packageFiltersByPlatform) || Object.keys(family.packageFiltersByPlatform).length === 0 || Object.entries(family.packageFiltersByPlatform).some(([platform, filters]) => !platforms.has(platform) || !strings(filters)))) throw new Error('[release manifest] Invalid package filters');
        for (const entry of family.packagedEntries) {
            if (!record(entry) || !string(entry.id) || !string(entry.label) || entryIds.has(entry.id) || !paths(entry.pathSegments) || !resourceType(entry.type)) throw new Error('[release manifest] Invalid packaged entry'); entryIds.add(entry.id);
            if (entry.platforms !== undefined && !allowedList(entry.platforms, platforms)) throw new Error('[release manifest] Invalid packaged entry platforms');
            if (entry.skip !== undefined && (!record(entry.skip) || Object.keys(entry.skip).length === 0 || Object.entries(entry.skip).some(([platform, reason]) => !platforms.has(platform) || !string(reason)))) throw new Error('[release manifest] Invalid packaged entry skip');
        } }
    if (!Array.isArray(value.globalResources) || value.globalResources.length === 0) throw new Error('[release manifest] globalResources must be a non-empty array'); const globalIds = new Set();
    for (const resource of value.globalResources) {
        if (!record(resource) || !string(resource.id) || !string(resource.label) || globalIds.has(resource.id) || !paths(resource.sourceSegments) || !paths(resource.stagedSegments) || !resourceType(resource.type) || (resource.filters !== undefined && !strings(resource.filters))) throw new Error('[release manifest] Invalid global resource');
        globalIds.add(resource.id); }
    const expectedRoots = new Set(value.families.map(family => family.stagedRootSegments.join('/'))); if (!record(value.signing) || !allowedList(value.signing.platforms, platforms) || !paths(value.signing.entitlementsPathSegments) || !Array.isArray(value.signing.executableRoots) || new Set(value.signing.executableRoots.map(root => Array.isArray(root) ? root.join('/') : '')).size !== expectedRoots.size || value.signing.executableRoots.length !== expectedRoots.size || !value.signing.executableRoots.every(root => paths(root) && expectedRoots.has(root.join('/')))) throw new Error('[release manifest] Invalid signing inputs');
    return value; }
/** @param {string} tag @returns {string} */
function renderPackagedEntries(tag) { const platform = tag.slice(0, tag.lastIndexOf('-'));
    if (!manifest.platformArches.includes(tag)) throw new Error(`[release manifest] Unsupported platform-arch: ${tag}`);
    const suffix = platform === 'win32' ? '.exe' : '';
    return [
        ...manifest.families.flatMap(family => family.packagedEntries
        .filter(entry => !entry.skip?.[platform] && (!entry.platforms || entry.platforms.includes(platform)))
        .map(entry => ['native', family.stagedRootSegments.join('/'), entry.pathSegments.join('/').replaceAll('{exeSuffix}', suffix), entry.type, entry.label, entry.id].join('\u001f'))),
        ...manifest.globalResources.map(resource => ['global', '', resource.stagedSegments.join('/'), resource.type, resource.label, resource.id].join('\u001f')),
    ].join('\n');
}
module.exports = {manifest: assertManifest(manifest), renderPackagedEntries, validateReleaseTargetManifest: assertManifest};
