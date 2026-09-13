import type { Ref } from 'vue';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

/** The canonical navigation-source union, owned by the viewer scroll contract. */
export type TWorkspacePageNavigationSource = NonNullable<IScrollToPageOptions['navigationSource']>;

export interface IWorkspacePageUpdateOutcome {
    /** Whether the observed page was committed to `currentPage`. */
    accepted: boolean;
    /**
     * The surface that armed the target this page settled, or null when the
     * page did not come from a pending programmatic navigation.
     */
    navigationSource: TWorkspacePageNavigationSource | null;
}

interface IWorkspacePageNavigationFenceOptions {
    currentPage: Ref<number>;
    openSurface?: IDocumentOpenSurfaceSession | undefined;
}

export function createWorkspacePageNavigationFence(options: IWorkspacePageNavigationFenceOptions) {
    const targetPage = ref<number | null>(null);
    // The source that armed the current target, so an accepted page update can
    // report which surface produced it.
    const targetNavigationSource = ref<TWorkspacePageNavigationSource | null>(null);

    function clear(reason = 'clear') {
        logPdfRenderTrace('workspace-programmatic-page-navigation-cleared', {
            reason,
            targetPage: targetPage.value,
        });
        targetPage.value = null;
        targetNavigationSource.value = null;
    }

    function begin(page: number, navigationSource: TWorkspacePageNavigationSource | null = null) {
        const previousTargetPage = targetPage.value;
        const viewport = options.openSurface?.viewportSession.value;
        if (
            viewport?.lifecycle === 'ready'
            && (viewport.observedPage ?? viewport.committedPage ?? viewport.requestedPage) === page
        ) {
            clear('navigation-already-settled');
            return;
        }
        // Viewer feedback re-arms the target it is already travelling to without
        // knowing which surface asked for it, so an unattributed re-arm keeps the
        // original source instead of blanking it.
        const resolvedSource = navigationSource
            ?? (previousTargetPage === page ? targetNavigationSource.value : null);
        targetPage.value = page;
        targetNavigationSource.value = resolvedSource;
        logPdfRenderTrace('workspace-programmatic-page-navigation-begin', {
            page,
            previousTargetPage,
            navigationSource: resolvedSource,
            currentPage: options.currentPage.value,
        });
    }

    /**
     * Commits an accepted page before releasing the fence. Writing `currentPage`
     * first is what keeps `navigationPage` monotonic: a reader woken by the
     * target going null already sees the new page rather than the pre-navigation
     * one.
     */
    function accept(
        page: number,
        reason: string,
        navigationSource: TWorkspacePageNavigationSource | null,
    ): IWorkspacePageUpdateOutcome {
        logPdfRenderTrace('workspace-viewer-current-page-update-accepted', {
            page,
            targetPage: targetPage.value,
            currentPage: options.currentPage.value,
            reason,
        });
        options.currentPage.value = page;
        if (targetPage.value !== null) {
            clear(reason);
        }
        return {
            accepted: true,
            navigationSource,
        };
    }

    /**
     * The single decision point for an observed viewer page: it judges the page,
     * commits it when accepted, releases the fence, and reports the source that
     * armed the settled target in the same call. Callers never have to read the
     * source before or after the verdict, so supersession cannot leak a stale
     * attribution.
     */
    function consumePageUpdate(page: number): IWorkspacePageUpdateOutcome {
        const pendingTargetPage = targetPage.value;
        if (pendingTargetPage === null) {
            return accept(page, 'no-programmatic-target', null);
        }
        const viewport = options.openSurface?.viewportSession.value;
        if (
            viewport?.lifecycle === 'ready'
            && (viewport.observedPage ?? viewport.committedPage) === page
            && page !== pendingTargetPage
        ) {
            // The surface moved somewhere the pending target never asked for, so
            // the armed source did not produce this page.
            return accept(page, 'navigation-superseded-by-surface', null);
        }
        if (page !== pendingTargetPage) {
            logPdfRenderTrace('workspace-viewer-current-page-update-rejected', {
                page,
                targetPage: pendingTargetPage,
                currentPage: options.currentPage.value,
                reason: 'target-pending',
            });
            return {
                accepted: false,
                navigationSource: null,
            };
        }
        if (viewport && viewport.lifecycle !== 'ready') {
            // A matching page projection can arrive before the physical
            // viewport reaches the target. Keep the fence armed until the
            // surface authoritatively reports a ready lifecycle.
            logPdfRenderTrace('workspace-viewer-current-page-update-rejected', {
                page,
                targetPage: pendingTargetPage,
                currentPage: options.currentPage.value,
                lifecycle: viewport.lifecycle,
                reason: 'surface-not-ready',
            });
            return {
                accepted: false,
                navigationSource: null,
            };
        }
        return accept(page, 'target-caught-up', targetNavigationSource.value);
    }

    function clampTo(availablePages: number) {
        const requestedPage = targetPage.value;
        if (requestedPage === null || availablePages <= 0) {
            return;
        }
        const clampedPage = Math.min(
            Math.max(1, Math.trunc(requestedPage)),
            Math.trunc(availablePages),
        );
        if (clampedPage === requestedPage) {
            return;
        }
        logPdfRenderTrace('workspace-programmatic-page-navigation-metadata-clamp', {
            requestedPage,
            clampedPage,
            pageCount: availablePages,
        });
        targetPage.value = clampedPage;
    }

    // The page a new navigation command steps from: the in-flight target while
    // one is pending, so held paging keys compose instead of replaying the same
    // step against a lagging current page. Derived here because only the fence
    // can guarantee the target and the committed page never disagree.
    const navigationPage = computed(() => targetPage.value ?? options.currentPage.value);

    return {
        begin,
        clampTo,
        clear,
        consumePageUpdate,
        navigationPage,
        targetPage: readonly(targetPage),
    };
}
