import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isRecord } from '@contracts/runtimeGuards';
import { SEARCH_NATIVE_PROTOCOL_VERSION } from '@contracts/nativeToolProtocols';
import {
    isNativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import { appendTextChunkWithByteCap } from '@electron/native-tools/appendTextChunkWithByteCap';
import { getErrorMessage } from '@electron/utils/error';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';

const SEARCH_SERVICE_READY_TIMEOUT_MS = 5_000;
const SEARCH_SERVICE_IDLE_TIMEOUT_MS = 5 * 60_000;
const SEARCH_SERVICE_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const SEARCH_SERVICE_MAX_STDERR_BYTES = 64 * 1024;
const SEARCH_SERVICE_SHUTDOWN_GRACE_MS = 1_500;

export const persistentNativeSearchRuntime = {terminateDetachedChildProcess};

const stoppingServiceTerminations = new Set<Promise<void>>();
const stoppingServiceFailures: unknown[] = [];

function trackStoppingServiceTermination(termination: Promise<void>) {
    const tracked = termination
        .catch((error: unknown) => {
            stoppingServiceFailures.push(error);
            throw error;
        })
        .finally(() => stoppingServiceTerminations.delete(tracked));
    stoppingServiceTerminations.add(tracked);
    void tracked.catch(() => {
        // Coordinated shutdown reads the rejection from stoppingServiceTerminations.
    });
}

class NativeSearchServiceError extends Error {
    constructor(readonly code: TNativeErrorCode, message: string) {
        super(message);
        this.name = 'NativeSearchServiceError';
    }
}

interface IPersistentNativeSearchRequest {
    contextChars: number;
    documentRevision: string;
    indexPath: string;
    limit: number;
    matchCase: boolean;
    pageCount?: number;
    query: string;
}

interface IPendingSearchRequest {
    reject: (error: Error) => void;
    resolve: (result: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
}

class PersistentNativeSearchService {
    readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<string, IPendingSearchRequest>();
    private readonly ready: Promise<void>;
    private resolveReady: (() => void) | null = null;
    private rejectReady: ((error: Error) => void) | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private startingSearches = 0;
    private stopped = false;
    private stderr = '';
    private stderrTruncated = false;
    private shutdownPromise: Promise<void> | null = null;
    private readonly exited: Promise<void>;

    constructor(
        binaryPath: string,
        private readonly idleTimeoutMs: number,
        private readonly onStopped: () => void,
    ) {
        this.child = spawn(binaryPath, ['serve'], createDetachedChildProcessSpawnOptions({
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
            windowsHide: true,
        }));
        this.child.unref();
        this.exited = new Promise(resolve => this.child.once('exit', () => resolve()));
        this.ready = new Promise<void>((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        const lines = createInterface({input: this.child.stdout});
        lines.on('line', line => this.handleLine(line));
        this.child.once('error', error => this.stop(error));
        this.child.once('exit', (code, signal) => this.stop(new Error(
            `Persistent native search service exited (${signal ?? code ?? 'unknown'})`,
        )));
        this.child.stdin.on('error', error => this.stop(error));
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', (chunk: string | Buffer) => {
            const appended = appendTextChunkWithByteCap(
                this.stderr,
                Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                SEARCH_SERVICE_MAX_STDERR_BYTES,
            );
            this.stderr = appended.text;
            this.stderrTruncated = this.stderrTruncated || appended.truncated;
        });
        this.armIdleTimer();
    }

    private armIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (this.pending.size === 0) {
                this.stop(new Error('Persistent native search service idle timeout'));
            }
        }, this.idleTimeoutMs);
        this.idleTimer.unref();
    }

    private disarmIdleTimer() {
        if (!this.idleTimer) {
            return;
        }
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    private armIdleTimerIfIdle() {
        if (this.pending.size === 0 && this.startingSearches === 0 && !this.stopped) {
            this.armIdleTimer();
        }
    }

    private handleLine(line: string) {
        if (Buffer.byteLength(line) > SEARCH_SERVICE_MAX_FRAME_BYTES) {
            this.stop(new Error('Persistent native search service frame exceeds limit'));
            return;
        }
        let frame: unknown;
        try {
            frame = JSON.parse(line);
        } catch {
            this.stop(new Error('Persistent native search service emitted invalid JSON'));
            return;
        }
        if (!isRecord(frame) || typeof frame.type !== 'string') {
            this.stop(new Error('Persistent native search service emitted an invalid frame'));
            return;
        }
        if (frame.type === 'ready') {
            if (frame.protocolVersion !== SEARCH_NATIVE_PROTOCOL_VERSION) {
                const receivedProtocolVersion = typeof frame.protocolVersion === 'number'
                    ? String(frame.protocolVersion)
                    : '<missing>';
                this.stop(new Error(
                    'Persistent native search service protocol mismatch: '
                    + `expected ${SEARCH_NATIVE_PROTOCOL_VERSION}, got ${receivedProtocolVersion}`,
                ));
                return;
            }
            this.resolveReady?.();
            this.clearReadyCallbacks();
            return;
        }
        const requestId = typeof frame.requestId === 'string' ? frame.requestId : '';
        const pending = this.pending.get(requestId);
        if (!pending) {
            return;
        }
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        this.armIdleTimerIfIdle();
        if (frame.type === 'result') {
            pending.resolve(frame.result);
        } else {
            const error = isNativeErrorEnvelope(frame.error)
                ? new NativeSearchServiceError(frame.error.code, frame.error.message)
                : new NativeSearchServiceError(
                    frame.type === 'canceled' ? 'native-failure' : 'invalid-request',
                    frame.type === 'canceled' ? 'Native search canceled' : 'Persistent native search failed',
                );
            pending.reject(error);
        }
    }

    private writeFrame(frame: unknown) {
        if (this.stopped || !this.child.stdin.writable) {
            throw new Error('Persistent native search service is unavailable');
        }
        this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    }

    resetCache() {
        this.writeFrame({type: 'reset-cache'});
    }

    shutdown(reason: string) {
        this.shutdownPromise ??= this.performShutdown(reason);
        return this.shutdownPromise;
    }

    private async performShutdown(reason: string) {
        if (this.stopped) {
            await this.ensureProcessTreeStopped();
            return;
        }
        try {
            this.writeFrame({type: 'shutdown'});
        } catch {
            // The process-tree fallback still owns daemon cleanup.
        }
        this.markStopped(new Error(reason));
        const exitedCooperatively = await Promise.race([
            this.exited.then(() => true),
            new Promise<false>(resolve => {
                const timer = setTimeout(() => resolve(false), SEARCH_SERVICE_SHUTDOWN_GRACE_MS);
                timer.unref();
            }),
        ]);
        if (!exitedCooperatively) {
            await this.ensureProcessTreeStopped();
        }
    }

    private async ensureProcessTreeStopped() {
        const stopped = await persistentNativeSearchRuntime.terminateDetachedChildProcess(
            this.child,
            SEARCH_SERVICE_SHUTDOWN_GRACE_MS,
        );
        if (!stopped) {
            throw new Error(`Persistent native search process tree ${this.child.pid ?? '<unknown>'} did not stop`);
        }
    }

    private tryWriteCancelFrame(requestId: string) {
        try {
            this.writeFrame({
                type: 'cancel',
                requestId,
            });
        } catch {
            // The request still has to settle when the daemon closes stdin first.
        }
    }

    async search(request: IPersistentNativeSearchRequest, options: {
        signal?: AbortSignal;
        timeoutMs: number
    }) {
        this.startingSearches += 1;
        this.disarmIdleTimer();
        try {
            await this.waitUntilReady(options.signal);
        } catch (error) {
            this.startingSearches -= 1;
            this.armIdleTimerIfIdle();
            throw error;
        }
        this.startingSearches -= 1;
        if (options.signal?.aborted) {
            this.armIdleTimerIfIdle();
            throw new Error('Native search canceled');
        }
        const requestId = randomUUID();
        return new Promise<unknown>((resolve, reject) => {
            let settled = false;
            const settle = (action: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                options.signal?.removeEventListener('abort', abort);
                action();
            };
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                this.armIdleTimerIfIdle();
                this.tryWriteCancelFrame(requestId);
                settle(() => reject(new Error('Persistent native search service request timeout')));
            }, options.timeoutMs);
            timer.unref();
            const abort = () => {
                const pending = this.pending.get(requestId);
                if (!pending) {
                    return;
                }
                this.pending.delete(requestId);
                clearTimeout(pending.timer);
                this.armIdleTimerIfIdle();
                this.tryWriteCancelFrame(requestId);
                settle(() => reject(new Error('Native search canceled')));
            };
            options.signal?.addEventListener('abort', abort, {once: true});
            this.pending.set(requestId, {
                reject: error => {
                    settle(() => reject(error));
                },
                resolve: result => {
                    settle(() => resolve(result));
                },
                timer,
            });
            this.disarmIdleTimer();
            if (options.signal?.aborted) {
                abort();
                return;
            }
            try {
                this.writeFrame({
                    type: 'search',
                    requestId,
                    ...request,
                });
            } catch (error) {
                this.pending.delete(requestId);
                clearTimeout(timer);
                this.armIdleTimerIfIdle();
                settle(() => reject(error));
            }
        });
    }

    private async waitUntilReady(signal?: AbortSignal) {
        if (signal?.aborted) {
            throw new Error('Native search canceled');
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        try {
            await Promise.race([
                this.ready,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error('Persistent native search service ready timeout');
                        this.stop(error);
                        reject(error);
                    }, SEARCH_SERVICE_READY_TIMEOUT_MS);
                    timer.unref();
                }),
                ...(signal ? [new Promise<never>((_, reject) => {
                    abort = () => reject(new Error('Native search canceled'));
                    signal.addEventListener('abort', abort, {once: true});
                    if (signal.aborted) {
                        abort();
                    }
                })] : []),
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
            if (abort) {
                signal?.removeEventListener('abort', abort);
            }
        }
    }

    private clearReadyCallbacks() {
        this.rejectReady = null;
        this.resolveReady = null;
    }

    private markStopped(error: Error) {
        if (this.stopped) {
            return false;
        }
        this.stopped = true;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        if (this.stderr.trim()) {
            const truncationNote = this.stderrTruncated
                ? `[native stderr truncated to ${SEARCH_SERVICE_MAX_STDERR_BYTES} bytes] `
                : '';
            error.message = `${error.message}; ${truncationNote}native stderr: ${this.stderr.trim()}`;
        }
        this.rejectReady?.(error);
        this.clearReadyCallbacks();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.onStopped();
        return true;
    }

    private stop(error: Error) {
        if (!this.markStopped(error)) {
            return;
        }
        trackStoppingServiceTermination(this.ensureProcessTreeStopped());
    }
}

