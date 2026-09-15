import { getErrorMessage } from '@contracts/getErrorMessage';
import {randomUUID} from 'node:crypto';
import {
    access,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {IWindowsTestHostLayout} from '@scripts/windows-test/contracts/windowsTestPaths';
import type {
    ICommandRunner,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';

const PROBE_SOURCE_PATH = fileURLToPath(new URL('./utmInputCaptureProbe.swift', import.meta.url));
const PROBE_TIMEOUT_MS = 120_000;
const RUN_ID_PATTERN = /^evb-win-test-(\d{8}T\d{6}Z-[a-f0-9]{12})$/u;

export interface IUtmInputCaptureProbeResult {
    windowTitle: string;
    windowAvailable: boolean;
    before: number;
    after: number;
    frontmostPid: number;
    utmPid: number;
    action: 'status' | 'release' | 'restore';
    windowNumbersBefore?: number[];
    windowNumbersAfter?: number[];
}

export interface IUtmInputCaptureWindowSnapshot {
    enumerationAvailable: boolean;
    screenCapturePreflight?: boolean;
    accessibilityTrusted?: boolean;
    windowNumbers: number[];
    windows: Array<Record<string, string>>;
    utmPid: number;
    frontmostPid: number;
}

export interface IUtmInputCaptureGuard {
    snapshotBeforeStart(): Promise<IUtmInputCaptureWindowSnapshot>;
    ensureReleased(vmId: string): Promise<IUtmInputCaptureProbeResult>;
    status(vmId: string): Promise<IUtmInputCaptureProbeResult>;
    restoreHostInput(): Promise<void>;
}

export interface IUtmInputCaptureGuardOptions {
    runner: ICommandRunner;
    utmctl: IUtmctlClient;
    layout?: IWindowsTestHostLayout;
    deniedVmIds?: readonly string[];
    sourcePath?: string;
    probeExecutablePath?: string;
}

function parseProbeResult(text: string): IUtmInputCaptureProbeResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.trim());
    } catch (error) {
        throw new Error(`The UTM input-capture probe returned invalid JSON: ${getErrorMessage(error)}.`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('The UTM input-capture probe returned a non-object result.');
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.windowTitle !== 'string'
        || typeof record.windowAvailable !== 'boolean'
        || typeof record.before !== 'number'
        || typeof record.after !== 'number'
        || typeof record.frontmostPid !== 'number'
        || typeof record.utmPid !== 'number'
        || (record.action !== 'status' && record.action !== 'release' && record.action !== 'restore')) {
        throw new Error('The UTM input-capture probe returned a malformed result.');
    }
    return {
        windowTitle: record.windowTitle,
        windowAvailable: record.windowAvailable,
        before: record.before,
        after: record.after,
        frontmostPid: record.frontmostPid,
        utmPid: record.utmPid,
        action: record.action,
    };
}

function parseWindowSnapshot(text: string): IUtmInputCaptureWindowSnapshot {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.trim());
    } catch (error) {
        throw new Error(`The UTM input-capture window snapshot returned invalid JSON: ${getErrorMessage(error)}.`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('The UTM input-capture window snapshot returned a non-object result.');
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.enumerationAvailable !== 'boolean'
        || typeof record.utmPid !== 'number'
        || typeof record.frontmostPid !== 'number') {
        throw new Error('The UTM input-capture window snapshot returned a malformed result.');
    }
    const windowNumbers = Array.isArray(record.windowNumbers)
        ? record.windowNumbers.filter((value): value is number => typeof value === 'number')
        : [];
    return {
        enumerationAvailable: record.enumerationAvailable,
        ...(typeof record.screenCapturePreflight === 'boolean'
            ? {screenCapturePreflight: record.screenCapturePreflight}
            : {}),
        ...(typeof record.accessibilityTrusted === 'boolean'
            ? {accessibilityTrusted: record.accessibilityTrusted}
            : {}),
        windowNumbers,
        windows: Array.isArray(record.windows)
            ? record.windows as Array<Record<string, string>>
            : [],
        utmPid: record.utmPid,
        frontmostPid: record.frontmostPid,
    };
}

