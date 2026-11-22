import type {
    InjectionKey,
    ShallowRef,
} from 'vue';
import type {
    ICreatePdfDocumentSessionOptions,
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type {
    TPdfSource, TPdfSourceJobOutcome,
} from '@app/types/pdfUi';

/** Why the document published its source: a new document, a rewrite of it, a saved revision, or nothing. */
export type TPdfSourceJobIntent = 'open' | 'reload' | 'adopt' | 'clear';

/**
 * One publication of the document's PDF source, until every view presenting
 * it settles. Its controller aborts with the outcome, which ends work on its
 * behalf. A job no renderer takes ends only when superseded or released.
 */
export interface IPdfSourceJob {
    readonly intent: TPdfSourceJobIntent;
    readonly source: TPdfSource | null;
    readonly reloadSource: TPdfSource | null;
    readonly abort: AbortController;
    readonly finished: Promise<TPdfSourceJobOutcome>;
}

export function createPdfSourceJob(
    intent: TPdfSourceJobIntent,
    options: Pick<ICreatePdfDocumentSessionOptions, 'src' | 'reloadSrc'>,
): IPdfSourceJob {
    const abort = new AbortController();
    return {
        intent,
        source: options.src?.value ?? null,
        reloadSource: options.reloadSrc?.value ?? null,
        abort,
        finished: new Promise(resolve => abort.signal.addEventListener('abort', () => resolve(abort.signal.reason as TPdfSourceJobOutcome))),
    };
}

/** The first outcome wins, as the first abort does. */
export function settlePdfSourceJob(job: IPdfSourceJob, outcome: TPdfSourceJobOutcome) {
    job.abort.abort(outcome);
}

/**
 * Where a document keeps its one PDF session. The session module loads
 * PDF.js, which only the lazily loaded viewer may import, so the document's
 * first viewer creates the session here, in the document's effect scope: it
 * lives as long as the document, not as long as that viewer. The document
 * reads it here, without a view (null until a viewer created it), and admits
 * each source it publishes here; a job admitted before then waits for it.
 */
export function createPdfDocumentSessionSlot(options: ICreatePdfDocumentSessionOptions) {
    const scope = effectScope();
    const session = shallowRef<TPdfDocumentSession | null>(null);
    let waitingJob: IPdfSourceJob | null = null;
    // A document that closes before any viewer took its job releases it.
    scope.run(() => onScopeDispose(() => waitingJob && settlePdfSourceJob(waitingJob, {status: 'released'})));
    return {
        session: session as Readonly<ShallowRef<TPdfDocumentSession | null>>,
        /** Admits the source just published; the publisher never waits for a renderer. */
        admit(intent: TPdfSourceJobIntent): IPdfSourceJob {
            const job = createPdfSourceJob(intent, options);
            if (session.value) {
                return session.value.admit(job);
            }
            if (waitingJob) settlePdfSourceJob(waitingJob, {status: 'superseded'});
            waitingJob = intent === 'clear' ? null : job;
            if (intent === 'clear') settlePdfSourceJob(job, {status: 'released'});
            return job;
        },
        /** The reload or Save adoption still running for the published source, else null. */
        running() {
            const job = session.value?.currentJob ?? waitingJob;
            return job?.source && job.intent !== 'open' && !job.abort.signal.aborted ? job : null;
        },
        /** Ends a running job as released; a waiting one is no longer handed to the first viewer. */
        release(job: IPdfSourceJob) {
            if (job === waitingJob) waitingJob = null;
            settlePdfSourceJob(job, {status: 'released'});
        },
        resolve(create: (sessionOptions: ICreatePdfDocumentSessionOptions) => TPdfDocumentSession) {
            if (!session.value) {
                session.value = scope.run(() => create(options)) ?? null;
                if (session.value && waitingJob) session.value.admit(waitingJob);
                waitingJob = null;
            }
            if (!session.value) {
                throw new Error('The document of this PDF session is closed.');
            }
            return session.value;
        },
    };
}

export type TPdfDocumentSessionSlot = ReturnType<typeof createPdfDocumentSessionSlot>;

/** A document provides its PDF session slot to the viewers it mounts. */
export const pdfDocumentSessionSlotKey: InjectionKey<TPdfDocumentSessionSlot> = Symbol('pdfDocumentSessionSlot');
