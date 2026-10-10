// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import {
    createDocumentOpeningPageFrame,
    resolveDocumentOpeningPageMargin,
    resolveDocumentOpeningPageShellId,
} from '@app/modules/document-viewer/runtime/documentOpeningPageFrame';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';
import { createPageNavigationRequest } from '@app/modules/document-viewer/navigation/documentNavigationRequest';

const uniformPages = Array.from({length: 431}, () => ({
    widthPoints: 600,
    heightPoints: 800,
    rotation: 0,
    userUnit: 1,
}));

const pdfGeometry = Object.freeze({
    documentId: '/documents/scan.pdf',
    pageNumber: 1,
    pageCount: 431,
    width: 600,
    height: 800,
    rotation: 0,
    size: 28_000_000,
    modifiedAt: 42,
} as const);

function createAuthority(
    surface: ReturnType<typeof createDocumentOpenSurfaceSession>,
    viewport = {
        width: 1_000,
        height: 800,
    },
    readLayoutRevision?: () => number,
) {
    return createDocumentOpeningPageFrame({
        instanceId: 'chassis-test',
        openSurface: surface,
        ...(readLayoutRevision ? {readLayoutRevision} : {}),
        readPolicy: () => ({
            fitMode: 'width',
            viewMode: 'single',
            zoom: 1,
            zoomMode: 'fit-width',
            continuousScroll: true,
        }),
        readViewportSize: () => viewport,
    });
}

