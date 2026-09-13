import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IUseDocumentOpenSurfaceLifecycleOptions {
    openSurface: IDocumentOpenSurfaceSession;
    onInitialVisualPending: () => void;
    onInitialVisualReady: () => void;
    pendingDocumentOpen: TReadableRef<boolean>;
    pendingDocumentIdentity: TReadableRef<string>;
}

/**
 * Starts document-open generations and forwards the viewer's joined ready
 * event. Presentation is derived exclusively from the shared session; this
 * composable never owns a timer, skeleton, or competing visibility flag.
 */
export const useDocumentOpenSurfaceLifecycle = (options: IUseDocumentOpenSurfaceLifecycleOptions) => {
    let intentGeneration = 0;

    watch(
        () => options.pendingDocumentOpen.value,
        (pending, wasPending) => {
            const snapshot = options.openSurface.snapshot.value;
            if (!pending) {
                return;
            }

            if (
                !wasPending
                && (
                    snapshot.phase === 'idle'
                    || snapshot.phase === 'ready'
                    || snapshot.phase === 'failed'
                )
            ) {
                intentGeneration += 1;
                options.openSurface.begin({
                    documentId: options.pendingDocumentIdentity.value,
                    documentRevision: `open-intent:${String(intentGeneration)}`,
                });
            }
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );

    return {
        handleDocumentInitialVisualPending: options.onInitialVisualPending,
        handleDocumentInitialVisualReady: () => {
            // A viewer's generic ready event is not the visual ownership
            // boundary. Only the renderer that joined canvas and viewport
            // commits may terminalize the shared open-surface generation.
            options.onInitialVisualReady();
        },
    };
};
