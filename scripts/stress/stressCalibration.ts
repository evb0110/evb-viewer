import { getErrorMessage } from '@contracts/getErrorMessage';
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Page } from 'puppeteer-core';
import type {IElectronAPI} from '@contracts/electronApi';
import type {THostResourceTier} from '@contracts/hostResourceProfile';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import { percentile } from '@scripts/stress/percentile';
import type {
    IStressCalibrationCheck,
    IStressCalibrationProbe,
    IStressCalibrationRecord,
    IStressCgroupLimits,
    IStressHostConstraintHint,
    IStressHostConstraintVerification,
    IStressHostProfile,
    TStressCalibrationVerdict,
} from '@scripts/stress/stressTypes';

const MAIN_LOOP_ITERATIONS = 6_000_000;
const RAF_SAMPLE_COUNT = 60;
const DISK_READ_BYTES = 64 * 1024 * 1024;

interface ICalibrationWindow extends Omit<Window, 'electronAPI'> { electronAPI?: Pick<IElectronAPI, 'host'>; }

interface IInPageCalibration {
    mainThreadLoopMs: number;
    workerLoopMs: number | null;
    rafGapsMs: number[];
    jsHeapSizeLimitBytes: number | null;
    detectedTier: THostResourceTier | null;
}

/**
 * Pure verdicts so a unit test can pin the thresholds without a browser.
 * "constraint-not-effective" means the profile asked for a slowdown that the
 * probe could not observe; "constraint-excessive" means the host is so much
 * slower than expected that scenario numbers would not be comparable.
 */
export function evaluateStressCalibration(
    profile: IStressHostProfile,
    unthrottled: IStressCalibrationProbe | null,
    throttled: IStressCalibrationProbe,
): IStressCalibrationCheck[] {
    const checks: IStressCalibrationCheck[] = [];
    const expectation = profile.calibration;

    if (profile.cpuThrottlingRate > 1) {
        if (!unthrottled || unthrottled.mainThreadLoopMs <= 0) {
            checks.push({
                check: 'renderer-slowdown',
                verdict: 'unverifiable',
                detail: 'no unthrottled probe to compare against',
            });
        } else {
            const ratio = throttled.mainThreadLoopMs / unthrottled.mainThreadLoopMs;
            const detail = `main-thread loop ${unthrottled.mainThreadLoopMs.toFixed(0)}ms -> ${throttled.mainThreadLoopMs.toFixed(0)}ms (x${ratio.toFixed(2)}, expected x${expectation.rendererSlowdownMin}-${expectation.rendererSlowdownMax})`;
            if (ratio < expectation.rendererSlowdownMin) {
                checks.push({
                    check: 'renderer-slowdown',
                    verdict: 'constraint-not-effective',
                    detail,
                });
            } else if (ratio > expectation.rendererSlowdownMax) {
                checks.push({
                    check: 'renderer-slowdown',
                    verdict: 'constraint-excessive',
                    detail,
                });
            } else {
                checks.push({
                    check: 'renderer-slowdown',
                    verdict: 'met',
                    detail,
                });
            }
        }

        if (unthrottled?.workerLoopMs && throttled.workerLoopMs) {
            const workerRatio = throttled.workerLoopMs / unthrottled.workerLoopMs;
            checks.push({
                check: 'worker-unthrottled',
                verdict: workerRatio < 1.6 ? 'met' : 'constraint-excessive',
                detail: `worker loop ratio x${workerRatio.toFixed(2)}; CDP throttling must leave workers alone`,
            });
        }
    }

    if (expectation.jsHeapSizeLimitMaxBytes !== null) {
        if (throttled.jsHeapSizeLimitBytes === null) {
            checks.push({
                check: 'js-heap-limit',
                verdict: 'unverifiable',
                detail: 'performance.memory.jsHeapSizeLimit unavailable in this renderer',
            });
        } else {
            const withinCap = throttled.jsHeapSizeLimitBytes <= expectation.jsHeapSizeLimitMaxBytes;
            checks.push({
                check: 'js-heap-limit',
                verdict: withinCap ? 'met' : 'constraint-not-effective',
                detail: `jsHeapSizeLimit=${(throttled.jsHeapSizeLimitBytes / 1024 / 1024).toFixed(0)} MiB, cap ${(expectation.jsHeapSizeLimitMaxBytes / 1024 / 1024).toFixed(0)} MiB (--js-flags may not reach the renderer)`,
            });
        }
    }

    if (expectation.expectedTier !== null) {
        checks.push({
            check: 'host-tier',
            verdict: throttled.detectedTier === expectation.expectedTier ? 'met' : 'constraint-not-effective',
            detail: `effective app tier '${throttled.detectedTier ?? 'unknown'}', expected '${expectation.expectedTier}'`,
        });
    }

    return checks;
}

