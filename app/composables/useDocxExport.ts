import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { createDocxFromTextAsync } from '@app/utils/docx';
import { createDocxFromTextChunks } from '@app/utils/docxStreaming';
import { useOcrErrorLocalizer } from '@app/composables/useOcrErrorLocalizer';
import { useAnalytics } from '@app/composables/useAnalytics';
import { hasRtlOcrLanguage } from '@app/utils/ocr/hasRtlOcrLanguage';
import { exportTextAsDocx } from '@app/utils/exportTextAsDocx';

export const useDocxExport = () => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const toast = useToast();
    const { localizeOcrError } = useOcrErrorLocalizer();

    const isExportingDocx = ref(false);
    const docxExportError = ref<string | null>(null);
    let activeAbortController: AbortController | null = null;

    function cancelDocxExport() {
        activeAbortController?.abort(new DOMException('DOCX export was canceled.', 'AbortError'));
    }

    async function exportDocx(params: {
        workingCopyPath: TDocumentRef | null;
        documentRevisionToken: TDocumentRevisionToken | null;
        pdfDocument: IPdfDocument | null;
        selectedLanguages?: string[];
    }) {
        if (isExportingDocx.value) {
            return false;
        }

        const selectedLanguages = params.selectedLanguages ?? [];
        isExportingDocx.value = true;
        docxExportError.value = null;
        const abortController = new AbortController();
        activeAbortController = abortController;

        try {
            const hasRtl = hasRtlOcrLanguage(selectedLanguages);
            return await exportTextAsDocx({
                workingCopyPath: params.workingCopyPath,
                documentRevisionToken: params.documentRevisionToken,
                pdfDocument: params.pdfDocument,
                signal: abortController.signal,
                hasRtl,
                buildDocx: createDocxFromTextAsync,
                buildDocxChunks: createDocxFromTextChunks,
                t,
                toast,
                setError: message => {
                    docxExportError.value = message;
                },
                localizeError: error => localizeOcrError(error, 'errors.ocr.exportDocx'),
                onSuccess: () => {
                    analytics.track('export_completed', {
                        format: 'docx',
                        hasRtl,
                        selectedLanguageCount: selectedLanguages.length,
                        status: 'success',
                    });
                },
            });
        } finally {
            if (activeAbortController === abortController) {
                activeAbortController = null;
                isExportingDocx.value = false;
            }
        }
    }

    function clearDocxExportError() {
        docxExportError.value = null;
    }

    if (getCurrentScope()) {
        onScopeDispose(() => {
            activeAbortController?.abort(new DOMException('DOCX export was canceled.', 'AbortError'));
        });
    }

    return {
        isExportingDocx,
        docxExportError,
        exportDocx,
        cancelDocxExport,
        clearDocxExportError,
    };
};
