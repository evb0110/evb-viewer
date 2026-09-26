import {execFileSync} from 'node:child_process';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    mkdir,
    open,
    readFile,
    rename,
    rm,
    writeFile,
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
    type TNativeToolResourceFamilyId,
    type TNativeResourcePlatformArch,
} from '@scripts/nativeResourceManifest';
import {RUNTIME_BINARY_MANIFEST} from '@scripts/runtimeBinaryManifest';
import {validateRuntimeBinaryArchivePaths} from '@scripts/validateRuntimeBinaryArchivePaths';
import {
    TESSERACT_PDF_FONT_RESOURCE_SEGMENTS,
    TESSERACT_PDF_FONT_SHA256,
} from '@scripts/tesseractPdfFont';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RUNTIME_BINARY_DOWNLOAD_REDIRECTS = 3;
const RUNTIME_BINARY_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const GITHUB_RELEASE_ORIGIN = 'https://github.com';
const GITHUB_RELEASE_ASSET_ORIGIN = 'https://release-assets.githubusercontent.com';

function usage() {
    return [
        'Usage: node --import tsx scripts/fetchRuntimeBinaries.ts [--target <platform-arch>] [--cache <directory>] [--family <family>]... [--tessdata-only] [--if-published]',
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

async function cancelResponseBody(response: Response | null) {
    if (response?.body === null || response?.body === undefined) return;
    await response.body.cancel().catch(() => undefined);
}

export function assertAllowedRuntimeBinaryDownloadRedirect(fromUrl: string, toUrl: string) {
    const from = new URL(fromUrl);
    const to = new URL(toUrl, from);
    const allowed = to.protocol === 'https:'
        && to.username === ''
        && to.password === ''
        && (
            from.origin === GITHUB_RELEASE_ORIGIN && to.origin === GITHUB_RELEASE_ASSET_ORIGIN
            || from.origin === GITHUB_RELEASE_ASSET_ORIGIN && to.origin === GITHUB_RELEASE_ASSET_ORIGIN
        );
    if (!allowed) {
        throw new Error(`Runtime archive redirect to untrusted origin ${to.origin} was rejected.`);
    }
    return to.href;
}

export async function* fetchRuntimeBinaryArchiveResponseBody(url: string) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), RUNTIME_BINARY_DOWNLOAD_TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let readerCompleted = false;
    try {
        let currentUrl = url;
        let response: Response | null = null;
        for (
            let redirectCount = 0;
            redirectCount <= MAX_RUNTIME_BINARY_DOWNLOAD_REDIRECTS;
            redirectCount += 1
        ) {
            response = await fetch(currentUrl, {
                redirect: 'manual',
                signal: abortController.signal,
            });
            if (response.status < 300 || response.status >= 400) break;
            const location = response.headers.get('location');
            if (!location || redirectCount === MAX_RUNTIME_BINARY_DOWNLOAD_REDIRECTS) {
                await cancelResponseBody(response);
                throw new Error('Runtime archive download exceeded the trusted redirect limit.');
            }
            await cancelResponseBody(response);
            currentUrl = assertAllowedRuntimeBinaryDownloadRedirect(currentUrl, location);
        }

        if (!response?.ok || response.body === null) {
            await cancelResponseBody(response);
            throw new Error(`Runtime archive download failed with HTTP status ${response?.status ?? 'unknown'}.`);
        }
        reader = response.body.getReader();
        for (;;) {
            const {
                done, value,
            } = await reader.read();
            if (done) {
                readerCompleted = true;
                return;
            }
            yield value;
        }
    } finally {
        if (reader && !readerCompleted) await reader.cancel().catch(() => undefined);
        reader?.releaseLock();
        clearTimeout(timeout);
    }
}

