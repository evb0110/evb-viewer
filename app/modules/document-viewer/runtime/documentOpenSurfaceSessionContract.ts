import type {
    IDocumentNavigationRequest, IDocumentNavigationTicket, TDocumentNavigationReport,
} from '@app/modules/document-viewer/navigation/documentNavigationRequest';
import type { Ref } from 'vue';
import type { IDocumentPageSource } from '@app/modules/document-viewer/source/documentPageSource';
import type { IDocumentOpenSurfaceDiagnosticEntry } from '@app/modules/document-viewer/runtime/createDocumentOpenSurfaceDiagnostics';
import type { IDocumentViewportSessionState } from '@app/modules/document-viewer/runtime/documentOpenSurfaceReducer';
import type {
    IDocumentOpenSurfaceGeometry,
    IDocumentOpenSurfacePageFrame,
    IDocumentOpenSurfacePageGeometry,
    IDocumentOpenSurfacePagePreview,
    TDocumentOpenSurfacePresentation,
    TDocumentNativeOpeningPreviewState,
} from '@app/modules/document-viewer/runtime/retargetDocumentOpeningShell';

export type TDocumentOpenSurfacePhase = 'idle' | 'pending' | 'geometry-committed'
    | 'canvas-committed' | 'viewport-committed' | 'ready' | 'failed';

export interface IDocumentOpenSurfaceIdentity {
    readonly documentId: string;
    readonly documentRevision: string;
    readonly provisional?: boolean;
}

export interface IDocumentOpenSurfacePreparedPageFrame {
    readonly documentId: string;
    readonly ownerId: string;
    readonly pageNumber: number;
    readonly intentKey: string;
    readonly layoutKey: string;
    readonly policyKey: string;
    readonly sourceRevisionKey: string | null;
    readonly style: Readonly<Record<string, string>>;
    readonly geometry: IDocumentOpenSurfacePageGeometry;
}

export interface IDocumentOpenSurfacePageGeometrySeed extends IDocumentOpenSurfacePageGeometry {
    readonly size: number;
    readonly modifiedAt: number;
}

export interface IDocumentOpenSurfaceRenderFence {
    readonly generation: number;
    readonly documentRevision: string;
    readonly viewportIntentId: string;
    readonly renderVersion: number;
    readonly requestId: number;
    readonly pageNumber: number;
}

export interface IDocumentOpenSurfaceReadyRelease {
    readonly authorized: boolean;
    readonly ready: boolean;
}

export interface IDocumentOpenSurfaceRenderOwner {readonly renderVersion: number;}

export interface IDocumentOpenSurfaceViewportCommit {
    readonly generation: number;
    readonly documentRevision: string;
    readonly viewportIntentId: string;
    readonly documentGeometryRevision: number;
    readonly interactionEpoch: number;
    readonly pageNumber: number;
    readonly left: number;
    readonly top: number;
}

export interface IDocumentOpenSurfaceSnapshot {
    readonly generation: number;
    readonly identity: IDocumentOpenSurfaceIdentity | null;
    readonly revisionSwapPending?: boolean;
    readonly phase: TDocumentOpenSurfacePhase;
    readonly presentation: TDocumentOpenSurfacePresentation;
    readonly geometry: IDocumentOpenSurfaceGeometry | null;
    readonly openingPageGeometry: IDocumentOpenSurfacePageGeometry | null;
    readonly openingPageFrame: IDocumentOpenSurfacePageFrame | null;
    readonly nativeOpeningPreviewState?: TDocumentNativeOpeningPreviewState;
    /** Whether the native opening-preview lane has claimed this generation. */
    readonly nativeOpeningPreviewStaged?: boolean;
    /** Source file size known when the open was claimed, before its source loads. */
    readonly declaredSourceSize?: number;
    readonly committedRender: IDocumentOpenSurfaceRenderFence | null;
    readonly committedViewport: IDocumentOpenSurfaceViewportCommit | null;
    readonly failure: string | null;
}

