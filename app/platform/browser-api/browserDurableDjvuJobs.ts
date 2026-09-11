import type {
    IDjvuConvertResult,
    IDjvuOpenResult,
    TDocumentOutputJobState,
} from '@contracts/electronApiDjvu';
import {
    decodeFailureReceipt,
    isExpectedOutcome,
} from '@contracts/diagnostics/failureReceipt';
import { getErrorMessage } from '@app/utils/error';
import type {
    TJobId,
    TRequestId,
} from '@contracts/shared';
import { createEpochMs } from '@contracts/timestamps';

const DEFAULT_TERMINAL_JOB_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_TERMINAL_JOBS = 64;

interface ITerminalBrowserDjvuJob {
    kind: 'open' | 'convert';
    promise: Promise<IDjvuOpenResult> | Promise<IDjvuConvertResult>;
    timer: ReturnType<typeof setTimeout>;
}

function getFailureReceipt(error: unknown) {
    if (typeof error !== 'object' || error === null || !('failure' in error)) {
        return undefined;
    }
    return decodeFailureReceipt(error.failure) ?? undefined;
}

function getExpectedOutcome(error: unknown) {
    if (typeof error !== 'object' || error === null || !('expected' in error)) {
        return undefined;
    }
    return isExpectedOutcome(error.expected) ? error.expected : undefined;
}

function getResultFailure(result: IDjvuOpenResult | IDjvuConvertResult) {
    return 'failure' in result ? result.failure : undefined;
}

function getResultExpectedOutcome(result: IDjvuOpenResult | IDjvuConvertResult) {
    return 'expected' in result ? result.expected : undefined;
}

export class BrowserDurableDjvuJobs {
    readonly #openJobs = new Map<TJobId, Promise<IDjvuOpenResult>>();
    readonly #convertJobs = new Map<TJobId, Promise<IDjvuConvertResult>>();
    readonly #states = new Map<TJobId, TDocumentOutputJobState>();
    readonly #terminalJobs = new Map<TJobId, ITerminalBrowserDjvuJob>();

    constructor(
        private readonly terminalJobTtlMs = DEFAULT_TERMINAL_JOB_TTL_MS,
        private readonly maxTerminalJobs = DEFAULT_MAX_TERMINAL_JOBS,
    ) {}

    startOpen(
        jobId: TJobId,
        requestId: TRequestId,
        run: () => Promise<IDjvuOpenResult>,
    ) {
        if (!this.#openJobs.has(jobId)) {
            this.#states.set(jobId, this.#createState(jobId, 'djvu-open', 'loading'));
            const job = Promise.resolve().then(run).catch((error: unknown): IDjvuOpenResult => ({
                success: false,
                error: getErrorMessage(error),
            })).then((result) => {
                this.#states.set(jobId, this.#finishState(jobId, 'djvu-open', 'loading', result));
                const normalizedResult: IDjvuOpenResult = {
                    ...result,
                    jobId,
                };
                this.#retainTerminalJob(jobId, 'open', job);
                return normalizedResult;
            });
            this.#openJobs.set(jobId, job);
        }
        return {
            jobId,
            requestId,
        };
    }

    awaitOpen(jobId: TJobId) {
        const job = this.#openJobs.get(jobId);
        if (!job) throw new Error(`Unknown browser DjVu open job: ${jobId}`);
        return job;
    }

    startConvert(
        jobId: TJobId,
        requestId: TRequestId,
        run: () => Promise<IDjvuConvertResult>,
    ) {
        if (!this.#convertJobs.has(jobId)) {
            this.#states.set(jobId, this.#createState(jobId, 'djvu-convert', 'converting'));
            let runPromise: Promise<IDjvuConvertResult>;
            try {
                runPromise = run();
            } catch (error) {
                runPromise = Promise.reject(error);
            }
            const job = runPromise.catch((error: unknown): IDjvuConvertResult => {
                const expected = getExpectedOutcome(error);
                const failure = expected === undefined ? getFailureReceipt(error) : undefined;
                return {
                    success: false,
                    error: getErrorMessage(error),
                    ...(failure === undefined ? {} : {failure}),
                    ...(expected === undefined ? {} : {expected}),
                };
            }).then((result) => {
                this.#states.set(jobId, this.#finishState(jobId, 'djvu-convert', 'converting', result));
                const normalizedResult: IDjvuConvertResult = {
                    ...result,
                    jobId,
                };
                this.#retainTerminalJob(jobId, 'convert', job);
                return normalizedResult;
            });
            this.#convertJobs.set(jobId, job);
        }
        return {
            jobId,
            requestId,
        };
    }

