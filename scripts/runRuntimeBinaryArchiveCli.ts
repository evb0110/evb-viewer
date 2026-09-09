import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchVerifiedRuntimeArchive} from '@scripts/runtimeBinaryArchive';
import {parseNativeResourcePlatformArch} from '@scripts/nativeResourceManifest';
import {
    POPPLER_RUNTIME_BINARY_MEMBER_POLICY,
    QPDF_RUNTIME_BINARY_MEMBER_POLICY,
    RUNTIME_BINARY_MANIFEST,
} from '@scripts/runtimeBinaryManifest';
import {validateRuntimeBinaryArchiveMembers} from '@scripts/validateRuntimeBinaryArchiveMembers';

const MAX_RUNTIME_BINARY_DOWNLOAD_REDIRECTS = 3;
const RUNTIME_BINARY_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const GITHUB_RELEASE_ORIGIN = 'https://github.com';
const GITHUB_RELEASE_ASSET_ORIGIN = 'https://release-assets.githubusercontent.com';
const RUNTIME_BINARY_FAMILIES = {
    poppler: POPPLER_RUNTIME_BINARY_MEMBER_POLICY,
    qpdf: QPDF_RUNTIME_BINARY_MEMBER_POLICY,
} as const;
type TRuntimeBinaryFamily = keyof typeof RUNTIME_BINARY_FAMILIES;
export type TRuntimeBinaryArchiveMemberReader = (archivePath: string) => readonly string[];

function usage(): string {
    return [
        'Usage:',
        '  node --import tsx scripts/runRuntimeBinaryArchiveCli.ts fetch <family> <platform-arch> <cache-directory>',
        '  node --import tsx scripts/runRuntimeBinaryArchiveCli.ts verify-members [<family>] <archive-path> [paths]',
    ].join('\n');
}

function isRuntimeBinaryFamily(value: string | undefined): value is TRuntimeBinaryFamily {
    return value === 'qpdf' || value === 'poppler';
}

function readRuntimeBinaryArchiveMembers(archivePath: string): readonly string[] {
    const output = execFileSync('unzip', [
        '-Z1',
        archivePath,
    ], {encoding: 'utf8'});
    return output.split(/\r?\n/u).filter(Boolean);
}

async function cancelResponseBody(response: Response | null) {
    if (response?.body === null || response?.body === undefined) {
        return;
    }
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
            if (response.status < 300 || response.status >= 400) {
                break;
            }
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
                return;
            }
            yield value;
        }
    } finally {
        if (reader) {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
        clearTimeout(timeout);
    }
}

export async function runRuntimeBinaryArchiveCli(
    argv: readonly string[],
    readMembers: TRuntimeBinaryArchiveMemberReader = readRuntimeBinaryArchiveMembers,
) {
    const [
        command,
        value,
        targetTag,
        cacheDirectory,
    ] = argv;
    if (
        command === 'fetch'
        && isRuntimeBinaryFamily(value)
        && targetTag
        && cacheDirectory
        && argv.length === 4
    ) {
        const target = parseNativeResourcePlatformArch(targetTag);
        const result = await fetchVerifiedRuntimeArchive({
            cacheDirectory: path.resolve(cacheDirectory),
            familyId: value,
            manifest: RUNTIME_BINARY_MANIFEST,
            target,
            transport: fetchRuntimeBinaryArchiveResponseBody,
        });
        console.log(result.archivePath);
        return;
    }

    if (command === 'verify-members') {
        let family: TRuntimeBinaryFamily = 'qpdf';
        let archivePath: string | undefined;
        let printPaths = false;
        if (isRuntimeBinaryFamily(value)) {
            if (!targetTag || (argv.length !== 3 && argv.length !== 4)) {
                throw new Error(usage());
            }
            family = value;
            archivePath = targetTag;
            printPaths = cacheDirectory === 'paths';
        } else if (
            value
            && (argv.length === 2 || (argv.length === 3 && targetTag === 'paths'))
        ) {
            archivePath = value;
            printPaths = targetTag === 'paths';
        } else {
            throw new Error(usage());
        }
        if (!archivePath) {
            throw new Error(usage());
        }

        const members = readMembers(path.resolve(archivePath));
        const result = validateRuntimeBinaryArchiveMembers(
            members,
            RUNTIME_BINARY_FAMILIES[family],
        );
        if (printPaths) {
            for (const executableEntry of result.executableEntries) console.log(executableEntry);
            for (const dllEntry of result.adjacentDllEntries) console.log(dllEntry);
        } else {
            console.log(JSON.stringify(result));
        }
        return;
    }

    throw new Error(usage());
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        await runRuntimeBinaryArchiveCli(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
