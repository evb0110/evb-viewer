import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import { withDefinedCommandOptions } from '@electron/native-tools/withDefinedCommandOptions';
import type { IProcessResult } from '@electron/native-tools/processResult';

/**
 * Build IDs of the native tools, keyed by binary name, embedded by
 * `scripts/build-electron.mjs` from the same source hash `scripts/native-build-id.mjs`
 * compiles into each binary. Undefined when the code runs from source (tests, tsx).
 */
declare const __EVB_NATIVE_BUILD_IDS__: Readonly<Record<string, string>> | undefined;

export interface IRunNativeToolCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    timeoutResetsOnStdout?: boolean;
    longLived?: boolean;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    rejectOnStdoutTruncation?: boolean;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    commandLabel?: string;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onSpawn?: (pid: number) => void;
    onClose?: () => void;
    onTerminationProof?: (proof: Promise<boolean>) => void;
    terminationGraceMs?: number;
    stdin?: AsyncIterable<string>;
    log?: (level: 'debug' | 'warn' | 'error', message: string) => void;
}

// A packaged app ships the binaries built with it, so only a development
// checkout can pair the app with a binary built from other sources.
const expectedBuildIds = typeof __EVB_NATIVE_BUILD_IDS__ === 'undefined'
    || fileURLToPath(import.meta.url).includes('app.asar')
    ? null
    : __EVB_NATIVE_BUILD_IDS__;
const verifiedBuilds = new Map<string, Promise<void>>();

export async function runNativeToolCommand(
    command: string,
    args: string[],
    options: IRunNativeToolCommandOptions = {},
): Promise<IProcessResult> {
    await assertNativeToolBuild(command);
    return runNativeCommand(command, args, createRunCommandOptions(options));
}

/**
 * Fails when an EVB native binary was built from other native sources than this
 * app, checked once per binary path.
 */
export function assertNativeToolBuild(command: string) {
    const baseName = basename(command).toLowerCase().replace(/\.exe$/u, '');
    const expectedBuildId = expectedBuildIds?.[baseName];
    if (expectedBuildId === undefined) {
        return Promise.resolve();
    }
    let verified = verifiedBuilds.get(command);
    if (verified === undefined) {
        verified = runNativeCommand(command, ['--build-id'], createRunCommandOptions({
            maxStdoutBytes: 256,
            commandLabel: `${baseName}(build-id)`,
        })).then((result) => {
            const actualBuildId = result.stdout.trim();
            if (actualBuildId !== expectedBuildId) {
                throw new Error(
                    `${baseName} at ${command} was built from other native sources `
                    + `(binary build ${actualBuildId || '<empty>'}, app build ${expectedBuildId}). `
                    + `Rebuild it with pnpm run build:${baseName.slice('evb-'.length)}.`,
                );
            }
        });
        verified.catch(() => verifiedBuilds.delete(command));
        verifiedBuilds.set(command, verified);
    }
    return verified;
}

function createRunCommandOptions(options: IRunNativeToolCommandOptions) {
    return withDefinedCommandOptions({
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
    }, options);
}
