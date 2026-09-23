import { BrowserLogger } from '@app/utils/browserLogger';

interface IUsePdfViewerReloadTransitionOptions {
    emitEffectiveZoom: (value: number) => void;
    summarizeViewerStateForLog?: () => unknown;
}

export const usePdfViewerReloadTransition = (
    options: IUsePdfViewerReloadTransitionOptions,
) => {
    const isVisualReloadTransitionActive = ref(false);
    const lastTransitionToken = ref(0);
    const activeTransitionToken = ref<number | null>(null);
    const pendingEffectiveZoom = ref<number | null>(null);

    function beginVisualReloadTransition(reason: string) {
        const token = lastTransitionToken.value + 1;
        lastTransitionToken.value = token;
        activeTransitionToken.value = token;
        isVisualReloadTransitionActive.value = true;

        BrowserLogger.diagnostic('pdf-nav', `[viewer-reload-transition] begin token=${token} reason=${reason}`, {
            token,
            reason,
            viewer: options.summarizeViewerStateForLog?.() ?? null,
        });

        return token;
    }

    function endVisualReloadTransition(token: number, reason: string) {
        if (activeTransitionToken.value !== token) {
            return;
        }

        activeTransitionToken.value = null;
        isVisualReloadTransitionActive.value = false;

        const deferredEffectiveZoom = pendingEffectiveZoom.value;
        pendingEffectiveZoom.value = null;

        BrowserLogger.diagnostic('pdf-nav', `[viewer-reload-transition] end token=${token} reason=${reason}`, {
            token,
            reason,
            deferredEffectiveZoom,
            viewer: options.summarizeViewerStateForLog?.() ?? null,
        });

        if (
            typeof deferredEffectiveZoom === 'number'
            && Number.isFinite(deferredEffectiveZoom)
            && deferredEffectiveZoom > 0
        ) {
            options.emitEffectiveZoom(deferredEffectiveZoom);
        }
    }

    function emitEffectiveZoom(value: number) {
        if (isVisualReloadTransitionActive.value) {
            pendingEffectiveZoom.value = value;
            return;
        }

        options.emitEffectiveZoom(value);
    }

    function commitEffectiveZoom(value: number) {
        if (!Number.isFinite(value) || value <= 0) {
            return;
        }

        pendingEffectiveZoom.value = null;
        options.emitEffectiveZoom(value);
    }

    return {
        isVisualReloadTransitionActive,
        beginVisualReloadTransition,
        endVisualReloadTransition,
        emitEffectiveZoom,
        commitEffectiveZoom,
    };
};
