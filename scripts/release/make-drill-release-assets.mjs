import { createHash } from 'node:crypto';
import {
    mkdir,
    readdir,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    basename,
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    expectsUpdaterMetadata,
    getLocalReleaseTargets,
    getRequiredArtifactPatterns,
} from './policy.mjs';
import {DRILL_TAG_PATTERN} from './releaseTag.mjs';
import {MULTIPART_PART_BYTES} from './publish-release-mirror.mjs';

const DRILL_POLICY_ENV = Object.freeze({EVB_RELEASE_HAS_MAC_SIGNING: 'true'});

/** @type {ReadonlyArray<{arch: string, artifactGroup: string, platform: 'darwin' | 'linux' | 'win32'}>} */
const TARGETS = Object.freeze([
    {
        arch: 'arm64',
        artifactGroup: 'dist-mac-arm64',
        platform: 'darwin',
    },
    {
        arch: 'x64',
        artifactGroup: 'dist-linux-x64',
        platform: 'linux',
    },
    {
        arch: 'arm64',
        artifactGroup: 'dist-linux-arm64',
        platform: 'linux',
    },
    {
        arch: 'x64',
        artifactGroup: 'dist-win-x64',
        platform: 'win32',
    },
]);

export const DRILL_ASSET_BYTES = 4 * 1024;
// One drill asset spans three mirror parts so every drill proves the
// multipart upload path against the real bucket, not only the unit fakes.
export const DRILL_MULTIPART_ASSET_BYTES = MULTIPART_PART_BYTES * 2 + 1024;
const DRILL_MULTIPART_ASSET_SUFFIX = '.dmg';

/** @typedef {ReturnType<typeof getLocalReleaseTargets>[number]} IReleaseTarget */
/** @typedef {{sha512: string, size: number}} IArtifactInfo */

/** @param {string} outputDirectory @param {string} version @returns {Promise<{artifactNames: string[], outputDirectory: string, targetGroups: string[]}>} */
export async function makeDrillReleaseAssets(outputDirectory, version) {
    validateDrillVersion(version);
    if (!outputDirectory) {
        throw new Error('Usage: make-drill-release-assets.mjs <outDir> <version>');
    }

    const root = resolve(outputDirectory);
    await mkdir(root, {recursive: true});
    const allArtifactNames = [];

    for (const targetDefinition of TARGETS) {
        const [target] = getLocalReleaseTargets({
            arch: targetDefinition.arch,
            platform: targetDefinition.platform,
        });
        if (!target) {
            throw new Error(`No release target matched ${targetDefinition.platform}-${targetDefinition.arch}`);
        }
        const targetDirectory = join(root, targetDefinition.artifactGroup);
        await mkdir(targetDirectory, {recursive: true});
        const artifactNames = getTargetArtifactNames(target, version);
        const requiredPatterns = getRequiredArtifactPatterns(target, DRILL_POLICY_ENV);
        for (const pattern of requiredPatterns) {
            if (!artifactNames.some(name => pattern.test(name))) {
                throw new Error(
                    `Drill asset set for ${targetDefinition.artifactGroup} does not satisfy ${pattern}`,
                );
            }
        }

        for (const name of artifactNames) {
            await writeFile(
                join(targetDirectory, name),
                createDeterministicBytes(version, name, drillAssetBytes(name)),
            );
        }

        const metadataName = getMetadataName(target, DRILL_POLICY_ENV);
        if (metadataName) {
            await writeFile(
                join(targetDirectory, metadataName),
                await createUpdaterMetadata(target, targetDirectory, version, artifactNames),
            );
        }
        allArtifactNames.push(...await listFiles(targetDirectory));
    }

    return {
        artifactNames: allArtifactNames.sort(),
        outputDirectory: root,
        targetGroups: TARGETS.map(target => target.artifactGroup),
    };
}

/** @param {string} version */
function validateDrillVersion(version) {
    if (typeof version !== 'string' || !DRILL_TAG_PATTERN.test(`v${version}`)) {
        throw new Error(`Invalid drill version: ${version ?? ''}`);
    }
}