    awaitConvert(jobId: TJobId) {
        const job = this.#convertJobs.get(jobId);
        if (!job) throw new Error(`Unknown browser DjVu conversion job: ${jobId}`);
        return job;
    }

    getState(jobId: TJobId) {
        return this.#states.get(jobId) ?? null;
    }

    clearForTests() {
        for (const terminal of this.#terminalJobs.values()) {
            clearTimeout(terminal.timer);
        }
        this.#terminalJobs.clear();
        this.#openJobs.clear();
        this.#convertJobs.clear();
        this.#states.clear();
    }

    #retainTerminalJob(
        jobId: TJobId,
        kind: 'open' | 'convert',
        promise: Promise<IDjvuOpenResult> | Promise<IDjvuConvertResult>,
    ) {
        const previous = this.#terminalJobs.get(jobId);
        if (previous) {
            clearTimeout(previous.timer);
            this.#terminalJobs.delete(jobId);
        }
        const timer = setTimeout(() => this.#deleteTerminalJob(jobId, promise), this.terminalJobTtlMs);
        timer.unref?.();
        this.#terminalJobs.set(jobId, {
            kind,
            promise,
            timer,
        });
        while (this.#terminalJobs.size > this.maxTerminalJobs) {
            const oldestJobId = this.#terminalJobs.keys().next().value;
            if (!oldestJobId) {
                break;
            }
            this.#deleteTerminalJob(oldestJobId);
        }
    }

    #deleteTerminalJob(jobId: TJobId, expectedPromise?: Promise<IDjvuOpenResult> | Promise<IDjvuConvertResult>) {
        const terminal = this.#terminalJobs.get(jobId);
        if (!terminal || expectedPromise && terminal.promise !== expectedPromise) {
            return;
        }
        clearTimeout(terminal.timer);
        this.#terminalJobs.delete(jobId);
        if (terminal.kind === 'open' && this.#openJobs.get(jobId) === terminal.promise) {
            this.#openJobs.delete(jobId);
        }
        if (terminal.kind === 'convert' && this.#convertJobs.get(jobId) === terminal.promise) {
            this.#convertJobs.delete(jobId);
        }
        this.#states.delete(jobId);
    }

    #createState(
        jobId: TJobId,
        operation: 'djvu-open' | 'djvu-convert',
        phase: 'loading' | 'converting',
    ): TDocumentOutputJobState {
        return {
            jobId,
            operation,
            status: 'running',
            progress: {
                jobId,
                phase,
                percent: 0,
            },
            updatedAtMs: createEpochMs(),
        };
    }

    #finishState(
        jobId: TJobId,
        operation: 'djvu-open' | 'djvu-convert',
        phase: 'loading' | 'converting',
        result: IDjvuOpenResult | IDjvuConvertResult,
    ): TDocumentOutputJobState {
        const expected = getResultExpectedOutcome(result);
        const failure = expected === undefined ? getResultFailure(result) : undefined;
        return {
            jobId,
            operation,
            status: result.success
                ? 'completed'
                : 'expected' in result && result.expected.code === 'canceled'
                    ? 'canceled'
                    : 'failed',
            progress: {
                jobId,
                phase,
                percent: result.success ? 100 : 0,
            },
            updatedAtMs: createEpochMs(),
            ...(result.success || !result.error ? {} : {error: result.error}),
            ...(failure === undefined ? {} : {failure}),
            ...(expected === undefined ? {} : {expected}),
            ...('pdfPath' in result && result.pdfPath ? {artifactPath: result.pdfPath} : {}),
        };
    }
}

export const browserDurableDjvuJobs = new BrowserDurableDjvuJobs();
