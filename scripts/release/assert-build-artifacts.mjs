#!/usr/bin/env node

import {
    readFileSync,
    readdirSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertPublishUpdaterMetadataPolicy,
    assertPublishUpdaterMetadataReferences,
    assertUpdaterMetadataVersion,
    expectsUpdaterMetadata,
    getRequiredArtifactPatterns,
    getUpdaterMetadataFileNames,
    parseUpdaterMetadataFileUrls,
} from './policy.mjs';
import { assertMacUpdaterMetadataHashes } from './notarize-macos-dmgs.mjs';
import { assertUpdaterArtifactIntegrity } from './assert-updater-artifact-integrity.mjs';

/** @typedef {(metadataFileName: string) => string} TMetadataReader */
/** @typedef {(artifactName: string) => {sha512: string, size: number}} TArtifactInfoReader */
/** @typedef {{arch: string, expectsUpdaterMetadata: boolean, isPrimaryHostTarget: boolean, platform: 'mac' | 'linux' | 'win'}} IReleaseTarget */
/** @typedef {{arch?: string | undefined, artifactsDir?: string, env?: NodeJS.ProcessEnv, platform?: string | undefined, readMetadataText?: TMetadataReader, readArtifactInfo?: TArtifactInfoReader, artifactNames?: string[], expectedVersion?: string}} IAssertBuildArtifactsOptions */

/** @param {string} platform @param {string} arch @returns {IReleaseTarget} */
function createBuildTarget(platform, arch) {
    if (![
        'mac',
        'linux',
        'win',
    ].includes(platform)) {
        throw new Error(`Unsupported release artifact platform "${platform}"`);
    }
    if (![
        'arm64',
        'x64',
    ].includes(arch)) {
        throw new Error(`Unsupported release artifact arch "${arch}"`);
    }

    const normalizedPlatform = /** @type {'mac' | 'linux' | 'win'} */ (platform);
    return {
        arch,
        expectsUpdaterMetadata: (
            (platform === 'mac' && arch === 'arm64')
            || platform === 'win'
        ),
        isPrimaryHostTarget: true,
        platform: normalizedPlatform,
    };
}

/** @param {IAssertBuildArtifactsOptions} [options] */
export function assertBuildArtifacts({
    arch,
    artifactsDir = 'release',
    env = process.env,
    platform,
    readMetadataText,
    readArtifactInfo,
    artifactNames,
    expectedVersion,
} = {}) {
    if (!platform || !arch) {
        throw new Error('Usage: assert-build-artifacts.mjs <artifactsDir> <platform> <arch>');
    }

    /** @param {string} metadataFileName */
    function readDefaultMetadataText(metadataFileName) {
        return readFileSync(resolve(process.cwd(), artifactsDir, metadataFileName), 'utf8');
    }

    const target = createBuildTarget(platform, arch);
    const files = [...(artifactNames ?? readdirSync(resolve(process.cwd(), artifactsDir)))];

    for (const pattern of getRequiredArtifactPatterns(target, env)) {
        if (!files.some(fileName => pattern.test(fileName))) {
            throw new Error(`Missing packaged artifact matching ${pattern} in ${artifactsDir}/`);
        }
    }

    assertPublishUpdaterMetadataPolicy(files, env);
    const hasUpdaterMetadata = assertPublishUpdaterMetadataReferences(
        files,
        readMetadataText ?? readDefaultMetadataText,
    );
    const metadataReader = readMetadataText ?? readDefaultMetadataText;
    if (platform === 'win') {
        const metadataName = `latest-win-${arch}.yml`;
        if (!files.includes(metadataName)) {
            throw new Error(`Missing updater metadata for win-${arch}: ${metadataName}`);
        }
        const urls = parseUpdaterMetadataFileUrls(metadataName, metadataReader(metadataName));
        if (urls.length !== 1 || !urls[0]?.endsWith(`-${arch}-setup.exe`)) {
            throw new Error(`Windows ${arch} updater metadata must reference its matching installer`);
        }
    }
    if (hasUpdaterMetadata) {
        const requiredVersion = expectedVersion
            ?? (artifactNames == null ? JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version : null);
        if (requiredVersion !== null) {
            assertUpdaterMetadataVersion(files, metadataReader, requiredVersion);
        }
        if (readArtifactInfo || artifactNames == null) {
            assertUpdaterArtifactIntegrity({
                artifactNames: files,
                artifactsDir: resolve(process.cwd(), artifactsDir),
                readArtifactInfo,
                readMetadataText: metadataReader,
            });
        }
    }
    const blockmaps = files.filter(fileName => fileName.endsWith('.blockmap'));
    const shouldPublishUpdaterMetadata = expectsUpdaterMetadata(target, env);

    if (shouldPublishUpdaterMetadata && !hasUpdaterMetadata) {
        throw new Error(`Missing updater metadata for ${platform}-${arch}`);
    }
    if (
        platform === 'mac'
        && shouldPublishUpdaterMetadata
        && hasUpdaterMetadata
        && (readArtifactInfo || artifactNames == null)
    ) {
        assertMacUpdaterMetadataHashes({
            artifactNames: files,
            artifactsDir,
            readArtifactInfo,
            readMetadataText: metadataReader,
        });
    }
    if (!shouldPublishUpdaterMetadata) {
        const updaterMetadata = getUpdaterMetadataFileNames(files);
        if (updaterMetadata.length > 0 || blockmaps.length > 0) {
            throw new Error(
                `Unexpected updater metadata for ${platform}-${arch}: `
                + [
                    ...updaterMetadata,
                    ...blockmaps,
                ].sort().join(', '),
            );
        }
    }

    return true;
}

const isDirectCliRun = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    assertBuildArtifacts({
        arch: process.argv[4],
        artifactsDir: process.argv[2] ?? 'release',
        platform: process.argv[3],
    });
    process.stdout.write('Release build artifact policy passed.\n');
}
