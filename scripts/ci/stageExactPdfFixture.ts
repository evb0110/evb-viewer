import { getErrorMessage } from '@contracts/getErrorMessage';
import { fsyncFile } from '@electron/utils/fsyncPath';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import {execFile} from 'node:child_process';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    constants as fsConstants,
    createReadStream,
    createWriteStream,
} from 'node:fs';
import {
    copyFile,
    mkdir,
    rename,
    stat,
    unlink,
} from 'node:fs/promises';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {
    dirname,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

export type TExactPdfFixtureCopyMode = 'clone' | 'stream';

export interface IExactPdfFixtureIdentity {
    bytes: number;
    pages: number;
    sha256: string;
}

export interface IExactPdfFixtureExpectation extends IExactPdfFixtureIdentity {profile: string;}

export interface IExactPdfFixtureStageResult {
    copyMode: TExactPdfFixtureCopyMode;
    sourceIdentity: IExactPdfFixtureIdentity;
    sourcePath: string;
    stagedIdentity: IExactPdfFixtureIdentity;
    stagedPath: string;
}

type TCopyFileImplementation = (
    sourcePath: string,
    targetPath: string,
    mode?: number,
) => Promise<void>;

type TStreamCopyImplementation = (
    sourcePath: string,
    targetPath: string,
    signal?: AbortSignal,
) => Promise<void>;

type TSyncFileImplementation = (path: string) => Promise<void>;

export interface IExactPdfCopyOptions {
    copyFileImpl?: TCopyFileImplementation;
    maxBytes?: number;
    mode?: 'auto' | TExactPdfFixtureCopyMode;
    signal?: AbortSignal;
    streamCopyImpl?: TStreamCopyImplementation;
    syncFileImpl?: TSyncFileImplementation;
}

export interface IExactPdfIdentityOptions {
    maxBytes?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface IStageExactPdfFixtureOptions extends IExactPdfIdentityOptions, IExactPdfCopyOptions {
    expectedIdentity: IExactPdfFixtureIdentity;
    outputPath: string;
    sourcePath: string;
}

/**
 * These are the only large-PDF identities admitted by the exact-fixture lane.
 * The local 882-page artifact is retained because it is the fixture used by
 * the existing developer and Linux E2E runs. Hosted CI does not run the
 * exact-fixture lane, so each local run selects its profile explicitly.
 */
export const EXACT_PDF_FIXTURE_MANIFEST = Object.freeze({
    auditedZaliznyak882: {
        bytes: 722_176_299,
        pages: 882,
        profile: 'auditedZaliznyak882',
        sha256: '4f5c6a438f19a0b19faff37882be6f0bc9199fbf6ba5d0694ab25d4d32ce897b',
    },
    localZaliznyak882: {
        bytes: 722_178_517,
        pages: 882,
        profile: 'localZaliznyak882',
        sha256: '1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6',
    },
    xlargeZaliznyak2646: {
        bytes: 2_168_527_413,
        pages: 2_646,
        profile: 'xlargeZaliznyak2646',
        sha256: '5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea',
    },
} satisfies Record<string, IExactPdfFixtureExpectation>);



const EXACT_FIXTURE_OPT_IN_REQUIRED = 'EXACT_FIXTURE_OPT_IN_REQUIRED';

const DEFAULT_MAX_BYTES = 2_500_000_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const CLONE_UNSUPPORTED_CODES = new Set([
    'EINVAL',
    'ENOSYS',
    'ENOTSUP',
    'EOPNOTSUPP',
    'EXDEV',
]);

function asPositiveInteger(value: string, label: string) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer: ${value}`);
    }
    return parsed;
}

function parseErrnoCode(error: unknown) {
    if (!error || typeof error !== 'object') {
        return undefined;
    }
    const code = (error as {code?: unknown}).code;
    return typeof code === 'string' ? code : undefined;
}

function isCloneUnsupportedError(error: unknown) {
    return CLONE_UNSUPPORTED_CODES.has(parseErrnoCode(error) ?? '');
}

function formatIdentity(identity: IExactPdfFixtureIdentity) {
    return `bytes=${identity.bytes}, pages=${identity.pages}, sha256=${identity.sha256}`;
}

function throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) {
        return;
    }
    const reason: unknown = signal.reason;
    throw reason instanceof Error ? reason : new Error('Exact fixture operation was aborted');
}

function abortError(signal: AbortSignal) {
    const reason: unknown = signal.reason;
    return reason instanceof Error ? reason : new Error('Exact fixture operation was aborted');
}

function assertMaxBytes(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error(`Maximum fixture size must be a positive integer: ${maxBytes}`);
    }
}

async function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return operation;
    }
    throwIfAborted(signal);
    return new Promise<T>((resolvePromise, rejectPromise) => {
        let settled = false;
        const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
        };
        const resolve = (value: T) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolvePromise(value);
        };
        const rejectOperation = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            rejectPromise(error);
        };
        const onAbort = () => rejectOperation(abortError(signal));
        signal.addEventListener('abort', onAbort, {once: true});
        operation.then(resolve, rejectOperation);
        if (signal.aborted) {
            onAbort();
        }
    });
}

function createStageAbortController(timeoutMs: number, parentSignal?: AbortSignal) {
    assertTimeout(timeoutMs);
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', onParentAbort, {once: true});
    const timer = setTimeout(() => {
        controller.abort(new Error(`Exact fixture staging exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    if (parentSignal?.aborted) {
        onParentAbort();
    }
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', onParentAbort);
        },
    };
}

