import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
    mkdir,
    open,
    rename,
    rm,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {
    fetchVerifiedRuntimeArchive,
    fetchVerifiedRuntimeDataArchive,
    validateRuntimeBinaryManifest,
    type TRuntimeBinaryArchiveTransport,
} from '@scripts/runtimeBinaryArchive';
import {
    NATIVE_RESOURCE_PLATFORM_ARCHES,
    parseNativeResourcePlatformArch,
    type TNativeResourcePlatformArch,
} from '@scripts/nativeResourceManifest';
import {RUNTIME_BINARY_MANIFEST} from '@scripts/runtimeBinaryManifest';
import {validateRuntimeBinaryArchivePaths} from '@scripts/validateRuntimeBinaryArchiveMembers';
import {fetchRuntimeBinaryArchiveResponseBody} from '@scripts/runRuntimeBinaryArchiveCli';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
    return [
        'Usage: node --import tsx scripts/fetchRuntimeBinaries.ts [--target <platform-arch>] [--cache <directory>] [--if-published]',
        '',
        `Targets: ${NATIVE_RESOURCE_PLATFORM_ARCHES.join(', ')}`,
        '',
        'EVB_RUNTIME_BINARY_ARCHIVE_BASE_URL may point to a local HTTP server for offline verification.',
    ].join('\n');
}

function hostTarget(): TNativeResourcePlatformArch {
    const platform = process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'win32'
            ? 'win32'
            : process.platform === 'linux'
                ? 'linux'
                : null;
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
    if (!platform || !arch) {
        throw new Error(`Unsupported runtime binary host: ${process.platform}/${process.arch}.`);
    }
    return `${platform}-${arch}`;
}

function archiveUrlForTransport(url: string, env: NodeJS.ProcessEnv) {
    const baseUrl = env.EVB_RUNTIME_BINARY_ARCHIVE_BASE_URL;
    if (!baseUrl) return url;

    const base = new URL(baseUrl);
    if (base.protocol !== 'file:' && base.protocol !== 'http:' && base.protocol !== 'https:') {
        throw new Error('EVB_RUNTIME_BINARY_ARCHIVE_BASE_URL must use file, HTTP, or HTTPS.');
    }
    const fileName = new URL(url).pathname.split('/').at(-1);
    if (!fileName) throw new Error(`Runtime archive URL has no file name: ${url}`);
    return new URL(fileName, base.href.endsWith('/') ? base.href : `${base.href}/`).href;
}

async function runtimeArchiveTransport(url: string, env: NodeJS.ProcessEnv) {
    const mappedUrl = archiveUrlForTransport(url, env);
    if (mappedUrl.startsWith('file:')) {
        const handle = await open(fileURLToPath(mappedUrl));
        return handle.createReadStream();
    }
    return fetchRuntimeBinaryArchiveResponseBody(mappedUrl);
}

function archiveMembers(archivePath: string) {
    const output = execFileSync('tar', [
        '-tzf',
        archivePath,
    ], {encoding: 'utf8'});
    return validateRuntimeBinaryArchivePaths(output.split(/\r?\n/u).filter(Boolean));
}

async function stageArchive(
    projectRoot: string,
    archivePath: string,
    resourceRoot: string,
) {
    const members = archiveMembers(archivePath);
    const expectedPrefix = `${resourceRoot}/`;
    if (!members.some(member => member === resourceRoot || member.startsWith(expectedPrefix))) {
        throw new Error(`Runtime archive does not contain its expected resource root ${resourceRoot}.`);
    }

    const extractionRoot = path.join(projectRoot, '.devkit', `runtime-extract-${randomUUID()}`);
    const destination = path.join(projectRoot, 'resources', resourceRoot);
    await mkdir(extractionRoot, {recursive: true});
    try {
        execFileSync('tar', [
            '-xzf',
            archivePath,
            '-C',
            extractionRoot,
            '--no-same-owner',
            '--no-same-permissions',
        ], {stdio: 'inherit'});
        await mkdir(path.dirname(destination), {recursive: true});
        await rm(destination, {
            force: true,
            recursive: true,
        });
        await rename(path.join(extractionRoot, resourceRoot), destination);
    } finally {
        await rm(extractionRoot, {
            force: true,
            recursive: true,
        });
    }
}

