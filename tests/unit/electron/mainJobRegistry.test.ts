/* eslint-disable @stylistic/array-bracket-newline, @stylistic/array-element-newline, @stylistic/object-curly-newline, @stylistic/object-property-newline */
import {EventEmitter} from 'node:events';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {WebContents} from 'electron';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {TDocumentInstanceId} from '@contracts/documentInstanceId';
import {getMainOperationErrorEnvelope} from '@contracts/mainOperationErrors';
import {beginMainOperationShutdown, cancelAllMainOperations, drainCriticalMainOperations, resetMainOperationLifecycleForTests, snapshotMainOperations} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {createMainJobRegistry, type IMainJobActor, type IMainJobRunContext} from '@electron/operation-lifecycle/createMainJobRegistry';
import {getErrorMessage} from '@contracts/getErrorMessage';

const mocks = vi.hoisted(() => ({appTempDir: ''}));
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => mocks.appTempDir}));
interface IProgress {requestId: string; value: number; status: 'running' | 'completed' | 'canceled' | 'failed';}
interface IResult {value: string;}
interface IError extends Error {code: 'canceled' | 'failed' | 'duplicate-job-id' | 'not-found-or-unauthorized';}
type TContext = IMainJobRunContext<IProgress, IResult, IError>;
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; return {promise: new Promise<T>(done => { resolve = done; }), resolve}; }
function sender(id: number): WebContents & EventEmitter & {send: ReturnType<typeof vi.fn>} {
    return Object.assign(new EventEmitter(), {id, destroyed: false, send: vi.fn(), isDestroyed() { return this.destroyed; }}) as never;
}
const initial = (requestId: string): IProgress => ({requestId, value: 0, status: 'running'});
function registry(retention = {eventReplayTtlMs: 30_000, terminalRecordTtlMs: 60_000}, now?: () => number, unbindOnSettlement = false) {
    return createMainJobRegistry<IProgress, IResult, IError>({
        retention, progress: {channel: 'test:progress', getEventKey: progress => progress.requestId},
        toError: (cause, kind) => Object.assign(new Error(getErrorMessage(cause)), {code: kind}) as IError,
        terminalProgress: {
            completed: latest => ({...latest, status: 'completed'}), canceled: latest => ({...latest, status: 'canceled'}),
            failed: latest => ({...latest, status: 'failed'}),
        },
        ...(now ? {now} : {}),
        ...(unbindOnSettlement ? {unbindOnSettlement: true} : {}),
    });
}
const start = (jobs: ReturnType<typeof registry>, actor: IMainJobActor, jobId: string, run: (context: TContext) => Promise<IResult>) =>
    jobs.start({jobId, owner: actor, operation: {kind: 'abortable-work'}, initialProgress: initial(jobId), run});