export function validateExactPdfFixtureIdentity(
    actual: IExactPdfFixtureIdentity,
    expected: IExactPdfFixtureIdentity,
) {
    const identityKeys: Array<keyof IExactPdfFixtureIdentity> = [
        'bytes',
        'pages',
        'sha256',
    ];
    const mismatches = identityKeys
        .filter(key => actual[key] !== expected[key])
        .map(key => `${key}: expected ${String(expected[key])}, got ${String(actual[key])}`);
    if (mismatches.length > 0) {
        throw new Error(
            `Exact PDF fixture identity mismatch: ${mismatches.join('; ')} `
            + `(${formatIdentity(actual)})`,
        );
    }
    return actual;
}

function createMaxBytesTransform(maxBytes: number) {
    let bytesRead = 0;
    return new Transform({transform(chunk: Buffer, _encoding, callback) {
        bytesRead += chunk.byteLength;
        if (bytesRead > maxBytes) {
            callback(new Error(
                `Exact PDF fixture exceeds the ${maxBytes}-byte resource limit while streaming`,
            ));
            return;
        }
        callback(null, chunk);
    }});
}

async function streamCopyFile(
    sourcePath: string,
    targetPath: string,
    maxBytes: number,
    signal?: AbortSignal,
) {
    assertMaxBytes(maxBytes);
    throwIfAborted(signal);
    await pipeline(
        createReadStream(sourcePath, {highWaterMark: 1024 * 1024}),
        createMaxBytesTransform(maxBytes),
        createWriteStream(targetPath, {flags: 'wx'}),
        {signal},
    );
}

/**
 * Stage one fixture without silently replacing a failed clone with a green
 * clone-only result. Linux filesystems may reject FICLONE_FORCE, so auto mode
 * records the tested streaming fallback explicitly.
 */
export async function copyExactPdfFixture(
    sourcePath: string,
    targetPath: string,
    options: IExactPdfCopyOptions = {},
): Promise<{mode: TExactPdfFixtureCopyMode;}> {
    const copyFileImpl = options.copyFileImpl ?? copyFile;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    assertMaxBytes(maxBytes);
    const streamCopyImpl = options.streamCopyImpl
        ?? ((sourcePathToCopy, targetPathToCopy, signal) => streamCopyFile(
            sourcePathToCopy,
            targetPathToCopy,
            maxBytes,
            signal,
        ));
    const syncFileImpl = options.syncFileImpl ?? fsyncFile;
    const mode = options.mode ?? 'auto';
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(dirname(targetPath), {recursive: true});
    throwIfAborted(options.signal);
    try {
        let copyMode: TExactPdfFixtureCopyMode;
        if (mode === 'stream') {
            await raceWithAbort(
                streamCopyImpl(sourcePath, temporaryPath, options.signal),
                options.signal,
            );
            copyMode = 'stream';
        } else {
            try {
                throwIfAborted(options.signal);
                await raceWithAbort(
                    copyFileImpl(sourcePath, temporaryPath, fsConstants.COPYFILE_FICLONE_FORCE),
                    options.signal,
                );
                throwIfAborted(options.signal);
                copyMode = 'clone';
            } catch (error) {
                if (options.signal?.aborted) {
                    throw error;
                }
                if (mode === 'clone' || !isCloneUnsupportedError(error)) {
                    throw new Error(
                        `Exact PDF fixture clone staging failed for ${sourcePath}`,
                        {cause: error},
                    );
                }
                // A failed clone may have left a partial destination behind.
                // Remove it before the streaming implementation opens the same
                // temporary path with exclusive-create semantics.
                await unlink(temporaryPath).catch(() => undefined);
                throwIfAborted(options.signal);
                await raceWithAbort(
                    streamCopyImpl(sourcePath, temporaryPath, options.signal),
                    options.signal,
                );
                copyMode = 'stream';
            }
        }

        throwIfAborted(options.signal);
        await raceWithAbort(syncFileImpl(temporaryPath), options.signal);
        throwIfAborted(options.signal);
        await raceWithAbort(rename(temporaryPath, targetPath), options.signal);
        return {mode: copyMode};
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

function assertTimeout(timeoutMs: number) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`Timeout must be a positive integer: ${timeoutMs}`);
    }
}

