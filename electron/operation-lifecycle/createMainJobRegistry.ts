import { getErrorMessage } from '@electron/utils/error';
import {randomUUID} from 'node:crypto';
import type {
    Event,
    WebContents,
} from 'electron';
import type {TDocumentInstanceId} from '@contracts/documentInstanceId';
import {
    registerMainOperation,
    type IMainOperationRegistration,
    type IRegisteredMainOperation,
    type IMainOperationOwnerLifecyclePolicy as IMainOperationLifecyclePolicy,
    type TMainOperationKind,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {
    createIpcProgressPump,
    type IProgressPumpTarget,
} from '@electron/utils/createIpcProgressPump';
import {
    type TManagedScratchPrefix,
    usingManagedScratchScope,
} from '@electron/utils/managedScratchTemp';
export interface IMainJobErrorEnvelope<TCode extends string = string> {
    code: TCode;
    message: string;
    retryable?: boolean;
    timestamp?: number;
    details?: string;
}
export interface IMainJobSender {
    id: WebContents['id'];
    isDestroyed: WebContents['isDestroyed'];
    on: WebContents['on'];
    once: WebContents['once'];
    removeListener: WebContents['removeListener'];
    send: WebContents['send'];
}
export interface IMainJobActor<TSender extends IMainJobSender = WebContents> {
    sender: TSender;
    ownerId?: string;
    documentInstanceId?: TDocumentInstanceId;
    documentRevision?: string;
}
interface IMainJobOwnerKey {
    webContentsId: number;
    ownerId?: string;
    documentInstanceId?: TDocumentInstanceId;
    documentRevision?: string;
}
type TMainJobStatus = 'queued' | 'running' | 'canceling' | 'handoff' | 'committing' | 'completed' | 'canceled' | 'failed';
interface IMainJobSnapshotBase<TProgress> {
    jobId: string;
    owner: IMainJobOwnerKey;
    operationKind: TMainOperationKind;
    status: TMainJobStatus;
    progress: TProgress;
    createdAtMs: number;
    updatedAtMs: number;
}
export type TMainJobSnapshot<TProgress, TResult, TError extends IMainJobErrorEnvelope> =
    | IMainJobSnapshotBase<TProgress> & {status: 'queued' | 'running' | 'canceling' | 'committing'}
    | IMainJobSnapshotBase<TProgress> & {
        status: 'handoff';
        handoffResult: TResult
    }
    | IMainJobSnapshotBase<TProgress> & {
        status: 'completed';
        result: TResult;
        handoffResult?: TResult
    }
    | IMainJobSnapshotBase<TProgress> & {
        status: 'canceled' | 'failed';
        error: TError
    };
export type TMainJobTerminalSnapshot<TProgress, TResult, TError extends IMainJobErrorEnvelope> = Extract<TMainJobSnapshot<TProgress, TResult, TError>, {status: 'completed' | 'canceled' | 'failed'}>;
export type TMainJobErrorKind = 'canceled' | 'failed' | 'duplicate-job-id' | 'not-found-or-unauthorized';
export type TMainJobOwnerEndAction = IMainOperationLifecyclePolicy['destroyed'];
export type IMainJobOwnerLifecyclePolicy = IMainOperationLifecyclePolicy;
export interface IMainJobScratch {using<T>(prefix: TManagedScratchPrefix, run: (scratchPath: string) => Promise<T>): Promise<T>;}
export interface IMainJobTerminalController<TProgress, TResult, _TError extends IMainJobErrorEnvelope> {
    complete(result: TResult, progress?: TProgress): boolean;
    cancel(cause?: unknown, progress?: TProgress): boolean;
    fail(cause: unknown, progress?: TProgress): boolean;
}
export interface IMainJobRunContext<TProgress, TResult, TError extends IMainJobErrorEnvelope> {
    jobId: string;
    signal: AbortSignal;
    scratch: IMainJobScratch;
    publish(progress: TProgress): void;
    handoff(result: TResult, progress?: TProgress): void;
    markCommitStarted(progress?: TProgress): void;
    terminal: IMainJobTerminalController<TProgress, TResult, TError>;
}
export interface IMainJobStartOptions<
    TProgress,
    TResult,
    TError extends IMainJobErrorEnvelope,
    TSender extends IMainJobSender = WebContents,
> {
    jobId?: string;
    owner: IMainJobActor<TSender>;
    operation: Pick<IMainOperationRegistration, 'kind' | 'workingCopyPath' | 'cancelOnWorkingCopyClose'>;
    initialProgress: TProgress;
    duplicate?: 'reject' | 'join';
    ownerLifecycle?: IMainJobOwnerLifecyclePolicy;
    signals?: readonly AbortSignal[];
    onCancel?: (reason: string, signal: AbortSignal) => void | Promise<void>;
    run(context: IMainJobRunContext<TProgress, TResult, TError>): Promise<TResult>;
}
export interface IMainJobHandle<TProgress, TResult, TError extends IMainJobErrorEnvelope> {
    jobId: string;
    signal: AbortSignal;
    terminal: Promise<TMainJobTerminalSnapshot<TProgress, TResult, TError>>;
    settled: Promise<void>;
    cancel(reason?: string): boolean;
}
export interface IMainJobRegistryOptions<
    TProgress,
    TResult,
    TError extends IMainJobErrorEnvelope,
    TSender extends IMainJobSender = WebContents,
> {
    retention: {
        eventReplayTtlMs: number;
        terminalRecordTtlMs: number;
        maxTerminalRecords?: number
    };
    progress?: {
        channel: string;
        intervalMs?: number;
        getEventKey(progress: TProgress): string | null;
        send?(sender: TSender, channel: string, progress: TProgress): void
    };
    toError(cause: unknown, kind: TMainJobErrorKind): TError;
    terminalProgress: {
        completed(latest: TProgress, result: TResult): TProgress;
        canceled(latest: TProgress, error: TError): TProgress;
        failed(latest: TProgress, error: TError): TProgress
    };
    scratch?: IMainJobScratch;
    unbindOnSettlement?: boolean;
    now?: () => number;
}
export interface IMainJobRegistry<
    TProgress,
    TResult,
    TError extends IMainJobErrorEnvelope,
    TSender extends IMainJobSender = WebContents,
> {
    start(options: IMainJobStartOptions<TProgress, TResult, TError, TSender>): IMainJobHandle<TProgress, TResult, TError>;
    get(jobId: string, actor: IMainJobActor<TSender>): TMainJobSnapshot<TProgress, TResult, TError> | null;
    subscribe(
        jobId: string,
        actor: IMainJobActor<TSender>,
        listener: (snapshot: TMainJobSnapshot<TProgress, TResult, TError>) => void,
        onClose?: () => void,
    ): (() => void) | null;
    subscribeOwner(actor: IMainJobActor<TSender>): () => void;
    cancel(jobId: string, actor: IMainJobActor<TSender>, reason?: string): boolean;
    await(jobId: string, actor: IMainJobActor<TSender>): Promise<TMainJobTerminalSnapshot<TProgress, TResult, TError>>;
    clearForTests(): Promise<void>;
}
export function createMainJobRegistry<
    TProgress,
    TResult,
    TError extends IMainJobErrorEnvelope = IMainJobErrorEnvelope,
    TSender extends IMainJobSender = WebContents,
>(
    options: IMainJobRegistryOptions<TProgress, TResult, TError, TSender>,
): IMainJobRegistry<TProgress, TResult, TError, TSender> {
    type TSnapshot = TMainJobSnapshot<TProgress, TResult, TError>;
    type TTerminal = TMainJobTerminalSnapshot<TProgress, TResult, TError>;
    type THandle = IMainJobHandle<TProgress, TResult, TError>;
    interface IRecord {
        actor: IMainJobActor<TSender>;
        owner: IMainJobOwnerKey;
        ownerKey: string;
        lifecycle: IMainJobOwnerLifecyclePolicy;
        operation: IRegisteredMainOperation;
        controller: AbortController;
        snapshot: TSnapshot;
        subscribers: Set<ISubscription>;
        handle: THandle;
        resolveTerminal: (snapshot: TTerminal) => void;
        cancelPromise: Promise<void>;
        cleanupSignals: Array<() => void>;
        terminalAtMs: number | null;
        retentionTimer: ReturnType<typeof setTimeout> | null;
        settled: boolean;
    }
    interface ISubscription {
        close: () => void;
        listener: (snapshot: TSnapshot) => void;
    }
    interface IBinding {
        sender: TSender;
        records: Set<IRecord>;
        destroyed: () => void;
        gone: () => void;
        navigation: (_event: Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => void;
    }
    const now = options.now ?? Date.now;
    const records = new Map<string, IRecord>(); const bindings = new Map<number, IBinding>();
    const cancelHooks = new WeakMap<IRecord, IMainJobStartOptions<TProgress, TResult, TError, TSender>['onCancel']>();
    let deliveryTarget: IProgressPumpTarget<TProgress> | null = null; let publishingTerminal = false;
    const ownerKeyOf = (actor: IMainJobActor<TSender> | IMainJobOwnerKey) => JSON.stringify([
        'sender' in actor ? actor.sender.id : actor.webContentsId,
        actor.ownerId,
        actor.documentInstanceId,
        actor.documentRevision,
    ]);
    const ownerOf = (actor: IMainJobActor<TSender>): IMainJobOwnerKey => ({
        webContentsId: actor.sender.id,
        ...(actor.ownerId === undefined ? {} : {ownerId: actor.ownerId}),
        ...(actor.documentInstanceId === undefined ? {} : {documentInstanceId: actor.documentInstanceId}),
        ...(actor.documentRevision === undefined ? {} : {documentRevision: actor.documentRevision}),
    });
    const throwable = (error: TError) => Object.assign(new Error(error.message), error);
    const pump = options.progress ? createIpcProgressPump<TProgress>({
        channel: options.progress.channel,
        getTarget: () => deliveryTarget,
        getKey: progress => options.progress?.getEventKey(progress) ?? '',
        isTerminal: () => publishingTerminal,
        ...(options.progress.intervalMs === undefined ? {} : {intervalMs: options.progress.intervalMs}),
        replayMode: {
            kind: 'external',
            getReplayPayloads: target => {
                const currentTime = now();
                return [...records.values()].filter(record => record.ownerKey === target.key && (record.terminalAtMs === null
                || currentTime - record.terminalAtMs < options.retention.eventReplayTtlMs)
                && options.progress?.getEventKey(record.snapshot.progress) !== null).map(record => record.snapshot.progress);
            },
        },
    }) : null;
    function notify(record: IRecord) { for (const subscription of record.subscribers) subscription.listener(record.snapshot); }
    function closeSubscriptions(record: IRecord) { for (const subscription of [...record.subscribers]) subscription.close(); }
    function emit(record: IRecord, terminal = false, flushKey?: string) {
        if (!pump || options.progress?.getEventKey(record.snapshot.progress) === null) {
            return;
        }
        deliveryTarget = {
            key: record.ownerKey,
            isDestroyed: () => record.actor.sender.isDestroyed(),
            send: (channel, progress) => options.progress?.send
                ? options.progress.send(record.actor.sender, channel, progress)
                : record.actor.sender.send(channel, progress),
        };
        publishingTerminal = terminal;
        if (flushKey) pump.flush(flushKey);
        pump.enqueue(record.snapshot.progress, deliveryTarget);
        publishingTerminal = false; deliveryTarget = null;
    }
    function unbind(record: IRecord) {
        const binding = bindings.get(record.owner.webContentsId); if (!binding || !binding.records.delete(record) || binding.records.size > 0) {
            return;
        }
        binding.sender.removeListener('destroyed', binding.destroyed); binding.sender.removeListener('render-process-gone', binding.gone); binding.sender.removeListener('did-start-navigation', binding.navigation); bindings.delete(record.owner.webContentsId);
    }
    function remove(record: IRecord) { if (records.get(record.snapshot.jobId) !== record) {
        return;
    } if (record.retentionTimer) clearTimeout(record.retentionTimer); records.delete(record.snapshot.jobId); closeSubscriptions(record); unbind(record); }
    function prune() {
        const cap = options.retention.maxTerminalRecords;
        if (cap === undefined) {
            return;
        }
        const terminal = [...records.values()].filter(record => record.terminalAtMs !== null && record.settled).sort((left, right) => (left.terminalAtMs ?? 0) - (right.terminalAtMs ?? 0));
        for (const record of terminal.slice(0, Math.max(0, terminal.length - cap))) remove(record);
    }
    function update(record: IRecord, patch: object) { record.snapshot = {
        ...record.snapshot,
        ...patch,
        updatedAtMs: now(),
    }; notify(record); }
    function finish(record: IRecord, status: 'completed' | 'canceled' | 'failed', value: TResult | unknown, progress?: TProgress) {
        if (record.terminalAtMs !== null) {
            return false;
        }
        const effective = record.snapshot.status === 'canceling' ? 'canceled' : status;
        const cause: unknown = effective === 'canceled' && record.controller.signal.aborted
            ? record.controller.signal.reason
            : value;
        const error = effective === 'completed' ? null : options.toError(cause, effective); const latest = progress ?? record.snapshot.progress;
        const terminalProgress = effective === 'completed' ? options.terminalProgress.completed(latest, value as TResult)
            : effective === 'canceled'
                ? options.terminalProgress.canceled(latest, error as TError)
                : options.terminalProgress.failed(latest, error as TError);
        record.terminalAtMs = now(); update(record, effective === 'completed' ? {
            status: effective,
            result: value as TResult,
            progress: terminalProgress,
        }
            : {
                status: effective,
                error,
                progress: terminalProgress,
            });
        emit(record, true); record.resolveTerminal(record.snapshot as TTerminal);
        record.retentionTimer = setTimeout(() => { if (record.settled) remove(record); }, Math.max(0, options.retention.terminalRecordTtlMs));
        record.retentionTimer.unref(); prune();
        return true;
    }
    function requestCancel(record: IRecord, reason = 'Operation canceled') {
        if (record.terminalAtMs !== null || record.snapshot.status === 'canceling'
            || (record.snapshot.operationKind === 'critical-write' && record.snapshot.status === 'committing')) {
            return false;
        }
        update(record, {status: 'canceling'}); record.controller.abort(new Error(reason));
        record.cancelPromise = Promise.resolve().then(() => cancelHooks.get(record)?.(reason, record.controller.signal))
            .catch(() => undefined);
        return true;
    }
    function ownerEnd(record: IRecord, action: TMainJobOwnerEndAction | undefined, reason: string) {
        closeSubscriptions(record);
        if (action === 'cancel') {
            requestCancel(record, reason);
            unbind(record);
        } else if (action === 'detach') unbind(record);
    }
    function bind(record: IRecord) {
        let binding = bindings.get(record.owner.webContentsId);
        if (!binding) {
            const sender = record.actor.sender;
            const dispatch = (field: keyof IMainJobOwnerLifecyclePolicy, reason: string) => { for (const owned of [...(bindings.get(sender.id)?.records ?? [])]) ownerEnd(owned, owned.lifecycle[field], reason); };
            binding = {
                sender,
                records: new Set(),
                destroyed: () => dispatch('destroyed', 'Renderer destroyed'),
                gone: () => dispatch('renderProcessGone', 'Renderer process gone'),
                navigation: (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) dispatch('mainFrameNavigation', 'Renderer main frame navigated'); },
            };
            bindings.set(sender.id, binding); sender.once('destroyed', binding.destroyed);
            sender.once('render-process-gone', binding.gone); sender.on('did-start-navigation', binding.navigation);
        }
        binding.records.add(record);
        if (record.actor.sender.isDestroyed()) ownerEnd(record, record.lifecycle.destroyed, 'Renderer destroyed');
    }
    function start(startOptions: IMainJobStartOptions<TProgress, TResult, TError, TSender>): THandle {
        const jobId = startOptions.jobId ?? randomUUID();
        const existing = records.get(jobId);
        if (existing) {
            if (startOptions.duplicate === 'join' && existing.ownerKey === ownerKeyOf(startOptions.owner)) {
                return existing.handle;
            }
            throw throwable(options.toError(new Error(`Duplicate job ID: ${jobId}`), 'duplicate-job-id'));
        }
        const recordRef: {current?: IRecord} = {};
        const operation = registerMainOperation({
            ...startOptions.operation,
            ownerWebContentsId: startOptions.owner.sender.id,
            cancel: reason => { if (recordRef.current) requestCancel(recordRef.current, reason); },
            ownerLifecycle: startOptions.ownerLifecycle,
        });
        const controller = new AbortController(); let resolveTerminal!: (snapshot: TTerminal) => void; let resolveSettled!: () => void;
        const terminal = new Promise<TTerminal>(resolve => { resolveTerminal = resolve; });
        const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
        const createdAtMs = now(); const owner = ownerOf(startOptions.owner);
        const record: IRecord = {
            actor: startOptions.owner,
            owner,
            ownerKey: ownerKeyOf(owner),
            lifecycle: startOptions.ownerLifecycle ?? {destroyed: 'cancel'},
            operation,
            controller,
            snapshot: {
                jobId,
                owner,
                operationKind: startOptions.operation.kind,
                status: 'queued',
                progress: startOptions.initialProgress,
                createdAtMs,
                updatedAtMs: createdAtMs,
            },
            subscribers: new Set(),
            handle: undefined as never,
            resolveTerminal,
            cancelPromise: Promise.resolve(),
            cleanupSignals: [],
            terminalAtMs: null,
            retentionTimer: null,
            settled: false,
        };
        record.handle = {
            jobId,
            signal: controller.signal,
            terminal,
            settled,
            cancel: reason => requestCancel(record, reason),
        };
        recordRef.current = record; records.set(jobId, record);
        cancelHooks.set(record, startOptions.onCancel); bind(record); emit(record);
        for (const signal of [
            operation.signal,
            ...(startOptions.signals ?? []),
        ]) {
            const abort = () => requestCancel(record, signal.reason instanceof Error ? getErrorMessage(signal.reason) : 'Operation canceled');
            if (signal.aborted) abort();
            else {
                signal.addEventListener('abort', abort, {once: true}); record.cleanupSignals.push(() => signal.removeEventListener('abort', abort));
            }
        }
        // Sampled here, while start() is still on the stack: only a signal that
        // was already aborted when the job was handed over means the work never
        // began. A cancel that lands later in the same turn belongs to a job the
        // caller has already started acting on, and must settle through its own
        // cancellation path rather than being short-circuited here.
        const abortedBeforeRun = controller.signal.aborted;
        const context: IMainJobRunContext<TProgress, TResult, TError> = {
            jobId,
            signal: controller.signal,
            scratch: options.scratch ?? {using: usingManagedScratchScope},
            publish: progress => { if (record.terminalAtMs === null) {
                const previousKey = options.progress?.getEventKey(record.snapshot.progress);
                const nextKey = options.progress?.getEventKey(progress);
                const flushKey = previousKey && nextKey && previousKey !== nextKey
                    ? previousKey
                    : undefined;
                update(record, {
                    progress,
                    ...(record.snapshot.status === 'queued' ? {status: 'running'} : {}),
                }); emit(record, false, flushKey);
            } },
            handoff: (result, progress) => {
                if (record.terminalAtMs === null && record.snapshot.status !== 'canceling') update(record, {
                    status: 'handoff',
                    handoffResult: result,
                    ...(progress === undefined ? {} : {progress}),
                });
            },
            markCommitStarted: progress => {
                if (record.terminalAtMs === null && record.snapshot.operationKind === 'critical-write') { operation.markCommitStarted(); update(record, {
                    status: 'committing',
                    ...(progress === undefined ? {} : {progress}),
                }); }
            },
            terminal: {
                complete: (result, progress) => finish(record, 'completed', result, progress),
                cancel: (cause, progress) => finish(record, 'canceled', cause, progress),
                fail: (cause, progress) => finish(record, 'failed', cause, progress),
            },
        };
        void Promise.resolve().then(() => {
            // The catch below maps this to the same outcome as a cancellation
            // that lands mid-run.
            if (abortedBeforeRun) {
                throw controller.signal.reason;
            }
            return startOptions.run(context);
        })
            .then(result => finish(record, 'completed', result))
            .catch(error => finish(record, controller.signal.aborted ? 'canceled' : 'failed', error))
            .finally(async () => {
                await record.cancelPromise; for (const cleanup of record.cleanupSignals.splice(0)) cleanup();
                operation.complete(); record.settled = true; resolveSettled();
                if (options.unbindOnSettlement === true) {
                    // Terminal records remain queryable for replay. This
                    // instance no longer needs renderer listeners at settle.
                    unbind(record);
                }
                if (record.terminalAtMs !== null && now() - record.terminalAtMs >= options.retention.terminalRecordTtlMs) remove(record);
                prune();
            });
        return record.handle;
    }
    const authorized = (jobId: string, actor: IMainJobActor<TSender>) => {
        const record = records.get(jobId); return record?.ownerKey === ownerKeyOf(actor) ? record : null;
    };
    return {
        start,
        get: (jobId, actor) => authorized(jobId, actor)?.snapshot ?? null,
        subscribe: (jobId, actor, listener, onClose) => {
            const record = authorized(jobId, actor); if (!record) {
                return null;
            }
            bind(record);
            let active = true;
            const subscription: ISubscription = {
                listener,
                close: () => {
                    if (!active) {
                        return;
                    }
                    active = false;
                    record.subscribers.delete(subscription);
                    onClose?.();
                },
            };
            record.subscribers.add(subscription); listener(record.snapshot);
            return subscription.close;
        },
        subscribeOwner: actor => {
            if (!pump) {
                return () => {};
            }
            const target: IProgressPumpTarget<TProgress> = {
                key: ownerKeyOf(actor),
                isDestroyed: () => actor.sender.isDestroyed(),
                send: (channel, progress) => options.progress?.send ? options.progress.send(actor.sender, channel, progress)
                    : actor.sender.send(channel, progress),
            };
            const unsubscribe = pump.subscribe(target) ?? (() => {});
            const navigation = (_event: Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
                if (isMainFrame && !isInPlace) cleanup();
            };
            const cleanup = () => {
                unsubscribe();
                actor.sender.removeListener('destroyed', cleanup);
                actor.sender.removeListener('render-process-gone', cleanup);
                actor.sender.removeListener('did-start-navigation', navigation);
            };
            actor.sender.once('destroyed', cleanup);
            actor.sender.once('render-process-gone', cleanup);
            actor.sender.on('did-start-navigation', navigation);
            return cleanup;
        },
        cancel: (jobId, actor, reason) => {
            const record = authorized(jobId, actor); return record ? requestCancel(record, reason) : false;
        },
        await: async (jobId, actor) => {
            const record = authorized(jobId, actor); if (!record) throw throwable(options.toError(new Error('Job not found or unauthorized'), 'not-found-or-unauthorized'));
            return record.handle.terminal;
        },
        clearForTests: async () => {
            for (const record of records.values()) requestCancel(record, 'Registry reset');
            await Promise.allSettled([...records.values()].map(record => record.handle.settled));
            for (const record of [...records.values()]) remove(record); pump?.dispose();
        },
    };
}
