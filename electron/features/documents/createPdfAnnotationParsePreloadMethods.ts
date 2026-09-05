import type {
    IDocumentFilesInvokeMap,
    IDocumentWorkingCopyInvokeMap,
} from '@contracts/documentsPlatformFeature';
import type {IIpcInvokeSpec} from '@contracts/ipcMain';
import {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertPdfIndexChunkOptions,
    assertPdfSerializedSaveOptions,
    assertPdfSidecarChunkOffset,
} from '@electron/features/documents/preloadShared';
import {PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';

type TFeatureInvoker<TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec}> = <
    TChannel extends Extract<keyof TMap, string>,
>(
    channel: TChannel,
    ...args: TMap[TChannel]['args']
) => Promise<TMap[TChannel]['result']>;

export function createPdfAnnotationParsePreloadMethods(options: {
    invokeFiles: TFeatureInvoker<IDocumentFilesInvokeMap>;
    invokeWorkingCopy: TFeatureInvoker<IDocumentWorkingCopyInvokeMap>;
}) {
    const {
        invokeFiles,
        invokeWorkingCopy,
    } = options;
    return {
        beginPdfAnnotationParse: (path: string, parseOptions: unknown) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.beginPdfAnnotationParse,
                assertAbsolutePath(path, 'beginPdfAnnotationParse.path'),
                assertPdfSerializedSaveOptions(parseOptions, 'beginPdfAnnotationParse.options'),
            ),
        readPdfAnnotationParseChunk: (sessionId: string, offset: number, parseOptions: unknown) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readPdfAnnotationParseChunk,
                assertNonEmptyString(sessionId, 'readPdfAnnotationParseChunk.sessionId'),
                assertPdfSidecarChunkOffset(offset, 'readPdfAnnotationParseChunk.offset'),
                assertPdfIndexChunkOptions(parseOptions, 'readPdfAnnotationParseChunk.options', PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES),
            ),
        releasePdfAnnotationParse: (sessionId: string) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.releasePdfAnnotationParse,
                assertNonEmptyString(sessionId, 'releasePdfAnnotationParse.sessionId'),
            ),
        cancelPdfAnnotationParse: (sessionId: string) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.cancelPdfAnnotationParse,
                assertNonEmptyString(sessionId, 'cancelPdfAnnotationParse.sessionId'),
            ),
        parsePdfAnnotations: (path: string, parseOptions: unknown) =>
            invokeWorkingCopy(
                DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.parsePdfAnnotations,
                assertAbsolutePath(path, 'parsePdfAnnotations.path'),
                assertPdfSerializedSaveOptions(parseOptions, 'parsePdfAnnotations.options'),
            ),
    };
}
