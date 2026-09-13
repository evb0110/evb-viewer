import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/chassis/documentOpenSurfaceSession';
import {
    createDocumentOpeningPageFrameAuthority,
    resolveDocumentOpeningPageMargin,
    resolveDocumentOpeningPageShellId,
} from '@app/modules/document-viewer/chassis/documentOpeningPageFrameAuthority';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';

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
    return createDocumentOpeningPageFrameAuthority({
        openSurface: surface,
        ...(readLayoutRevision ? {readLayoutRevision} : {}),
        readPolicy: () => ({
            fitMode: 'width',
            viewMode: 'single',
            zoom: 1,
            zoomMode: 'fit-width',
        }),
        readViewportSize: () => viewport,
    });
}

describe('documentOpeningPageFrameAuthority', () => {
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
        expect(resolveDocumentOpeningPageMargin(pdfGeometry, 'native-pdf')).toBe(DOCUMENT_PAGE_GUTTER_PX);
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
        expect(surface.snapshot.value.openingPageFrame?.ownerId).toMatch(/^document-viewer-chassis:/u);
    });

    it('content-addresses frames by effective layout and policy instead of observer event order', () => {
        const surface = createDocumentOpenSurfaceSession();
        const viewport = {
            width: 1_000,
            height: 800,
        };
        const authority = createAuthority(surface, viewport);
        const prepared = authority.draftOpeningPageFrame(pdfGeometry);

        expect(prepared).toMatchObject({
            documentId: pdfGeometry.documentId,
            layoutKey: '1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: '28000000:42',
            style: {
                width: '960px',
                height: '1280px',
            },
        });
        expect(authority.isPreparedOpeningPageFrameCurrent(prepared!)).toBe(true);
        expect(surface.snapshot.value.phase).toBe('idle');

        let layoutRevision = 1;
        const revisionAuthority = createAuthority(surface, viewport, () => layoutRevision);
        const revisionPrepared = revisionAuthority.draftOpeningPageFrame(pdfGeometry)!;
        expect(revisionAuthority.isPreparedOpeningPageFrameCurrent(revisionPrepared)).toBe(true);
        layoutRevision += 1;
        expect(revisionAuthority.isPreparedOpeningPageFrameCurrent(revisionPrepared)).toBe(true);

        viewport.width = 900;
        expect(authority.isPreparedOpeningPageFrameCurrent(prepared!)).toBe(false);
        expect(revisionAuthority.isPreparedOpeningPageFrameCurrent(revisionPrepared)).toBe(false);
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
        const generation = surface.begin({
            documentId: '/documents/scan.djvu',
            documentRevision: 'pending',
        }, {
            ...pdfGeometry,
            documentId: '/documents/scan.djvu',
        });

        expect(createAuthority(surface).prepareOpeningPageFrame(generation)).toBe(true);
        expect(surface.snapshot.value.openingPageFrame?.style).toEqual({
            width: '960px',
            height: '1280px',
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