describe('documentOpeningPageFrame', () => {
    it('includes the chassis instance in opening-page shell identities', () => {
        expect(resolveDocumentOpeningPageShellId('chassis-a', 7)).toBe('chassis-a-opening-page-shell-7');
        expect(resolveDocumentOpeningPageShellId('chassis-b', 7)).not.toBe(
            resolveDocumentOpeningPageShellId('chassis-a', 7),
        );
    });

    it('uses one shared page gutter for every renderer before and after handoff', () => {
        expect(resolveDocumentOpeningPageMargin(pdfGeometry, 'pdfjs')).toBe(DOCUMENT_PAGE_GUTTER_PX);
        expect(resolveDocumentOpeningPageMargin({
            ...pdfGeometry,
            documentId: '/documents/scan.djvu',
        }, 'page-source')).toBe(DOCUMENT_PAGE_GUTTER_PX);
    });

    it('commits the exact PDF page shell synchronously from trusted geometry and the live chassis viewport', () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        }, pdfGeometry);

        expect(createAuthority(surface).prepareOpeningPageFrame(generation)).toBe(true);
        expect(surface.snapshot.value).toMatchObject({
            generation,
            presentation: 'page-shell',
            openingPageFrame: {
                generation,
                pageNumber: 1,
                intentKey: 'fit-width:1',
                style: {
                    width: '960px',
                    height: '1280px',
                },
            },
        });
        expect(surface.snapshot.value.openingPageFrame?.ownerId).toMatch(/^document-viewer-runtime:/u);
    });

    it('sizes the shell of an open that starts where its reader left it at that view\'s zoom', () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        }, {
            ...pdfGeometry,
            pageNumber: 4,
            readingView: {
                currentPage: 4,
                pageCount: 431,
                zoom: 1.5,
                zoomMode: 'custom',
                viewMode: 'single',
                continuousScroll: true,
                viewRotation: 0,
            },
        }, 4);

        expect(createAuthority(surface).prepareOpeningPageFrame(generation)).toBe(true);
        expect(surface.snapshot.value.openingPageFrame).toMatchObject({
            pageNumber: 4,
            intentKey: 'custom:1.5',
            style: {
                width: '900px',
                height: '1200px',
            },
        });
    });

    it('places the shell of a restored reading point where the viewer will place that point', () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        }, {
            ...pdfGeometry,
            pageNumber: 4,
            pages: uniformPages,
        }, 4);
        surface.navigate(createPageNavigationRequest(4, 'restore', {
            page: 4,
            pageXFraction: 0.5,
            pageYFraction: 0.5,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center',
        }));

        expect(createAuthority(surface).prepareOpeningPageFrame(generation)).toBe(true);
        // The page's middle at the viewport's middle: 800 / 2 - 1280 / 2.
        expect(surface.snapshot.value.openingPageFrame?.style).toEqual({
            width: '960px',
            height: '1280px',
            top: '-240px',
            left: '20px',
        });
    });

    // A reader's place among pages of other shapes, in each view the viewer lays out.
    function placeShell(
        pageNumber: number,
        pages: Array<{
            widthPoints: number;
            heightPoints: number;
            rotation: number;
            userUnit: number
        }>,
        policy: Partial<{
            viewMode: 'single' | 'facing' | 'facing-first-single';
            continuousScroll: boolean;
            viewRotation: 0 | 90 | 180 | 270
        }>,
        anchor?: Parameters<typeof createPageNavigationRequest>[2],
    ) {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        }, {
            ...pdfGeometry,
            pageNumber,
            pageCount: pages.length,
            width: pages[pageNumber - 1]!.widthPoints,
            height: pages[pageNumber - 1]!.heightPoints,
            pages,
        }, pageNumber);
        if (anchor) {
            surface.navigate(createPageNavigationRequest(pageNumber, 'restore', anchor));
        }
        createDocumentOpeningPageFrame({
            instanceId: 'chassis-test',
            openSurface: surface,
            readPolicy: () => ({
                fitMode: 'width',
                viewMode: 'single',
                zoom: 1,
                zoomMode: 'custom',
                continuousScroll: true,
                ...policy,
            }),
            readViewportSize: () => ({
                width: 1_000,
                height: 800,
            }),
        }).prepareOpeningPageFrame(generation);
        return surface.snapshot.value.openingPageFrame?.style;
    }

    it('places a page by the exact pages above it, not by its own shape repeated', () => {
        const pages = [
            {
                widthPoints: 600,
                heightPoints: 900,
                rotation: 0,
                userUnit: 1,
            },
            {
                widthPoints: 600,
                heightPoints: 300,
                rotation: 0,
                userUnit: 1,
            },
            {
                widthPoints: 600,
                heightPoints: 800,
                rotation: 0,
                userUnit: 1,
            },
        ];
        // Page 2's top at nine tenths of the viewport: 720 px down, since
        // page 1's 900 leaves room to scroll there. Pages shaped like page 2
        // would end the scroll at the document start and show it at 340.
        expect(placeShell(2, pages, {}, {
            page: 2,
            pageXFraction: 0.5,
            pageYFraction: 0,
            viewportXFraction: 0.5,
            viewportYFraction: 0.9,
            affinity: 'center',
        })).toMatchObject({
            width: '600px',
            height: '300px',
            top: '720px',
        });
    });

    it('places a paged facing spread from the top inset, with its page beside its partner', () => {
        const pages = Array.from({length: 4}, () => ({
            widthPoints: 300,
            heightPoints: 400,
            rotation: 0,
            userUnit: 1,
        }));
        const style = placeShell(4, pages, {
            viewMode: 'facing',
            continuousScroll: false,
        });
        expect(style).toMatchObject({
            width: '300px',
            height: '400px',
            top: `${String(DOCUMENT_PAGE_GUTTER_PX)}px`,
            // Spread 3-4 is centred: page 4 sits right of page 3 and the gap.
            left: `${String((1_000 - (300 * 2 + DOCUMENT_PAGE_GUTTER_PX)) / 2 + 300 + DOCUMENT_PAGE_GUTTER_PX)}px`,
        });
    });

    it('sizes a quarter-turned page by the sides the view shows, without the other pages', () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        }, pdfGeometry);
        createDocumentOpeningPageFrame({
            instanceId: 'chassis-test',
            openSurface: surface,
            readPolicy: () => ({
                fitMode: 'width',
                viewMode: 'single',
                zoom: 1,
                zoomMode: 'custom',
                continuousScroll: true,
                viewRotation: 90,
            }),
            readViewportSize: () => ({
                width: 1_000,
                height: 800,
            }),
        }).prepareOpeningPageFrame(generation);

        expect(surface.snapshot.value.openingPageFrame?.style).toEqual({
            width: '800px',
            height: '600px',
        });
    });

    it('turns every page with a quarter-turned view before laying them out', () => {
        const pages = Array.from({length: 2}, () => ({
            widthPoints: 300,
            heightPoints: 500,
            rotation: 0,
            userUnit: 2,
        }));
        expect(placeShell(1, pages, {viewRotation: 90})).toMatchObject({
            width: '1000px',
            height: '600px',
        });
    });

    it('sizes a continuous Fit Width shell by the widest page of the document', () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        }, {
            ...pdfGeometry,
            widestPageWidth: 800,
        });

        expect(createAuthority(surface).prepareOpeningPageFrame(generation)).toBe(true);
        expect(surface.snapshot.value.openingPageFrame?.style).toEqual({
            width: '720px',
            height: '960px',
        });
    });

    // Pages 612x900 and 612x820: the tallest page is the widest a quarter-turned view shows.
    it.each([
        // Upright: 960 / 612 wide. Quarter-turned: 960 / 900, the tallest page.
        [
            0,
            960,
            820 * 960 / 612,
        ],
        [
            180,
            960,
            820 * 960 / 612,
        ],
        [
            90,
            820 * 960 / 900,
            612 * 960 / 900,
        ],
        [
            270,
            820 * 960 / 900,
            612 * 960 / 900,
        ],
    ] as const)('sizes a continuous Fit Width shell turned %i by the widest page the view shows', (viewRotation, width, height) => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        }, {
            ...pdfGeometry,
            pageNumber: 3,
            pageCount: 3,
            width: 612,
            height: 820,
            widestPageWidth: 612,
            tallestPageHeight: 900,
        });
        createDocumentOpeningPageFrame({
            instanceId: 'chassis-test',
            openSurface: surface,
            readPolicy: () => ({
                fitMode: 'width',
                viewMode: 'single',
                zoom: 1,
                zoomMode: 'fit-width',
                continuousScroll: true,
                viewRotation,
            }),
            readViewportSize: () => ({
                width: 1_000,
                height: 800,
            }),
        }).prepareOpeningPageFrame(generation);

        const style = surface.snapshot.value.openingPageFrame?.style;
        expect(Number.parseFloat(style?.width ?? '')).toBeCloseTo(width, 6);
        expect(Number.parseFloat(style?.height ?? '')).toBeCloseTo(height, 6);
    });

    it('does not need source or working-copy completion to present the shell', async () => {
        const surface = createDocumentOpenSurfaceSession();
        let releaseSource!: () => void;
        const sourcePending = new Promise<void>((resolve) => {
            releaseSource = resolve;
        });
        const generation = surface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        }, pdfGeometry);

        expect(createAuthority(surface).prepareOpeningPageFrame(generation)).toBe(true);
        expect(surface.snapshot.value.presentation).toBe('page-shell');

        releaseSource();
        await sourcePending;
    });

    it('leaves cold, stale, and already-owned transactions unchanged', () => {
        const coldSurface = createDocumentOpenSurfaceSession();
        const coldGeneration = coldSurface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        });
        expect(createAuthority(coldSurface).prepareOpeningPageFrame(coldGeneration)).toBe(false);
        expect(coldSurface.snapshot.value.presentation).toBe('idle');

        const ownedSurface = createDocumentOpenSurfaceSession();
        const ownedGeneration = ownedSurface.begin({
            documentId: pdfGeometry.documentId,
            documentRevision: 'pending',
        }, pdfGeometry);
        expect(createAuthority(ownedSurface).prepareOpeningPageFrame(ownedGeneration)).toBe(true);
        const ownedFrame = ownedSurface.snapshot.value.openingPageFrame;
        expect(createAuthority(ownedSurface, {
            width: 700,
            height: 600,
        }).prepareOpeningPageFrame(ownedGeneration)).toBe(false);
        expect(ownedSurface.snapshot.value.openingPageFrame).toBe(ownedFrame);
        expect(createAuthority(ownedSurface).prepareOpeningPageFrame(ownedGeneration - 1)).toBe(false);
    });

    it('uses the page-source frame policy for DjVu documents', () => {
        const surface = createDocumentOpenSurfaceSession();
        let zoomMode: 'fit-width' | 'custom' = 'fit-width';
        const viewport = document.createElement('div');
        Object.defineProperties(viewport, {
            offsetWidth: {value: 1_018},
            clientWidth: {value: 1_000},
        });
        const generation = surface.begin({
            documentId: '/documents/scan.djvu',
            documentRevision: 'pending',
        }, {
            ...pdfGeometry,
            documentId: '/documents/scan.djvu',
            pageNumber: 7,
        }, 7);
        const authority = createDocumentOpeningPageFrame({
            instanceId: 'chassis-test',
            openSurface: surface,
            readPolicy: () => ({
                fitMode: 'width',
                viewMode: 'single',
                zoom: 2,
                zoomMode,
                continuousScroll: true,
            }),
            readViewportSize: () => ({
                width: 1_000,
                height: 800,
            }),
            readViewport: () => viewport,
        });

        expect(authority.prepareOpeningPageFrame(generation)).toBe(true);
        expect(surface.snapshot.value.openingPageFrame?.style).toEqual({
            width: '960px',
            height: '1280px',
        });
        zoomMode = 'custom';
        surface.navigate(createPageNavigationRequest(7, 'restore', {
            page: 7,
            pageXFraction: 0.4,
            pageYFraction: 0.2375,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center',
        }));
        expect(authority.prepareOpeningPageFrame(generation)).toBe(true);
        // The old 800 px viewport had the page at 20 px. The final horizontal
        // scrollbar makes it 782 px high, so restoration places it at 11 px.
        expect(authority.shell.value?.style).toMatchObject({
            width: '1200px',
            height: '1600px',
            top: '11px',
        });
    });

    it('uses native-preview margins for oversized PDFs before renderer handoff', () => {
        const surface = createDocumentOpenSurfaceSession();
        const nativeGeometry = {
            ...pdfGeometry,
            size: 512 * 1024 * 1024,
        };
        const generation = surface.begin({
            documentId: nativeGeometry.documentId,
            documentRevision: 'pending',
        }, nativeGeometry);

        expect(createAuthority(surface).prepareOpeningPageFrame(generation)).toBe(true);
        expect(surface.snapshot.value.openingPageFrame?.style).toEqual({
            width: '960px',
            height: '1280px',
        });
    });
});
