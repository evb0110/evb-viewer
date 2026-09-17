import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IpcRenderer} from 'electron';
import {
    isReactive,
    reactive,
} from 'vue';
import type {
    IScanCleanupOptions,
    IScanCleanupPreviewResult,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import {
    SCAN_CLEANUP_PLATFORM_FEATURE,
    type IScanCleanupInvokeMap,
} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import {createDefaultScanCleanupSettingsFile} from '@contracts/scan-cleanup/scanCleanupSettings';
import {createPlatformFeaturePreloadClient} from '@electron/preload/ipcClient';

const SCAN_CLEANUP_CHANNELS = SCAN_CLEANUP_PLATFORM_FEATURE.invokeChannels;

const owner = {
    ownerId: 'workspace-owner',
    documentRevision: 'revision-7',
};

const plainOptions: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'bw',
    readingOrder: 'ltr',
    thickness: 1,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 4,
        topMm: 4,
        rightMm: 4,
        bottomMm: 4,
    },
    despeckle: true,
    skipBlankPages: false,
    pageOverrides: {'2': {
        rotationDegrees: 90,
        layoutOverride: 'spread',
        excluded: false,
        manualSplit: {
            xNormalized: 0.43,
            rotationDegrees: 90,
        },
        manualContentBoxes: {left: {
            xNormalized: 0.03,
            yNormalized: 0.05,
            widthNormalized: 0.4,
            heightNormalized: 0.8,
            rotationDegrees: 90,
        }},
        placementOverrides: {left: 'bottom-right'},
    }},
};

const documentPrior = {
    dominantLayout: 'two-page-spread' as const,
    cutterRatioMedian: 0.51,
    clusterDims: {
        widthPx: 2400,
        heightPx: 1700,
    },
    agreementStrength: 0.87,
};

function previewResult(): IScanCleanupPreviewResult {
    return {
        pageNumber: requirePageNumber(2),
        totalPages: 12,
        rawImageData: new Uint8Array([1]),
        rawWidthPx: 2400,
        rawHeightPx: 1700,
        pageMetadata: {
            layoutClassification: 'two-page-spread',
            layoutConfidence: 0.87,
            cutterXPx: 1224,
            rotationDegrees: 90,
            canvasScope: 'document',
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: 'single-uncut-page',
            reconciled: true,
            clusterAgreement: 0.87,
        },
        outputs: [{
            imageData: new Uint8Array([2]),
            metadata: {
                half: 'left',
                layoutClassification: 'two-page-spread',
                layoutConfidence: 0.87,
                sourceRegion: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1224,
                    heightPx: 1700,
                },
                contentBox: null,
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                outputWidthPx: 1224,
                outputHeightPx: 1700,
                canvasWidthPx: 1224,
                canvasHeightPx: 1700,
                canvasPolicy: 'strict-maximum',
                canvasOverflow: false,
                matchedCanvasTargetWidthPx: 1224,
                matchedCanvasTargetHeightPx: 1700,
                placementOffsetXPx: 0,
                placementOffsetYPx: 0,
                forwardTransform: {matrix: [
                    [
                        1,
                        0,
                        0,
                    ],
                    [
                        0,
                        1,
                        0,
                    ],
                    [
                        0,
                        0,
                        1,
                    ],
                ]},
                cutterXPx: 1224,
                inputWidthPx: 2400,
                inputHeightPx: 1700,
                rotationDegrees: 90,
                canvasScope: 'document',
                resamplePasses: 1,
                warnings: [],
            },
        }],
    };
}

type TScanCleanupChannel = keyof IScanCleanupInvokeMap;

const responses: {[TChannel in TScanCleanupChannel]: unknown} = {
    [SCAN_CLEANUP_CHANNELS.preview]: previewResult(),
    [SCAN_CLEANUP_CHANNELS.resolvePlacementAnchorCalibration]:
        SCAN_CLEANUP_PLATFORM_FEATURE.methods.resolvePlacementAnchorCalibration.ipc.result.example(),
    [SCAN_CLEANUP_CHANNELS.cancelPreview]: true,
    [SCAN_CLEANUP_CHANNELS.detectAll]: {
        started: true,
        jobId: 'detect-1',
    },
    [SCAN_CLEANUP_CHANNELS.cancelDetection]: true,
    [SCAN_CLEANUP_CHANNELS.getDetectionJobState]: null,
    [SCAN_CLEANUP_CHANNELS.subscribeDetectionJob]: null,
    [SCAN_CLEANUP_CHANNELS.start]: {
        started: true,
        jobId: 'cleanup-1',
        outputPdfPath: '/documents/cleaned.pdf',
    },
    [SCAN_CLEANUP_CHANNELS.cancel]: true,
    [SCAN_CLEANUP_CHANNELS.getJobState]: null,
    [SCAN_CLEANUP_CHANNELS.subscribeJob]: null,
    [SCAN_CLEANUP_CHANNELS.reconnectJob]: null,
    [SCAN_CLEANUP_CHANNELS.pruneGeneratedOutputs]: 2,
    [SCAN_CLEANUP_CHANNELS.getSettings]: createDefaultScanCleanupSettingsFile(),
    [SCAN_CLEANUP_CHANNELS.updateSettings]: createDefaultScanCleanupSettingsFile(),
};

