import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import type { IPdfNativePlacedImage } from '@contracts/electronApiDocuments';
import { decodeManagedTempFileHandle } from '@contracts/electronApiDocuments';
import { parsePageIndex } from '@contracts/pageNumbers';
import {
    decodeBrowserImageBlob,
    toTransferableUint8Array,
} from '@app/platform/browser-api/public';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { isNativeDocumentRef } from '@app/utils/documentRef';
import {
    NativePdfSaveRequiredError,
    consumeNativePdfMutationProjection,
} from '@app/modules/workspace-shell/public/nativePdfMutationArtifact';
import type { INativePdfMutationProjection } from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import { createPdfSourceDataReader } from '@app/modules/pdf-viewer/runtime/composables/pdf/createPdfSourceDataReader';

export interface IPdfPlacedImageNativePathResult {
    readonly kind: 'native-path';
    readonly path: TDocumentRef;
    readonly revisionToken: TDocumentRevisionToken;
}

export type TPdfPlacedImageEmbeddingResult = Uint8Array | IPdfPlacedImageNativePathResult;

export function isPdfPlacedImageNativePathResult(result: TPdfPlacedImageEmbeddingResult): result is IPdfPlacedImageNativePathResult {
    return typeof result === 'object' && result !== null && 'kind' in result && result.kind === 'native-path';
}

interface ISerializedPlacedImagePayload extends Omit<IPdfPlacedImageFinalizePayload, 'mimeType'> {mimeType: 'image/png' | 'image/jpeg';}

async function normalizeImagePayload(payload: IPdfPlacedImageFinalizePayload): Promise<ISerializedPlacedImagePayload> {
    if (payload.mimeType === 'image/png' || payload.mimeType === 'image/jpeg') {
        return {
            ...payload,
            mimeType: payload.mimeType,
        };
    }
    const image = await decodeBrowserImageBlob(new Blob([payload.bytes.buffer as ArrayBuffer], {type: payload.mimeType || 'image/png'}), {fallbackErrorMessage: 'Failed to decode image for PDF embedding'});
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(payload.targetPixelWidth));
    canvas.height = Math.max(1, Math.round(payload.targetPixelHeight));
    try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image rasterization failed')), 'image/png'));
        return {
            ...payload,
            bytes: new Uint8Array(await blob.arrayBuffer()),
            mimeType: 'image/png',
        };
    } finally {
        if ('close' in image && typeof image.close === 'function') image.close();
        canvas.width = 0;
        canvas.height = 0;
    }
}

function toNativeImage(payload: ISerializedPlacedImagePayload): IPdfNativePlacedImage | null {
    const source = decodeManagedTempFileHandle(payload.nativeSourceHandle);
    if (payload.mimeType !== 'image/jpeg' || !source || payload.pageNumber < 1) {
        return null;
    }
    const pageIndex = parsePageIndex(payload.pageNumber - 1);
    return pageIndex === null ? null : {
        pageIndex,
        ...(payload.stableKey ? {stableKey: payload.stableKey} : {}),
        ...(payload.annotationId ? {annotationId: payload.annotationId} : {}),
        x: payload.x,
        y: payload.y,
        width: payload.width,
        height: payload.height,
        rotationDegrees: payload.rotationDegrees,
        mimeType: 'image/jpeg',
        source,
    };
}

export const usePdfPlacedImagePersistence = (deps: {
    pdfData: Ref<Uint8Array | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
}) => {
    const getSourcePdfData = createPdfSourceDataReader(deps);
    const embedPlacedImageToPage = async (data: Uint8Array | null, placement: IPdfPlacedImageFinalizePayload): Promise<TPdfPlacedImageEmbeddingResult> => {
        const payload = await normalizeImagePayload(placement);
        const image = toNativeImage(payload);
        const path = deps.workingCopyPath.value;
        const revisionToken = deps.documentRevisionToken?.value;
        if (!path || !image || !revisionToken) {
            throw new NativePdfSaveRequiredError({
                code: 'native-save-required',
                phase: 'pre-write',
                reason: 'missing-native-capability',
                detail: 'Placed-image persistence requires the native writer',
            });
        }
        const projection = {
            canonicalAnnotationProgram: [],
            mutations: {placedImages: [image]},
            noteTextUpdates: [],
            freeTextNotes: [],
            freeTextEditors: [],
            annotationDeletes: [],
            hasMetadataMutations: false,
            hasShapeMutations: false,
            hasMarkupMutations: false,
            phase: 'placed-image',
        } as INativePdfMutationProjection;
        try {
            await consumeNativePdfMutationProjection({
                workingPath: path,
                expectedDocumentRevisionToken: revisionToken,
                projection,
                operation: 'replace',
            });
            if (isNativeDocumentRef(path)) {
                const revision = await getDocumentFilesCapability().getDocumentRevision(path);
                return {
                    kind: 'native-path',
                    path,
                    revisionToken: revision.token,
                };
            }
            return toTransferableUint8Array(await readDocumentBytes(path));
        } finally {
            await getDocumentFilesCapability().releaseManagedTempFileHandle?.(image.source.leaseId).catch(() => false);
        }
    };
    return {
        getSourcePdfData,
        embedPlacedImageToPage,
    };
};
