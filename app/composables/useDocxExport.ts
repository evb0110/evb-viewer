import { ref } from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getElectronAPI } from '@app/utils/electron';
import { createDocxFromText } from '@app/utils/docx';
import {
    loadOcrText,
    extractPdfText,
} from '@app/composables/ocrProcessing';
import { createOcrErrorLocalizer } from '@app/composables/ocrErrorLocalization';

const RTL_OCR_LANGUAGES = new Set([
    'heb',
    'syr',
]);

export const useDocxExport = () => {
    const { t } = useTypedI18n();
    const { localizeOcrError } = createOcrErrorLocalizer(t);

    const isExportingDocx = ref(false);
    const docxExportError = ref<string | null>(null);

    async function exportDocx(params: {
        workingCopyPath: string | null;
        pdfDocument: PDFDocumentProxy | null;
        selectedLanguages?: string[];
    }): Promise<boolean> {
        if (isExportingDocx.value) {
            return false;
        }

        const workingPath = params.workingCopyPath ?? '';
        const selectedLanguages = params.selectedLanguages ?? [];
        isExportingDocx.value = true;
        docxExportError.value = null;

        try {
            let text = params.workingCopyPath ? await loadOcrText(params.workingCopyPath) : null;
            if (!text && params.pdfDocument) {
                text = await extractPdfText(params.pdfDocument);
            }
            if (!text) {
                docxExportError.value = t('errors.ocr.noText');
                return false;
            }

            const outPath = await getElectronAPI().saveDocxAs(workingPath);
            if (!outPath) {
                return false;
            }

            const hasRtl = selectedLanguages.some(lang => RTL_OCR_LANGUAGES.has(lang));
            const docxBytes = createDocxFromText(text, hasRtl);
            await getElectronAPI().writeDocxFile(outPath, docxBytes);
            return true;
        } catch (error) {
            docxExportError.value = localizeOcrError(error, 'errors.ocr.exportDocx');
            return false;
        } finally {
            isExportingDocx.value = false;
        }
    }

    function clearDocxExportError() {
        docxExportError.value = null;
    }

    return {
        isExportingDocx,
        docxExportError,
        exportDocx,
        clearDocxExportError,
    };
};
