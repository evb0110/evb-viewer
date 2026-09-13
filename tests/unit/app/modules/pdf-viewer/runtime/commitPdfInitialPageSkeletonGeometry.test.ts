import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    type Ref,
} from 'vue';
import { commitPdfPageSkeletonGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfInitialPageSkeletonGeometry';
import type { IDocumentViewerChassisAuthority } from '@app/modules/document-viewer/chassis/documentViewerChassisAuthority';
import type { IDocumentOpenSurfaceSnapshot } from '@app/modules/document-viewer/chassis/documentOpenSurfaceSession';

function createElementShim(shape: Record<string, unknown>): HTMLElement {
    // The lifecycle reads only connectivity, scroll extent, selectors, and
    // measured boxes from these DOM fixtures.
    return Object.assign(Object.create(null), shape);
}

function createCanvasShim(shape: Record<string, unknown>): HTMLCanvasElement {
    // Canvas dimensions and its measured box are the only fields under test.
    return Object.assign(Object.create(null), shape);
}

function createChassisAuthority(
    snapshot: Ref<IDocumentOpenSurfaceSnapshot>,
    commitGeometry: (generation: number, geometry: {
        width: number;
        height: number;
        margin: number
    }) => boolean,
): IDocumentViewerChassisAuthority {
    // The lifecycle receives the full app authority in production but reads
    // only this open-surface slice in the unit.
    return {openSurface: {
        snapshot,
        commitGeometry,
    }} as IDocumentViewerChassisAuthority;
}

describe('commitPdfPageSkeletonGeometry', () => {
    it('keeps the previous surface until the expected virtual extent is mounted', () => {
        const snapshot = ref<IDocumentOpenSurfaceSnapshot>({
            generation: 4,
            identity: {
                documentId: '/tmp/scan.pdf',
                documentRevision: 'open:4',
            },
            phase: 'pending',
            presentation: 'idle',
            geometry: null,
            openingPageGeometry: null,
            openingPageFrame: null,
            committedRender: null,
            committedViewport: null,
            failure: null,
        });
        const commitGeometry = vi.fn(() => true);
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
        const chassisAuthority = createChassisAuthority(snapshot, commitGeometry);
        vi.stubGlobal('window', { getComputedStyle: vi.fn(() => ({
            display: 'block',
            visibility: 'visible',
        })) });

        const unresolvedOptions = {
            expectedGeneration: 4,
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
        expect(commitGeometry).not.toHaveBeenCalled();

        const options = {
            expectedGeneration: 4,
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
        expect(commitGeometry).not.toHaveBeenCalled();

        Object.defineProperty(viewerContainer, 'scrollHeight', { value: 536245 });
        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            requirePageNumber(1),
            options,
        )).toBe(true);
        expect(commitGeometry).toHaveBeenCalledExactlyOnceWith(4, {
            width: 760,
            height: 1224,
            margin: 20,
        });
    });

    it('recovers geometry for the surface-authoritative page after its skeleton is removed', () => {
        const snapshot = ref<IDocumentOpenSurfaceSnapshot>({
            generation: 7,
            identity: {
                documentId: '/tmp/large-scan.pdf',
                documentRevision: 'open:7',
            },
            phase: 'pending',
            presentation: 'idle',
            geometry: null,
            openingPageGeometry: null,
            openingPageFrame: null,
            committedRender: null,
            committedViewport: null,
            failure: null,
        });
        const commitGeometry = vi.fn(() => true);
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
        const chassisAuthority = createChassisAuthority(snapshot, commitGeometry);

        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            // The local page projection may still lag an early navigation.
            ref(1),
            ref(20),
            requirePageNumber(6),
            {
                authoritativePageNumber: 6,
                expectedGeneration: 7,
                minimumScrollHeight: null,
                requireVisibleSkeleton: false,
            },
        )).toBe(true);
        expect(commitGeometry).toHaveBeenCalledExactlyOnceWith(7, {
            width: 860,
            height: 1112.94,
            margin: 20,
        });
    });

    it('rejects canvas recovery for a stale open-surface generation', () => {
        const snapshot = ref<IDocumentOpenSurfaceSnapshot>({
            generation: 9,
            identity: {
                documentId: '/tmp/replacement.pdf',
                documentRevision: 'open:9',
            },
            phase: 'pending',
            presentation: 'idle',
            geometry: null,
            openingPageGeometry: null,
            openingPageFrame: null,
            committedRender: null,
            committedViewport: null,
            failure: null,
        });
        const commitGeometry = vi.fn(() => true);
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
        const chassisAuthority = createChassisAuthority(snapshot, commitGeometry);

        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            requirePageNumber(1),
            {
                expectedGeneration: 8,
                minimumScrollHeight: 478000,
                requireVisibleSkeleton: false,
            },
        )).toBe(false);
        expect(commitGeometry).not.toHaveBeenCalled();
    });
});
