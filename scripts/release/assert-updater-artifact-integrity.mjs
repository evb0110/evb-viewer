import {createHash} from 'node:crypto';
import {closeSync, openSync, readSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {getUpdaterMetadataFileNames} from './policy.mjs';

const HASH_BUFFER_BYTES = 1024 * 1024;

/** @typedef {{url: string, sha512?: string | undefined, size?: number | undefined}} IUpdaterArtifactEntry */
/** @typedef {{artifactNames: string[], artifactsDir: string, readArtifactInfo?: ((artifactName: string) => {sha512: string, size: number}) | undefined, readMetadataText: (metadataFileName: string) => string}} IUpdaterArtifactIntegrityOptions */

/** @param {string} path */
export function calculateArtifactSha512(path) {
    const descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    const hash = createHash('sha512');
    try {
        let bytesRead = 0;
        do {
            bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
            if (bytesRead > 0) {
                hash.update(buffer.subarray(0, bytesRead));
            }
        } while (bytesRead > 0);
    } finally {
        closeSync(descriptor);
    }
    return hash.digest('base64');
}

/** @param {string} metadataFileName @param {string} metadataText */
function readMetadataEntries(metadataFileName, metadataText) {
    /** @type {IUpdaterArtifactEntry[]} */
    const entries = [];
    /** @type {IUpdaterArtifactEntry | null} */
    let current = null;
    /** @type {string | undefined} */
    let topLevelPath;
    /** @type {string | undefined} */
    let topLevelSha512;
    /** @type {number | undefined} */
    let topLevelSize;
    for (const line of metadataText.split(/\r?\n/u)) {
        const url = line.match(/^\s*-\s+url:\s*(.+?)\s*$/u)?.[1];
        if (url !== undefined) {
            current = {url: url.replace(/^['"]|['"]$/gu, '')};
            entries.push(current);
            continue;
        }
        const nestedSha512 = line.match(/^\s{4,}sha512:\s*(\S+)\s*$/u)?.[1];
        if (nestedSha512 !== undefined && current) {
            current.sha512 = nestedSha512;
            continue;
        }
        const nestedSize = line.match(/^\s{4,}size:\s*(\d+)\s*$/u)?.[1];
        if (nestedSize !== undefined && current) {
            current.size = Number(nestedSize);
            continue;
        }
        topLevelPath ??= line.match(/^path:\s*(.+?)\s*$/u)?.[1]?.replace(/^['"]|['"]$/gu, '');
        topLevelSha512 ??= line.match(/^sha512:\s*(\S+)\s*$/u)?.[1];
        const size = line.match(/^size:\s*(\d+)\s*$/u)?.[1];
        topLevelSize ??= size === undefined ? undefined : Number(size);
    }
    const topLevelEntry =
        topLevelPath === undefined
            ? null
            : {
                  sha512: topLevelSha512,
                  size: topLevelSize,
                  url: topLevelPath,
              };
    if (entries.length === 0 && topLevelEntry) {
        entries.push(topLevelEntry);
    }
    if (entries.length === 0) {
        throw new Error(`Updater metadata has no artifact entries: ${metadataFileName}`);
    }
    return {
        entries,
        topLevelEntry,
    };
}

/** @param {IUpdaterArtifactIntegrityOptions} options */
export function assertUpdaterArtifactIntegrity({artifactNames, artifactsDir, readArtifactInfo, readMetadataText}) {
    for (const metadataFileName of getUpdaterMetadataFileNames(artifactNames)) {
        const {entries, topLevelEntry} = readMetadataEntries(metadataFileName, readMetadataText(metadataFileName));
        if (topLevelEntry) {
            const matchingEntry = entries.find((entry) => entry.url === topLevelEntry.url);
            if (
                !matchingEntry ||
                matchingEntry.sha512 !== topLevelEntry.sha512 ||
                (topLevelEntry.size !== undefined && matchingEntry.size !== topLevelEntry.size)
            ) {
                throw new Error(`Updater top-level artifact metadata is inconsistent with files[] in ${metadataFileName}`);
            }
        }
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string' || typeof entry.sha512 !== 'string') {
                throw new Error(`Invalid updater artifact entry in ${metadataFileName}`);
            }
            const info = readArtifactInfo
                ? readArtifactInfo(entry.url)
                : {
                      sha512: calculateArtifactSha512(resolve(artifactsDir, entry.url)),
                      size: statSync(resolve(artifactsDir, entry.url)).size,
                  };
            if (info.sha512 !== entry.sha512) {
                throw new Error(`Updater SHA-512 mismatch in ${metadataFileName} for ${entry.url}`);
            }
            if (entry.size !== undefined && Number(entry.size) !== info.size) {
                throw new Error(`Updater size mismatch in ${metadataFileName} for ${entry.url}: expected ${entry.size}, got ${info.size}`);
            }
        }
    }
}