async function probeInPage(page: Page) {
    return evaluateInPage(page, async (iterations: number, rafSamples: number): Promise<IInPageCalibration> => {
        const loop = (count: number) => {
            let acc = 0;
            for (let index = 0; index < count; index += 1) {
                acc = (acc + index * 2654435761) % 4294967296;
            }
            return acc;
        };
        const mainStart = performance.now();
        loop(iterations);
        const mainThreadLoopMs = performance.now() - mainStart;

        let workerLoopMs: number | null = null;
        try {
            const source = 'self.onmessage = (event) => { const start = performance.now(); let acc = 0; for (let i = 0; i < event.data; i += 1) { acc = (acc + i * 2654435761) % 4294967296; } self.postMessage(performance.now() - start + (acc === -1 ? 1 : 0)); };';
            const blobUrl = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
            workerLoopMs = await new Promise<number | null>((resolve) => {
                const worker = new Worker(blobUrl);
                const timer = setTimeout(() => {
                    worker.terminate();
                    resolve(null);
                }, 20_000);
                worker.onmessage = (event: MessageEvent<number>) => {
                    clearTimeout(timer);
                    worker.terminate();
                    resolve(event.data);
                };
                worker.onerror = () => {
                    clearTimeout(timer);
                    worker.terminate();
                    resolve(null);
                };
                worker.postMessage(iterations);
            });
            URL.revokeObjectURL(blobUrl);
        } catch {
            workerLoopMs = null;
        }

        const rafGapsMs: number[] = [];
        await new Promise<void>((resolve) => {
            let previous = performance.now();
            let remaining = rafSamples;
            const tick = () => {
                const now = performance.now();
                rafGapsMs.push(now - previous);
                previous = now;
                remaining -= 1;
                if (remaining <= 0) {
                    resolve();
                    return;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });

        const memory = (performance as Performance & {memory?: {jsHeapSizeLimit?: number}}).memory;
        return {
            mainThreadLoopMs,
            workerLoopMs,
            rafGapsMs,
            jsHeapSizeLimitBytes: typeof memory?.jsHeapSizeLimit === 'number' ? memory.jsHeapSizeLimit : null,
            detectedTier: (window as ICalibrationWindow).electronAPI?.host.getResourceProfile()?.tier ?? null,
        };
    }, MAIN_LOOP_ITERATIONS, RAF_SAMPLE_COUNT);
}

async function measureDiskRead(path: string | null) {
    if (!path) {
        return null;
    }
    const handle = await open(path, 'r');
    try {
        const chunk = Buffer.alloc(4 * 1024 * 1024);
        const started = performance.now();
        let remaining = DISK_READ_BYTES;
        let position = 0;
        while (remaining > 0) {
            const {bytesRead} = await handle.read(chunk, 0, chunk.length, position);
            if (bytesRead === 0) {
                break;
            }
            remaining -= bytesRead;
            position += bytesRead;
        }
        return performance.now() - started;
    } finally {
        await handle.close();
    }
}

export async function probeStressCalibration(page: Page, options: {diskReadPath: string | null}): Promise<IStressCalibrationProbe> {
    const inPage = await probeInPage(page);
    const diskRead64MiBMs = await measureDiskRead(options.diskReadPath);
    return {
        mainThreadLoopMs: inPage.mainThreadLoopMs,
        workerLoopMs: inPage.workerLoopMs,
        rafP50Ms: percentile(inPage.rafGapsMs, 50),
        rafP95Ms: percentile(inPage.rafGapsMs, 95),
        jsHeapSizeLimitBytes: inPage.jsHeapSizeLimitBytes,
        diskRead64MiBMs,
        detectedTier: inPage.detectedTier,
    };
}

/** Tolerance for cgroup values that systemd rounds (CPUQuota=100% is stored as `100000 100000`). */
const CGROUP_LIMIT_TOLERANCE = 0.1;

/** cgroup v2 `cpu.max` is `"<quota> <period>"` or `"max"`; `memory.max` is bytes or `"max"`. */
export function parseCgroupLimits(cpuMax: string, memoryMax: string): IStressCgroupLimits {
    const cpuParts = cpuMax.trim().split(/\s+/u);
    const quota = Number(cpuParts[0]);
    const period = Number(cpuParts[1] ?? '100000');
    const cpus = cpuParts[0] === 'max' || !Number.isFinite(quota) || !Number.isFinite(period) || period <= 0
        ? null
        : quota / period;
    const memory = Number(memoryMax.trim());
    const memoryBytes = memoryMax.trim() === 'max' || !Number.isFinite(memory) ? null : memory;
    return {
        cpus,
        memoryBytes,
    };
}

function withinTolerance(actual: number, expected: number) {
    return Math.abs(actual - expected) <= expected * CGROUP_LIMIT_TOLERANCE;
}

/**
 * Pure: an unlimited cgroup, or one whose limits differ from the profile's
 * declared CPU and memory ceilings by more than the tolerance, is not the
 * constraint the profile promised.
 */
export function evaluateCgroupConstraint(limits: IStressCgroupLimits, hint: IStressHostConstraintHint): IStressHostConstraintVerification {
    const problems: string[] = [];
    if (limits.cpus === null) {
        problems.push('cpu.max is unlimited');
    } else if (!withinTolerance(limits.cpus, hint.expectedCpus)) {
        problems.push(`cpu.max allows ${limits.cpus.toFixed(2)} CPUs, profile expects ${hint.expectedCpus}`);
    }
    if (limits.memoryBytes === null) {
        problems.push('memory.max is unlimited');
    } else if (!withinTolerance(limits.memoryBytes, hint.expectedMemoryBytes)) {
        problems.push(`memory.max is ${(limits.memoryBytes / 1024 / 1024).toFixed(0)} MiB, profile expects ${(hint.expectedMemoryBytes / 1024 / 1024).toFixed(0)} MiB`);
    }
    const cpuDetail = limits.cpus === null ? 'unlimited' : `${limits.cpus} CPUs`;
    const memoryDetail = limits.memoryBytes === null
        ? 'unlimited'
        : `${(limits.memoryBytes / 1024 / 1024).toFixed(0)} MiB`;
    return {
        verified: problems.length === 0,
        detail: problems.length === 0
            ? `cgroup limits match the profile (${cpuDetail}, ${memoryDetail})`
            : problems.join('; '),
    };
}

/**
 * Linux cgroup v2 only. Reads the cpu.max and memory.max of the runner's own
 * cgroup, which Electron inherits when the whole runner is launched under
 * `systemd-run --scope`, and compares them with what the profile declared.
 */
export function readOwnCgroupConstraint(platform: NodeJS.Platform, hint: IStressHostConstraintHint): IStressHostConstraintVerification {
    if (platform !== 'linux') {
        return {
            verified: false,
            detail: `cgroup verification only exists on linux (platform=${platform})`,
        };
    }
    try {
        const cgroupLine = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').find(line => line.startsWith('0::'));
        if (!cgroupLine) {
            return {
                verified: false,
                detail: 'cgroup v2 unified hierarchy not found in /proc/self/cgroup',
            };
        }
        const cgroupPath = cgroupLine.slice('0::'.length);
        const cpuMax = readFileSync(`/sys/fs/cgroup${cgroupPath}/cpu.max`, 'utf8').trim();
        const memoryMax = readFileSync(`/sys/fs/cgroup${cgroupPath}/memory.max`, 'utf8').trim();
        const verification = evaluateCgroupConstraint(parseCgroupLimits(cpuMax, memoryMax), hint);
        return {
            verified: verification.verified,
            detail: `cgroup ${cgroupPath}: cpu.max=${cpuMax} memory.max=${memoryMax}; ${verification.detail}`,
        };
    } catch (error) {
        return {
            verified: false,
            detail: `cgroup read failed: ${getErrorMessage(error)}`,
        };
    }
}

export function buildStressCalibrationRecord(
    profile: IStressHostProfile,
    unthrottled: IStressCalibrationProbe | null,
    throttled: IStressCalibrationProbe,
    platform: NodeJS.Platform = process.platform,
): IStressCalibrationRecord {
    const checks = evaluateStressCalibration(profile, unthrottled, throttled);
    const hostConstraint: IStressHostConstraintVerification = profile.hostConstraint
        ? readOwnCgroupConstraint(platform, profile.hostConstraint)
        : {
            verified: true,
            detail: 'profile declares no host-level wrapper',
        };
    if (profile.hostConstraint && !hostConstraint.verified) {
        checks.push({
            check: 'host-wrapper',
            verdict: 'constraint-not-effective',
            detail: hostConstraint.detail,
        });
    }
    return {
        profileId: profile.id,
        unthrottled,
        throttled,
        checks,
        hostConstraint,
    };
}

const BLOCKING_VERDICTS = new Set<TStressCalibrationVerdict>([
    'constraint-not-effective',
    'constraint-excessive',
]);

/**
 * A slow-host profile whose floor was not met, or whose probe crashed, must
 * not produce scenario results: a "passed" run on an unthrottled renderer
 * would be read as slow-host coverage it never was. `unverifiable` checks
 * (missing worker probe, cgroup files absent) only warn.
 */
export function calibrationBlocksStressRun(record: IStressCalibrationRecord | null) {
    if (!record) {
        return 'calibration probe did not complete';
    }
    const blocking = record.checks.filter(check => BLOCKING_VERDICTS.has(check.verdict));
    if (blocking.length === 0) {
        return null;
    }
    return blocking.map(check => `${check.check}: ${check.verdict} (${check.detail})`).join('; ');
}
