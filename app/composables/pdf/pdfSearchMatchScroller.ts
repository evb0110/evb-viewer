import { nextTick } from 'vue';
import { getPageContainer } from '@app/composables/pdf/pdfPageBufferManager';

interface ICurrentSearchMatch {pageIndex: number;}

interface IPdfSearchMatchScrollerDeps {
    getContainer: () => HTMLElement | null;
    getCurrentSearchMatch: () => ICurrentSearchMatch | null;
    getCurrentMatchRangeRect: (textLayerDiv: HTMLElement) => DOMRect | null;
    scrollToCurrentMatch: () => boolean;
    scheduleRenderForSinglePage: (pageNumber: number) => void;
    scrollToPage?: (pageNumber: number) => void;
    runDeferredScrollToCurrentMatch: () => void;
}

export function createPdfSearchMatchScroller(deps: IPdfSearchMatchScrollerDeps) {
    let scrollToMatchRequestId = 0;

    function scheduleScrollCorrection(requestId: number) {
        if (typeof window === 'undefined') {
            return;
        }

        const correctIfNeeded = () => {
            if (requestId !== scrollToMatchRequestId) {
                return;
            }

            const containerRoot = deps.getContainer();
            const currentMatch = deps.getCurrentSearchMatch();
            if (!containerRoot || !currentMatch) {
                return;
            }

            const targetContainer = getPageContainer(containerRoot, currentMatch.pageIndex);
            if (!targetContainer) {
                return;
            }

            const textLayerDiv = targetContainer.querySelector<HTMLElement>('.text-layer');
            if (!textLayerDiv) {
                return;
            }

            const rect = deps.getCurrentMatchRangeRect(textLayerDiv);
            if (!rect || (rect.width === 0 && rect.height === 0)) {
                return;
            }

            const containerRect = containerRoot.getBoundingClientRect();
            const centerDelta = (rect.top + rect.height / 2) - (containerRect.top + containerRect.height / 2);
            const isVisible = rect.bottom > containerRect.top + 16 && rect.top < containerRect.bottom - 16;
            const isCentered = Math.abs(centerDelta) < 8;
            if (isVisible && isCentered) {
                return;
            }

            deps.scrollToCurrentMatch();
        };

        requestAnimationFrame(() => {
            correctIfNeeded();
            requestAnimationFrame(() => {
                correctIfNeeded();
            });
        });
        setTimeout(correctIfNeeded, 120);
        setTimeout(correctIfNeeded, 350);
        setTimeout(correctIfNeeded, 800);
    }

    function requestScrollToMatch(matchPageIndex: number | null) {
        const requestId = ++scrollToMatchRequestId;

        if (matchPageIndex === null || typeof window === 'undefined') {
            return;
        }

        const maxAttempts = 8;
        let attempts = 0;

        const tryScroll = () => {
            if (requestId !== scrollToMatchRequestId) {
                return;
            }

            const didScroll = deps.scrollToCurrentMatch();
            if (didScroll) {
                scheduleScrollCorrection(requestId);
                return;
            }

            attempts += 1;

            deps.scheduleRenderForSinglePage(matchPageIndex + 1);

            if (attempts >= maxAttempts) {
                deps.scrollToPage?.(matchPageIndex + 1);
                requestAnimationFrame(() => {
                    if (requestId !== scrollToMatchRequestId) {
                        return;
                    }
                    deps.runDeferredScrollToCurrentMatch();
                });
                return;
            }

            requestAnimationFrame(tryScroll);
        };

        void nextTick(tryScroll);
    }

    return {
        requestScrollToMatch,
        invalidatePendingRequests: () => {
            scrollToMatchRequestId += 1;
        },
    };
}
