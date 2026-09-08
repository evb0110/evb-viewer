export interface IPdfImagePlacementDraft {
    /** Existing canonical stamp being replaced. */
    appAnnotationId?: string;
    stableKey: string;
    /** Display rotation that owns the draft coordinates. */
    viewRotation: number;
    annotationId?: string | null;
    pageNumber: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotationDegrees: number;
    previewUrl: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    sourceFrameCount?: number;
    sourceOrientation?: number;
    sourcePixelWidth: number;
    sourcePixelHeight: number;
}

export interface IPdfImagePlacementRectUpdate {
    x: number;
    y: number;
    width: number;
    height: number;
    rotationDegrees?: number;
}

export interface IPdfPlacedImageFinalizePayload {
    /** Display rotation that owns the submitted coordinates. */
    viewRotation: number;
    /** Cancels work when the placement or document session is replaced. */
    signal?: AbortSignal;
    /** Existing canonical stamp being replaced. */
    appAnnotationId?: string;
    /** Canonical identity persisted in the Stamp `/NM` entry. */
    stableKey?: string;
    /** Existing Stamp object ref when replacing a reopened placed image. */
    annotationId?: string | null;
    pageNumber: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotationDegrees: number;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    sourceFrameCount?: number;
    sourceOrientation?: number;
    sourcePixelWidth: number;
    sourcePixelHeight: number;
    targetPixelWidth: number;
    targetPixelHeight: number;
}