describe('createMainJobRegistry violations', {timeout: 20_000}, () => {
    beforeEach(() => { mocks.appTempDir = mkdtempSync(join(tmpdir(), 'main-job-registry-')); });
    afterEach(() => { resetMainOperationLifecycleForTests(); rmSync(mocks.appTempDir, {force: true, recursive: true}); vi.useRealTimers(); });
    it('keeps cancellation ownership until the runner and cancel adapter settle', async () => {
        const jobs = registry(); const actor = {sender: sender(1)}; const runner = deferred<IResult>(); const cancelHook = deferred<undefined>();
        const handle = jobs.start({jobId: 'owned', owner: actor, operation: {kind: 'abortable-work'}, initialProgress: initial('owned'), onCancel: () => cancelHook.promise, run: () => runner.promise});
        expect(handle.cancel('stop')).toBe(true); expect(jobs.get('owned', actor)?.status).toBe('canceling'); expect(snapshotMainOperations()).toHaveLength(1);
        expect(() => start(jobs, actor, 'owned', async () => ({value: 'late'}))).toThrow(expect.objectContaining({code: 'duplicate-job-id'}));
        runner.resolve({value: 'ignored'}); await expect(handle.terminal).resolves.toMatchObject({status: 'canceled'});
        expect(snapshotMainOperations()).toHaveLength(1); cancelHook.resolve(undefined); await handle.settled;
        expect(snapshotMainOperations()).toEqual([]); await jobs.clearForTests();
    });
    it('does not run a job when a start signal is already aborted', async () => {
        const jobs = registry(); const actor = {sender: sender(13)}; const signal = new AbortController(); const run = vi.fn(async () => ({value: 'unexpected'}));
        signal.abort(new Error('already canceled'));
        const handle = jobs.start({jobId: 'pre-canceled', owner: actor, operation: {kind: 'abortable-work'}, initialProgress: initial('pre-canceled'), signals: [signal.signal], run});
        await expect(handle.terminal).resolves.toMatchObject({status: 'canceled', error: {message: 'already canceled'}});
        expect(run).not.toHaveBeenCalled(); await handle.settled; expect(snapshotMainOperations()).toEqual([]); await jobs.clearForTests();
    });
    it('requires the complete owner tuple and multiplexes renderer listeners', async () => {
        const jobs = registry(); const ownerSender = sender(2); const runner = deferred<IResult>();
        const actor: IMainJobActor = {sender: ownerSender, ownerId: 'tab-a', documentInstanceId: 'document-a' as TDocumentInstanceId, documentRevision: 'revision-a'};
        const handles = ['owner-a', 'owner-b'].map(id => start(jobs, actor, id, () => runner.promise));
        const violations: IMainJobActor[] = [
            {sender: ownerSender}, {...actor, sender: sender(3)}, {...actor, ownerId: 'tab-b'},
            {...actor, documentInstanceId: 'document-b' as TDocumentInstanceId}, {...actor, documentRevision: 'revision-b'},
        ];
        for (const violation of violations) {
            expect(jobs.get('owner-a', violation)).toBeNull(); expect(jobs.subscribe('owner-a', violation, vi.fn())).toBeNull();
            expect(jobs.cancel('owner-a', violation)).toBe(false);
            await expect(jobs.await('owner-a', violation)).rejects.toMatchObject({code: 'not-found-or-unauthorized'});
        }
        expect(ownerSender.listenerCount('destroyed')).toBe(1); runner.resolve({value: 'done'});
        await Promise.all(handles.map(handle => handle.settled)); await jobs.clearForTests();
    });
    it('unbinds renderer listeners at settlement while retaining the terminal record', async () => {
        const jobs = registry(undefined, undefined, true); const ownerSender = sender(6); const actor = {sender: ownerSender}; const runner = deferred<IResult>();
        const handle = start(jobs, actor, 'terminal-retained', () => runner.promise);
        expect(ownerSender.listenerCount('destroyed')).toBe(1); expect(ownerSender.listenerCount('render-process-gone')).toBe(1);
        runner.resolve({value: 'done'}); await handle.settled;
        expect(ownerSender.listenerCount('destroyed')).toBe(0); expect(ownerSender.listenerCount('render-process-gone')).toBe(0);
        expect(jobs.get('terminal-retained', actor)).toMatchObject({status: 'completed'});
        expect(jobs.subscribe('terminal-retained', actor, vi.fn())).not.toBeNull(); await jobs.clearForTests();
    });
    it('replays latest active and terminal progress on distinct retention clocks', async () => {
        let clock = 1_000; const jobs = registry({eventReplayTtlMs: 30_000, terminalRecordTtlMs: 60_000}, () => clock);
        const ownerSender = sender(4); const actor = {sender: ownerSender}; const runner = deferred<IResult>(); let publish!: TContext['publish'];
        const handle = start(jobs, actor, 'replay', context => { publish = context.publish; return runner.promise; });
        await vi.waitFor(() => expect(publish).toBeTypeOf('function'));
        publish({requestId: 'replay', value: 1, status: 'running'}); publish({requestId: 'replay', value: 2, status: 'running'});
        ownerSender.send.mockClear(); jobs.subscribeOwner(actor);
        expect(ownerSender.send).toHaveBeenLastCalledWith('test:progress', expect.objectContaining({value: 2}));
        runner.resolve({value: 'done'}); await handle.settled; ownerSender.send.mockClear(); clock += 29_999; jobs.subscribeOwner(actor);
        expect(ownerSender.send).toHaveBeenCalledWith('test:progress', expect.objectContaining({status: 'completed'}));
        ownerSender.send.mockClear(); clock += 1; jobs.subscribeOwner(actor);
        expect(ownerSender.send).not.toHaveBeenCalled(); expect(jobs.get('replay', actor)?.status).toBe('completed');
        expect(jobs.subscribe('replay', actor, vi.fn())).not.toBeNull(); await jobs.clearForTests();
    });
    it('closes subscriptions through owner loss and record disposal', async () => {
        const jobs = registry(); const ownerSender = sender(11); const actor = {sender: ownerSender}; const closedOnOwnerLoss = vi.fn();
        const active = start(jobs, actor, 'owner-loss', context => new Promise<IResult>((_resolve, reject) => {
            const abort = () => reject(context.signal.reason);
            if (context.signal.aborted) abort();
            else context.signal.addEventListener('abort', abort, {once: true});
        }));
        expect(jobs.subscribe('owner-loss', actor, vi.fn(), closedOnOwnerLoss)).not.toBeNull();

        ownerSender.emit('destroyed');

        await active.settled; expect(closedOnOwnerLoss).toHaveBeenCalledOnce();
        const disposedSender = sender(12); const disposedActor = {sender: disposedSender}; const closedOnDisposal = vi.fn();
        const terminal = start(jobs, disposedActor, 'disposed', async () => ({value: 'done'}));
        await terminal.settled; expect(jobs.subscribe('disposed', disposedActor, vi.fn(), closedOnDisposal)).not.toBeNull();
        await jobs.clearForTests(); expect(closedOnDisposal).toHaveBeenCalledOnce();
    });
    it('publishes exactly one synthesized terminal and ignores late results', async () => {
        const jobs = registry(); const ownerSender = sender(5); let context!: TContext;
        const handle = start(jobs, {sender: ownerSender}, 'terminal', async current => { context = current; throw new Error('boom'); });
        await expect(handle.terminal).resolves.toMatchObject({status: 'failed', error: {message: 'boom'}});
        context.publish({requestId: 'terminal', value: 99, status: 'running'});
        expect(context.terminal.complete({value: 'late'})).toBe(false); expect(context.terminal.fail(new Error('later'))).toBe(false);
        expect(ownerSender.send.mock.calls.filter(([, progress]) => (progress as IProgress).status === 'failed')).toHaveLength(1);
        expect(jobs.get('terminal', {sender: ownerSender})).toMatchObject({status: 'failed', progress: {value: 0}});
        await jobs.clearForTests();
    });
    it('honors shutdown admission, abortable cancellation, and critical commit drain', async () => {
        const ownerSender = sender(6); beginMainOperationShutdown('closing'); let admissionError: unknown;
        try { start(registry(), {sender: ownerSender}, 'rejected', async () => ({value: 'never'})); } catch (error) { admissionError = error; }
        expect(getMainOperationErrorEnvelope(admissionError)).toEqual({code: 'shutting-down', message: 'closing'}); expect(snapshotMainOperations()).toEqual([]);
        resetMainOperationLifecycleForTests(); const jobs = registry();
        const abortable = start(jobs, {sender: ownerSender}, 'abortable', context => new Promise<IResult>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), {once: true})));
        const critical = deferred<IResult>(); const criticalHandle = jobs.start({
            owner: {sender: ownerSender}, operation: {kind: 'critical-write'}, initialProgress: initial('critical'),
            run: async context => { context.markCommitStarted(); return critical.promise; },
        });
        await vi.waitFor(() => expect(snapshotMainOperations().some(operation => operation.commitStarted)).toBe(true));
        cancelAllMainOperations('shutdown'); await expect(abortable.terminal).resolves.toMatchObject({status: 'canceled'});
        const drain = drainCriticalMainOperations({timeoutMs: 5_000}); expect(criticalHandle.signal.aborted).toBe(false);
        critical.resolve({value: 'written'}); await expect(drain).resolves.toEqual({completed: true, pending: []}); await jobs.clearForTests();
    });
    it('cleans scratch on success, failure, cancellation, and owner loss', async () => {
        const jobs = registry(); const paths: string[] = []; const senders = [sender(7), sender(8), sender(9), sender(10)];
        const handles = (['success', 'failure', 'cancel', 'cancel'] as const).map((mode, index) => jobs.start({
            jobId: `scratch-${mode}-${index}`, owner: {sender: senders[index]!}, operation: {kind: 'abortable-work'},
            initialProgress: initial(`scratch-${index}`), ownerLifecycle: {destroyed: 'cancel'},
            run: context => context.scratch.using('pdfExport-', async scratchPath => {
                paths.push(scratchPath); await writeFile(join(scratchPath, 'work'), 'data');
                if (mode === 'failure') throw new Error('scratch failure');
                if (mode === 'cancel') await new Promise<void>((_resolve, reject) => {
                    const abort = () => reject(context.signal.reason);
                    if (context.signal.aborted) abort();
                    else context.signal.addEventListener('abort', abort, {once: true});
                });
                return {value: 'done'};
            }),
        }));
        await vi.waitFor(() => expect(paths).toHaveLength(4)); handles[2]!.cancel(); senders[3]!.emit('destroyed');
        await Promise.all(handles.map(handle => handle.settled)); expect(paths.every(path => !existsSync(path))).toBe(true);
        const unmanaged = mkdtempSync(join(mocks.appTempDir, 'unmanaged-')); expect(existsSync(unmanaged)).toBe(true); await jobs.clearForTests();
    });
});
