import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { IPageGeometry } from '@contracts/shared';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { ICropSelectionResult } from '@app/types/crop';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { marginsToDisplayNormalizedRect } from '@app/utils/pdfCropCoordinates';
import {TEST_PDF_SAVE_BYTE_ROUTE_DECISION} from '@tests/unit/app/modules/pdf-viewer/runtime/save/testPdfSaveByteRouteDecision';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

type TCreateTextMarkupOptions = Parameters<IPdfViewerExpose['createTextMarkupFromText']>[0];
type TCreatePointNoteOptions = Parameters<IPdfViewerExpose['createPointNoteAnnotation']>[0];
type TCreateShapeOptions = Parameters<IPdfViewerExpose['createShapeAnnotation']>[0];

const mocks = vi.hoisted(() => ({
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    getPageGeometry: vi.fn(),
    warn: vi.fn(),
}));

const platformApi = createElectronPlatformApiFixture({pageOps: {getPageGeometry: mocks.getPageGeometry}});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: {
    diagnostic: (...args: unknown[]) => mocks.diagnostic(...args),
    diagnosticThrottled: (...args: unknown[]) => mocks.diagnosticThrottled(...args),
    warn: (...args: unknown[]) => mocks.warn(...args),
} }));

function createPdfViewerExpose(overrides: Partial<IPdfViewerExpose> = {}): IPdfViewerExpose {
    const viewer: IPdfViewerExpose = {
        getViewerContainer: () => null,
        scrollToPage: vi.fn(),
        moveAnnotationMarker: vi.fn(),
        captureRegionToClipboard: vi.fn(async () => false),
        isCapturingRegion: false,
        startCropSelection: vi.fn(async () => null),
        cancelCropSelection: vi.fn(),
        isCropSelecting: false,
        runSaveTransaction: vi.fn(async () => ({
            source: 'writer-save' as const,
            nativeMutationProjection: null,
            fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
            annotationSavePlan: {
                route: 'source-clean' as const,
                expectedCost: 'small' as const,
                reason: 'no-annotation-work' as const,
                unreplayableAnnotationIds: [],
            },
        })),
        highlightSelection: vi.fn(async () => false),
        commentSelection: vi.fn(async () => false),
        createTextMarkupFromText: vi.fn(async (options: TCreateTextMarkupOptions) => ({
            created: false,
            pageNumber: options.pageNumber,
            requestedText: options.text,
            matchedText: null,
            occurrence: options.occurrence ?? 1,
            subtype: 'Highlight' as const,
        })),
        commentAtPoint: vi.fn(async () => false),
        createPointNoteAnnotation: vi.fn(async (options: TCreatePointNoteOptions) => ({
            created: false,
            pageNumber: options.pageNumber,
            pageX: options.pageX,
            pageY: options.pageY,
        })),
        createShapeAnnotation: vi.fn(async (options: TCreateShapeOptions) => ({
            created: false,
            pageNumber: options.pageNumber,
            shape: null,
        })),
        focusAnnotationComment: vi.fn(async () => {}),
        updateAnnotationComment: vi.fn(() => false),
        deleteAnnotationComment: vi.fn(async () => false),
        getAllShapes: () => [],
        getDeletedEmbeddedShapeAnnotationIds: () => [],
        deleteSelectedShape: vi.fn(),
        hasShapes: false,
        startImagePlacement: vi.fn(async () => false),
    };

    return {
        ...viewer,
        ...overrides,
    };
}

