import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { usePdfImagePlacement } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfImagePlacement';
import { getInitialImagePlacementRect } from '@app/modules/pdf-viewer/engine/image-placement/getInitialImagePlacementRect';
import type {IPdfPlacedImageFinalizePayload} from '@app/types/pdfImagePlacement';

const platformMocks = vi.hoisted(() => ({releaseManagedTempFileHandle: vi.fn(async () => true)}));

vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => platformMocks}));

function toElement<T extends object>(value: T) {
    return value as HTMLElement;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

describe('usePdfImagePlacement', () => {
    const createObjectURL = vi.fn(() => 'blob:preview');
    const revokeObjectURL = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('URL', {
            createObjectURL,
            revokeObjectURL,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function createViewerContainer() {
        const canvas = {
            width: 1200,
            height: 1600,
        } as HTMLCanvasElement;
        const pageContainer = toElement({
            getBoundingClientRect: () => ({
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: 600,
                bottom: 800,
                width: 600,
                height: 800,
                toJSON: () => ({}),
            }),
            clientWidth: 600,
            clientHeight: 800,
            querySelector: vi.fn((selector: string) =>
                selector === '.page_canvas canvas' ? canvas : null),
        });

        return toElement({ querySelector: vi.fn((selector: string) =>
            selector === '.page_container[data-page="1"]' ? pageContainer : null) });
    }

    async function probeImageForTest(file: File) {
        const bitmap = await createImageBitmap(file);
        try {
            return {
                bytes: new Uint8Array(await file.arrayBuffer()),
                width: bitmap.width,
                height: bitmap.height,
                frameCount: 1,
                mimeType: file.type,
            };
        } finally {
            bitmap.close();
        }
    }

    const createPreviewForTest = async () => new Blob(['preview'], {type: 'image/png'});

    function createNativeSourceHandle(leaseId: string) {
        return {
            path: `/tmp/${leaseId}.jpg` as const,
            size: 3,
            sha256: 'a'.repeat(64),
            leaseId,
            revision: null,
        };
    }

    function createImageFileWithNativeSourceHandle(
        name: string,
        leaseId: string,
    ) {
        return Object.assign(
            new File([new Uint8Array([
                1,
                2,
                3,
            ])], name, {type: 'image/jpeg'}),
            {nativeSourceHandle: createNativeSourceHandle(leaseId)},
        );
    }

    it('clamps the initial placement rect to page bounds', () => {
        expect(getInitialImagePlacementRect({
            pageNumber: 2,
            pageX: 0,
            pageY: 1,
            pageWidthPx: 600,
            pageHeightPx: 800,
        }, {
            width: 0.4,
            height: 0.3,
        })).toEqual({
            pageNumber: 2,
            x: 0,
            y: 0.7,
            width: 0.4,
            height: 0.3,
        });
    });

    it('returns false and leaves no draft when image decoding fails', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => {
            throw new Error('decode failed');
        }));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            const didStart = await imagePlacement.startImagePlacement(
                createImageFileWithNativeSourceHandle('broken.png', 'decode-failure-lease'),
            );

            expect(didStart).toBe(false);
            expect(imagePlacement.pendingImagePlacement.value).toBeNull();
            expect(finalized).not.toHaveBeenCalled();
            expect(platformMocks.releaseManagedTempFileHandle)
                .toHaveBeenCalledWith('decode-failure-lease');
        } finally {
            scope.stop();
        }
    });

    it('releases the native source handle when preview creation fails', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));
        const createPreview = vi.fn(async () => {
            throw new Error('preview failed');
        });

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: vi.fn(),
            probeImage: probeImageForTest,
            createPreview,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await expect(imagePlacement.startImagePlacement(
                createImageFileWithNativeSourceHandle('preview-failure.jpg', 'preview-failure-lease'),
            )).resolves.toBe(false);
            expect(platformMocks.releaseManagedTempFileHandle)
                .toHaveBeenCalledWith('preview-failure-lease');
            expect(imagePlacement.pendingImagePlacement.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('releases the native source handle when an in-flight placement is canceled', async () => {
        const deferredProbe = createDeferred<{
            bytes: Uint8Array;
            width: number;
            height: number;
            frameCount: number;
            mimeType: string;
        }>();
        const probeImage = vi.fn((_file: File, _limits: unknown, signal?: AbortSignal) => {
            signal?.addEventListener('abort', () => deferredProbe.reject(signal.reason), {once: true});
            return deferredProbe.promise;
        });

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: vi.fn(),
            probeImage,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            const start = imagePlacement.startImagePlacement(
                createImageFileWithNativeSourceHandle('canceled.jpg', 'cancel-lease'),
            );
            imagePlacement.clearPendingImagePlacement();

            await expect(start).resolves.toBe(false);
            expect(platformMocks.releaseManagedTempFileHandle)
                .toHaveBeenCalledWith('cancel-lease');
        } finally {
            scope.stop();
        }
    });

    it('keeps the latest image placement when overlapping starts resolve out of order', async () => {
        const slowBitmap = createDeferred<{
            width: number;
            height: number;
            close: () => void;
        }>();
        const fastBitmap = createDeferred<{
            width: number;
            height: number;
            close: () => void;
        }>();
        vi.stubGlobal('createImageBitmap', vi.fn()
            .mockReturnValueOnce(slowBitmap.promise)
            .mockReturnValueOnce(fastBitmap.promise));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            const slowStart = imagePlacement.startImagePlacement(
                new File([new Uint8Array([1])], 'slow.png', { type: 'image/png' }),
            );
            const fastStart = imagePlacement.startImagePlacement(
                new File([new Uint8Array([2])], 'fast.png', { type: 'image/png' }),
            );

            fastBitmap.resolve({
                width: 200,
                height: 100,
                close: vi.fn(),
            });
            await expect(fastStart).resolves.toBe(true);
            expect(imagePlacement.pendingImagePlacement.value?.fileName).toBe('fast.png');

            slowBitmap.resolve({
                width: 400,
                height: 200,
                close: vi.fn(),
            });
            await expect(slowStart).resolves.toBe(false);
            expect(imagePlacement.pendingImagePlacement.value?.fileName).toBe('fast.png');
            expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:preview');
        } finally {
            scope.stop();
        }
    });

    it('releases the replaced native source handle while retaining the latest draft', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: vi.fn(),
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await expect(imagePlacement.startImagePlacement(
                createImageFileWithNativeSourceHandle('first.jpg', 'first-lease'),
            )).resolves.toBe(true);
            await expect(imagePlacement.startImagePlacement(
                createImageFileWithNativeSourceHandle('second.jpg', 'second-lease'),
            )).resolves.toBe(true);

            expect(platformMocks.releaseManagedTempFileHandle)
                .toHaveBeenCalledWith('first-lease');
            expect(platformMocks.releaseManagedTempFileHandle)
                .not.toHaveBeenCalledWith('second-lease');
            expect(imagePlacement.pendingImagePlacement.value?.fileName).toBe('second.jpg');
        } finally {
            scope.stop();
        }
    });

    it('keeps a shared native source handle leased across overlapping starts and draft replacement', async () => {
        const firstProbe = createDeferred<{
            bytes: Uint8Array;
            width: number;
            height: number;
            frameCount: number;
            mimeType: string;
        }>();
        const secondProbe = createDeferred<{
            bytes: Uint8Array;
            width: number;
            height: number;
            frameCount: number;
            mimeType: string;
        }>();
        const thirdProbe = createDeferred<{
            bytes: Uint8Array;
            width: number;
            height: number;
            frameCount: number;
            mimeType: string;
        }>();
        const probeImage = vi.fn()
            .mockReturnValueOnce(firstProbe.promise)
            .mockReturnValueOnce(secondProbe.promise)
            .mockReturnValueOnce(thirdProbe.promise);
        const sharedHandleFile = (name: string) => createImageFileWithNativeSourceHandle(name, 'shared-lease');

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: vi.fn(),
            probeImage,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            const firstStart = imagePlacement.startImagePlacement(sharedHandleFile('first.jpg'));
            const secondStart = imagePlacement.startImagePlacement(sharedHandleFile('second.jpg'));

            firstProbe.resolve({
                bytes: new Uint8Array([1]),
                width: 400,
                height: 200,
                frameCount: 1,
                mimeType: 'image/jpeg',
            });
            await expect(firstStart).resolves.toBe(false);

            secondProbe.resolve({
                bytes: new Uint8Array([2]),
                width: 400,
                height: 200,
                frameCount: 1,
                mimeType: 'image/jpeg',
            });
            await expect(secondStart).resolves.toBe(true);

            expect(platformMocks.releaseManagedTempFileHandle)
                .not.toHaveBeenCalledWith('shared-lease');
            expect(imagePlacement.pendingImagePlacement.value?.nativeSourceHandle?.leaseId)
                .toBe('shared-lease');

            const thirdStart = imagePlacement.startImagePlacement(sharedHandleFile('third.jpg'));
            thirdProbe.resolve({
                bytes: new Uint8Array([3]),
                width: 400,
                height: 200,
                frameCount: 1,
                mimeType: 'image/jpeg',
            });
            await expect(thirdStart).resolves.toBe(true);

            expect(platformMocks.releaseManagedTempFileHandle)
                .not.toHaveBeenCalledWith('shared-lease');
            expect(imagePlacement.pendingImagePlacement.value?.fileName)
                .toBe('third.jpg');

            imagePlacement.clearPendingImagePlacement();

            expect(platformMocks.releaseManagedTempFileHandle)
                .toHaveBeenCalledOnce();
            expect(platformMocks.releaseManagedTempFileHandle)
                .toHaveBeenCalledWith('shared-lease');
            scope.stop();
            expect(platformMocks.releaseManagedTempFileHandle)
                .toHaveBeenCalledOnce();
        } finally {
            scope.stop();
        }
    });

    it('finalizes with target pixel dimensions derived from the rendered page size', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.png', { type: 'image/png' }),
                {
                    stableKey: 'placed-image-app-1',
                    annotationId: '44R',
                },
            );
            imagePlacement.updatePendingImagePlacementRect({
                x: 0.1,
                y: 0.2,
                width: 0.25,
                height: 0.5,
                rotationDegrees: 90,
            });

            imagePlacement.requestPendingImagePlacementFinalize();

            expect(finalized).toHaveBeenCalledOnce();
            expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
                stableKey: 'placed-image-app-1',
                annotationId: '44R',
                pageNumber: 1,
                x: 0.1,
                y: 0.2,
                width: 0.25,
                height: 0.5,
                rotationDegrees: 90,
                fileName: 'image.png',
                mimeType: 'image/png',
                targetPixelWidth: 150,
                targetPixelHeight: 400,
            }));
            expect(imagePlacement.pendingImagePlacement.value).toBeNull();
            expect(imagePlacement.isPendingImagePlacementFinalizing.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('releases the placement only after canonical stamp creation succeeds', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalization = createDeferred<boolean>();
        const finalized = vi.fn(() => finalization.promise);
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.jpg', {type: 'image/jpeg'}),
            );
            imagePlacement.requestPendingImagePlacementFinalize();

            expect(imagePlacement.isPendingImagePlacementFinalizing.value).toBe(true);
            expect(imagePlacement.pendingImagePlacement.value).not.toBeNull();
            finalization.resolve(true);
            await vi.waitFor(() => expect(imagePlacement.pendingImagePlacement.value).toBeNull());
            expect(imagePlacement.isPendingImagePlacementFinalizing.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('restores a failed stamp finalization and allows a retry', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.jpg', {type: 'image/jpeg'}),
            );
            imagePlacement.requestPendingImagePlacementFinalize();
            await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(imagePlacement.isPendingImagePlacementFinalizing.value).toBe(false));
            expect(imagePlacement.pendingImagePlacement.value).not.toBeNull();

            imagePlacement.requestPendingImagePlacementFinalize();
            await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(imagePlacement.pendingImagePlacement.value).toBeNull());
        } finally {
            scope.stop();
        }
    });

    it('passes owned bytes to stamp creation without exposing the draft buffer', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn((candidate: IPdfPlacedImageFinalizePayload) => {
            candidate.bytes[0] = 99;
            return false;
        });
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'image.jpg', {type: 'image/jpeg'}),
            );
            const draftBytes = imagePlacement.pendingImagePlacement.value?.bytes.slice();
            imagePlacement.requestPendingImagePlacementFinalize();

            const payload = finalized.mock.calls[0]?.[0];
            expect(payload?.bytes[0]).toBe(99);
            expect(payload?.stableKey).toMatch(/^placed-image-/u);
            expect(imagePlacement.pendingImagePlacement.value?.bytes).toEqual(draftBytes);
        } finally {
            scope.stop();
        }
    });

    it('upsizes tiny finalized placements before serialization', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 400,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const finalized = vi.fn();
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: finalized,
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                new File([new Uint8Array([
                    1,
                    2,
                    3,
                ])], 'tiny.png', { type: 'image/png' }),
            );
            imagePlacement.updatePendingImagePlacementRect({
                x: 0.15,
                y: 0.2,
                width: 0.01,
                height: 0.01,
                rotationDegrees: 0,
            });

            imagePlacement.requestPendingImagePlacementFinalize();

            expect(finalized).toHaveBeenCalledOnce();
            expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
                fileName: 'tiny.png',
                targetPixelWidth: 48,
                targetPixelHeight: 64,
            }));
        } finally {
            scope.stop();
        }
    });

    it('revokes the preview URL when the draft is cleared', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: vi.fn(),
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        try {
            await imagePlacement.startImagePlacement(
                createImageFileWithNativeSourceHandle('image.png', 'clear-lease'),
            );

            imagePlacement.clearPendingImagePlacement();

            expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
            expect(platformMocks.releaseManagedTempFileHandle)
                .toHaveBeenCalledWith('clear-lease');
            expect(imagePlacement.pendingImagePlacement.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('releases the native source handle when its scope is disposed', async () => {
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 400,
            height: 200,
            close: vi.fn(),
        })));

        const viewerContainer = ref<HTMLElement | null>(createViewerContainer());
        const scope = effectScope();
        const imagePlacement = scope.run(() => usePdfImagePlacement({
            viewerContainer,
            currentPage: ref(1),
            numPages: ref(4),
            effectiveScale: ref(2),
            finalizePlacement: vi.fn(),
            probeImage: probeImageForTest,
            createPreview: createPreviewForTest,
        }));

        if (!imagePlacement) {
            throw new Error('Failed to create image placement composable');
        }

        await expect(imagePlacement.startImagePlacement(
            createImageFileWithNativeSourceHandle('scope.jpg', 'scope-lease'),
        )).resolves.toBe(true);
        scope.stop();

        expect(platformMocks.releaseManagedTempFileHandle)
            .toHaveBeenCalledWith('scope-lease');
    });
});