function archiveMembers(archivePath: string) {
    const output = execFileSync('tar', [
        '-tzf',
        path.basename(archivePath),
    ], {
        cwd: path.dirname(archivePath),
        encoding: 'utf8',
    });
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
        // Relative paths keep Git Bash's GNU tar from reading a Windows drive letter as a remote host.
        execFileSync('tar', [
            '-xzf',
            path.relative(extractionRoot, archivePath),
            '--no-same-owner',
            '--no-same-permissions',
        ], {
            cwd: extractionRoot,
            stdio: 'inherit',
        });
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

async function readVerifiedTesseractPdfFont(projectRoot: string) {
    const fontPath = path.join(projectRoot, ...TESSERACT_PDF_FONT_RESOURCE_SEGMENTS);
    const fontBytes = await readFile(fontPath);
    const actualSha256 = createHash('sha256').update(fontBytes).digest('hex');
    if (actualSha256 !== TESSERACT_PDF_FONT_SHA256) {
        throw new Error(
            `Tesseract PDF font SHA-256 ${actualSha256} does not match ${TESSERACT_PDF_FONT_SHA256}.`,
        );
    }
    return {
        bytes: fontBytes,
        path: fontPath,
    };
}

export async function fetchRuntimeBinaries({
    cacheDirectory = path.join(repositoryRoot, '.cache', 'runtime-binaries'),
    env = process.env,
    projectRoot = repositoryRoot,
    targetTag = hostTarget(),
    familyIds,
    dataOnly = false,
    skipUnpublished = false,
    transport = (url: string) => runtimeArchiveTransport(url, env),
}: {
    cacheDirectory?: string;
    env?: NodeJS.ProcessEnv;
    projectRoot?: string;
    targetTag?: string;
    familyIds?: readonly TNativeToolResourceFamilyId[];
    dataOnly?: boolean;
    skipUnpublished?: boolean;
    transport?: TRuntimeBinaryArchiveTransport;
} = {}) {
    validateRuntimeBinaryManifest(RUNTIME_BINARY_MANIFEST);
    const target = parseNativeResourcePlatformArch(targetTag);
    const requestedFamilies = familyIds ? new Set(familyIds) : null;
    if (requestedFamilies?.size === 0) throw new Error('At least one runtime family is required.');
    const entries = dataOnly ? [] : RUNTIME_BINARY_MANIFEST.entries.filter(entry => (
        entry.target.platformArch === target.platformArch
        && (!requestedFamilies || requestedFamilies.has(entry.familyId))
    ));
    console.log(`Fetching verified runtime archives for ${target.platformArch}.`);
    if (!dataOnly) {
        const allFamilies = new Set(RUNTIME_BINARY_MANIFEST.entries.map(entry => entry.familyId));
        const requiredFamilies = requestedFamilies ?? allFamilies;
        const availableFamilies = new Set(entries.map(entry => entry.familyId));
        const missingFamilies = [...requiredFamilies].filter(family => !availableFamilies.has(family));
        if (missingFamilies.length > 0) {
            if (skipUnpublished) {
                console.log(`No published ${target.platformArch} archives for: ${missingFamilies.join(', ')}.`);
                return null;
            }
            throw new Error(`Runtime manifest has no ${target.platformArch} archives for: ${missingFamilies.join(', ')}.`);
        }
        for (const entry of entries) {
            try {
                const result = await fetchVerifiedRuntimeArchive({
                    cacheDirectory,
                    familyId: entry.familyId,
                    manifest: RUNTIME_BINARY_MANIFEST,
                    target,
                    transport,
                });
                await stageArchive(projectRoot, result.archivePath, `${entry.familyId}/${target.platformArch}`);
                console.log(`  ${entry.familyId}: verified ${entry.archiveSha256}`);
            } catch (error) {
                if (skipUnpublished && error instanceof Error && error.message.includes('HTTP status 404')) {
                    console.log(`No published ${target.platformArch} archive for ${entry.familyId}.`);
                    return null;
                }
                throw error;
            }
        }
    }

    if (!requestedFamilies || dataOnly) {
        for (const dataEntry of RUNTIME_BINARY_MANIFEST.dataEntries ?? []) {
            try {
                const result = await fetchVerifiedRuntimeDataArchive({
                    cacheDirectory,
                    dataEntry,
                    manifest: RUNTIME_BINARY_MANIFEST,
                    transport,
                });
                const pdfFont = await readVerifiedTesseractPdfFont(projectRoot);
                await stageArchive(projectRoot, result.archivePath, dataEntry.resourceRoot);
                await writeFile(pdfFont.path, pdfFont.bytes);
                console.log(`  ${dataEntry.resourceRoot}: verified ${dataEntry.archiveSha256}`);
            } catch (error) {
                if (skipUnpublished && error instanceof Error && error.message.includes('HTTP status 404')) {
                    console.log(`No published runtime data archive for ${dataEntry.resourceRoot}.`);
                    return null;
                }
                throw error;
            }
        }
    }

    return {
        dataEntries: requestedFamilies && !dataOnly ? 0 : RUNTIME_BINARY_MANIFEST.dataEntries?.length ?? 0,
        entries: entries.length,
        manifestSha256: RUNTIME_BINARY_MANIFEST.manifestSha256,
        target: target.platformArch,
    };
}

const RUNTIME_FAMILIES = [
    'tesseract',
    'poppler',
    'qpdf',
    'djvulibre',
] as const;

function parseArguments(argv: readonly string[]) {
    let targetTag: string | undefined;
    let cacheDirectory: string | undefined;
    let ifPublished = false;
    let dataOnly = false;
    const familyIds: TNativeToolResourceFamilyId[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--target' || argument === '--cache' || argument === '--family') {
            const value = argv[index + 1];
            if (!value) throw new Error(usage());
            if (argument === '--target') targetTag = value;
            else if (argument === '--cache') cacheDirectory = value;
            else {
                const familyId = RUNTIME_FAMILIES.find(candidate => candidate === value);
                if (!familyId) throw new Error(usage());
                familyIds.push(familyId);
            }
            index += 1;
        } else if (argument === '--if-published') {
            ifPublished = true;
        } else if (argument === '--tessdata-only') {
            dataOnly = true;
        } else if (argument === '--help') {
            console.log(usage());
            return null;
        } else {
            throw new Error(usage());
        }
    }
    if (dataOnly && familyIds.length > 0) throw new Error(usage());
    return {
        cacheDirectory,
        dataOnly,
        familyIds: familyIds.length > 0 ? familyIds : undefined,
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
                ...(options.familyIds === undefined ? {} : {familyIds: options.familyIds}),
                dataOnly: options.dataOnly,
                skipUnpublished: options.ifPublished,
                ...(options.targetTag === undefined ? {} : {targetTag: options.targetTag}),
            });
            if (!result && !options.ifPublished) process.exitCode = 1;
        }
    } catch (error) {
        console.error(`Runtime binary fetch failed: ${getErrorMessage(error)}`);
        process.exitCode = 1;
    }
}
