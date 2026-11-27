export type TElectronE2EInfrastructureFailureKind = 'process-launch' | 'transport' | 'cdp-connection' | 'session-runner';

function toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
}

function escapeInfrastructureMarkers(value: string) {
    return value.replace(/\[INFRA\]/gu, '[application-infra-marker]');
}

function formatContainedErrors(error: Error) {
    if (!(error instanceof AggregateError)) {
        return '';
    }
    return error.errors
        .map((containedError, index) => `\nContained error ${String(index + 1)}: ${toError(containedError).message}`)
        .join('');
}

export class ElectronE2EInfrastructureError extends Error {
    readonly kind: TElectronE2EInfrastructureFailureKind;

    constructor(kind: TElectronE2EInfrastructureFailureKind, message: string, cause?: unknown) {
        const source = cause === undefined ? null : toError(cause);
        const sourceDetails = source ? `${source.message}${formatContainedErrors(source)}` : '';
        super(`[INFRA] ${message}${source ? `\n${escapeInfrastructureMarkers(sourceDetails)}` : ''}`, source ? {cause: source} : undefined);
        this.name = 'ElectronE2EInfrastructureError';
        this.kind = kind;
    }
}

export function createElectronE2EHealthReadinessFailure(
    sessionName: string,
    successfulResponseCount: number,
    lastTransportError: unknown,
    lastApplicationError?: unknown,
) {
    if (successfulResponseCount === 0) {
        return new ElectronE2EInfrastructureError(
            'transport',
            `Electron E2E session '${sessionName}' health transport was unavailable`,
            lastTransportError,
        );
    }
    const label = `Electron E2E session '${sessionName}' reported application health but did not become ready`;
    return lastApplicationError === undefined ? new Error(label) : formatElectronE2ESessionFailure(label, lastApplicationError);
}

export async function runElectronE2EInfrastructureStage<T>(
    kind: TElectronE2EInfrastructureFailureKind,
    label: string,
    operation: () => Promise<T>,
) {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof ElectronE2EInfrastructureError) {
            throw error;
        }
        throw new ElectronE2EInfrastructureError(kind, label, error);
    }
}

function isNodeSystemFailure(error: unknown): error is NodeJS.ErrnoException & {
    errno: number;
    syscall: string;
} {
    if (!(error instanceof Error)) {
        return false;
    }
    const candidate = error as NodeJS.ErrnoException;
    return (
        typeof candidate.code === 'string' &&
        typeof candidate.errno === 'number' &&
        typeof candidate.syscall === 'string' &&
        candidate.syscall.length > 0
    );
}

export async function runElectronE2EProcessLaunchStage<T>(label: string, operation: () => Promise<T>) {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof ElectronE2EInfrastructureError) {
            throw error;
        }
        if (isNodeSystemFailure(error)) {
            throw new ElectronE2EInfrastructureError('process-launch', label, error);
        }
        throw error;
    }
}

export function formatElectronE2ESessionFailure(label: string, error: unknown) {
    const source = toError(error);
    if (source instanceof ElectronE2EInfrastructureError) {
        return new ElectronE2EInfrastructureError(source.kind, label, source);
    }
    const sourceDetails = `${source.message}${formatContainedErrors(source)}`;
    const failure = new Error(`${label}\n${escapeInfrastructureMarkers(sourceDetails)}`);
    if (source.stack) {
        failure.stack = `${failure.name}: ${failure.message}\nCaused by: ${escapeInfrastructureMarkers(source.stack)}`;
    }
    return failure;
}

export class ElectronE2ETimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(label: string, timeoutMs: number, diagnostics: string | null, cleanupFailure?: unknown) {
        const cleanup = cleanupFailure === undefined ? null : toError(cleanupFailure);
        super(
            [
                `${label} timed out after ${String(Math.round(timeoutMs / 1000))}s.`,
                ...(cleanup ? [`Cleanup after the timeout failed: ${cleanup.message}${formatContainedErrors(cleanup)}`] : []),
                ...(diagnostics ? [diagnostics] : []),
            ].join('\n'),
            cleanup ? {cause: cleanup} : undefined,
        );
        this.name = 'ElectronE2ETimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

export interface IElectronE2EDeadlineOptions {
    onTimeout?: () => Promise<void>;
    diagnostics?: () => string;
}

// The task receives the signal that fires at the deadline, so a polling wait
// stops instead of running on behind the failure. A task that cannot observe
// the signal is abandoned; its late result is neither awaited nor reported as
// an unhandled rejection. Cleanup runs to completion before the timeout is
// thrown, and a cleanup failure is part of the reported error.
export async function runWithElectronE2EDeadline<T>(
    label: string,
    timeoutMs: number,
    task: (signal: AbortSignal) => Promise<T>,
    options: IElectronE2EDeadlineOptions = {},
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const settled = task(controller.signal).then(
        (value) => ({
            kind: 'value' as const,
            value,
        }),
        (error: unknown) => ({
            kind: 'error' as const,
            error,
        }),
    );

    try {
        const outcome = await Promise.race([settled, deadline]);
        if (outcome !== 'timeout') {
            if (outcome.kind === 'error') {
                throw outcome.error;
            }
            return outcome.value;
        }
    } finally {
        clearTimeout(timer);
    }

    controller.abort(new Error(`${label} was abandoned at its ${String(Math.round(timeoutMs / 1000))}s deadline`));
    const diagnostics = options.diagnostics?.() ?? null;
    let cleanupFailure: unknown;
    try {
        await options.onTimeout?.();
    } catch (error) {
        cleanupFailure = error;
    }
    throw new ElectronE2ETimeoutError(label, timeoutMs, diagnostics, cleanupFailure);
}

export interface IElectronE2ETeardownStep {
    label: string;
    run: () => Promise<void>;
}

export class ElectronE2ETeardownError extends AggregateError {
    constructor(
        primary: Error | null,
        failures: ReadonlyArray<{
            label: string;
            error: Error;
        }>,
    ) {
        super(
            [...(primary ? [primary] : []), ...failures.map((failure) => failure.error)],
            [
                primary ? `Test failed: ${primary.message}` : 'Test body passed but teardown failed.',
                ...failures.map((failure) => `Teardown step ${failure.label}: ${failure.error.message}`),
            ].join('\n'),
        );
        this.name = 'ElectronE2ETeardownError';
    }
}

// Every step runs even after an earlier one fails, so a stop is attempted for
// each session. The primary error is rethrown as-is when teardown is clean;
// otherwise the primary error and every step failure are reported together.
export async function runElectronE2ETeardown(primary: unknown, steps: readonly IElectronE2ETeardownStep[]) {
    const failures: Array<{
        label: string;
        error: Error;
    }> = [];
    for (const step of steps) {
        try {
            await step.run();
        } catch (error) {
            failures.push({
                label: step.label,
                error: toError(error),
            });
        }
    }
    const hasPrimary = primary !== null && primary !== undefined;
    if (failures.length === 0) {
        if (hasPrimary) {
            throw primary;
        }
        return;
    }
    throw new ElectronE2ETeardownError(hasPrimary ? toError(primary) : null, failures);
}
