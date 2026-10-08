import { getErrorMessage } from '@app/utils/error';
import { createPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/createPageRenderTimeoutError';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisor,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

const defaultPdfPageStageRenderSupervisor = createPdfRenderSupervisor();
let pageStageTimeoutSequence = 0;

interface IArmPageStageDeadlineOptions {
    key: string;
    metadata?: Record<string, unknown> | undefined;
    onRenderStall?: ((payload: IPageRenderStallPayload) => void) | undefined;
    onTimeout?: (() => void) | undefined;
    payload: IPageRenderStallPayload;
    renderSupervisor: IPdfRenderSupervisor;
    shouldNotify: () => boolean;
}

function logPageStageDeadlineCallbackFailure(
    callback: 'on-timeout' | 'render-stall-recovery',
    error: unknown,
    options: IArmPageStageDeadlineOptions,
) {
    logPdfRenderTrace('pdf-page-stage-deadline-callback-failed', {
        callback,
        error: getErrorMessage(error),
        key: options.key,
        pageNumber: options.payload.pageNumber,
        stage: options.payload.stage,
    });
}

/**
 * A render stage fails when it makes no progress for `payload.timeoutMs`.
 * `refresh` restarts that window, so a slow page that keeps drawing is not a
 * stall; a stage that never reports progress still fails once.
 */
export function armPageStageDeadline(options: IArmPageStageDeadlineOptions) {
    let rejectDeadline!: (error: unknown) => void;
    const promise = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
    });
    let fired = false;
    const arm = () => options.renderSupervisor.armTimer({
        cause: 'page-stage-timeout',
        delayMs: options.payload.timeoutMs,
        key: options.key,
        metadata: {
            ...options.metadata,
            pageNumber: options.payload.pageNumber,
            stage: options.payload.stage,
            timeoutMs: options.payload.timeoutMs,
        },
        onFire: () => {
            fired = true;
            rejectDeadline(createPageRenderTimeoutError(
                options.payload.pageNumber,
                options.payload.stage,
                options.payload.timeoutMs,
            ));
            try {
                options.onTimeout?.();
            } catch (error) {
                logPageStageDeadlineCallbackFailure('on-timeout', error, options);
            }
            try {
                if (options.shouldNotify()) {
                    options.onRenderStall?.(options.payload);
                }
            } catch (error) {
                logPageStageDeadlineCallbackFailure('render-stall-recovery', error, options);
            }
        },
    });
    let timer = arm();
    return {
        clear: () => timer.clear(),
        refresh: () => {
            if (!fired && timer.isCurrent()) {
                timer = arm();
            }
        },
        promise,
    };
}

export async function withPageStageTimeout<T>(
    promise: Promise<T>,
    payload: IPageRenderStallPayload,
    shouldNotify: () => boolean,
    onTimeout?: () => void,
    onRenderStall?: (payload: IPageRenderStallPayload) => void,
    renderSupervisor: IPdfRenderSupervisor = defaultPdfPageStageRenderSupervisor,
    signal?: AbortSignal,
) {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const createAbortError = () => {
            const error = new Error('Page render stage was aborted');
            error.name = 'AbortError';
            return error;
        };
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }
        pageStageTimeoutSequence += 1;
        const deadline = armPageStageDeadline({
            key: `page-stage-timeout:${payload.pageNumber}:${payload.stage}:${pageStageTimeoutSequence}`,
            onRenderStall,
            onTimeout: () => {
                signal?.removeEventListener('abort', handleAbort);
                onTimeout?.();
            },
            payload,
            renderSupervisor,
            shouldNotify,
        });
        void deadline.promise.catch((error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            signal?.removeEventListener('abort', handleAbort);
            reject(error);
        });
        const handleAbort = () => {
            if (settled) {
                return;
            }
            settled = true;
            deadline.clear();
            signal?.removeEventListener('abort', handleAbort);
            reject(createAbortError());
        };
        signal?.addEventListener('abort', handleAbort, {once: true});

        promise.then(
            (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal?.removeEventListener('abort', handleAbort);
                deadline.clear();
                resolve(value);
            },
            (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal?.removeEventListener('abort', handleAbort);
                deadline.clear();
                reject(error);
            },
        );
    });
}
