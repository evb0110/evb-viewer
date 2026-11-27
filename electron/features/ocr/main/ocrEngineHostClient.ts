import {EventEmitter} from 'node:events';
import * as electron from 'electron';
import type {IOcrEngineWorkerData} from '@electron/features/ocr/main/ocrEngineWorker';
import {
    decodeOcrEngineHostEvent,
    type IOcrEngineLaneReply,
    type IOcrEngineLaneRequest,
    type TOcrEngineHostRequest,
} from '@electron/features/ocr/main/ocrEngineHostProtocol';
import {createLogger} from '@electron/utils/createLogger';
import {OCR_ENGINE_SERVICE_NAME} from '@electron/processDeathRecovery';

const log = createLogger('ocr-engine-host');

// A host asked to exit that has not after this long is killed.
const HOST_EXIT_GRACE_MS = 5_000;

/**
 * One engine lane: a warm Tesseract engine on its own thread. It behaves like
 * a Node worker thread, so the pool cannot tell where it runs.
 */
export interface IOcrEngineLane {
    on(event: 'message', listener: (reply: IOcrEngineLaneReply) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'exit', listener: (code: number) => void): unknown;
    off(event: 'message', listener: (reply: IOcrEngineLaneReply) => void): unknown;
    off(event: 'error', listener: (error: Error) => void): unknown;
    off(event: 'exit', listener: (code: number) => void): unknown;
    /** Dropped once the lane has exited, as for a worker thread. */
    postMessage(message: IOcrEngineLaneRequest, transfer: ArrayBuffer[]): void;
    /** Ends the lane, busy or not; settles once it has exited. */
    terminate(): Promise<unknown>;
}

/** The OCR utility process ended while main had not asked it to. */
export class OcrEngineHostExitError extends Error {
    readonly code = 'OCR_ENGINE_HOST_EXITED';
    constructor(
        readonly exitCode: number,
        readonly pid: number | undefined,
        readonly lanes: number,
        /** The fatal error Electron reported before the exit, such as `FatalError`. */
        readonly failure?: string,
    ) {
        super(
            `The OCR engine process exited unexpectedly (exit code ${exitCode}, pid ${pid ?? 'unknown'}, ${lanes} running engine${lanes === 1 ? '' : 's'}${failure ? `, ${failure}` : ''})`,
        );
        this.name = 'OcrEngineHostExitError';
    }
}

type TUtilityProcess = ReturnType<typeof electron.utilityProcess.fork>;

interface IHostProcess {
    child: TUtilityProcess;
    lanes: Map<number, HostLane>;
    /** Asked to exit: it takes no more lanes or requests, and its exit is not a failure. */
    closing: boolean;
    exited: boolean;
    spawned: boolean;
    /** Requests sent before the process started. */
    outbox: TOcrEngineHostRequest[];
    killTimer?: NodeJS.Timeout;
    /** Its grace time ran out before it started; it gets another once it has. */
    killPending: boolean;
    /** The fatal error Electron reported, if any, before its exit. */
    failure?: string;
}

class HostLane extends EventEmitter implements IOcrEngineLane {
    private exitCode: number | null = null;
    private readonly exitedPromise: Promise<number>;
    private resolveExited!: (code: number) => void;

    constructor(
        private readonly send: (request: TOcrEngineHostRequest) => void,
        readonly id: number,
    ) {
        super();
        this.exitedPromise = new Promise((resolve) => {
            this.resolveExited = resolve;
        });
    }

    get exited() {
        return this.exitCode !== null;
    }

    postMessage(message: IOcrEngineLaneRequest) {
        if (this.exited) {
            return;
        }
        this.send({
            type: 'run',
            lane: this.id,
            message,
        });
    }

    terminate() {
        if (!this.exited) {
            this.send({
                type: 'end',
                lane: this.id,
            });
        }
        return this.exitedPromise;
    }

    fail(error: Error) {
        if (this.exited) {
            return;
        }
        // As for a worker thread, an error with no listener must not throw into main.
        if (this.listenerCount('error') > 0) {
            this.emit('error', error);
        }
    }

    markExited(code: number) {
        if (this.exited) {
            return;
        }
        this.exitCode = code;
        this.resolveExited(code);
        this.emit('exit', code);
    }
}

export interface IOcrEngineHostOptions {
    /** The utility process entry. */
    hostPath: string;
    /** The engine worker thread each lane runs inside the utility process. */
    workerPath: string;
    workerData: IOcrEngineWorkerData;
}

/**
 * Desktop's OCR engines live in one Electron utility process, each lane a
 * worker thread in it, so Tesseract's WebAssembly heaps and any crash stay
 * out of main. The process starts with the first lane and exits when its
 * last lane has ended, idle or not, giving all its memory back; the next
 * lane starts a fresh one. If it dies on its own, every lane on it fails
 * with an `OcrEngineHostExitError` and exits.
 */
