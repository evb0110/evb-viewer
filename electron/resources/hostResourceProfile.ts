import type { App } from 'electron';
import {
    availableParallelism,
    cpus,
    totalmem,
} from 'node:os';
import {
    HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX,
    type IHostGpuStatusSnapshot,
    type IHostResourceProfileSnapshot,
    type TPerformanceMode,
    resolveDetectedHostResourceTier,
    resolveEffectiveHostResourceTier,
} from '@contracts/hostResourceProfile';
import { isRecord } from '@contracts/runtimeGuards';
import { PROCESS_SAFE_MODE_ARGUMENT } from '@electron/processDeathRecovery';

interface ICreateHostResourceProfileSnapshotOptions {
    logicalCpus: number;
    totalRamBytes: number;
    safeMode: boolean;
    gpuStatus?: IHostGpuStatusSnapshot;
    performanceMode: TPerformanceMode;
}

export interface IInitializeHostResourceProfileOptions {
    app: Pick<App, 'getGPUFeatureStatus'>;
    performanceMode: TPerformanceMode;
    argv?: readonly string[];
    availableParallelism?: () => number;
    cpus?: () => readonly unknown[];
    totalmem?: () => number;
}

let hostResourceProfileSnapshot: IHostResourceProfileSnapshot | null = null;

function readCpuCountFromCpus(options: IInitializeHostResourceProfileOptions) {
    const readCpus = options.cpus ?? cpus;
    try {
        const value = readCpus().length;
        return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch {
        return 0;
    }
}

function readLogicalCpuCount(options: IInitializeHostResourceProfileOptions) {
    const readAvailableParallelism = options.availableParallelism ?? availableParallelism;
    try {
        const value = readAvailableParallelism();
        if (Number.isSafeInteger(value) && value > 0) {
            return value;
        }
    } catch {
        return readCpuCountFromCpus(options);
    }
    return readCpuCountFromCpus(options);
}

function readTotalRamBytes(options: IInitializeHostResourceProfileOptions) {
    const readTotalmem = options.totalmem ?? totalmem;
    try {
        const value = readTotalmem();
        return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch {
        return 0;
    }
}

function readGpuStatus(options: IInitializeHostResourceProfileOptions) {
    try {
        const value: unknown = options.app.getGPUFeatureStatus();
        if (!isRecord(value)) {
            return undefined;
        }
        const snapshot: Record<string, string> = {};
        for (const [
            featureName,
            status,
        ] of Object.entries(value)) {
            if (typeof status !== 'string') {
                return undefined;
            }
            snapshot[featureName] = status;
        }
        return snapshot;
    } catch {
        return undefined;
    }
}

function createHostResourceProfileSnapshot(
    options: ICreateHostResourceProfileSnapshotOptions,
): IHostResourceProfileSnapshot {
    const detectedTier = resolveDetectedHostResourceTier(options);
    const gpuStatus = options.gpuStatus === undefined
        ? undefined
        : Object.freeze({...options.gpuStatus});
    return Object.freeze({
        logicalCpus: options.logicalCpus,
        totalRamBytes: options.totalRamBytes,
        safeMode: options.safeMode,
        ...(gpuStatus === undefined ? {} : {gpuStatus}),
        detectedTier,
        performanceMode: options.performanceMode,
        tier: resolveEffectiveHostResourceTier(
            detectedTier,
            options.performanceMode,
        ),
    });
}

export function initializeHostResourceProfile(
    options: IInitializeHostResourceProfileOptions,
) {
    if (hostResourceProfileSnapshot) {
        throw new Error('Host resource profile is already initialized');
    }

    const gpuStatus = readGpuStatus(options);
    hostResourceProfileSnapshot = createHostResourceProfileSnapshot({
        logicalCpus: readLogicalCpuCount(options),
        totalRamBytes: readTotalRamBytes(options),
        safeMode: (options.argv ?? process.argv).includes(PROCESS_SAFE_MODE_ARGUMENT),
        ...(gpuStatus === undefined ? {} : {gpuStatus}),
        performanceMode: options.performanceMode,
    });
    return hostResourceProfileSnapshot;
}

export function tryGetHostResourceProfileSnapshot() {
    return hostResourceProfileSnapshot;
}

export function getHostResourceProfileSnapshot() {
    if (!hostResourceProfileSnapshot) {
        throw new Error('Host resource profile was not initialized');
    }
    return hostResourceProfileSnapshot;
}

export function encodeHostResourceProfileArgument(
    snapshot: IHostResourceProfileSnapshot,
) {
    const encodedSnapshot = Buffer
        .from(JSON.stringify(snapshot), 'utf8')
        .toString('base64url');
    return `${HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX}${encodedSnapshot}`;
}
