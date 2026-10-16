import type {
    IDocumentsMenuCapability,
    IOpenPdfDirectBatchProgress,
} from '@contracts/electronApiDocuments';
import type { DOCUMENT_MENU_PLATFORM_FEATURE } from '@contracts/documentsPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

const openDocumentDirectBatchProgressListeners =
    new Set<(progress: IOpenPdfDirectBatchProgress) => void>();

export function emitBrowserOpenDocumentDirectBatchProgress(
    progress: IOpenPdfDirectBatchProgress,
) {
    openDocumentDirectBatchProgressListeners.forEach((listener) => {
        listener(progress);
    });
}

export const onBrowserOpenDocumentDirectBatchProgress = (
    callback: (progress: IOpenPdfDirectBatchProgress) => void,
) => {
    openDocumentDirectBatchProgressListeners.add(callback);
    return () => {
        openDocumentDirectBatchProgressListeners.delete(callback);
    };
};

export const browserDocumentsMenuCapability = {
    setMenuDocumentState: async (_hasDocument) => {},
    setMenuTabCount: async (_tabCount) => {},
    onPdfOptimizeProgress: noopUnsubscribe,
    onMenuOpenPdf: noopUnsubscribe,
    onMenuInsertImageFromFile: noopUnsubscribe,
    onMenuPasteImageFromClipboard: noopUnsubscribe,
    onMenuSave: noopUnsubscribe,
    onMenuRepairSave: noopUnsubscribe,
    onMenuOptimizePdfForInteraction: noopUnsubscribe,
    onMenuSaveAs: noopUnsubscribe,
    onMenuPrint: noopUnsubscribe,
    onMenuPrintCurrentPage: noopUnsubscribe,
    onMenuExportDocx: noopUnsubscribe,
    onMenuExportImages: noopUnsubscribe,
    onMenuExportMultiPageTiff: noopUnsubscribe,
    onMenuZoomIn: noopUnsubscribe,
    onMenuZoomOut: noopUnsubscribe,
    onMenuActualSize: noopUnsubscribe,
    onMenuFitWidth: noopUnsubscribe,
    onMenuFitHeight: noopUnsubscribe,
    onMenuToggleContinuousScroll: noopUnsubscribe,
    onMenuViewModeSingle: noopUnsubscribe,
    onMenuViewModeFacing: noopUnsubscribe,
    onMenuViewModeFacingFirstSingle: noopUnsubscribe,
    onMenuViewRotationCw: noopUnsubscribe,
    onMenuViewRotationCcw: noopUnsubscribe,
    onMenuToggleAssistant: noopUnsubscribe,
    onMenuUndo: noopUnsubscribe,
    onMenuRedo: noopUnsubscribe,
    onMenuDeletePages: noopUnsubscribe,
    onMenuExtractPages: noopUnsubscribe,
    onMenuRotateCw: noopUnsubscribe,
    onMenuRotateCcw: noopUnsubscribe,
    onMenuInsertPages: noopUnsubscribe,
    onMenuOpenRecentFile: noopUnsubscribe,
    onMenuOpenExternalPaths: noopUnsubscribe,
    onMenuClearRecentFiles: noopUnsubscribe,
} satisfies IDocumentsMenuCapability
    & TFeatureBrowserBindings<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;