export interface IDocumentOpenSurfaceSession {
    readonly navigationTicket: Readonly<Ref<IDocumentNavigationTicket | null>>;
    navigate(request: IDocumentNavigationRequest): IDocumentNavigationTicket | null;
    isNavigationCurrent(ticket: IDocumentNavigationTicket): boolean;
    reportNavigation(ticket: IDocumentNavigationTicket, report: TDocumentNavigationReport): boolean;
    readonly snapshot: Readonly<Ref<IDocumentOpenSurfaceSnapshot>>;
    readonly viewportSession: Readonly<Ref<IDocumentViewportSessionState>>;
    readonly readyAuthorizationRevision: Readonly<Ref<number>>;
    readonly openingPageSource: Readonly<Ref<IDocumentPageSource | null>>;
    getDiagnosticHistory(): readonly IDocumentOpenSurfaceDiagnosticEntry[];
    begin(
        identity: IDocumentOpenSurfaceIdentity,
        openingPageGeometry?: IDocumentOpenSurfacePageGeometry | null,
        initialPage?: number,
    ): number;
    beginPrepared(
        identity: IDocumentOpenSurfaceIdentity,
        preparedFrame: IDocumentOpenSurfacePreparedPageFrame,
    ): number | null;
    commitOpeningPageGeometry(
        generation: number,
        geometry: IDocumentOpenSurfacePageGeometry,
    ): boolean;
    prepareRevisionSwap(
        identity: IDocumentOpenSurfaceIdentity,
        pageNumber: number,
        invalidatedPages: readonly number[],
    ): boolean;
    completeRevisionSwap(generation: number, documentRevision: string): boolean;
    cancelRevisionSwap(generation: number, documentRevision: string): boolean;
    acquireSource(identity: IDocumentOpenSurfaceIdentity, expectedGeneration: number): number | null;
    commitOpeningPageFrame(generation: number, frame: IDocumentOpenSurfacePageFrame): boolean;
    commitOpeningPagePreview(generation: number, preview: IDocumentOpenSurfacePagePreview): boolean;
    declareSourceSize(generation: number, size: number): boolean;
    setNativeOpeningPreviewState(
        generation: number,
        state: TDocumentNativeOpeningPreviewState,
    ): boolean;
    clearOpeningPagePreview(generation: number, objectUrl: string): boolean;
    publishOpeningPageSource(
        generation: number,
        source: IDocumentPageSource,
        onRetire?: () => void,
    ): boolean;
    clearOpeningPageSource(generation: number, source: IDocumentPageSource): boolean;
    holdReadyForValidation(generation: number, sourceRevisionKey: string): boolean;
    releaseReadyAfterValidation(
        generation: number,
        sourceRevisionKey: string,
    ): IDocumentOpenSurfaceReadyRelease;
    clearOpeningPageFrame(generation: number, ownerId: string): boolean;
    commitGeometry(generation: number, geometry: IDocumentOpenSurfaceGeometry): boolean;
    claimRenderOwner(): IDocumentOpenSurfaceRenderOwner;
    createRenderFence(
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId'>,
    ): IDocumentOpenSurfaceRenderFence | null;
    createOwnedRenderFence(
        owner: IDocumentOpenSurfaceRenderOwner,
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId' | 'renderVersion' | 'requestId'> & {
            readonly rendererVersion: number;
            readonly rendererRequestId: number;
        },
    ): IDocumentOpenSurfaceRenderFence | null;
    createOwnedResidentRenderFence(
        owner: IDocumentOpenSurfaceRenderOwner,
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId' | 'renderVersion' | 'requestId'>,
    ): IDocumentOpenSurfaceRenderFence | null;
    commitCanvas(fence: IDocumentOpenSurfaceRenderFence): boolean;
    commitViewport(commit: IDocumentOpenSurfaceViewportCommit): boolean;
    markReady(fence: IDocumentOpenSurfaceRenderFence): boolean;
    reject(fence: IDocumentOpenSurfaceRenderFence, reason: string): boolean;
    failPageTransition(pageNumber: number, reason: string): boolean;
    fail(generation: number, reason: string): boolean;
    reset(): void;
    metadataReady(pageCount: number): boolean;
    invalidateResidentVisual(pageNumber: number): boolean;
    requestNavigation(pageNumber: number, skeletonDelayMs?: number): number;
    observeViewportPage(pageNumber: number, options?: {supersedeNavigation?: boolean}): number;
}
