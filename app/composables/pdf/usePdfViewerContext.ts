import {
    provide,
    inject,
    type InjectionKey,
    type ComputedRef,
} from 'vue';
import type { IContentInsets } from 'app/types/pdf';

interface IPdfViewerContext {
    scaledSkeletonPadding: ComputedRef<IContentInsets | null>;
    scaledPageHeight: ComputedRef<number | null>;
}

const PDF_VIEWER_CONTEXT_KEY: InjectionKey<IPdfViewerContext> = Symbol('PdfViewerContext');

export const providePdfViewerContext = (context: IPdfViewerContext) => {
    provide(PDF_VIEWER_CONTEXT_KEY, context);
};

export const usePdfViewerContext = () => {
    const context = inject<IPdfViewerContext>(PDF_VIEWER_CONTEXT_KEY);
    if (!context) {
        throw new Error('usePdfViewerContext must be used within a PdfViewer');
    }
    return context;
};
