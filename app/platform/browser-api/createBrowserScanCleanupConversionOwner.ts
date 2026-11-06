import type {
    IScanCleanupCapability,
    IScanCleanupOwnerContext,
    IScanCleanupStartRequest,
    TScanCleanupJobState,
    TScanCleanupStartResult,
    TScanCleanupSummary,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {attachScanCleanupPageOverrideDefaults} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {REQUEST_HEADER} from '@contracts/browserPageOpsWasm.generated';
import type {TDocumentRef} from '@contracts/documentRef';
import {createJobId} from '@contracts/shared';
import {createEpochMs} from '@contracts/timestamps';
import {formatScanCleanupOutputName} from '@evb/scan-cleanup/core/formatScanCleanupOutputName';
import {getErrorMessage} from '@app/utils/error';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import {createBrowserScanCleanupJobRegistry} from '@app/platform/browser-api/createBrowserScanCleanupJobRegistry';
import type {createBrowserScanCleanupDetectionOwner} from '@app/platform/browser-api/createBrowserScanCleanupDetectionOwner';
import {classifyBrowserScanCleanupError} from '@app/platform/browser-api/classifyBrowserScanCleanupError';
import {
    awaitScanCleanupSource,
    borrowBrowserScanCleanupSource,
} from '@app/platform/browser-api/browserScanCleanupSources';

type TJobListener = Parameters<IScanCleanupCapability['onJobState']>[0];

interface IConversionResult {
    outputRef: TDocumentRef;
    summary: TScanCleanupSummary;
    partial: boolean;
}

const isPartial = (request: IScanCleanupStartRequest) => request.sourcePageNumbers !== undefined
    || request.sourcePageRange !== undefined;

const isLiveStatus = (status: TScanCleanupJobState['status']) => status === 'queued'
    || status === 'running'
    || status === 'canceling'
    || status === 'handoff'
    || status === 'committing';

function withoutPageMetadata(progress: TScanCleanupJobState['progress']) {
    const {
        completedPageNumbers: _completedPageNumbers,
        completedPageNumbersTruncated: _completedPageNumbersTruncated,
        etaSeconds: _etaSeconds,
        ...rest
    } = progress;
    return rest;
}

/**
 * The window's Scan Cleanup conversions, as desktop's service runs them: one
 * job per start, its progress delivered to listeners, cancelable until it
 * commits its output, and completed with a new browser document the
 * workspace opens in a tab.
 */
export function createBrowserScanCleanupConversionOwner(
    detection: ReturnType<typeof createBrowserScanCleanupDetectionOwner>,
) {
    const listeners = new Set<TJobListener>();
    const sourceByJob = new Map<string, {
        ref: string;
        owner: IScanCleanupOwnerContext
    }>();
    const jobs = createBrowserScanCleanupJobRegistry<TScanCleanupJobState, IConversionResult>({
        terminal: {
            completed: (latest, result) => ({
                jobId: latest.jobId,
                status: 'completed',
                outputPdfPath: result.outputRef,
                summary: result.summary,
                partial: result.partial,
                progress: {
                    ...withoutPageMetadata(latest.progress),
                    stage: 'handoff',
                    completedUnits: result.summary.inputPages,
                    totalUnits: result.summary.inputPages,
                    percent: 100,
                },
                updatedAtMs: createEpochMs(),
            }),
            canceled: latest => ({
                jobId: latest.jobId,
                status: 'canceled',
                progress: latest.progress,
                updatedAtMs: createEpochMs(),
            }),
            failed: (latest, error) => ({
                jobId: latest.jobId,
                status: 'failed',
                progress: latest.progress,
                error: getErrorMessage(error),
                errorCode: classifyBrowserScanCleanupError(error),
                updatedAtMs: createEpochMs(),
            }),
        },
        canceling: latest => ({
            jobId: latest.jobId,
            status: 'canceling',
            progress: latest.progress,
            updatedAtMs: createEpochMs(),
        }),
        cancelable: latest => latest.status !== 'committing',
        onState: state => {
            for (const listener of [...listeners]) listener(state);
        },
    });

    const run = async (
        request: IScanCleanupStartRequest,
        outputRef: TDocumentRef,
        context: Parameters<Parameters<typeof jobs.start>[0]['run']>[0],
    ): Promise<IConversionResult> => {
        const {signal} = context;
        const publish = (status: 'running' | 'committing', progress: TScanCleanupJobState['progress']) => {
            context.publish({
                jobId: context.latest().jobId,
                status,
                progress,
                updatedAtMs: createEpochMs(),
            });
        };
        const lease = request.detectionResultStoreId === undefined
            ? null
            : detection.leaseResultStore(request.detectionResultStoreId, request);
        if (request.detectionResultStoreId !== undefined && lease === null) {
            throw new Error('Detection results are no longer available for this document');
        }
        const borrow = borrowBrowserScanCleanupSource(request.sourcePdfPath, request.documentRevision);
        try {
            const source = await awaitScanCleanupSource(borrow.opened, signal);
            const token = requireDocumentRevisionToken(request.documentRevision);
            const {runBrowserScanCleanupConversion} = await import('@app/platform/browser-api/runBrowserScanCleanupConversion');
            const {
                detectionResultStoreId: _detectionResultStoreId,
                ownerId: _ownerId,
                documentRevision: _documentRevision,
                ...pipelineRequest
            } = request;
            const result = await runBrowserScanCleanupConversion({
                request: {
                    ...pipelineRequest,
                    outputPdfPath: '',
                    ...(lease === null ? {} : {detectionResultStore: lease.store}),
                },
                source,
                readSource: async () => {
                    await browserDocumentStore.assertDocumentRevisionCurrent(request.sourcePdfPath, token);
                    return browserDocumentStore.read(request.sourcePdfPath, {maxBytes: BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - REQUEST_HEADER.bytes});
                },
                signal,
                onProgress: progress => publish('running', progress),
            });
            signal.throwIfAborted();
            // Past this point the output is being published; a cancel would
            // leave the workspace without the document it is about to open.
            publish('committing', context.latest().progress);
            if (!await browserDocumentStore.write(outputRef, result.pdf)) {
                throw new Error('Scan cleanup could not store the cleaned document');
            }
            return {
                outputRef,
                summary: result.summary,
                partial: isPartial(request),
            };
        } finally {
            borrow.release();
            lease?.release();
        }
    };

    const owned = (jobId: string, owner: IScanCleanupOwnerContext) => jobs.get(jobId, owner);

    return {
        onJobState(listener: TJobListener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        async start(request: IScanCleanupStartRequest): Promise<TScanCleanupStartResult> {
            attachScanCleanupPageOverrideDefaults(
                request.options.pageOverrides,
                request.options.pageOverrideDefaults,
                request.options.marginsMm,
            );
            const jobId = createJobId('scan-cleanup');
            // The output document exists from the start, as desktop's output
            // path does; a run that does not complete removes it.
            let outputRef: TDocumentRef;
            try {
                outputRef = await browserDocumentStore.createStoredDocument(
                    formatScanCleanupOutputName(
                        getBrowserDocumentFileName(request.sourcePdfPath).replace(/\.[^.]+$/u, ''),
                        isPartial(request),
                    ),
                    new Uint8Array(),
                    {
                        mimeType: 'application/pdf',
                        saveKind: 'pdf',
                        kind: 'output',
                        retention: 'transient',
                    },
                );
            } catch (error) {
                return {
                    started: false,
                    jobId,
                    error: getErrorMessage(error),
                    errorCode: classifyBrowserScanCleanupError(error),
                };
            }
            sourceByJob.set(jobId, {
                ref: request.sourcePdfPath,
                owner: request,
            });
            const {settled} = jobs.start({
                jobId,
                owner: request,
                initial: {
                    jobId,
                    status: 'queued',
                    progress: {
                        stage: 'queued',
                        completedUnits: 0,
                        totalUnits: 1,
                        percent: 0,
                    },
                    updatedAtMs: createEpochMs(),
                },
                run: context => run(request, outputRef, context),
            });
            void settled.finally(async () => {
                sourceByJob.delete(jobId);
                if (jobs.get(jobId, request)?.status !== 'completed') {
                    await browserDocumentStore.remove(outputRef).catch(() => undefined);
                }
            });
            return {
                started: true,
                jobId,
                outputPdfPath: outputRef,
            };
        },
        cancel(jobId: string, owner: IScanCleanupOwnerContext) {
            const state = owned(jobId, owner);
            if (state === null || !isLiveStatus(state.status)) return Promise.resolve(false);
            return Promise.resolve(jobs.cancel(jobId, owner, 'Scan cleanup canceled') === 'canceled');
        },
        getJobState(jobId: string, owner: IScanCleanupOwnerContext) {
            return Promise.resolve(owned(jobId, owner));
        },
        /** A closed source ends its conversions that have not begun publishing. */
        closeSource(ref: TDocumentRef) {
            for (const [
                jobId,
                job,
            ] of sourceByJob) {
                if (job.ref === ref) jobs.cancel(jobId, job.owner, 'Scan cleanup source closed');
            }
        },
    };
}
