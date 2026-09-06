import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TTranslateFn } from '@i18n-app';
import type { IDocxExportFileCapability } from '@contracts/docxExport';
import type { TDocxTextPageSource } from '@app/utils/docxStreaming';
import {
    getDocumentRefBaseName,
    isBrowserDocumentRef,
} from '@app/utils/documentRef';
import {
    loadDocumentTextCatalogPages,
    prepareDocumentTextCatalogTextPages,
} from '@app/utils/ocr/loadOcrText';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';

type TDocxBuilder = (
    text: string,
    hasRtl: boolean,
    signal?: AbortSignal,
) => Uint8Array | Promise<Uint8Array>;
type TDocxChunkBuilder = (
    pages: TDocxTextPageSource,
    hasRtl: boolean,
    signal?: AbortSignal,
) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;

const BROWSER_DOCX_MAX_TEXT_CHARACTERS = 3 * 1024 * 1024;
const BROWSER_DOCX_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function throwIfAborted(signal?: AbortSignal) {
    signal?.throwIfAborted();
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

function* getNonEmptyPageTexts(
    catalogPages: Array<{text: string}> | null,
): Generator<string> {
    for (const page of catalogPages ?? []) {
        const pageText = page.text.trim();
        if (pageText) {
            yield pageText;
        }
    }
}

function hasNonEmptyPage(catalogPages: Array<{text: string}> | null) {
    return (catalogPages ?? []).some(page => page.text.trim().length > 0);
}

export async function exportTextAsDocx(params: {
    workingCopyPath: TDocumentRef | null;
    documentRevisionToken: TDocumentRevisionToken | null;
    pdfDocument: IPdfDocument | null;
    hasRtl: boolean;
    buildDocx: TDocxBuilder;
    buildDocxChunks?: TDocxChunkBuilder;
    signal?: AbortSignal;
    t: TTranslateFn;
    toast: ReturnType<typeof useToast>;
    setError: (message: string) => void;
    localizeError: (error: unknown) => string;
    onSuccess?: () => void;
}) {
    try {
        throwIfAborted(params.signal);
        const documentFiles = getDocumentFilesCapability();
        const documentWorkingCopy = getDocumentWorkingCopyCapability();
        const workingPath = params.workingCopyPath ?? '';
        const outPath = await documentFiles.saveDocxAs(workingPath);
        if (!outPath) {
            return false;
        }

        try {
            throwIfAborted(params.signal);
            const isBrowserOutput = isBrowserDocumentRef(outPath);
            const pageCount = params.pdfDocument?.numPages;
            const knownPageCount = typeof pageCount === 'number'
                && Number.isSafeInteger(pageCount)
                && pageCount > 0
                ? pageCount
                : undefined;
            const writeDocxFileChunks = !isBrowserOutput
                ? (documentFiles as typeof documentFiles & Partial<IDocxExportFileCapability>)
                    .writeDocxFileChunks
                : undefined;
            if (
                !isBrowserOutput
                && params.workingCopyPath
                && params.documentRevisionToken
                && knownPageCount !== undefined
                && params.buildDocxChunks
                && writeDocxFileChunks
            ) {
                const textPages = params.signal === undefined
                    ? await prepareDocumentTextCatalogTextPages(
                        params.workingCopyPath,
                        params.documentRevisionToken,
                        knownPageCount,
                    )
                    : await prepareDocumentTextCatalogTextPages(
                        params.workingCopyPath,
                        params.documentRevisionToken,
                        knownPageCount,
                        params.signal,
                    );
                if (!textPages) {
                    throwIfAborted(params.signal);
                    params.setError(params.t('errors.ocr.noText'));
                    return false;
                }
                const docxChunks = params.signal === undefined
                    ? await params.buildDocxChunks(textPages, params.hasRtl)
                    : await params.buildDocxChunks(textPages, params.hasRtl, params.signal);
                if (params.signal === undefined) {
                    await writeDocxFileChunks(outPath, docxChunks);
                } else {
                    await writeDocxFileChunks(outPath, docxChunks, params.signal);
                }
                throwIfAborted(params.signal);
            } else {
                const catalogPages = params.workingCopyPath && params.documentRevisionToken
                    ? params.signal === undefined
                        ? await loadDocumentTextCatalogPages(
                            params.workingCopyPath,
                            params.documentRevisionToken,
                            knownPageCount,
                        )
                        : await loadDocumentTextCatalogPages(
                            params.workingCopyPath,
                            params.documentRevisionToken,
                            knownPageCount,
                            params.signal,
                        )
                    : null;
                if (!hasNonEmptyPage(catalogPages)) {
                    throwIfAborted(params.signal);
                    params.setError(params.t('errors.ocr.noText'));
                    return false;
                }

                if (!isBrowserOutput) {
                    if (!params.buildDocxChunks || !writeDocxFileChunks) {
                        throw new Error('DOCX streaming output is unavailable on this desktop platform');
                    }
                    const docxChunks = params.signal === undefined
                        ? await params.buildDocxChunks(getNonEmptyPageTexts(catalogPages), params.hasRtl)
                        : await params.buildDocxChunks(getNonEmptyPageTexts(catalogPages), params.hasRtl, params.signal);
                    if (params.signal === undefined) {
                        await writeDocxFileChunks(outPath, docxChunks);
                    } else {
                        await writeDocxFileChunks(outPath, docxChunks, params.signal);
                    }
                    throwIfAborted(params.signal);
                } else {
                    let catalogTextLength = 0;
                    const catalogTextParts: string[] = [];
                    for (const page of catalogPages ?? []) {
                        throwIfAborted(params.signal);
                        const pageText = page.text.trim();
                        if (!pageText) continue;
                        catalogTextLength += pageText.length + (catalogTextParts.length > 0 ? 2 : 0);
                        if (catalogTextLength > BROWSER_DOCX_MAX_TEXT_CHARACTERS) {
                            throw new RangeError('Browser DOCX export text exceeds its bounded Blob budget');
                        }
                        catalogTextParts.push(pageText);
                    }
                    const text = catalogTextParts.join('\n\n');
                    const docxBytes = params.signal === undefined
                        ? await params.buildDocx(text, params.hasRtl)
                        : await params.buildDocx(text, params.hasRtl, params.signal);
                    throwIfAborted(params.signal);
                    if (docxBytes.byteLength > BROWSER_DOCX_MAX_OUTPUT_BYTES) {
                        throw new RangeError('Browser DOCX export exceeds its bounded Blob size');
                    }
                    if (params.signal === undefined) {
                        await documentFiles.writeDocxFile(outPath, docxBytes);
                    } else {
                        await documentFiles.writeDocxFile(outPath, docxBytes, params.signal);
                    }
                    throwIfAborted(params.signal);
                }
            }
            params.onSuccess?.();
            params.toast.add({
                color: 'success',
                title: params.t('notifications.docxSavedTitle'),
                description: params.t('notifications.docxSavedDescription', {name: getDocumentRefBaseName(outPath) ?? outPath}),
            });
            return true;
        } finally {
            if (isBrowserDocumentRef(outPath)) {
                await documentWorkingCopy.cleanupFile(outPath).catch(() => {});
            }
        }
    } catch (error) {
        if (params.signal?.aborted || isAbortError(error)) {
            return false;
        }
        params.setError(params.localizeError(error));
        return false;
    }
}
