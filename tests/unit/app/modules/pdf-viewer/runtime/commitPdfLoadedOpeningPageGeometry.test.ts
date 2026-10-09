import { requireDocumentRef } from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { commitPdfLoadedOpeningPageGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfLoadedOpeningPageGeometry';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type { IDocumentViewerRuntime } from '@app/modules/document-viewer/runtime/documentViewerRuntime';

function createHarness(surfaceDocumentId = '/tmp/scan.pdf') {
    const source = {
        kind: 'path',
        path: requireDocumentRef('/tmp/scan.pdf'),
        size: 28_000_000,
    } as const;
    const surface = createDocumentOpenSurfaceSession();
    const generation = surface.begin({
        documentId: surfaceDocumentId,
        documentRevision: 'open:4',
    });
    // This lifecycle unit reads only the open surface from the viewer runtime.
    const authority = {openSurface: surface} as IDocumentViewerRuntime;
    const input = {
        expectedGeneration: generation,
        documentId: '/tmp/scan.pdf',
        metricSource: source,
        currentSource: source,
        pageNumber: requirePageNumber(1),
        currentPage: 1,
        pageCount: 431,
        metric: {
            width: 860,
            height: 1112.94,
            rotation: 0,
        },
    };
    return {
        authority,
        input,
        /** The page frame the open surface shows before the first raster. */
        openingPageGeometry: () => surface.snapshot.value.openingPageGeometry,
        source,
    };
}

describe('commitPdfLoadedOpeningPageGeometry', () => {
    it('commits authoritative loaded PDF geometry to the current empty-surface generation', () => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, harness.input)).toBe(true);
        expect(harness.openingPageGeometry()).toMatchObject({
            documentId: '/tmp/scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 860,
            height: 1112.94,
            rotation: 0,
        });
    });

    it('accepts an equivalent reconstructed path descriptor', () => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            currentSource: {...harness.source},
        })).toBe(true);
        expect(harness.openingPageGeometry()?.pageNumber).toBe(1);
    });

    it('commits under the session identity when the accepted native source uses an alias path', () => {
        const harness = createHarness('/var/tmp/scan.pdf');
        const aliasedSource = {
            kind: 'path',
            path: requireDocumentRef('/private/var/tmp/scan.pdf'),
            size: 28_000_000,
        } as const;

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            documentId: '/var/tmp/scan.pdf',
            metricSource: aliasedSource,
            currentSource: {...aliasedSource},
        })).toBe(true);
        expect(harness.openingPageGeometry()?.documentId).toBe('/var/tmp/scan.pdf');
    });

    it('rejects a path descriptor whose size revision changed', () => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            currentSource: {
                ...harness.source,
                size: harness.source.size + 1,
            },
        })).toBe(false);
        expect(harness.openingPageGeometry()).toBeNull();
    });

    it.each([
        [
            'wrong document',
            {documentId: '/tmp/replacement.pdf'},
        ],
        [
            'wrong generation',
            {expectedGeneration: 5},
        ],
        [
            'wrong page',
            {currentPage: 2},
        ],
        [
            'missing metric',
            {metric: undefined},
        ],
    ])('rejects %s evidence', (_label, override) => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            ...override,
        })).toBe(false);
        expect(harness.openingPageGeometry()).toBeNull();
    });

    it('rejects metrics captured for a stale source', () => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            metricSource: {
                kind: 'path',
                path: requireDocumentRef('/tmp/older-copy.pdf'),
                size: 28_000_000,
            },
        })).toBe(false);
        expect(harness.openingPageGeometry()).toBeNull();
    });
});
