import type {
    IDocumentsMenuCapability,
    IOpenPdfDirectBatchProgress,
} from '@contracts/electronApiDocuments';
import type { DOCUMENT_MENU_PLATFORM_FEATURE } from '@contracts/documentsPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';
import {
    setBrowserMenuDocumentState,
    subscribeBrowserMenuEvent,
} from '@app/platform/browserMenuBar';

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

// The page's application menu (ToolbarAppMenu) dispatches desktop's menu events.
export const browserDocumentsMenuCapability = {
    setMenuDocumentState: (state) => {
        setBrowserMenuDocumentState(state);
        return Promise.resolve(undefined);
    },
    setMenuTabCount: async (_tabCount) => {},
    onPdfOptimizeProgress: noopUnsubscribe,
    onMenuOpenPdf: subscribeBrowserMenuEvent('onMenuOpenPdf'),
    onMenuInsertImageFromFile: subscribeBrowserMenuEvent('onMenuInsertImageFromFile'),
    onMenuPasteImageFromClipboard: subscribeBrowserMenuEvent('onMenuPasteImageFromClipboard'),
    onMenuSave: subscribeBrowserMenuEvent('onMenuSave'),
    onMenuRepairSave: subscribeBrowserMenuEvent('onMenuRepairSave'),
    onMenuOptimizePdfForInteraction: subscribeBrowserMenuEvent('onMenuOptimizePdfForInteraction'),
    onMenuSaveAs: subscribeBrowserMenuEvent('onMenuSaveAs'),
    onMenuPrint: subscribeBrowserMenuEvent('onMenuPrint'),
    onMenuPrintCurrentPage: subscribeBrowserMenuEvent('onMenuPrintCurrentPage'),
    onMenuExportDocx: subscribeBrowserMenuEvent('onMenuExportDocx'),
    onMenuExportImages: subscribeBrowserMenuEvent('onMenuExportImages'),
    onMenuExportMultiPageTiff: subscribeBrowserMenuEvent('onMenuExportMultiPageTiff'),
    onMenuZoomIn: subscribeBrowserMenuEvent('onMenuZoomIn'),
    onMenuZoomOut: subscribeBrowserMenuEvent('onMenuZoomOut'),
    onMenuActualSize: subscribeBrowserMenuEvent('onMenuActualSize'),
    onMenuFitWidth: subscribeBrowserMenuEvent('onMenuFitWidth'),
    onMenuFitHeight: subscribeBrowserMenuEvent('onMenuFitHeight'),
    onMenuToggleContinuousScroll: subscribeBrowserMenuEvent('onMenuToggleContinuousScroll'),
    onMenuViewModeSingle: subscribeBrowserMenuEvent('onMenuViewModeSingle'),
    onMenuViewModeFacing: subscribeBrowserMenuEvent('onMenuViewModeFacing'),
    onMenuViewModeFacingFirstSingle: subscribeBrowserMenuEvent('onMenuViewModeFacingFirstSingle'),
    onMenuViewRotationCw: subscribeBrowserMenuEvent('onMenuViewRotationCw'),
    onMenuViewRotationCcw: subscribeBrowserMenuEvent('onMenuViewRotationCcw'),
    onMenuToggleAssistant: subscribeBrowserMenuEvent('onMenuToggleAssistant'),
    onMenuUndo: subscribeBrowserMenuEvent('onMenuUndo'),
    onMenuRedo: subscribeBrowserMenuEvent('onMenuRedo'),
    onMenuDeletePages: subscribeBrowserMenuEvent('onMenuDeletePages'),
    onMenuExtractPages: subscribeBrowserMenuEvent('onMenuExtractPages'),
    onMenuRotateCw: subscribeBrowserMenuEvent('onMenuRotateCw'),
    onMenuRotateCcw: subscribeBrowserMenuEvent('onMenuRotateCcw'),
    onMenuInsertPages: subscribeBrowserMenuEvent('onMenuInsertPages'),
    onMenuOpenRecentFile: subscribeBrowserMenuEvent('onMenuOpenRecentFile'),
    onMenuOpenExternalPaths: subscribeBrowserMenuEvent('onMenuOpenExternalPaths'),
    onMenuClearRecentFiles: subscribeBrowserMenuEvent('onMenuClearRecentFiles'),
} satisfies IDocumentsMenuCapability
    & TFeatureBrowserBindings<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;
