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
    // The shared surface owns accepted navigation. The local receipt exists only
    // for callers that arm this compatibility adapter before a shared ticket has
    // been minted; once a ticket exists, its target and source win.
    const localTargetPage = ref<number | null>(null);
    const localNavigationSource = ref<TWorkspacePageNavigationSource | null>(null);
    const targetPage = computed(() => {
        const ticket = options.openSurface?.navigationTicket.value;
        if (ticket) {
            const target = ticket.request.target;
            if ('page' in target) {
                return target.page;
            }
            return options.openSurface?.viewportSession.value.requestedPage ?? null;
        }
        return localTargetPage.value;
    });

    function sharedNavigationSource() {
        return options.openSurface?.navigationTicket.value?.request.source
            ?? localNavigationSource.value;
    }

    function releaseSharedNavigation(
        page: number,
        outcome: 'arrived' | 'abandoned',
    ) {
        const ticket = options.openSurface?.navigationTicket.value;
        if (ticket) {
            const released = options.openSurface?.reportNavigation(ticket, outcome === 'arrived'
                ? {
                    kind: 'arrived',
                    page,
                }
                : {
                    kind: 'abandoned',
                    by: 'user-input',
                });
            if (outcome === 'arrived' && released === false) {
                options.openSurface?.reportNavigation(ticket, {
                    kind: 'abandoned',
                    by: 'user-input',
                });
            }
        }
        localTargetPage.value = null;
        localNavigationSource.value = null;
    }

    function clear(reason = 'clear') {
        logPdfRenderTrace('workspace-programmatic-page-navigation-cleared', {
            reason,
            targetPage: targetPage.value,
        });
        localTargetPage.value = null;
        localNavigationSource.value = null;
    }

    function begin(page: number, navigationSource: TWorkspacePageNavigationSource | null = null) {
        const previousTargetPage = localTargetPage.value;
        const viewport = options.openSurface?.viewportSession.value;
        if (
            viewport?.lifecycle === 'ready'
            && (viewport.observedPage ?? viewport.committedPage ?? viewport.requestedPage) === page
        ) {
            if (options.openSurface?.navigationTicket.value) {
                releaseSharedNavigation(page, 'arrived');
            }
            clear('navigation-already-settled');
            return;
        }
        localTargetPage.value = page;
        localNavigationSource.value = navigationSource
            ?? (previousTargetPage === page ? localNavigationSource.value : null);
        logPdfRenderTrace('workspace-programmatic-page-navigation-begin', {
            page,
            navigationSource: localNavigationSource.value,
            ticketId: options.openSurface?.navigationTicket.value?.id ?? null,
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
        if (options.openSurface?.navigationTicket.value) {
            releaseSharedNavigation(page, navigationSource === null ? 'abandoned' : 'arrived');
        }
        if (localTargetPage.value !== null) {
            localTargetPage.value = null;
            localNavigationSource.value = null;
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
            const observedPage = options.openSurface?.observeViewportPage(page) ?? page;
            return accept(observedPage, 'no-programmatic-target', null);
        }
        const viewport = options.openSurface?.viewportSession.value;
        const observedPage = options.openSurface?.observeViewportPage(page) ?? page;
        if (
            viewport?.lifecycle === 'ready'
            && (viewport.observedPage ?? viewport.committedPage) === observedPage
            && observedPage !== pendingTargetPage
        ) {
            releaseSharedNavigation(observedPage, 'abandoned');
            return accept(observedPage, 'navigation-superseded-by-surface', null);
        }
        if (observedPage !== pendingTargetPage) {
            logPdfRenderTrace('workspace-viewer-current-page-update-rejected', {
                page: observedPage,
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
            logPdfRenderTrace('workspace-viewer-current-page-update-rejected', {
                page: observedPage,
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
        return accept(observedPage, 'target-caught-up', sharedNavigationSource());
    }

    function clampTo(availablePages: number) {
        if (localTargetPage.value === null || availablePages <= 0) return;
        localTargetPage.value = Math.min(
            Math.max(1, Math.trunc(localTargetPage.value)),
            Math.trunc(availablePages),
        );
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
