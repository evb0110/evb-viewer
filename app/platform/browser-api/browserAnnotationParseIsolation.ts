import {BrowserPageOpsWorkerUnavailableError} from '@app/platform/browser-api/browserPageOpsWorkerUnavailableError';

const MAX_CONCURRENT_WORKERS = 2;
const MAX_QUEUED_REQUESTS = 8;

interface IAdmissionWaiter {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
}

function abortErrorFromSignal(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error('Browser page operation request was aborted');
}

export class BrowserAnnotationParseIsolation {
    private activeWorkers = 0;
    private readonly waiters: IAdmissionWaiter[] = [];

    public acquire(signal?: AbortSignal) {
        if (signal?.aborted) {
            return Promise.reject(abortErrorFromSignal(signal));
        }

        if (this.activeWorkers < MAX_CONCURRENT_WORKERS) {
            this.activeWorkers += 1;
            return this.createRelease();
        }

        if (this.waiters.length >= MAX_QUEUED_REQUESTS) {
            return Promise.reject(new BrowserPageOpsWorkerUnavailableError(
                'Browser annotation parse worker queue is full',
            ));
        }

        return new Promise<() => void>((resolve, reject) => {
            const waiter: IAdmissionWaiter = {
                resolve,
                reject,
                ...(signal ? {signal} : {}),
            };
            if (signal) {
                waiter.abort = () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index < 0) {
                        return;
                    }
                    this.waiters.splice(index, 1);
                    signal.removeEventListener('abort', waiter.abort!);
                    reject(abortErrorFromSignal(signal));
                };
                signal.addEventListener('abort', waiter.abort, {once: true});
            }
            this.waiters.push(waiter);
        });
    }

    private createRelease() {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.activeWorkers = Math.max(0, this.activeWorkers - 1);
            this.pump();
        };
    }

    private pump() {
        while (this.activeWorkers < MAX_CONCURRENT_WORKERS && this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            if (waiter.signal && waiter.abort) {
                waiter.signal.removeEventListener('abort', waiter.abort);
            }
            if (waiter.signal?.aborted) {
                waiter.reject(abortErrorFromSignal(waiter.signal));
                continue;
            }
            this.activeWorkers += 1;
            waiter.resolve(this.createRelease());
        }
    }
}

export const browserAnnotationParseIsolation = new BrowserAnnotationParseIsolation();