export async function fetchRuntimeBinaries({
    cacheDirectory = path.join(repositoryRoot, '.cache', 'runtime-binaries'),
    env = process.env,
    projectRoot = repositoryRoot,
    targetTag = hostTarget(),
    transport = (url: string) => runtimeArchiveTransport(url, env),
}: {
    cacheDirectory?: string;
    env?: NodeJS.ProcessEnv;
    projectRoot?: string;
    targetTag?: string;
    transport?: TRuntimeBinaryArchiveTransport;
} = {}) {
    validateRuntimeBinaryManifest(RUNTIME_BINARY_MANIFEST);
    const target = parseNativeResourcePlatformArch(targetTag);
    const entries = RUNTIME_BINARY_MANIFEST.entries.filter(entry => entry.target.platformArch === target.platformArch);
    if (entries.length === 0) {
        return null;
    }

    console.log(`Fetching verified runtime archives for ${target.platformArch}.`);
    for (const entry of entries) {
        const result = await fetchVerifiedRuntimeArchive({
            cacheDirectory,
            familyId: entry.familyId,
            manifest: RUNTIME_BINARY_MANIFEST,
            target,
            transport,
        });
        await stageArchive(projectRoot, result.archivePath, `${entry.familyId}/${target.platformArch}`);
        console.log(`  ${entry.familyId}: verified ${entry.archiveSha256}`);
    }

    for (const dataEntry of RUNTIME_BINARY_MANIFEST.dataEntries ?? []) {
        const result = await fetchVerifiedRuntimeDataArchive({
            cacheDirectory,
            dataEntry,
            manifest: RUNTIME_BINARY_MANIFEST,
            transport,
        });
        await stageArchive(projectRoot, result.archivePath, dataEntry.resourceRoot);
        console.log(`  ${dataEntry.resourceRoot}: verified ${dataEntry.archiveSha256}`);
    }

    return {
        dataEntries: RUNTIME_BINARY_MANIFEST.dataEntries?.length ?? 0,
        entries: entries.length,
        manifestSha256: RUNTIME_BINARY_MANIFEST.manifestSha256,
        target: target.platformArch,
    };
}

const UNPUBLISHED_TARGET_EXIT_CODE = 3;

function parseArguments(argv: readonly string[]) {
    let targetTag: string | undefined;
    let cacheDirectory: string | undefined;
    let ifPublished = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--target' || argument === '--cache') {
            const value = argv[index + 1];
            if (!value) throw new Error(usage());
            if (argument === '--target') targetTag = value;
            else cacheDirectory = value;
            index += 1;
        } else if (argument === '--if-published') {
            ifPublished = true;
        } else if (argument === '--help') {
            console.log(usage());
            return null;
        } else {
            throw new Error(usage());
        }
    }
    return {
        cacheDirectory,
        ifPublished,
        targetTag,
    };
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        const options = parseArguments(process.argv.slice(2));
        if (options) {
            const result = await fetchRuntimeBinaries({
                ...(options.cacheDirectory === undefined ? {} : {cacheDirectory: options.cacheDirectory}),
                ...(options.targetTag === undefined ? {} : {targetTag: options.targetTag}),
            });
            if (!result) {
                console.log('No published runtime archives for this target; the platform bundler builds them from source.');
                // Bundlers read this exit code as "build from source instead".
                if (!options.ifPublished) process.exitCode = UNPUBLISHED_TARGET_EXIT_CODE;
            }
        }
    } catch (error) {
        console.error(`Runtime binary fetch failed: ${getErrorMessage(error)}`);
        process.exitCode = 1;
    }
}
