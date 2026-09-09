import { existsSync } from 'fs';
import { join } from 'path';
import { uniq } from 'es-toolkit/array';
import type { IOcrPreparingJob } from '@electron/features/ocr/main/jobManager.types';
import {
    ensureRuntimeTessdataSeeded,
    ensureTessdataLanguages,
} from '@electron/features/ocr/languageModels';
import { getOcrToolPaths } from '@electron/features/ocr/main/paths';
import type { TOcrPdfPageSelection } from '@electron/ocr/worker/types';
import { createTimeoutError } from '@electron/features/ocr/main/jobManagerProtocol';
import { createLogger } from '@electron/utils/createLogger';

const log = createLogger('ocr-ipc');

function getOcrJobLanguages(pages: TOcrPdfPageSelection) {
    if (!Array.isArray(pages) && pages.kind !== 'pages') {
        return uniq(pages.languages);
    }
    const pageRequests = Array.isArray(pages) ? pages : pages.pages;
    return uniq(pageRequests.flatMap(page => page.languages));
}

function logMissingLanguageModels(languages: string[]) {
    const tessdataDir = getOcrToolPaths().tessdata;
    const missingLanguages = languages.filter(languageCode =>
        !existsSync(join(tessdataDir, `${languageCode}.traineddata`)),
    );
    if (missingLanguages.length > 0) {
        log.warn(`Missing OCR language models in ${tessdataDir}; downloading: ${missingLanguages.join(', ')}`);
    }
}

export async function prepareLanguageModelsForJob(
    preparingJob: IOcrPreparingJob,
    pages: TOcrPdfPageSelection,
    timeoutMs: number,
) {
    const languages = getOcrJobLanguages(pages);
    const timeoutController = new AbortController();
    const modelPrepTimeout = setTimeout(() => {
        timeoutController.abort(
            createTimeoutError(`OCR model preparation timed out after ${timeoutMs}ms`),
        );
    }, timeoutMs);
    modelPrepTimeout.unref();
    const signal = AbortSignal.any([
        preparingJob.registry.signal,
        timeoutController.signal,
    ]);
    try {
        await ensureRuntimeTessdataSeeded({ signal });
        logMissingLanguageModels(languages);
        await ensureTessdataLanguages(languages, { signal });
    } finally {
        clearTimeout(modelPrepTimeout);
    }
}
