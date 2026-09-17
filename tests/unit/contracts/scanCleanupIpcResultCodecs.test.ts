import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeScanCleanupJobState,
    decodeScanCleanupRawPreviewEvent,
    decodeScanCleanupPreviewResult,
} from '@contracts/scan-cleanup/ipcResultCodecs';

const failedState = {
    jobId: 'job-1',
    status: 'failed',
    error: 'native pipeline failed',
    errorCode: 'native-failure',
    progress: {
        stage: 'rendering',
        completedUnits: 1,
        totalUnits: 2,
        percent: 50,
    },
    updatedAtMs: 1,
    failure: {
        eventId: '0123456789abcdef0123456789abcdef',
        code: 'UNCLASSIFIED_MAIN_ERROR',
        occurredAt: 1,
        severity: 'error',
    },
};

describe('scan cleanup job state diagnostics', () => {
    it('preserves the closed main failure receipt on a failed projection', () => {
        expect(decodeScanCleanupJobState(failedState)).toEqual(failedState);
    });

    it('keeps legacy failed projections compatible while rejecting an invalid receipt', () => {
        const {
            failure: _failure,
            ...legacy
        } = failedState;
        expect(decodeScanCleanupJobState(legacy)).toEqual(legacy);
        expect(() => decodeScanCleanupJobState({
            ...failedState,
            failure: {
                ...failedState.failure,
                eventId: 'not-an-event-id',
            },
        })).toThrow('invalid failure receipt');
    });

    it('preserves typed scratch figures on a failed run projection', () => {
        const runState = {
            ...failedState,
            errorCode: 'insufficient-scratch',
            scratchShortfall: {
                availableBytes: 520 * 1024 * 1024,
                requiredBytes: 1_100 * 1024 * 1024,
            },
        };
        expect(decodeScanCleanupJobState(runState)).toEqual(runState);
    });
});

describe('scan cleanup raw preview result', () => {
    const rawPreview = {
        ownerId: 'preview-owner',
        documentRevision: 'revision-1',
        requestId: 'preview-request-1',
        pageNumber: 1,
        totalPages: 1,
        rawImageData: new Uint8Array([1]),
        rawWidthPx: 1,
        rawHeightPx: 1,
    };

    it('bounds the owner identity fields at the result boundary', () => {
        expect(decodeScanCleanupRawPreviewEvent(rawPreview)).toMatchObject(rawPreview);
        expect(decodeScanCleanupRawPreviewEvent({
            ...rawPreview,
            ownerId: 'o'.repeat(128),
            documentRevision: 'r'.repeat(128),
        })).toMatchObject({
            ownerId: 'o'.repeat(128),
            documentRevision: 'r'.repeat(128),
        });
        expect(() => decodeScanCleanupRawPreviewEvent({
            ...rawPreview,
            ownerId: 'x'.repeat(129),
        })).toThrow('raw preview owner id');
        expect(() => decodeScanCleanupRawPreviewEvent({
            ...rawPreview,
            documentRevision: 'x'.repeat(129),
        })).toThrow('raw preview document revision');
    });
});

describe('scan cleanup preview result geometry', () => {
    const previewMetadata = (appliedMargins: {
        leftPx: number;
        rightPx: number;
    }) => ({
        half: 'full',
        layoutClassification: 'single-uncut-page',
        layoutConfidence: 1,
        sourceRegion: {
            xPx: 0,
            yPx: 0,
            widthPx: 1000,
            heightPx: 500,
        },
        contentBox: null,
        appliedMargins: {
            leftPx: appliedMargins.leftPx,
            topPx: 0,
            rightPx: appliedMargins.rightPx,
            bottomPx: 0,
        },
        outputWidthPx: 1000,
        outputHeightPx: 500,
        intrinsicRasterWidthPx: 1000,
        intrinsicRasterHeightPx: 500,
        canvasWidthPx: 1000,
        canvasHeightPx: 500,
        matchedCanvasContentWidthPx: 1000,
        matchedCanvasContentHeightPx: 500,
        matchedCanvasOpticalPlacement: true,
        matchedCanvasOpticalContentLeftPx: 300,
        matchedCanvasOpticalContentRightPx: 950,
        matchedCanvasIntrinsicOverflowLeftPx: 125,
        placementOffsetXPx: 0,
        placementOffsetYPx: 0,
        forwardTransform: null,
        cutterXPx: null,
        inputWidthPx: 1000,
        inputHeightPx: 500,
        rotationDegrees: 0,
        canvasScope: 'page',
        resamplePasses: 1,
        warnings: [],
    });

    const previewResult = (metadata: ReturnType<typeof previewMetadata>) => ({
        pageNumber: 1,
        totalPages: 1,
        rawImageData: new Uint8Array([1]),
        rawWidthPx: 1000,
        rawHeightPx: 500,
        pageMetadata: {
            layoutClassification: 'single-uncut-page',
            cutterXPx: null,
            rotationDegrees: 0,
            canvasScope: 'page',
            excluded: false,
            blankOutputsSkipped: 0,
        },
        outputs: [{
            imageData: new Uint8Array([2]),
            metadata,
        }],
    });

    it('uses applied margins for optical placement at the IPC boundary', () => {
        expect(decodeScanCleanupPreviewResult(previewResult(previewMetadata({
            leftPx: 100,
            rightPx: 100,
        })))).toMatchObject({pageNumber: 1});
        expect(() => decodeScanCleanupPreviewResult(
            previewResult(previewMetadata({
                leftPx: 200,
                rightPx: 100,
            })),
        )).toThrow('invalid scan-cleanup preview intrinsic/canvas placement');
    });
});
