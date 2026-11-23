import {
    watch,
    type Ref,
} from 'vue';
import type {
    IPdfSourceJob,
    TPdfSourceJobIntent,
} from '@app/modules/pdf-viewer/public';
import type { TPdfSource } from '@app/types/pdfUi';

/** Stops ending a document's jobs; `true` publishes the revision again when one was ended. */
export type TEndDocumentJobRelease = (republish: boolean) => void;

export const NO_DOCUMENT_JOB_RELEASE: TEndDocumentJobRelease = () => undefined;

/**
 * Coordinates ending a document's running reload or Save adoption during tab/window close (#1598),
 * and republishing a released revision inside Save's own document operation lease turn (N7).
 */
export interface IDocumentJobReleaser {
    /** Begins a release scope; the returned end function stops this scope and optionally republishes. */
    begin(): TEndDocumentJobRelease;
    /**
     * Publishes the revision again when an active release ended a job, while keeping the release
     * active so jobs published after it (such as Save's adoption) are still ended.
     */
    republishForSave(): void;
}

/**
 * While a view shows the document, ends its running job and each one it publishes until every active
 * release scope has ended. A revision is published again only while the working copy is still the
 * one the release began with and a non-null PDF source is present.
 */
export function createDocumentJobReleaser(document: {
    workingCopyPath: Readonly<Ref<unknown>>;
    pdfSrc: Readonly<Ref<TPdfSource | null>>;
    publishPdfSource: (source: TPdfSource | null, intent: TPdfSourceJobIntent) => IPdfSourceJob;
    hasView: () => boolean;
    running: () => IPdfSourceJob | null;
    release: (job: IPdfSourceJob) => void;
}): IDocumentJobReleaser {
    let activeCount = 0;
    let path: unknown = null;
    let released = false;
    let kept: IPdfSourceJob | null = null;
    let stopWatch: (() => void) | null = null;

    const isCurrent = () => document.workingCopyPath.value === path;

    const releaseRunning = () => {
        const job = isCurrent() && document.hasView() ? document.running() : null;
        if (!job || job === kept) {
            return;
        }
        kept = null;
        document.release(job);
        released = true;
    };

    const republishIfNeeded = (keepRunningJob: boolean) => {
        if (released && isCurrent() && document.pdfSrc.value !== null) {
            const job = document.publishPdfSource(document.pdfSrc.value, 'reload');
            kept = keepRunningJob ? job : null;
        } else if (keepRunningJob && isCurrent()) {
            // A source written synchronously in the same tick may still have a queued flush:'pre'
            // watch callback pending; keep its running job for Save instead of releasing it.
            kept = document.running();
        } else {
            kept = null;
        }
        released = false;
    };

    return {
        begin() {
            let ended = false;
            if (activeCount === 0 || !isCurrent()) {
                path = document.workingCopyPath.value;
                released = false;
                kept = null;
            }
            activeCount += 1;
            releaseRunning();
            if (!stopWatch) {
                stopWatch = watch(document.pdfSrc, releaseRunning);
            }
            return (again: boolean) => {
                if (ended) {
                    return;
                }
                ended = true;
                activeCount = Math.max(0, activeCount - 1);
                if (activeCount > 0) {
                    return;
                }
                stopWatch?.();
                stopWatch = null;
                if (again) {
                    republishIfNeeded(false);
                } else {
                    kept = null;
                    released = false;
                }
            };
        },
        republishForSave() {
            if (activeCount === 0) {
                return;
            }
            republishIfNeeded(true);
        },
    };
}
