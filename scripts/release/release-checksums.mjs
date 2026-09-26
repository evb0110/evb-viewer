import {
    createHash,
    randomUUID,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    lstat,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    basename,
    join,
} from 'node:path';
import { pathToFileURL } from 'node:url';

const CHECKSUM_FILENAME = 'SHA256SUMS';
const CHECKSUM_LINE_PATTERN = /^([a-f0-9]{64}) {2}(.+)$/u;

/** @typedef {{name: string, sha256: string}} IChecksumEntry */

/** @param {string} artifactDirectory @returns {Promise<{assetNames: string[], checksumPath: string, contents: string}>} */
export async function generateReleaseChecksums(artifactDirectory) {
    const assetNames = await releaseAssetNames(artifactDirectory);
    const lines = [];
    for (const name of assetNames) {
        lines.push(`${await hashFile(join(artifactDirectory, name))}  ${name}`);
    }
    const contents = `${lines.join('\n')}\n`;
    const checksumPath = join(artifactDirectory, CHECKSUM_FILENAME);
    const temporaryPath = join(artifactDirectory, `.${CHECKSUM_FILENAME}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryPath, contents, {
            encoding: 'utf8',
            flag: 'wx',
        });
        await rename(temporaryPath, checksumPath);
    } finally {
        await rm(temporaryPath, {force: true});
    }
    return {
        assetNames,
        checksumPath,
        contents,
    };
}

/** @param {string} artifactDirectory @returns {Promise<{assetNames: string[]}>} */
export async function verifyReleaseChecksums(artifactDirectory) {
    const assetNames = await releaseAssetNames(artifactDirectory);
    const checksumPath = join(artifactDirectory, CHECKSUM_FILENAME);
    const checksumStat = await lstat(checksumPath);
    if (!checksumStat.isFile()) {
        throw new Error(`${CHECKSUM_FILENAME} must be a regular file`);
    }
    const listedAssets = parseChecksumManifest(await readFile(checksumPath, 'utf8'));
    const actualSet = new Set(assetNames);
    const listedSet = new Set(listedAssets.map(asset => asset.name));
    const missing = assetNames.filter(name => !listedSet.has(name));
    const unexpected = listedAssets.map(asset => asset.name).filter(name => !actualSet.has(name));
    if (missing.length > 0 || unexpected.length > 0) {
        throw new Error(
            `Release asset set does not match ${CHECKSUM_FILENAME}; missing: ${formatNames(missing)}; `
            + `unexpected: ${formatNames(unexpected)}`,
        );
    }
    for (const asset of listedAssets) {
        const actualSha256 = await hashFile(join(artifactDirectory, asset.name));
        if (actualSha256 !== asset.sha256) {
            throw new Error(`Checksum mismatch for release asset: ${asset.name}`);
        }
    }
    return {assetNames};
}

/** @param {string} contents @returns {IChecksumEntry[]} */
export function parseChecksumManifest(contents) {
    if (!contents.endsWith('\n') || contents.length === 1) {
        throw new Error(`${CHECKSUM_FILENAME} must be non-empty and end with a newline`);
    }
    const lines = contents.slice(0, -1).split('\n');
    const assets = [];
    const portableNames = new Set();
    for (const line of lines) {
        const match = CHECKSUM_LINE_PATTERN.exec(line);
        if (!match) {
            throw new Error(`Invalid ${CHECKSUM_FILENAME} line: ${JSON.stringify(line)}`);
        }
        const sha256 = match[1];
        const rawName = match[2];
        if (sha256 === undefined || rawName === undefined) {
            throw new Error(`Invalid ${CHECKSUM_FILENAME} line: ${JSON.stringify(line)}`);
        }
        const name = validateAssetBasename(rawName);
        const portableName = portableAssetName(name);
        if (portableNames.has(portableName)) {
            throw new Error(`Duplicate release asset basename in ${CHECKSUM_FILENAME}: ${name}`);
        }
        portableNames.add(portableName);
        assets.push({
            name,
            sha256,
        });
    }
    return assets;
}

/** @param {string} artifactDirectory @returns {Promise<string[]>} */
async function releaseAssetNames(artifactDirectory) {
    const entries = await readdir(artifactDirectory, {withFileTypes: true});
    const names = [];
    for (const entry of entries) {
        if (entry.name === CHECKSUM_FILENAME) {
            continue;
        }
        if (!entry.isFile()) {
            throw new Error(`Release artifact must be a regular file: ${JSON.stringify(entry.name)}`);
        }
        names.push(entry.name);
    }
    return validateReleaseAssetNames(names);
}

/** @param {string[]} assetNames @returns {string[]} */
export function validateReleaseAssetNames(assetNames) {
    const names = [];
    const portableNames = new Set();
    for (const assetName of assetNames) {
        const name = validateAssetBasename(assetName);
        const portableName = portableAssetName(name);
        if (portableNames.has(portableName)) {
            throw new Error(`Release asset basenames are not portable and unique: ${name}`);
        }
        portableNames.add(portableName);
        names.push(name);
    }
    if (names.length === 0) {
        throw new Error('Release asset names must not be empty');
    }
    return names.sort();
}

/** @param {string} name @returns {string} */
function validateAssetBasename(name) {
    if (
        name !== basename(name)
        || name === '.'
        || name === '..'
        || name.normalize('NFC') !== name
        || name.trim() !== name
        || name.includes('/')
        || name.includes('\\')
        || [...name].some(character => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
        })
        || portableAssetName(name) === portableAssetName(CHECKSUM_FILENAME)
    ) {
        throw new Error(`Unsafe release asset basename: ${JSON.stringify(name)}`);
    }
    return name;
}

/** @param {string} name @returns {string} */
function portableAssetName(name) {
    return name.normalize('NFC').toLowerCase();
}

/** @param {string[]} names @returns {string} */
function formatNames(names) {
    return names.length > 0 ? names.join(', ') : '(none)';
}

/** @param {string} filePath @returns {Promise<string>} */
async function hashFile(filePath) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [
        command,
        artifactDirectory,
        ...extraArguments
    ] = process.argv.slice(2);
    if (
        !artifactDirectory
        || extraArguments.length > 0
        || (command !== 'generate' && command !== 'verify')
    ) {
        throw new Error(
            'Usage: release-checksums.mjs <generate|verify> <artifact-directory> [release-version]',
        );
    }
    if (command === 'generate') {
        await generateReleaseChecksums(artifactDirectory);
    } else {
        await verifyReleaseChecksums(artifactDirectory);
    }
}
