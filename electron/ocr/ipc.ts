import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import { runOcr } from '@electron/ocr/tesseract';
import { validateOcrTools } from '@electron/ocr/paths';
import type { IOcrLanguage } from '@app/types/shared';
import { createLogger } from '@electron/utils/logger';
import {
    forEachConcurrent,
    getOcrConcurrency,
    getSequentialProgressPage,
    getTesseractThreadLimit,
} from '@electron/utils/concurrency';
import {
    handleOcrCreateSearchablePdfAsync,
    handleOcrCancel,
    safeSendToWindow,
} from '@electron/ocr/jobManager';
import {
    handlePreprocessingValidate,
    handlePreprocessPage,
} from '@electron/ocr/preprocessingHandlers';

const log = createLogger('ocr-ipc');

interface IOcrPageRequest {
    pageNumber: number;
    imageData: Uint8Array;
    languages: string[];
}

const AVAILABLE_LANGUAGES: IOcrLanguage[] = [
    {
        code: 'eng',
        name: 'English',
        script: 'latin',
    },
    {
        code: 'fra',
        name: 'French',
        script: 'latin',
    },
    {
        code: 'deu',
        name: 'German',
        script: 'latin',
    },
    {
        code: 'tur',
        name: 'Turkish',
        script: 'latin',
    },
    {
        code: 'ell',
        name: 'Greek (Modern)',
        script: 'greek',
    },
    {
        code: 'grc',
        name: 'Greek (Ancient)',
        script: 'greek',
    },
    {
        code: 'kmr',
        name: 'Kurmanji',
        script: 'latin',
    },
    {
        code: 'rus',
        name: 'Russian',
        script: 'cyrillic',
    },
    {
        code: 'heb',
        name: 'Hebrew',
        script: 'rtl',
    },
    {
        code: 'syr',
        name: 'Syriac',
        script: 'rtl',
    },
];

async function handleOcrRecognize(
    _event: IpcMainInvokeEvent,
    request: IOcrPageRequest,
) {
    const imageBuffer = Buffer.from(request.imageData);
    const result = await runOcr(imageBuffer, request.languages);

    return {
        pageNumber: request.pageNumber,
        success: result.success,
        text: result.text,
        error: result.error,
    };
}

async function handleOcrRecognizeBatch(
    event: IpcMainInvokeEvent,
    pages: IOcrPageRequest[],
    requestId: string,
) {
    const window = BrowserWindow.fromWebContents(event.sender);
    const results: Record<number, string> = {};
    const errors: string[] = [];

    const targetPages = pages.filter((p): p is IOcrPageRequest => !!p);
    const concurrency = getOcrConcurrency(targetPages.length);
    const tesseractThreads = getTesseractThreadLimit(concurrency);

    log.debug(`OCR batch: pages=${targetPages.length}, concurrency=${concurrency}, threads=${tesseractThreads}`);

    let processedCount = 0;

    safeSendToWindow(window, 'ocr:progress', {
        requestId,
        currentPage: targetPages[0]?.pageNumber ?? 0,
        processedCount,
        totalPages: targetPages.length,
    });

    await forEachConcurrent(targetPages, concurrency, async (page) => {
        const imageBuffer = Buffer.from(page.imageData);

        try {
            const result = await runOcr(imageBuffer, page.languages, {threads: tesseractThreads});

            if (result.success) {
                results[page.pageNumber] = result.text;
            } else {
                errors.push(`Page ${page.pageNumber}: ${result.error}`);
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            errors.push(`Page ${page.pageNumber}: ${errMsg}`);
        } finally {
            processedCount += 1;
            safeSendToWindow(window, 'ocr:progress', {
                requestId,
                currentPage: getSequentialProgressPage(targetPages, processedCount),
                processedCount,
                totalPages: targetPages.length,
            });
        }
    });

    return {
        results,
        errors,
    };
}

function handleOcrGetLanguages() {
    return AVAILABLE_LANGUAGES;
}

async function handleOcrValidateTools() {
    return validateOcrTools();
}

export function registerOcrHandlers() {
    ipcMain.handle('ocr:recognize', handleOcrRecognize);
    ipcMain.handle('ocr:recognizeBatch', handleOcrRecognizeBatch);
    ipcMain.handle('ocr:createSearchablePdf', handleOcrCreateSearchablePdfAsync);
    ipcMain.handle('ocr:cancel', handleOcrCancel);
    ipcMain.handle('ocr:getLanguages', handleOcrGetLanguages);
    ipcMain.handle('ocr:validateTools', handleOcrValidateTools);
    ipcMain.handle('preprocessing:validate', handlePreprocessingValidate);
    ipcMain.handle('preprocessing:preprocessPage', handlePreprocessPage);
}