async function hashFile(path: string, timeoutMs: number, signal?: AbortSignal) {
    assertTimeout(timeoutMs);
    throwIfAborted(signal);
    return new Promise<string>((resolvePromise, reject) => {
        const digest = createHash('sha256');
        const stream = createReadStream(path, {highWaterMark: 1024 * 1024});
        let settled = false;
        const timer = setTimeout(() => {
            fail(new Error(`SHA-256 for ${path} exceeded ${timeoutMs}ms`));
        }, timeoutMs);
        const settle = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            callback();
        };
        const fail = (error: Error) => settle(() => {
            stream.destroy(error);
            reject(error);
        });
        const onAbort = () => {
            const reason: unknown = signal?.reason;
            const error = reason instanceof Error ? reason : new Error(`SHA-256 for ${path} was aborted`);
            fail(error);
        };
        signal?.addEventListener('abort', onAbort, {once: true});
        stream.on('data', chunk => digest.update(chunk));
        stream.on('error', error => settle(() => reject(error)));
        stream.on('end', () => settle(() => resolvePromise(digest.digest('hex'))));
        if (signal?.aborted) {
            onAbort();
        }
    });
}

async function runQpdf(
    qpdfPath: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
) {
    try {
        throwIfAborted(signal);
        return await execFileAsync(qpdfPath, args, {
            encoding: 'utf8',
            maxBuffer: 128 * 1024,
            signal,
            timeout: timeoutMs,
        });
    } catch (error) {
        throw new Error(`qpdf failed for ${args.at(-1) ?? '<fixture>'}`, {cause: error});
    }
}

export async function readExactPdfFixtureIdentity(
    path: string,
    options: IExactPdfIdentityOptions = {},
): Promise<IExactPdfFixtureIdentity> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertTimeout(timeoutMs);
    throwIfAborted(options.signal);
    const qpdfPath = getPdfNativeToolPaths().qpdf;
    assertMaxBytes(maxBytes);
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
        throw new Error(`Exact PDF fixture must be a regular file: ${path}`);
    }
    if (fileStat.size > maxBytes) {
        throw new Error(`Exact PDF fixture exceeds the ${maxBytes}-byte resource limit: ${path}`);
    }
    const siblingController = new AbortController();
    const onAbort = () => siblingController.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, {once: true});
    let pageCountOutput: string;
    let sha256: string;
    try {
        [
            {stdout: pageCountOutput},
            sha256,
        ] = await Promise.all([
            runQpdf(qpdfPath, [
                '--show-npages',
                path,
            ], timeoutMs, siblingController.signal),
            hashFile(path, timeoutMs, siblingController.signal),
        ]);
    } catch (error) {
        siblingController.abort(error);
        throw error;
    } finally {
        options.signal?.removeEventListener('abort', onAbort);
    }
    await runQpdf(qpdfPath, [
        '--check',
        path,
    ], timeoutMs, options.signal);
    const pages = Number.parseInt(pageCountOutput.trim(), 10);
    if (!Number.isSafeInteger(pages) || pages <= 0) {
        throw new Error(`qpdf returned an invalid page count for ${path}: ${pageCountOutput}`);
    }
    return {
        bytes: fileStat.size,
        pages,
        sha256,
    };
}

export async function stageExactPdfFixture(
    options: IStageExactPdfFixtureOptions,
): Promise<IExactPdfFixtureStageResult> {
    const sourcePath = resolve(options.sourcePath);
    const stagedPath = resolve(options.outputPath);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const operation = createStageAbortController(timeoutMs, options.signal);
    const operationOptions = {
        ...options,
        signal: operation.signal,
        timeoutMs,
    };
    let stagedOutputCreated = false;
    try {
        const sourceIdentity = await readExactPdfFixtureIdentity(sourcePath, operationOptions);
        validateExactPdfFixtureIdentity(sourceIdentity, options.expectedIdentity);
        const copy = await copyExactPdfFixture(sourcePath, stagedPath, operationOptions);
        stagedOutputCreated = true;
        const stagedIdentity = await readExactPdfFixtureIdentity(stagedPath, operationOptions);
        validateExactPdfFixtureIdentity(stagedIdentity, options.expectedIdentity);
        return {
            copyMode: copy.mode,
            sourceIdentity,
            sourcePath,
            stagedIdentity,
            stagedPath,
        };
    } catch (error) {
        if (stagedOutputCreated) {
            await unlink(stagedPath).catch(() => undefined);
        }
        throw error;
    } finally {
        operation.dispose();
    }
}

