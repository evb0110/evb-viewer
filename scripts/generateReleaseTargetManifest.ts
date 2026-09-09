import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ELECTRON_BUILDER_PLATFORM_KEYS,
    GLOBAL_PACKAGED_RESOURCES,
    getPackagedNativeToolFamilies,
    NATIVE_RESOURCE_PLATFORM_ARCHES,
} from '@scripts/nativeResourceManifest';
import { writeGeneratedFileIfChanged } from '@scripts/writeGeneratedFileIfChanged';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedRelativePath = 'scripts/release/generated-release-targets.cjs';

export const PACKAGED_ENTRY_FIELD_SEPARATOR = '\u001f';

export function createReleaseTargetManifest() {
    const families = getPackagedNativeToolFamilies();
    return {
        electronBuilderPlatformKeys: ELECTRON_BUILDER_PLATFORM_KEYS,
        families,
        globalResources: GLOBAL_PACKAGED_RESOURCES,
        platformArches: NATIVE_RESOURCE_PLATFORM_ARCHES,
        schemaVersion: 1,
        signing: {
            entitlementsPathSegments: [
                'build',
                'entitlements.mac.plist',
            ],
            executableRoots: families.map(family => family.stagedRootSegments),
            platforms: ['darwin'],
        },
    };
}

export function renderReleaseTargetManifest() {
    const serializedManifest = JSON.stringify(createReleaseTargetManifest(), null, 4);
    return `'use strict'; /* eslint-disable @stylistic/array-bracket-newline, @stylistic/array-element-newline, @stylistic/object-curly-newline, @stylistic/object-property-newline, @stylistic/indent */
/** @type {TManifest} */
const manifest = JSON.parse(String.raw\`${serializedManifest}\`);
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
    return isStringList(item) && item.every(part => !['.', '..'].includes(part) && !/[\\\\/:]/u.test(part));
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
    if (!manifest.platformArches.includes(tag)) throw new Error(\`[release manifest] Unsupported platform-arch: \${tag}\`);
    const suffix = platform === 'win32' ? '.exe' : '';
    return [
        ...manifest.families.flatMap(family => family.packagedEntries
        .filter(entry => !entry.skip?.[platform] && (!entry.platforms || entry.platforms.includes(platform)))
        .map(entry => ['native', family.stagedRootSegments.join('/'), entry.pathSegments.join('/').replaceAll('{exeSuffix}', suffix), entry.type, entry.label, entry.id].join('\\u001f'))),
        ...manifest.globalResources.map(resource => ['global', '', resource.stagedSegments.join('/'), resource.type, resource.label, resource.id].join('\\u001f')),
    ].join('\\n');
}
module.exports = {manifest: assertManifest(manifest), renderPackagedEntries, validateReleaseTargetManifest: assertManifest};
`;
}

export async function generateReleaseTargetManifest({projectRoot: targetRoot = projectRoot}: { projectRoot?: string } = {}) {
    return writeGeneratedFileIfChanged(
        path.join(targetRoot, generatedRelativePath),
        renderReleaseTargetManifest(),
    );
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun && await generateReleaseTargetManifest()) {
    console.info('Generated release target manifest.');
}
