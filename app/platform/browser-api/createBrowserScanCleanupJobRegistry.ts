import type {IScanCleanupOwnerContext} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {TJobId} from '@contracts/shared';

/** Terminal records answer late reads and subscriptions this long, as desktop's registry does. */
const TERMINAL_RECORD_TTL_MS = 60_000;

interface IJobState {
    jobId: TJobId;
    status: string;
}

export interface IBrowserScanCleanupJobContext<TState> {
    signal: AbortSignal;
    /** Stores a state, then announces it. Ignored once the job has settled. */
    publish: (state: TState) => void;
    latest: () => TState;
}

export interface IBrowserScanCleanupJobRegistryOptions<TState extends IJobState, TResult> {
    terminal: {
        completed: (latest: TState, result: TResult) => TState;
        canceled: (latest: TState) => TState;
        failed: (latest: TState, error: unknown) => TState;
    };
    /** The state a job announces when it accepts a cancellation; unchanged when omitted. */
    canceling?: (latest: TState) => TState;
    /** Whether a live job may still be canceled; a committing job may not. */
    cancelable?: (latest: TState) => boolean;
    onState: (state: TState) => void;
}

export type TBrowserScanCleanupJobCancel = 'canceled' | 'not-found' | 'settled' | 'refused';

interface IRecord<TState> {
    owner: IScanCleanupOwnerContext;
    state: TState;
    controller: AbortController;
    settled: boolean;
}

/**
 * The one owner of a window's Scan Cleanup jobs of one kind: their states,
 * who may read or cancel them, and how long a settled job stays readable. A
 * job's work runs under its abort signal and reports through `publish`; the
 * registry turns its outcome into the terminal state.
 */
export function createBrowserScanCleanupJobRegistry<TState extends IJobState, TResult>(
    options: IBrowserScanCleanupJobRegistryOptions<TState, TResult>,
) {
    const records = new Map<string, IRecord<TState>>();
    const owns = (record: IRecord<TState>, owner: IScanCleanupOwnerContext) => record.owner.ownerId === owner.ownerId
        && record.owner.documentRevision === owner.documentRevision;
    const store = (record: IRecord<TState>, state: TState) => {
        record.state = state;
        options.onState(state);
    };
    const settle = (record: IRecord<TState>, state: TState) => {
        if (record.settled) return;
        record.settled = true;
        store(record, state);
        setTimeout(() => {
            if (records.get(state.jobId) === record) records.delete(state.jobId);
        }, TERMINAL_RECORD_TTL_MS);
    };
    return {
        start(input: {
            jobId: TJobId;
            owner: IScanCleanupOwnerContext;
            initial: TState;
            run: (context: IBrowserScanCleanupJobContext<TState>) => Promise<TResult>;
        }) {
            const record: IRecord<TState> = {
                owner: {
                    ownerId: input.owner.ownerId,
                    documentRevision: input.owner.documentRevision,
                },
                state: input.initial,
                controller: new AbortController(),
                settled: false,
            };
            records.set(input.jobId, record);
            store(record, input.initial);
            const {signal} = record.controller;
            const settled = (async () => {
                try {
                    const result = await input.run({
                        signal,
                        publish: state => {
                            if (!record.settled) store(record, state);
                        },
                        latest: () => record.state,
                    });
                    settle(record, signal.aborted
                        ? options.terminal.canceled(record.state)
                        : options.terminal.completed(record.state, result));
                } catch (error) {
                    settle(record, signal.aborted
                        ? options.terminal.canceled(record.state)
                        : options.terminal.failed(record.state, error));
                }
            })();
            return {settled};
        },
        get(jobId: string, owner: IScanCleanupOwnerContext): TState | null {
            const record = records.get(jobId);
            return record !== undefined && owns(record, owner) ? record.state : null;
        },
        isLive(jobId: string) {
            const record = records.get(jobId);
            return record !== undefined && !record.settled && !record.controller.signal.aborted;
        },
        cancel(jobId: string, owner: IScanCleanupOwnerContext, reason: string): TBrowserScanCleanupJobCancel {
            const record = records.get(jobId);
            if (record === undefined || !owns(record, owner)) return 'not-found';
            if (record.settled) return 'settled';
            if (record.controller.signal.aborted) return 'canceled';
            if (options.cancelable?.(record.state) === false) return 'refused';
            if (options.canceling !== undefined) store(record, options.canceling(record.state));
            record.controller.abort(new DOMException(reason, 'AbortError'));
            return 'canceled';
        },
        /** Cancels every live job; for window teardown. */
        cancelAll(reason: string) {
            for (const record of records.values()) {
                if (!record.settled) record.controller.abort(new DOMException(reason, 'AbortError'));
            }
        },
    };
}
