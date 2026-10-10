import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { commitPdfPageSkeletonGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfInitialPageSkeletonGeometry';
import type { IDocumentViewerRuntime } from '@app/modules/document-viewer/runtime/documentViewerRuntime';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';

function createElementShim(shape: Record<string, unknown>): HTMLElement {
    // The lifecycle reads only connectivity, scroll extent, selectors, and
    // measured boxes from these DOM fixtures.
    return Object.assign(Object.create(null), shape);
}

function createCanvasShim(shape: Record<string, unknown>): HTMLCanvasElement {
    // Canvas dimensions and its measured box are the only fields under test.
    return Object.assign(Object.create(null), shape);
}

function createOpeningSurface(documentId: string) {
    const surface = createDocumentOpenSurfaceSession();
    const generation = surface.begin({
        documentId,
        documentRevision: 'open:1',
    });
    return {
        // The lifecycle receives the full app authority in production but
        // reads only its open surface in the unit.
        chassisAuthority: {openSurface: surface} as IDocumentViewerRuntime,
        generation,
        /** The page shell geometry the open surface presents. */
        committedGeometry: () => surface.snapshot.value.geometry,
    };
}

describe('commitPdfPageSkeletonGeometry', () => {
    it('keeps the previous surface until the expected virtual extent is mounted', () => {
        const opening = createOpeningSurface('/tmp/scan.pdf');
        const pageSkeleton = createElementShim({ isConnected: true });
        const pageContainer = createElementShim({
            isConnected: true,
            querySelector: vi.fn(() => pageSkeleton),
            getBoundingClientRect: vi.fn(() => ({
                width: 760,
                height: 1224,
            })),
        });
        const viewerContainer = createElementShim({
            scrollHeight: 1245,
            querySelector: vi.fn(() => pageContainer),
        });
        const {chassisAuthority} = opening;
        vi.stubGlobal('window', { getComputedStyle: vi.fn(() => ({
            display: 'block',
            visibility: 'visible',
        })) });

        const unresolvedOptions = {
            expectedGeneration: opening.generation,
            minimumScrollHeight: null,
        };
        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            requirePageNumber(1),
            unresolvedOptions,
        )).toBe(false);
        expect(opening.committedGeometry()).toBeNull();

        const options = {
            expectedGeneration: opening.generation,
            minimumScrollHeight: 534900,
        };
        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            requirePageNumber(1),
            options,
        )).toBe(false);
        expect(opening.committedGeometry()).toBeNull();

        Object.defineProperty(viewerContainer, 'scrollHeight', { value: 536245 });
        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            requirePageNumber(1),
            options,
        )).toBe(true);
        expect(opening.committedGeometry()).toEqual({
            width: 760,
            height: 1224,
            margin: 20,
        });
    });

    it('recovers geometry for the surface-authoritative page after its skeleton is removed', () => {
        const opening = createOpeningSurface('/tmp/large-scan.pdf');
        const canvas = createCanvasShim({
            isConnected: true,
            width: 1390,
            height: 1798,
            getBoundingClientRect: vi.fn(() => ({
                width: 860,
                height: 1112.94,
            })),
        });
        const pageContainer = createElementShim({
            isConnected: true,
            querySelector: vi.fn((selector: string) => selector === '.page_canvas canvas' ? canvas : null),
            getBoundingClientRect: vi.fn(() => ({
                width: 860,
                height: 1112.94,
            })),
        });
        const viewerContainer = createElementShim({
            scrollHeight: 478942,
            querySelector: vi.fn(() => pageContainer),
        });
        const {chassisAuthority} = opening;

        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            // The local page projection may still lag an early navigation.
            ref(1),
            ref(20),
            requirePageNumber(6),
            {
                authoritativePageNumber: 6,
                expectedGeneration: opening.generation,
                minimumScrollHeight: null,
                requireVisibleSkeleton: false,
            },
        )).toBe(true);
        expect(opening.committedGeometry()).toEqual({
            width: 860,
            height: 1112.94,
            margin: 20,
        });
    });

    it('rejects canvas recovery for a stale open-surface generation', () => {
        const opening = createOpeningSurface('/tmp/replacement.pdf');
        const canvas = createCanvasShim({
            isConnected: true,
            width: 1390,
            height: 1798,
            getBoundingClientRect: vi.fn(() => ({
                width: 860,
                height: 1112.94,
            })),
        });
        const pageContainer = createElementShim({
            isConnected: true,
            querySelector: vi.fn((selector: string) => selector === '.page_canvas canvas' ? canvas : null),
            getBoundingClientRect: vi.fn(() => ({
                width: 860,
                height: 1112.94,
            })),
        });
        const viewerContainer = createElementShim({
            scrollHeight: 478942,
            querySelector: vi.fn(() => pageContainer),
        });
        const {chassisAuthority} = opening;

        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            requirePageNumber(1),
            {
                expectedGeneration: opening.generation - 1,
                minimumScrollHeight: 478000,
                requireVisibleSkeleton: false,
            },
        )).toBe(false);
        expect(opening.committedGeometry()).toBeNull();
    });
});