export function createOcrEngineHost(options: IOcrEngineHostOptions) {
    const processes = new Set<IHostProcess>();
    let current: IHostProcess | null = null;
    let nextLane = 0;

    const send = (host: IHostProcess, request: TOcrEngineHostRequest) => {
        if (host.exited) {
            return;
        }
        // A closing process only needs to hear that it should exit.
        if (host.closing && request.type !== 'shutdown') {
            return;
        }
        if (!host.spawned) {
            host.outbox.push(request);
            return;
        }
        try {
            host.child.postMessage(request);
        } catch {
            // The process is going away; its exit ends the lanes.
        }
    };

    // Ends a process now. Before it has started there is no process to kill,
    // so it gets its grace time again once it has.
    const kill = (host: IHostProcess, reason: string) => {
        if (host.exited) {
            return;
        }
        if (!host.spawned) {
            host.killPending = true;
            return;
        }
        log.warn('Killing the OCR engine process', {
            code: 'OCR_ENGINE_HOST_KILLED',
            reason,
            pid: host.child.pid,
            lanes: host.lanes.size,
        });
        host.child.kill();
    };

    const armKill = (host: IHostProcess) => {
        clearTimeout(host.killTimer);
        host.killTimer = setTimeout(() => kill(host, 'did not exit within its grace time'), HOST_EXIT_GRACE_MS);
        host.killTimer.unref();
    };

    const retire = (host: IHostProcess) => {
        host.closing = true;
        host.outbox.length = 0;
        if (current === host) {
            current = null;
        }
    };

    const close = (host: IHostProcess) => {
        if (host.closing) {
            return;
        }
        retire(host);
        send(host, {type: 'shutdown'});
        armKill(host);
    };

    // A process that sent what main cannot read is not trusted with more
    // pages: every page on it fails now rather than at its time limit, and it
    // is killed. Its lanes exit with it.
    const abandon = (host: IHostProcess, message: string) => {
        if (host.exited) {
            return;
        }
        log.warn('OCR engine process sent an invalid message', {
            code: 'OCR_ENGINE_HOST_INVALID_MESSAGE',
            pid: host.child.pid,
            lanes: host.lanes.size,
        });
        retire(host);
        const error = new Error(message);
        for (const lane of host.lanes.values()) {
            lane.fail(error);
        }
        kill(host, 'sent an invalid message');
    };

    const laneExited = (host: IHostProcess, lane: HostLane, code: number) => {
        host.lanes.delete(lane.id);
        lane.markExited(code);
        if (host.lanes.size === 0) {
            close(host);
        }
    };

    const hostExited = (host: IHostProcess, code: number) => {
        if (host.exited) {
            return;
        }
        host.exited = true;
        host.outbox.length = 0;
        clearTimeout(host.killTimer);
        processes.delete(host);
        if (current === host) {
            current = null;
        }
        const lanes = Array.from(host.lanes.values());
        host.lanes.clear();
        if (!host.closing) {
            const error = new OcrEngineHostExitError(code, host.child.pid, lanes.length, host.failure);
            log.warn('OCR engine process exited unexpectedly', {
                code: error.code,
                exitCode: code,
                pid: host.child.pid,
                lanes: lanes.length,
                ...(host.failure ? {failure: host.failure} : {}),
            });
            for (const lane of lanes) {
                lane.fail(error);
            }
        }
        for (const lane of lanes) {
            lane.markExited(code);
        }
    };

    const spawn = (): IHostProcess => {
        const child = electron.utilityProcess.fork(options.hostPath, [], {
            serviceName: OCR_ENGINE_SERVICE_NAME,
            stdio: 'ignore',
        });
        const host: IHostProcess = {
            child,
            lanes: new Map(),
            closing: false,
            exited: false,
            spawned: false,
            outbox: [],
            killPending: false,
        };
        processes.add(host);
        child.once('spawn', () => {
            host.spawned = true;
            for (const request of host.outbox.splice(0)) {
                send(host, request);
            }
            if (host.killPending) {
                host.killPending = false;
                armKill(host);
            }
        });
        // A V8 fatal error or running out of memory; the exit that follows
        // fails the lanes. Without a listener the event would throw into main.
        child.on('error', (type: string, location: string) => {
            host.failure = `${type} at ${location}`;
            log.warn('OCR engine process failed', {
                code: 'OCR_ENGINE_HOST_FATAL',
                type,
                location,
                pid: child.pid,
            });
        });
        child.on('message', (value: unknown) => {
            if (host.exited) {
                return;
            }
            const event = decodeOcrEngineHostEvent(value);
            if (!event) {
                const laneId = (value as {lane?: unknown} | null)?.lane;
                const target = typeof laneId === 'number' ? host.lanes.get(laneId) : undefined;
                if (!target) {
                    abandon(host, 'The OCR engine process sent a message main cannot read');
                    return;
                }
                log.warn('OCR engine process sent an invalid message', {
                    code: 'OCR_ENGINE_HOST_INVALID_MESSAGE',
                    pid: child.pid,
                    lane: target.id,
                });
                // A page whose answer cannot be read would wait for its time
                // limit; fail it now and end its lane.
                target.fail(new Error('The OCR engine returned an invalid result'));
                void target.terminate();
                return;
            }
            const lane = host.lanes.get(event.lane);
            // A lane that has exited may still have a message in flight.
            if (!lane) {
                return;
            }
            switch (event.type) {
                case 'reply':
                    lane.emit('message', event.reply);
                    return;
                case 'error':
                    lane.fail(new Error(event.message));
                    return;
                case 'exit':
                    laneExited(host, lane, event.code);
                    return;
            }
        });
        child.once('exit', (code) => hostExited(host, code));
        return host;
    };

    return {
        /** Starts an engine lane in the OCR utility process, starting the process if none runs. */
        startLane(): IOcrEngineLane {
            // A fork that throws leaves no process behind; the next lane tries again.
            const host = current ?? spawn();
            current = host;
            const lane = new HostLane((request) => send(host, request), nextLane++);
            host.lanes.set(lane.id, lane);
            send(host, {
                type: 'start',
                lane: lane.id,
                workerPath: options.workerPath,
                workerData: options.workerData,
            });
            return lane;
        },
        /** Asks every OCR utility process to end its lanes and exit. */
        shutdown() {
            for (const host of processes) {
                close(host);
            }
        },
    };
}
