import { basename } from 'node:path';
import {
    runNativeCommand,
    type IRunCommandOptions,
} from '@electron/native-tools/runNativeCommand';
import { withDefinedCommandOptions } from '@electron/native-tools/withDefinedCommandOptions';
import type { IProcessResult } from '@electron/native-tools/processResult';
import {
    GENERATED_RUST_NATIVE_TOOL_PROTOCOLS,
    type IGeneratedRustNativeToolCapability,
    type IGeneratedRustNativeToolProtocol,
} from '@contracts/nativeToolProtocols';
import { abortErrorFromSignal } from '@electron/utils/abort';

export interface IRunNativeToolCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    rejectOnStdoutTruncation?: boolean;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    requiredCapabilities?: readonly string[];
    commandLabel?: string;
    onStdout?: (chunk: string) => void;
    onSpawn?: (pid: number) => void;
    log?: (level: 'debug' | 'warn' | 'error', message: string) => void;
}

export class NativeToolProtocolVersionError extends Error {
    readonly toolName: string;
    readonly expectedVersion: number;
    readonly actualVersion: string;

    constructor(toolName: string, expectedVersion: number, actualVersion: string) {
        super(`${toolName} unsupported native protocol version: expected ${expectedVersion}, got ${actualVersion}`);
        this.name = 'NativeToolProtocolVersionError';
        this.toolName = toolName;
        this.expectedVersion = expectedVersion;
        this.actualVersion = actualVersion;
    }
}

export class NativeToolProtocolCapabilityError extends Error {
    readonly toolName: string;
    readonly capability: string | null;

    constructor(toolName: string, message: string, capability: string | null = null) {
        super(`${toolName} native protocol capability negotiation failed: ${message}`);
        this.name = 'NativeToolProtocolCapabilityError';
        this.toolName = toolName;
        this.capability = capability;
    }
}

interface INativeToolProtocolHandshake {
    protocolVersion: number;
    capabilities: readonly string[];
}

const nativeToolProtocolCapabilities = new Map<string, readonly IGeneratedRustNativeToolCapability[]>(
    (GENERATED_RUST_NATIVE_TOOL_PROTOCOLS as readonly IGeneratedRustNativeToolProtocol[])
        .flatMap(tool => tool.capabilities === undefined
            ? []
            : [[
                tool.binaryName,
                tool.capabilities,
            ] as const]),
);

const NATIVE_TOOL_PROTOCOL_VERSION_TIMEOUT_MS = 5_000;
const MIN_COMPATIBLE_SCAN_CLEANUP_PROTOCOL_VERSION = 9;
const expectedNativeToolProtocolVersions = new Map<string, number>(
    GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.map(tool => [
        tool.binaryName,
        tool.protocolVersion,
    ]),
);
interface IProtocolHandshake {
    controller: AbortController;
    promise: Promise<INativeToolProtocolHandshake>;
    waiters: number;
}

const nativeToolProtocolHandshakeCache = new Map<string, IProtocolHandshake>();

export async function runNativeToolCommand(
    command: string,
    args: string[],
    options: IRunNativeToolCommandOptions = {},
): Promise<IProcessResult> {
    await verifyNativeToolProtocol(command, options);
    return runNativeCommand(command, args, createBaseRunCommandOptions(options));
}

export async function verifyNativeToolProtocol(command: string, options: IRunNativeToolCommandOptions = {}) {
    const toolName = getNativeToolName(command);
    if (toolName === null) {
        return;
    }
    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }

    const cachedHandshake = nativeToolProtocolHandshakeCache.get(command);
    if (cachedHandshake) {
        const handshake = await waitForProtocolHandshake(cachedHandshake, options.signal);
        assertRequiredCapabilities(toolName, handshake, options.requiredCapabilities);
        return handshake;
    }

    const controller = new AbortController();
    const handshake: IProtocolHandshake = {
        controller,
        promise: runNativeToolProtocolHandshake(command, toolName, options, controller.signal)
            .catch((error: unknown) => {
                if (nativeToolProtocolHandshakeCache.get(command) === handshake) {
                    nativeToolProtocolHandshakeCache.delete(command);
                }
                throw error;
            }),
        waiters: 0,
    };
    nativeToolProtocolHandshakeCache.set(command, handshake);
    const result = await waitForProtocolHandshake(handshake, options.signal);
    assertRequiredCapabilities(toolName, result, options.requiredCapabilities);
    return result;
}

