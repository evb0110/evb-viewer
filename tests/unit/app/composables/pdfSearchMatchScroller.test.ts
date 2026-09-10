import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createPdfSearchMatchScroller } from '@app/modules/pdf-viewer/engine/pdf-search-match-scroller/createPdfSearchMatchScroller';
import {requirePageIndex} from '@contracts/pageNumbers';

describe('createPdfSearchMatchScroller', () => {
    it('emits exactly one semantic rect request with no polling or private scroll', () => {
        const revealSearchNavigationTarget = vi.fn();
        const scrollToCurrentMatch = vi.fn();
        const scheduleRenderForSinglePage = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => document.createElement('div'),
            getCurrentSearchMatch: () => ({
                pageIndex: requirePageIndex(2),
                pageWidth: 200,
                pageHeight: 400,
                words: [{
                    x: 20,
                    y: 80,
                    width: 40,
                    height: 20,
                }],
            }),
            scrollToCurrentMatch,
            scheduleRenderForSinglePage,
            revealSearchNavigationTarget,
        });
        scroller.requestScrollToMatch(2);
        expect(revealSearchNavigationTarget).toHaveBeenCalledOnce();
        const marker = revealSearchNavigationTarget.mock.calls[0]?.[1]?.markerRect;
        expect(revealSearchNavigationTarget.mock.calls[0]?.[0]).toBe(3);
        expect(marker?.left).toBeCloseTo(0.1);
        expect(marker?.top).toBeCloseTo(0.2);
        expect(marker?.width).toBeCloseTo(0.2);
        expect(marker?.height).toBeCloseTo(0.05);
        expect(scrollToCurrentMatch).not.toHaveBeenCalled();
        expect(scheduleRenderForSinglePage).not.toHaveBeenCalled();
    });

    it('rotates the navigation marker with the visible page highlight', () => {
        const revealSearchNavigationTarget = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => document.createElement('div'),
            getCurrentSearchMatch: () => ({
                pageIndex: requirePageIndex(2),
                pageWidth: 200,
                pageHeight: 400,
                rotation: 90,
                words: [{
                    x: 20,
                    y: 80,
                    width: 40,
                    height: 20,
                }],
            }),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            revealSearchNavigationTarget,
        });

        scroller.requestScrollToMatch(2);

        const marker = revealSearchNavigationTarget.mock.calls[0]?.[1]?.markerRect;
        expect(marker?.left).toBeCloseTo(0.75);
        expect(marker?.top).toBeCloseTo(0.1);
        expect(marker?.width).toBeCloseTo(0.05);
        expect(marker?.height).toBeCloseTo(0.2);
    });

    it('emits a page request when word geometry is unavailable', () => {
        const revealSearchNavigationTarget = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => null,
            getCurrentSearchMatch: () => ({pageIndex: requirePageIndex(0)}),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            revealSearchNavigationTarget,
        });
        scroller.requestScrollToMatch(0);
        expect(revealSearchNavigationTarget).toHaveBeenCalledWith(1, undefined);
    });

    it('carries the exact search range when word geometry is unavailable', () => {
        const revealSearchNavigationTarget = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => null,
            getCurrentSearchMatch: () => ({
                pageIndex: requirePageIndex(4),
                startOffset: 42,
                endOffset: 48,
                excerpt: {
                    prefix: true,
                    suffix: true,
                    before: 'before ',
                    match: 'needle',
                    after: ' after',
                },
            }),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            revealSearchNavigationTarget,
        });

        scroller.requestScrollToMatch(4);

        expect(revealSearchNavigationTarget).toHaveBeenCalledWith(5, {textAnchor: {
            text: 'needle',
            prefix: 'before ',
            suffix: ' after',
            searchRange: {
                startOffset: 42,
                endOffset: 48,
            },
        }});
    });

    it('carries page-local identity and search semantics for an index fallback', () => {
        const revealSearchNavigationTarget = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => null,
            getCurrentSearchMatch: () => ({
                pageIndex: requirePageIndex(4),
                pageMatchIndex: 2,
                matchIndex: 12,
                startOffset: 420,
                endOffset: 426,
                excerpt: {
                    prefix: true,
                    suffix: true,
                    before: 'before ',
                    match: 'needle',
                    after: ' after',
                },
            }),
            getCurrentSearchPageMatches: () => ({
                searchQuery: 'needle',
                searchOptions: {
                    matchCase: false,
                    wholeWord: true,
                    useRegex: false,
                },
                matches: [
                    {start: 100},
                    {start: 200},
                    {start: 300},
                ],
            }),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            revealSearchNavigationTarget,
        });

        scroller.requestScrollToMatch(4);

        expect(revealSearchNavigationTarget).toHaveBeenCalledTimes(1);
        expect(revealSearchNavigationTarget.mock.calls[0]?.[1]).toMatchObject({textAnchor: {
            pageMatchIndex: 2,
            matchIndex: 12,
            searchQuery: 'needle',
            searchOptions: {wholeWord: true},
            expectedPageMatchCount: 3,
        }});
    });

    it('omits expected page match count for reversed native ranges', () => {
        const revealSearchNavigationTarget = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => null,
            getCurrentSearchMatch: () => ({
                pageIndex: requirePageIndex(0),
                pageMatchIndex: 0,
                matchIndex: 12,
                startOffset: 42,
                endOffset: 48,
                excerpt: {
                    prefix: true,
                    suffix: true,
                    before: 'before ',
                    match: 'needle',
                    after: ' after',
                },
            }),
            getCurrentSearchPageMatches: () => ({
                searchQuery: 'needle',
                matches: [
                    {start: 100},
                    {start: 20},
                ],
            }),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            revealSearchNavigationTarget,
        });

        scroller.requestScrollToMatch(0);

        const textAnchor = revealSearchNavigationTarget.mock.calls[0]?.[1]?.textAnchor;
        expect(textAnchor).toBeDefined();
        expect(textAnchor).not.toHaveProperty('expectedPageMatchCount');
    });

    it('uses the authority-compatible page fallback', () => {
        const scrollToPage = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => null,
            getCurrentSearchMatch: () => ({pageIndex: requirePageIndex(1)}),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            scrollToPage,
        });
        scroller.requestScrollToMatch(1);
        expect(scrollToPage).toHaveBeenCalledWith(2, {navigationSource: 'search'});
    });

    it('emits nothing for a cleared target', () => {
        const revealSearchNavigationTarget = vi.fn();
        const endSearchNavigation = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => null,
            getCurrentSearchMatch: () => null,
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            revealSearchNavigationTarget,
            endSearchNavigation,
        });
        scroller.requestScrollToMatch(null);
        expect(revealSearchNavigationTarget).not.toHaveBeenCalled();
        expect(endSearchNavigation).toHaveBeenCalledWith(0);
    });
});
