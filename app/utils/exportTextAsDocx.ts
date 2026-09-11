import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TTranslateFn } from '@i18n-app';
import type {
    IDocxExportFileCapability,
    IDocxExportStreamBeginResult,
} from '@contracts/docxExport';
import type { TSessionId } from '@contracts/shared';
import {
    resolveDocxParagraphDirection,
    type TDocxParagraphDirection,
    type TDocxTextPageSource,
} from '@app/utils/docxStreaming';
import {hasRtlOcrLanguage} from '@app/utils/ocr/hasRtlOcrLanguage';
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
    direction: TDocxParagraphDirection,
    signal?: AbortSignal,
) => Uint8Array | Promise<Uint8Array>;
type TDocxChunkBuilder = (
    pages: TDocxTextPageSource,
    direction: TDocxParagraphDirection,
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
    catalogPages: ReadonlyArray<{text: string}> | null,
): Generator<string> {
    for (const page of catalogPages ?? []) {
        const pageText = page.text.trim();
        if (pageText) {
            yield pageText;
        }
    }
}

function hasNonEmptyPage(catalogPages: ReadonlyArray<{text: string}> | null) {
    return (catalogPages ?? []).some(page => page.text.trim().length > 0);
}

function hasSerialDocxStream<T extends object>(files: T): files is T & IDocxExportFileCapability {
    return [
        'beginDocxFileStream',
        'writeDocxFileStreamChunk',
        'commitDocxFileStream',
        'cancelDocxFileStream',
    ].every(name => typeof Reflect.get(files, name) === 'function');
}

async function writeDocxChunksThroughSerialTransport(
    stream: Pick<IDocxExportFileCapability, 'beginDocxFileStream' | 'writeDocxFileStreamChunk' | 'commitDocxFileStream' | 'cancelDocxFileStream'>,
    outPath: TDocumentRef,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
) {
    let sessionId: TSessionId | undefined;
    let cancelPromise: Promise<boolean> | undefined;
    let beginPromise: Promise<IDocxExportStreamBeginResult> | undefined;
    let committed = false;
    const cancelSession = () => {
        if (!sessionId) {
            return Promise.resolve(false);
        }
        return cancelPromise ??= stream.cancelDocxFileStream(sessionId).catch(() => false);
    };
    const handleAbort = () => {
        if (beginPromise) void beginPromise.then(() => cancelSession(), () => undefined);
        else void cancelSession();
    };
    throwIfAborted(signal);
    signal?.addEventListener('abort', handleAbort, {once: true});
    try {
        beginPromise = stream.beginDocxFileStream(outPath);
        const beginResult = await beginPromise;
        if (!beginResult || typeof beginResult.sessionId !== 'string' || beginResult.sessionId.trim().length === 0) {
            throw new Error('Invalid DOCX stream begin response');
        }
        sessionId = beginResult.sessionId;
        throwIfAborted(signal);
        let wroteChunk = false;
        for await (const chunk of chunks) {
            throwIfAborted(signal);
            if (await stream.writeDocxFileStreamChunk(sessionId, chunk) !== true) {
                throw new Error('DOCX stream chunk was not accepted');
            }
            wroteChunk = true;
            throwIfAborted(signal);
        }
        throwIfAborted(signal);
        if (!wroteChunk) throw new Error('DOCX stream requires at least one chunk');
        if (await stream.commitDocxFileStream(sessionId) !== true) {
            throw new Error('DOCX stream commit was not accepted');
        }
        committed = true;
        return true;
    } catch (error) {
        if (!committed) await cancelSession();
        throw error;
    } finally {
        signal?.removeEventListener('abort', handleAbort);
    }
}

export async function exportTextAsDocx(params: {
    workingCopyPath: TDocumentRef | null;
    documentRevisionToken: TDocumentRevisionToken | null;
    pdfDocument: IPdfDocument | null;
    hasRtl?: boolean;
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
        let documentHasRtlLanguage = params.hasRtl ?? false;
        const direction: TDocxParagraphDirection = text => resolveDocxParagraphDirection(text, documentHasRtlLanguage);
        throwIfAborted(params.signal);
        const documentFiles = getDocumentFilesCapability();
        const documentWorkingCopy = getDocumentWorkingCopyCapability();
        if (!params.workingCopyPath) {
            return false;
        }
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
            const docxStream = !isBrowserOutput && hasSerialDocxStream(documentFiles)
                ? documentFiles
                : undefined;
            const canUseSerialDocxStream = docxStream !== undefined;
            if (
                !isBrowserOutput
                && params.workingCopyPath
                && params.documentRevisionToken
                && knownPageCount !== undefined
                && params.buildDocxChunks
                && canUseSerialDocxStream
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
                    ? await params.buildDocxChunks(textPages, direction)
                    : await params.buildDocxChunks(textPages, direction, params.signal);
                await writeDocxChunksThroughSerialTransport(docxStream, outPath, docxChunks, params.signal);
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
                documentHasRtlLanguage ||= hasRtlOcrLanguage(
                    (catalogPages ?? []).flatMap(page => page.languages ?? []),
                );

                if (!isBrowserOutput) {
                    if (!params.buildDocxChunks || !canUseSerialDocxStream) {
                        throw new Error('DOCX streaming output is unavailable on this desktop platform');
                    }
                    const docxChunks = params.signal === undefined
                        ? await params.buildDocxChunks(getNonEmptyPageTexts(catalogPages), direction)
                        : await params.buildDocxChunks(getNonEmptyPageTexts(catalogPages), direction, params.signal);
                    await writeDocxChunksThroughSerialTransport(docxStream, outPath, docxChunks, params.signal);
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
                        ? await params.buildDocx(text, direction)
                        : await params.buildDocx(text, direction, params.signal);
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