describe('scan-cleanup IPC structured-clone contract', () => {
    it('encodes every preload request and decodes every response into structured-cloneable data', async () => {
        const reactiveOptions = reactive(structuredClone(plainOptions));
        const documentPriorByPage = reactive(new Map([[
            2,
            documentPrior,
        ]]));
        const reactiveDocumentPrior = documentPriorByPage.get(2)!;
        const reactiveOwner = reactive({...owner});
        expect(isReactive(reactiveDocumentPrior)).toBe(true);

        const regressedPreviewPayload = {
            ...owner,
            sourcePdfPath: '/documents/source.pdf',
            pageNumber: 2,
            options: plainOptions,
            documentPrior: reactiveDocumentPrior,
        };
        expect(() => structuredClone(regressedPreviewPayload)).toThrow();

        const encodedByChannel = new Map<string, unknown[]>();
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
                if (!(channel in responses)) throw new Error(`Unexpected scan-cleanup IPC channel: ${channel}`);
                const boundaryPayload = structuredClone(args);
                encodedByChannel.set(channel, boundaryPayload);
                return structuredClone(responses[channel as TScanCleanupChannel]);
            }),
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'>;
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer,
            SCAN_CLEANUP_PLATFORM_FEATURE,
        );

        const decodedResponses = await Promise.all([
            client.preview({
                ...owner,
                requestId: requireRequestId('clone-boundary-preview'),
                sourcePdfPath: '/documents/source.pdf',
                pageNumber: requirePageNumber(2),
                options: reactiveOptions,
                documentPrior: reactiveDocumentPrior,
                visible: true,
            }),
            client.cancelPreview({
                ...reactiveOwner,
                sourcePdfPath: '/documents/source.pdf',
                invalidateRawCache: false,
            }),
            client.resolvePlacementAnchorCalibration!({
                ...reactiveOwner,
                sourcePdfPath: '/documents/source.pdf',
                detectionResultStoreId: 'store-1',
                options: reactiveOptions,
                pageNumber: requirePageNumber(2),
            }),
            client.detectAll({
                ...reactiveOwner,
                sourcePdfPath: '/documents/source.pdf',
                options: reactiveOptions,
            }),
            client.cancelDetection(requireJobId('detect-1'), reactiveOwner),
            client.getDetectionJobState(requireJobId('detect-1'), reactiveOwner),
            client.subscribeDetectionJob(requireJobId('detect-1'), reactiveOwner),
            client.start({
                ...reactiveOwner,
                sourcePdfPath: '/documents/source.pdf',
                options: reactiveOptions,
                sourcePageNumbers: [
                    requirePageNumber(2),
                    requirePageNumber(4),
                ],
            }),
            client.cancel(requireJobId('cleanup-1'), reactiveOwner),
            client.getJobState(requireJobId('cleanup-1'), reactiveOwner),
            client.subscribeJob(requireJobId('cleanup-1'), reactiveOwner),
            client.reconnectJob(requireJobId('cleanup-1'), reactiveOwner),
            client.pruneGeneratedOutputs(),
            client.getSettings!({}),
            client.updateSettings!({}),
        ]);

        expect(encodedByChannel.size).toBe(Object.keys(SCAN_CLEANUP_CHANNELS).length);
        for (const encoded of encodedByChannel.values()) {
            expect(() => structuredClone(encoded)).not.toThrow();
            expect(isReactive(encoded)).toBe(false);
        }
        expect(encodedByChannel.get(SCAN_CLEANUP_CHANNELS.preview)?.[0]).toMatchObject({
            documentPrior,
            options: plainOptions,
            visible: true,
        });
        for (const decoded of decodedResponses) {
            expect(() => structuredClone(decoded)).not.toThrow();
        }
    });
});