const services = new Map<string, PersistentNativeSearchService>();

export function resetPersistentNativeSearchServiceCaches() {
    for (const service of services.values()) {
        try {
            service.resetCache();
        } catch {
            // A stopped daemon is evicted by its lifecycle handlers.
        }
    }
}

export async function shutdownPersistentNativeSearchServices(reason: string) {
    const activeServices = Array.from(services.values());
    const shutdownAttempts = [
        ...activeServices.map(service => service.shutdown(reason)),
        ...stoppingServiceTerminations,
    ];
    const results = await Promise.allSettled(shutdownAttempts);
    const failures: unknown[] = [];
    for (const result of results) {
        if (result.status === 'rejected') {
            failures.push(result.reason as unknown);
        }
    }
    for (const failure of stoppingServiceFailures.splice(0)) {
        if (!failures.includes(failure)) {
            failures.push(failure);
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Persistent native search shutdown failed: ${failures.map(getErrorMessage).join('; ')}`,
        );
    }
}

function persistentSearchIsDisabled() {
    return process.env.EVB_PDF_SEARCH_SERVICE_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env.EVB_PDF_SEARCH_SERVICE_ENABLE !== '1');
}

export async function tryRunPersistentNativeSearch(
    binaryPath: string,
    request: IPersistentNativeSearchRequest,
    options: {
        idleTimeoutMs?: number;
        signal?: AbortSignal;
        timeoutMs: number
    },
) {
    if (persistentSearchIsDisabled()) {
        return null;
    }
    if (options.signal?.aborted) {
        throw new Error('Native search canceled');
    }
    let service = services.get(binaryPath);
    if (!service) {
        service = new PersistentNativeSearchService(
            binaryPath,
            options.idleTimeoutMs ?? SEARCH_SERVICE_IDLE_TIMEOUT_MS,
            () => services.delete(binaryPath),
        );
        services.set(binaryPath, service);
    }
    return service.search(request, options);
}
