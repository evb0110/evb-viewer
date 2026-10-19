import type {
    IOcrDiagnostic,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import type {IPdfOcrPageTextVisibility} from '@contracts/pdfOcrTextVisibility';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    classifyOcrPageText,
    shouldOcrClassifiedPage,
} from '@ocr-core/pageTextClassifier';

/** Stands for a page whose text could not be extracted; it is never read as a page without text. */
export const OCR_TEXT_PROBE_UNAVAILABLE = '[text-probe-unavailable]';

interface IOcrSelectablePage {
    pageNumber: number;
    languages: readonly string[];
}

/**
 * Which requested pages OCR recognizes, given what each already shows: the
 * writer's visibility report and the page's extracted text (absent, or
 * `OCR_TEXT_PROBE_UNAVAILABLE`, when extraction failed). A page whose text the
 * writer cannot replace safely is skipped rather than failing the run after
 * recognition.
 */
export function selectOcrPagesByExistingText<TPage extends IOcrSelectablePage>(input: {
    pages: readonly TPage[];
    supersessionPolicy: TOcrTextSupersessionPolicy;
    visibility: ReadonlyMap<number, IPdfOcrPageTextVisibility>;
    texts: ReadonlyMap<number, string>;
    log?: (level: 'debug' | 'warn', message: string) => void;
}) {
    const pages: TPage[] = [];
    const warnings: string[] = [];
    const diagnostics: IOcrDiagnostic[] = [];
    // The writer refuses a page whose text it cannot replace safely, and that
    // refusal would fail the whole run after recognition; skip the page instead.
    const skipUnsupportedPage = (pageNumber: number, reason: string) => {
        const message = `Skipped page ${pageNumber}: its existing text cannot be replaced safely (${reason})`;
        warnings.push(message);
        diagnostics.push({
            code: 'OCR_EXISTING_TEXT_SKIPPED',
            severity: 'warning',
            pageNumber: requirePageNumber(pageNumber),
            message,
        });
    };

    for (const page of input.pages) {
        const pageVisibility = input.visibility.get(page.pageNumber);
        const unsupported = pageVisibility?.unsupported ?? null;
        const extractedText = input.texts.get(page.pageNumber) ?? OCR_TEXT_PROBE_UNAVAILABLE;
        if (extractedText === OCR_TEXT_PROBE_UNAVAILABLE) {
            const canReplaceWithoutTextProbe = input.supersessionPolicy === 'replace-all'
                || input.supersessionPolicy === 'replace-evb' && pageVisibility?.evbOcrLayer === true;
            if (canReplaceWithoutTextProbe && unsupported !== null) {
                skipUnsupportedPage(page.pageNumber, unsupported);
                continue;
            }
            if (canReplaceWithoutTextProbe) {
                const message = `Scheduled page ${page.pageNumber}: existing-text probe was unavailable under ${input.supersessionPolicy} policy`;
                input.log?.('warn', message);
                warnings.push(message);
                pages.push(page);
                continue;
            }
            const message = `Skipped page ${page.pageNumber}: existing-text probe was unavailable under ${input.supersessionPolicy} policy`;
            warnings.push(message);
            diagnostics.push({
                code: 'OCR_EXISTING_TEXT_SKIPPED',
                severity: 'warning',
                pageNumber: requirePageNumber(page.pageNumber),
                message,
            });
            continue;
        }
        const classification = classifyOcrPageText({
            extractedText,
            ...(pageVisibility === undefined ? {} : {visibility: pageVisibility}),
            languages: [...page.languages],
        });
        if (shouldOcrClassifiedPage(classification, input.supersessionPolicy)) {
            if (unsupported !== null) {
                skipUnsupportedPage(page.pageNumber, unsupported);
                continue;
            }
            pages.push(page);
            continue;
        }
        // Keeping a page's own text is what the policy asked for, so it is
        // information about the run, not a warning that it fell short.
        const message = `Skipped page ${page.pageNumber}: classified ${classification} under ${input.supersessionPolicy} policy`;
        input.log?.('debug', message);
        diagnostics.push({
            code: 'OCR_EXISTING_TEXT_SKIPPED',
            severity: 'info',
            pageNumber: requirePageNumber(page.pageNumber),
            message,
        });
    }
    return {
        pages,
        warnings,
        diagnostics,
    };
}