describe('useWorkspaceCrop', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        0,
        90,
        180,
        270,
    ] as const)('reads the same page margins from a selection drawn at view rotation %i', async (viewRotation) => {
        const mediaBox = {
            x: 0,
            y: 0,
            width: 200,
            height: 100,
        };
        const margins = {
            top: 10,
            bottom: 20,
            left: 30,
            right: 40,
        };
        // The page is stored rotated 90°; the view adds its own rotation.
        mocks.getPageGeometry.mockResolvedValue({
            mediaBox,
            cropBox: null,
            rotation: 90,
            userUnit: 2,
        });
        const displayRotation = (90 + viewRotation) % 360;
        const displayed = displayRotation % 180 === 0
            ? {
                width: 200,
                height: 100,
            }
            : {
                width: 100,
                height: 200,
            };
        const rect = marginsToDisplayNormalizedRect(margins, mediaBox, displayRotation);
        const viewer = createPdfViewerExpose({startCropSelection: vi.fn(async (): Promise<ICropSelectionResult> => ({
            pageNumber: 1,
            viewRotation,
            pageRect: displayed,
            pageLocalRect: {
                x: rect.x * displayed.width,
                y: rect.y * displayed.height,
                width: rect.width * displayed.width,
                height: rect.height * displayed.height,
            },
        }))});
        const {useWorkspaceCrop} = await import('@app/modules/workspace-shell/composables/useWorkspaceCrop');
        const crop = useWorkspaceCrop({
            pdfViewerRef: ref<IPdfViewerExpose | null>(viewer),
            workingCopyPath: ref<TDocumentRef | null>(requireDocumentRef('/tmp/work.pdf')),
        });

        await crop.handleCrop();

        expect(crop.cropDialogMargins.value).toEqual({
            top: expect.closeTo(margins.top, 6),
            bottom: expect.closeTo(margins.bottom, 6),
            left: expect.closeTo(margins.left, 6),
            right: expect.closeTo(margins.right, 6),
        });
    });

    it('opens the crop dialog only after geometry and margins are ready', async () => {
        let resolveGeometry: ((value: IPageGeometry) => void) | undefined;

        mocks.getPageGeometry.mockImplementation(() =>
            new Promise<IPageGeometry>((resolve) => {
                resolveGeometry = resolve;
            }),
        );

        const selectionResult: ICropSelectionResult = {
            pageNumber: 1,
            viewRotation: 0,
            pageRect: {
                width: 100,
                height: 50,
            },
            pageLocalRect: {
                x: 10,
                y: 5,
                width: 70,
                height: 40,
            },
        };

        const viewer = createPdfViewerExpose({startCropSelection: vi.fn(async () => selectionResult)});

        const { useWorkspaceCrop } = await import('@app/modules/workspace-shell/composables/useWorkspaceCrop');
        const crop = useWorkspaceCrop({
            pdfViewerRef: ref<IPdfViewerExpose | null>(viewer),
            workingCopyPath: ref<TDocumentRef | null>(requireDocumentRef('/tmp/work.pdf')),
        });

        const cropPromise = crop.handleCrop();
        await Promise.resolve();

        expect(crop.cropDialogLoading.value).toBe(true);
        expect(crop.cropDialogOpen.value).toBe(false);

        if (!resolveGeometry) {
            throw new Error('Expected crop geometry request to be pending');
        }

        resolveGeometry({
            mediaBox: {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            cropBox: null,
            rotation: 90,
            userUnit: 2,
        });

        await cropPromise;

        expect(crop.cropDialogLoading.value).toBe(false);
        expect(crop.cropDialogOpen.value).toBe(true);
        expect(crop.cropDialogPageNumber.value).toBe(1);
        expect(crop.cropDialogGeometry.value).toMatchObject({
            rotation: 90,
            userUnit: 2,
        });
        expect(crop.cropDialogMargins.value).toEqual({
            top: 20,
            bottom: 10,
            left: 20,
            right: 20,
        });
    });

    it('ignores a crop selection if the working copy changes before selection resolves', async () => {
        const selectionResult: ICropSelectionResult = {
            pageNumber: 1,
            viewRotation: 0,
            pageRect: {
                width: 100,
                height: 50,
            },
            pageLocalRect: {
                x: 10,
                y: 5,
                width: 70,
                height: 40,
            },
        };
        const workingCopyPath = ref<TDocumentRef | null>(requireDocumentRef('/tmp/original.pdf'));
        const viewer = createPdfViewerExpose({startCropSelection: vi.fn(async () => {
            workingCopyPath.value = requireDocumentRef('/tmp/replaced.pdf');
            return selectionResult;
        })});

        const { useWorkspaceCrop } = await import('@app/modules/workspace-shell/composables/useWorkspaceCrop');
        const crop = useWorkspaceCrop({
            pdfViewerRef: ref<IPdfViewerExpose | null>(viewer),
            workingCopyPath,
        });

        await crop.handleCrop();

        expect(viewer.startCropSelection).toHaveBeenCalledOnce();
        expect(mocks.getPageGeometry).not.toHaveBeenCalled();
        expect(crop.cropDialogLoading.value).toBe(false);
        expect(crop.cropDialogOpen.value).toBe(false);
    });
});
