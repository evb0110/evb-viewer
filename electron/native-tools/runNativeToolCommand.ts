import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isPdfPageOpsWasmPath} from '@node-runtime/pdfPageOpsWasmRunner';
import {isQpdfWasmPath} from '@node-runtime/qpdfWasmRunner';
import {runDesktopPageOpsWasm} from '@electron/native-tools/pdfPageOpsWorkerClient';
import {runDesktopQpdfWasm} from '@electron/native-tools/qpdfWasmWorkerClient';
import {runNativeCommand} from '@electron/native-tools/runNativeCommand';
import {withDefinedCommandOptions} from '@electron/native-tools/withDefinedCommandOptions';
import type {IProcessResult} from '@electron/native-tools/processResult';
import {mergeTerminationProofSinks, type IJobBrokerRunContext, type TTerminationProofSink} from '@electron/resources/jobBroker';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';

/**
 * Build IDs of the native tools, keyed by binary name, embedded by
 * `scripts/build-electron.mjs` from the same source hash `scripts/native-build-id.mjs`
 * compiles into each binary. Undefined when the code runs from source (tests, tsx).
 */
declare const __EVB_NATIVE_BUILD_IDS__: Readonly<Record<string, string>> | undefined;

declare const __EVB_RUNTIME_ARCHIVE_IDS__: Readonly<Record<string, string>> | undefined;

/** The same build identity the command owner validates before native execution. */
export function getNativeToolBuildIdentity(binaryName: string) {
    return typeof __EVB_NATIVE_BUILD_IDS__ === 'undefined' ? null : (__EVB_NATIVE_BUILD_IDS__[binaryName] ?? null);
}

/** Archive pins already verified when the bundled third-party tools are installed. */
export function getRuntimeToolArchiveIdentity(familyId: string) {
    return typeof __EVB_RUNTIME_ARCHIVE_IDS__ === 'undefined'
        ? null
        : (__EVB_RUNTIME_ARCHIVE_IDS__[`${familyId}-${process.platform}-${process.arch}`] ?? null);
}

export interface IRunNativeToolCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    timeoutResetsOnStdout?: boolean;
    longLived?: boolean;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    rejectOnStdoutTruncation?: boolean;
    allowedExitCodes?: readonly number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    commandLabel?: string;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onSpawn?: (pid: number) => void;
    onClose?: () => void;
    brokerRun?: IJobBrokerRunContext;
    onTerminationProof?: TTerminationProofSink;
    terminationGraceMs?: number;
    stdin?: AsyncIterable<string>;
    log?: (level: 'debug' | 'warn' | 'error', message: string) => void;
}

// A packaged app ships the binaries built with it, so only a development
// checkout can pair the app with a binary built from other sources.
const expectedBuildIds =
    typeof __EVB_NATIVE_BUILD_IDS__ === 'undefined' || fileURLToPath(import.meta.url).includes('app.asar')
        ? null
        : __EVB_NATIVE_BUILD_IDS__;
const verifiedBuilds = new Map<string, Promise<void>>();

/**
 * An EVB native binary built from other native sources than this development
 * app. It is never a reason to fall back to another engine: the fix is to
 * rebuild the binary, and a fallback would hide that.
 */
export class NativeToolBuildMismatchError extends Error {
    override name = 'NativeToolBuildMismatchError';
}

