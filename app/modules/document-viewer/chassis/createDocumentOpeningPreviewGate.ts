import type { Ref } from 'vue';
import type {
    IDocumentOpenSurfacePageFrame,
    IDocumentOpenSurfacePagePreview,
} from '@app/modules/document-viewer/chassis/retargetDocumentOpeningShell';

interface IOpeningPreviewSnapshot {
    readonly generation: number;
    readonly identity: {
        readonly documentId: string;
        readonly documentRevision: string;
    } | null;
    readonly phase: string;
    readonly openingPageGeometry: {readonly pageNumber: number;} | null;
    readonly openingPageFrame: IDocumentOpenSurfacePageFrame | null;
}

function isTransitionPhase(phase: string) {
    return phase === 'pending'
        || phase === 'geometry-committed'
        || phase === 'canvas-committed'
        || phase === 'viewport-committed';
}

export function createDocumentOpeningPreviewGate(options: {
    readSnapshot: () => IOpeningPreviewSnapshot;
    replaceFrame: (frame: IDocumentOpenSurfacePageFrame) => void;
}) {
    const readyAuthorizationRevision = ref(0);
    let readyGate: {
        generation: number;
        sourceRevisionKey: string;
        authorized: boolean;
    } | null = null;

    function reset() {
        if (readyGate === null) {
            return;
        }
        readyGate = null;
        readyAuthorizationRevision.value += 1;
    }

    return {
        readyAuthorizationRevision: readonly(readyAuthorizationRevision) as Readonly<Ref<number>>,
        reset,
        refineFrameRevision(frame: IDocumentOpenSurfacePageFrame, documentRevision: string) {
            return frame.preview
                ? Object.freeze({
                    ...frame,
                    preview: Object.freeze({
                        ...frame.preview,
                        documentRevision,
                    }),
                })
                : frame;
        },
        commit(generation: number, preview: IDocumentOpenSurfacePagePreview) {
            const current = options.readSnapshot();
            const frame = current.openingPageFrame;
            if (
                current.generation !== generation
                || current.identity?.documentId !== preview.documentId
                || current.identity.documentRevision !== preview.documentRevision
                || !isTransitionPhase(current.phase)
                || frame === null
                || frame.generation !== generation
                || (current.openingPageGeometry?.pageNumber ?? frame.pageNumber) !== preview.pageNumber
                || frame.sourceRevisionKey !== preview.sourceRevisionKey
                || preview.sourceRevisionKey.length === 0
                || preview.objectUrl.length === 0
                || !Number.isFinite(preview.renderedWidth)
                || preview.renderedWidth <= 0
            ) {
                return false;
            }
            options.replaceFrame(Object.freeze({
                ...frame,
                pageNumber: preview.pageNumber,
                preview: Object.freeze({...preview}),
            }));
            return true;
        },
        clear(generation: number, objectUrl: string) {
            const current = options.readSnapshot();
            const frame = current.openingPageFrame;
            if (current.generation !== generation || frame?.preview?.objectUrl !== objectUrl) {
                return false;
            }
            const {
                preview: _preview,
                ...openingPageFrame
            } = frame;
            options.replaceFrame(Object.freeze(openingPageFrame));
            return true;
        },
        hold(generation: number, sourceRevisionKey: string) {
            const current = options.readSnapshot();
            if (
                current.generation !== generation
                || !isTransitionPhase(current.phase)
                || sourceRevisionKey.length === 0
                || current.openingPageFrame?.sourceRevisionKey !== sourceRevisionKey
            ) {
                return false;
            }
            readyGate = {
                generation,
                sourceRevisionKey,
                authorized: false,
            };
            readyAuthorizationRevision.value += 1;
            return true;
        },
        authorize(generation: number, sourceRevisionKey: string) {
            if (
                readyGate?.generation !== generation
                || readyGate.sourceRevisionKey !== sourceRevisionKey
            ) {
                return false;
            }
            readyGate = {
                ...readyGate,
                authorized: true,
            };
            readyAuthorizationRevision.value += 1;
            return true;
        },
        isReadyHeld(generation: number) {
            return readyGate?.generation === generation && readyGate.authorized === false;
        },
        retire(generation: number) {
            if (readyGate?.generation === generation) reset();
        },
    };
}