function waitForProtocolHandshake(handshake: IProtocolHandshake, signal: AbortSignal | undefined) {
    handshake.waiters += 1;
    let released = false;
    const release = () => {
        if (released) {
            return;
        }
        released = true;
        handshake.waiters -= 1;
        if (handshake.waiters === 0 && !handshake.controller.signal.aborted) {
            handshake.controller.abort(new Error('All native tool protocol callers canceled'));
        }
    };
    if (signal === undefined) {
        return handshake.promise.finally(release);
    }
    if (signal.aborted) {
        release();
        return Promise.reject(abortErrorFromSignal(signal));
    }

    return new Promise<INativeToolProtocolHandshake>((resolve, reject) => {
        const handleAbort = () => {
            signal.removeEventListener('abort', handleAbort);
            release();
            reject(abortErrorFromSignal(signal));
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        void handshake.promise.then(
            result => {
                signal.removeEventListener('abort', handleAbort);
                release();
                resolve(result);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', handleAbort);
                release();
                reject(error);
            },
        );
    });
}

function getNativeToolName(command: string) {
    const baseName = basename(command).toLowerCase();
    const toolName = baseName.endsWith('.exe') ? baseName.slice(0, -4) : baseName;
    return toolName.startsWith('evb-') ? toolName : null;
}

async function runNativeToolProtocolHandshake(
    command: string,
    toolName: string,
    options: IRunNativeToolCommandOptions,
    signal: AbortSignal,
): Promise<INativeToolProtocolHandshake> {
    const expectedVersion = expectedNativeToolProtocolVersions.get(toolName);
    if (expectedVersion === undefined) {
        throw new NativeToolProtocolVersionError(toolName, -1, 'unknown tool');
    }

    const commandOptions = createProtocolHandshakeCommandOptions(options, signal);
    commandOptions.timeoutMs = NATIVE_TOOL_PROTOCOL_VERSION_TIMEOUT_MS;
    commandOptions.commandLabel = `${toolName}(protocol-version)`;
    commandOptions.maxStdoutBytes = 128;
    commandOptions.maxStderrBytes = 4_096;
    commandOptions.allowedExitCodes = [0];
    const result = await runNativeCommand(command, ['--protocol-version'], commandOptions);
    const handshake = parseProtocolHandshake(toolName, expectedVersion, result.stdout.trim());
    const knownCapabilities = nativeToolProtocolCapabilities.get(toolName) ?? [];
    if (handshake.capabilities === undefined
        && toolName === 'evb-scan-cleanup'
        && handshake.protocolVersion >= 10) {
        throw new NativeToolProtocolCapabilityError(
            toolName,
            'scalar revisions cannot advertise revision-10 capabilities',
        );
    }
    const claimedTooEarly = knownCapabilities.find(capability => (
        handshake.capabilities?.includes(capability.name) === true
        && capability.introducedIn > handshake.protocolVersion
    ));
    if (claimedTooEarly !== undefined) {
        throw new NativeToolProtocolCapabilityError(
            toolName,
            `capability ${claimedTooEarly.name} was introduced in revision ${claimedTooEarly.introducedIn}`,
            claimedTooEarly.name,
        );
    }
    const capabilities = handshake.capabilities ?? knownCapabilities
        .filter(capability => capability.introducedIn <= handshake.protocolVersion)
        .map(capability => capability.name);
    const missingRequired = knownCapabilities
        .filter(capability => capability.required && capability.introducedIn <= handshake.protocolVersion)
        .find(capability => !capabilities.includes(capability.name));
    if (missingRequired !== undefined) {
        throw new NativeToolProtocolCapabilityError(toolName, `required capability ${missingRequired.name} is missing`, missingRequired.name);
    }
    if (handshake.protocolVersion > expectedVersion) {
        throw new NativeToolProtocolVersionError(toolName, expectedVersion, String(handshake.protocolVersion));
    }
    const minimumCompatibleVersion = toolName === 'evb-scan-cleanup'
        ? MIN_COMPATIBLE_SCAN_CLEANUP_PROTOCOL_VERSION
        : expectedVersion;
    if (handshake.protocolVersion < minimumCompatibleVersion) {
        throw new NativeToolProtocolVersionError(toolName, expectedVersion, String(handshake.protocolVersion));
    }
    return {
        protocolVersion: handshake.protocolVersion,
        capabilities,
    };
}

function parseProtocolHandshake(toolName: string, expectedVersion: number, text: string): {
    protocolVersion: number;
    capabilities?: string[] | undefined
} {
    const version = Number.parseInt(text, 10);
    if (Number.isSafeInteger(version) && version.toString() === text) {
        if (version < 1) {
            throw new NativeToolProtocolVersionError(toolName, expectedVersion, text || '<empty>');
        }
        return {protocolVersion: version};
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new NativeToolProtocolVersionError(toolName, expectedVersion, text || '<empty>');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new NativeToolProtocolCapabilityError(toolName, 'handshake must be an object');
    }
    const record = value as Record<string, unknown>;
    if (!Number.isSafeInteger(record.protocolVersion) || typeof record.protocolVersion !== 'number') {
        throw new NativeToolProtocolCapabilityError(toolName, 'protocolVersion must be a safe integer');
    }
    if (record.capabilities === undefined) {
        throw new NativeToolProtocolCapabilityError(toolName, 'structured handshake must include capabilities');
    }
    if (!Array.isArray(record.capabilities)
        || record.capabilities.some(capability => typeof capability !== 'string' || capability.length === 0)) {
        throw new NativeToolProtocolCapabilityError(toolName, 'capabilities must be a list of non-empty names');
    }
    return {
        protocolVersion: record.protocolVersion,
        capabilities: record.capabilities as string[] | undefined,
    };
}

function assertRequiredCapabilities(
    toolName: string,
    handshake: INativeToolProtocolHandshake,
    requiredCapabilities: readonly string[] | undefined,
) {
    for (const capability of requiredCapabilities ?? []) {
        if (!handshake.capabilities.includes(capability)) {
            throw new NativeToolProtocolCapabilityError(toolName, `required capability ${capability} is missing`, capability);
        }
    }
}

function createProtocolHandshakeCommandOptions(options: IRunNativeToolCommandOptions, signal: AbortSignal): IRunCommandOptions {
    const handshakeOptions: IRunNativeToolCommandOptions = {};
    if (options.cwd !== undefined) {
        handshakeOptions.cwd = options.cwd;
    }
    if (options.env !== undefined) {
        handshakeOptions.env = options.env;
    }
    if (options.log !== undefined) {
        handshakeOptions.log = options.log;
    }
    handshakeOptions.signal = signal;
    return createBaseRunCommandOptions(handshakeOptions);
}

function createBaseRunCommandOptions(options: IRunNativeToolCommandOptions): IRunCommandOptions {
    return withDefinedCommandOptions({
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
    }, options);
}