export async function runNativeToolCommand(
    command: string,
    args: string[],
    options: IRunNativeToolCommandOptions = {},
): Promise<IProcessResult> {
    const wasmTerminationProof = mergeTerminationProofSinks(options.brokerRun?.onTerminationProof, options.onTerminationProof);
    if (isPdfPageOpsWasmPath(command)) {
        try {
            return await runDesktopPageOpsWasm(command, args, {
                ...(options.signal === undefined ? {} : {signal: options.signal}),
                ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs}),
                ...(options.cancelGroup === undefined ? {} : {cancelGroup: options.cancelGroup}),
                ...(options.commandLabel === undefined ? {} : {commandLabel: options.commandLabel}),
                ...(options.maxStdoutBytes === undefined ? {} : {maxStdoutBytes: options.maxStdoutBytes}),
                ...(options.rejectOnStdoutTruncation === undefined ? {} : {rejectOnStdoutTruncation: options.rejectOnStdoutTruncation}),
                ...(wasmTerminationProof === undefined ? {} : {onTerminationProof: wasmTerminationProof}),
            });
        } finally {
            options.onClose?.();
        }
    }
    if (isQpdfWasmPath(command)) {
        try {
            return await runDesktopQpdfWasm(args, {
                wasmPath: command,
                ...(options.allowedExitCodes === undefined ? {} : {allowedExitCodes: options.allowedExitCodes}),
                ...(options.cwd === undefined ? {} : {cwd: options.cwd}),
                ...(options.signal === undefined ? {} : {signal: options.signal}),
                ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs}),
                ...(options.cancelGroup === undefined ? {} : {cancelGroup: options.cancelGroup}),
                ...(options.commandLabel === undefined ? {} : {commandLabel: options.commandLabel}),
                ...(options.maxStdoutBytes === undefined ? {} : {maxStdoutBytes: options.maxStdoutBytes}),
                ...(options.maxStderrBytes === undefined ? {} : {maxStderrBytes: options.maxStderrBytes}),
                ...(options.rejectOnStdoutTruncation === undefined ? {} : {rejectOnStdoutTruncation: options.rejectOnStdoutTruncation}),
                ...(wasmTerminationProof === undefined ? {} : {onTerminationProof: wasmTerminationProof}),
            });
        } finally {
            options.onClose?.();
        }
    }
    await assertNativeToolBuild(command, options.brokerRun);
    return runNativeCommand(command, args, createRunCommandOptions(options));
}

/**
 * Fails when an EVB native binary was built from other native sources than this
 * app, checked once per binary path.
 */
export function assertNativeToolBuild(command: string, brokerRun?: IJobBrokerRunContext) {
    const baseName = basename(command)
        .toLowerCase()
        .replace(/\.exe$/u, '');
    const expectedBuildId = expectedBuildIds?.[baseName];
    if (expectedBuildId === undefined) {
        return Promise.resolve();
    }
    let verified = verifiedBuilds.get(command);
    if (verified === undefined) {
        const probeBrokerRun: IJobBrokerRunContext | undefined =
            brokerRun === undefined
                ? undefined
                : {
                      broker: brokerRun.broker,
                      lease: brokerRun.lease,
                      onTerminationProof: brokerRun.leaseTerminationProof ?? brokerRun.onTerminationProof,
                      ...(brokerRun.leaseTerminationProof === undefined ? {} : {leaseTerminationProof: brokerRun.leaseTerminationProof}),
                  };
        verified = runNativeCommand(
            command,
            ['--build-id'],
            createRunCommandOptions({
                maxStdoutBytes: 256,
                commandLabel: `${baseName}(build-id)`,
                ...(probeBrokerRun === undefined ? {} : {brokerRun: probeBrokerRun}),
            }),
        ).then(
            (result) => {
                const actualBuildId = result.stdout.trim();
                if (actualBuildId !== expectedBuildId) {
                    throw new NativeToolBuildMismatchError(
                        `${baseName} at ${command} was built from other native sources ` +
                            `(binary build ${actualBuildId || '<empty>'}, app build ${expectedBuildId}). ` +
                            `Rebuild it with pnpm run build:${baseName.slice('evb-'.length)}.`,
                    );
                }
            },
            (error: unknown) => {
                // The check's child opens none of the caller's files, so one that
                // outlived its kill must not keep the caller from reclaiming them.
                throw getUnprovenNativeTerminationDetail(error) === undefined || !(error instanceof Error)
                    ? error
                    : new Error(error.message, {cause: error});
            },
        );
        verified.catch(() => verifiedBuilds.delete(command));
        verifiedBuilds.set(command, verified);
    }
    return verified;
}

function createRunCommandOptions(options: IRunNativeToolCommandOptions) {
    return withDefinedCommandOptions(
        {
            defaultCwdToCommandDir: true,
            prependCommandDirToPath: true,
            includeProcessEnv: true,
            windowsHide: true,
        },
        options,
    );
}