function targetWindowName(entries: Awaited<ReturnType<IUtmctlClient['list']>>, vmId: string, deniedVmIds: Set<string>) {
    const normalizedVmId = vmId.toLowerCase();
    if (deniedVmIds.has(normalizedVmId)) {
        throw new Error(`Refusing to inspect input capture for a denied VM ${normalizedVmId}.`);
    }
    const entry = entries.find(candidate => candidate.uuid.toLowerCase() === normalizedVmId);
    if (entry === undefined || entry.name.trim().length === 0) {
        throw new Error(`UTM did not list the owned VM ${normalizedVmId}; refusing to inspect an unspecified window.`);
    }
    if (entry.name.trim().toLowerCase() === 'windows') {
        throw new Error('Refusing to inspect the personal Windows VM by display name.');
    }
    return entry.name.trim();
}

export function createUtmInputCaptureGuard(options: IUtmInputCaptureGuardOptions): IUtmInputCaptureGuard {
    const deniedVmIds = new Set((options.deniedVmIds ?? []).map(value => value.toLowerCase()));
    const sourcePath = options.sourcePath ?? PROBE_SOURCE_PATH;
    let probeExecutable: string | null = null;
    let ownsProbeExecutable = false;
    let compilePromise: Promise<string> | null = null;
    let activeWindowTitle: string | null = null;
    let activeWindowAvailable = false;
    let activeRunId: string | null = null;
    let beforeStartSnapshot: IUtmInputCaptureWindowSnapshot | null = null;
    const evidenceCounts = new Map<string, number>();
    const evidenceFileName = (name: string) => {
        const count = (evidenceCounts.get(name) ?? 0) + 1;
        evidenceCounts.set(name, count);
        return `${name}${count === 1 ? '' : `-${count}`}.json`;
    };

    const ensureProbeExecutable = async () => {
        if (probeExecutable !== null) {
            return probeExecutable;
        }
        if (options.probeExecutablePath !== undefined) {
            probeExecutable = options.probeExecutablePath;
            return probeExecutable;
        }
        compilePromise ??= (async () => {
            const executable = path.join(tmpdir(), `evb-utm-input-capture-${process.pid}-${randomUUID()}`);
            const result = await options.runner.run('/usr/bin/xcrun', [
                'swiftc',
                sourcePath,
                '-O',
                '-o',
                executable,
            ], {timeoutMs: PROBE_TIMEOUT_MS});
            if (result.exitCode !== 0 || result.timedOut) {
                throw new Error(`Could not compile the UTM input-capture probe: ${result.stderr.trim() || result.stdout.trim() || 'swiftc failed'}.`);
            }
            probeExecutable = executable;
            ownsProbeExecutable = true;
            return executable;
        })();
        return compilePromise;
    };

    const runProbe = async (windowTitle: string, action: 'status' | 'release' | 'restore') => {
        const executable = await ensureProbeExecutable();
        const result = await options.runner.run(executable, [
            '--window-title',
            windowTitle,
            action === 'status' ? '--status' : `--${action}`,
        ], {timeoutMs: 15_000});
        if (options.layout !== undefined && activeRunId !== null) {
            await writeFile(path.join(options.layout.runsDir, activeRunId, evidenceFileName(`input-capture-${action}-command`)), `${JSON.stringify({
                action,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                timedOut: result.timedOut,
                signal: result.signal,
            }, null, 4)}\n`, 'utf8');
        }
        if (result.exitCode !== 0 || result.timedOut) {
            throw new Error(`The UTM input-capture ${action} probe failed: ${result.stderr.trim() || result.stdout.trim() || 'probe failed'}.`);
        }
        return parseProbeResult(result.stdout);
    };

    const runWindowSnapshot = async () => {
        const executable = await ensureProbeExecutable();
        const result = await options.runner.run(executable, ['--snapshot'], {timeoutMs: 15_000});
        if (result.exitCode !== 0 || result.timedOut) {
            throw new Error(`The UTM input-capture window snapshot failed: ${result.stderr.trim() || result.stdout.trim() || 'probe failed'}.`);
        }
        return parseWindowSnapshot(result.stdout);
    };

    const snapshotBeforeStart = async () => {
        const snapshot = await runWindowSnapshot();
        beforeStartSnapshot = snapshot;
        return snapshot;
    };

    const resolveWindowTitle = async (vmId: string) => targetWindowName(
        await options.utmctl.list(),
        vmId,
        deniedVmIds,
    );

    const record = async (phase: 'launch' | 'cleanup', result: IUtmInputCaptureProbeResult) => {
        if (options.layout === undefined || activeRunId === null) {
            return;
        }
        const runDirectory = path.join(options.layout.runsDir, activeRunId);
        if (await access(runDirectory).then(() => true, () => false) === false) {
            return;
        }
        await writeFile(
            path.join(runDirectory, evidenceFileName(`input-capture-${phase}`)),
            `${JSON.stringify({
                schemaVersion: 1,
                phase,
                windowTitle: result.windowTitle,
                windowAvailable: result.windowAvailable,
                before: result.before,
                after: result.after,
                frontmostPid: result.frontmostPid,
                utmPid: result.utmPid,
                action: result.action,
                windowNumbersBefore: result.windowNumbersBefore,
                windowNumbersAfter: result.windowNumbersAfter,
                hostInputAvailable: result.after === 0 && result.frontmostPid !== result.utmPid,
            }, null, 4)}\n`,
            'utf8',
        );
    };

    const ensureReleased = async (vmId: string) => {
        const windowTitle = await resolveWindowTitle(vmId);
        activeWindowTitle = windowTitle;
        const runIdMatch = RUN_ID_PATTERN.exec(windowTitle);
        activeRunId = runIdMatch?.[1] ?? null;
        const before = beforeStartSnapshot ?? await snapshotBeforeStart();
        const after = await runWindowSnapshot();
        beforeStartSnapshot = null;
        if (!before.enumerationAvailable || !after.enumerationAvailable) {
            throw new Error('UTM window enumeration was unavailable; refusing to claim host input was released.');
        }
        const beforeNumbers = new Set(before.windowNumbers);
        const newWindows = after.windowNumbers.filter(number => !beforeNumbers.has(number));
        if (newWindows.length > 0) {
            if (after.screenCapturePreflight !== true || after.accessibilityTrusted !== true) {
                throw new Error('A new on-screen UTM window appeared, but Capture Input cannot be verified without Screen Recording or Accessibility permission.');
            }
            activeWindowAvailable = true;
            const result = await runProbe(windowTitle, 'release');
            if (!result.windowAvailable || result.after !== 0 || result.frontmostPid === result.utmPid) {
                throw new Error('The clone window must have Capture Input off and leave host input available.');
            }
            await record('launch', result);
            return result;
        }
        activeWindowAvailable = false;
        const result: IUtmInputCaptureProbeResult = {
            windowTitle,
            windowAvailable: false,
            before: 0,
            after: 0,
            frontmostPid: after.frontmostPid,
            utmPid: after.utmPid,
            action: 'release',
            windowNumbersBefore: before.windowNumbers,
            windowNumbersAfter: after.windowNumbers,
        };
        await record('launch', result);
        return result;
    };

    const status = async (vmId: string) => {
        const windowTitle = await resolveWindowTitle(vmId);
        return runProbe(windowTitle, 'status');
    };

    const restoreHostInput = async () => {
        if (activeWindowTitle === null) {
            return;
        }
        if (!activeWindowAvailable) {
            activeWindowTitle = null;
            activeRunId = null;
            beforeStartSnapshot = null;
            return;
        }
        try {
            const result = await runProbe(activeWindowTitle, 'restore');
            if (!result.windowAvailable) {
                await record('cleanup', result);
                return;
            }
            if (result.after !== 0) {
                throw new Error(`UTM Capture Input remained enabled for ${activeWindowTitle} during cleanup.`);
            }
            if (result.frontmostPid === result.utmPid) {
                throw new Error(`UTM remained focused for ${activeWindowTitle} during cleanup.`);
            }
            await record('cleanup', result);
        } catch (error) {
            const detail = getErrorMessage(error);
            if (!/(?:target window|UTM process count|not listed)/iu.test(detail)) {
                throw error;
            }
        } finally {
            if (probeExecutable !== null && ownsProbeExecutable) {
                await rm(probeExecutable, {force: true});
            }
            probeExecutable = null;
            ownsProbeExecutable = false;
            compilePromise = null;
            activeWindowTitle = null;
            activeWindowAvailable = false;
            activeRunId = null;
            beforeStartSnapshot = null;
        }
    };

    return {
        snapshotBeforeStart,
        ensureReleased,
        status,
        restoreHostInput,
    };
}