type TExactPdfFixtureProfileName = keyof typeof EXACT_PDF_FIXTURE_MANIFEST;

function isExactPdfFixtureProfileName(value: string): value is TExactPdfFixtureProfileName {
    return Object.hasOwn(EXACT_PDF_FIXTURE_MANIFEST, value);
}

export function resolveExactPdfFixtureExpectation(
    env: NodeJS.ProcessEnv = process.env,
): IExactPdfFixtureExpectation {
    const configuredProfile = env.EVB_EXACT_FIXTURE_PROFILE?.trim();
    if (configuredProfile === undefined || configuredProfile === '') {
        throw Object.assign(new Error(
            'Exact fixture opt-in boundary: a runner must set EVB_EXACT_FIXTURE_PROFILE '
            + `to one of ${Object.keys(EXACT_PDF_FIXTURE_MANIFEST).join(', ')}; `
            + 'fixture absence cannot produce a green exact-fixture lane',
        ), {code: EXACT_FIXTURE_OPT_IN_REQUIRED});
    }
    const profileName = configuredProfile;
    if (!isExactPdfFixtureProfileName(profileName)) {
        throw new Error(
            `Unknown EVB_EXACT_FIXTURE_PROFILE '${profileName}'. `
            + `Expected one of ${Object.keys(EXACT_PDF_FIXTURE_MANIFEST).join(', ')}`,
        );
    }
    const profile = EXACT_PDF_FIXTURE_MANIFEST[profileName];

    const identityOverrideKeys = [
        'EVB_EXACT_FIXTURE_BYTES',
        'EVB_EXACT_FIXTURE_PAGES',
        'EVB_EXACT_FIXTURE_SHA256',
    ] as const;
    const identityOverrides = identityOverrideKeys.filter(key => {
        const value = env[key];
        return value !== undefined && value.trim() !== '';
    });
    if (identityOverrides.length > 0) {
        throw new Error(
            `Exact fixture identity override is not supported: ${identityOverrides.join(', ')}`,
        );
    }
    return profile;
}

function readArgument(argv: string[], name: string) {
    const prefix = `--${name}=`;
    return argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main(argv = process.argv.slice(2)) {
    const sourcePath = readArgument(argv, 'source') ?? process.env.EVB_EXACT_FIXTURE_SOURCE?.trim();
    const outputPath = readArgument(argv, 'output') ?? process.env.EVB_EXACT_FIXTURE_OUTPUT?.trim();
    if (!sourcePath || !outputPath) {
        throw new Error(
            'Exact fixture staging requires --source=<path> and --output=<path> '
            + '(or EVB_EXACT_FIXTURE_SOURCE/EVB_EXACT_FIXTURE_OUTPUT)',
        );
    }
    const expectation = resolveExactPdfFixtureExpectation();
    const result = await stageExactPdfFixture({
        expectedIdentity: expectation,
        maxBytes: process.env.EVB_EXACT_FIXTURE_MAX_BYTES
            ? asPositiveInteger(process.env.EVB_EXACT_FIXTURE_MAX_BYTES, 'EVB_EXACT_FIXTURE_MAX_BYTES')
            : DEFAULT_MAX_BYTES,
        mode: (readArgument(argv, 'mode') ?? process.env.EVB_EXACT_FIXTURE_STAGE_MODE ?? 'auto') as 'auto' | TExactPdfFixtureCopyMode,
        outputPath,
        sourcePath,
        timeoutMs: process.env.EVB_EXACT_FIXTURE_TIMEOUT_MS
            ? asPositiveInteger(process.env.EVB_EXACT_FIXTURE_TIMEOUT_MS, 'EVB_EXACT_FIXTURE_TIMEOUT_MS')
            : DEFAULT_TIMEOUT_MS,
    });
    process.stdout.write(`${JSON.stringify({
        ...result,
        expectedIdentity: expectation,
    }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch(error => {
        console.error(getErrorMessage(error));
        process.exitCode = 1;
    });
}