/** @param {IReleaseTarget} target @param {string} version @returns {string[]} */
function getTargetArtifactNames(target, version) {
    const artifactPrefix = `EVB-Viewer-${version}-${target.arch}`;
    switch (target.platform) {
        case 'mac':
            return [
                `${artifactPrefix}.dmg`,
                `${artifactPrefix}.zip`,
                ...(expectsUpdaterMetadata(target, DRILL_POLICY_ENV)
                    ? [
                        `${artifactPrefix}.dmg.blockmap`,
                        `${artifactPrefix}.zip.blockmap`,
                    ]
                    : []),
            ];
        case 'linux':
            return [`${artifactPrefix}.deb`];
        case 'win':
            return [
                `${artifactPrefix}-setup.exe`,
                `EVB-Viewer-${version}-win-${target.arch}-provenance.json`,
                ...(expectsUpdaterMetadata(target, DRILL_POLICY_ENV)
                    ? [`${artifactPrefix}-setup.exe.blockmap`]
                    : []),
            ];
        default:
            throw new Error(`Unsupported drill target platform: ${target.platform}`);
    }
}

/** @param {IReleaseTarget} target @param {NodeJS.ProcessEnv} environment @returns {string | null} */
function getMetadataName(target, environment) {
    if (!expectsUpdaterMetadata(target, environment)) {
        return null;
    }
    if (target.platform === 'mac') {
        return 'latest-mac.yml';
    }
    if (target.platform === 'win') {
        return `latest-win-${target.arch}.yml`;
    }
    return null;
}

/** @param {IReleaseTarget} target @param {string} targetDirectory @param {string} version @param {string[]} artifactNames @returns {Promise<string>} */
async function createUpdaterMetadata(target, targetDirectory, version, artifactNames) {
    const updateArtifacts = artifactNames.filter(name => {
        if (target.platform === 'mac') {
            return name.endsWith('.dmg') || name.endsWith('.zip');
        }
        return name.endsWith('.exe');
    });
    const entries = await Promise.all(updateArtifacts.map(async (name) => {
        const info = await getArtifactInfo(join(targetDirectory, name));
        return {
            name,
            sha512: info.sha512,
            size: info.size,
        };
    }));
    const primary = entries.find(entry => entry.name.endsWith('.zip')) ?? entries[0];
    if (!primary) {
        throw new Error('Drill updater metadata requires at least one update artifact');
    }
    return [
        `version: ${version}`,
        'files:',
        ...entries.flatMap(entry => [
            `  - url: ${entry.name}`,
            `    sha512: ${entry.sha512}`,
            `    size: ${entry.size}`,
        ]),
        `path: ${primary.name}`,
        `sha512: ${primary.sha512}`,
        '',
    ].join('\n');
}

/** @param {string} name @returns {number} */
function drillAssetBytes(name) {
    return name.endsWith(DRILL_MULTIPART_ASSET_SUFFIX) ? DRILL_MULTIPART_ASSET_BYTES : DRILL_ASSET_BYTES;
}

/** @param {string} version @param {string} name @param {number} byteLength @returns {Buffer} */
function createDeterministicBytes(version, name, byteLength) {
    const seed = Buffer.from(`EVB Viewer publish-chain drill ${version} ${name}\n`, 'utf8');
    const bytes = Buffer.alloc(byteLength);
    for (let offset = 0; offset < byteLength; offset += seed.byteLength) {
        seed.copy(bytes, offset, 0, Math.min(seed.byteLength, byteLength - offset));
    }
    return bytes;
}

/** @param {string} filePath @returns {Promise<IArtifactInfo>} */
async function getArtifactInfo(filePath) {
    const contents = await readFile(filePath);
    return {
        sha512: createHash('sha512').update(contents).digest('base64'),
        size: (await stat(filePath)).size,
    };
}

/** @param {string} directory @returns {Promise<string[]>} */
async function listFiles(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    return entries
        .filter(entry => entry.isFile())
        .map(entry => basename(entry.name));
}

const isMain = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
    const [
        outputDirectory,
        version,
        ...extraArguments
    ] = process.argv.slice(2);
    if (!outputDirectory || !version || extraArguments.length > 0) {
        throw new Error('Usage: make-drill-release-assets.mjs <outDir> <version>');
    }
    await makeDrillReleaseAssets(outputDirectory, version);
}
