import type {
    IDocumentMutationRevisionOptions,
    IDocumentsFileCapability,
    IPdfNativeMutationSet,
    IPdfNativeSaveResult,
} from '@contracts/electronApiDocuments';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { IRecentFile } from '@contracts/shared';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
    getBrowserDocumentFileName,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import { syncBrowserWindowTitle } from '@app/platform/browserWindowTabs';
import {
    OPEN_IMAGE_ACCEPT,
    OPEN_INPUT_ACCEPT,
    buildDocxSaveTypes,
    buildImagePickerTypes,
    buildOpenPdfPickerTypes,
    buildPdfSaveTypes,
} from '@app/platform/browser-api/browserFileAccepts';
import {
    ensureDocxExtension,
    ensurePdfExtension,
} from '@app/platform/browser-api/browserFileName';
import type { IBrowserBatchOpenProgressOptions } from '@app/platform/browser-api/createCombinedPdfFromPaths';
import {
    analyzeBrowserPdfConformance,
    validateBrowserPdfData,
    validateBrowserPdfPath,
} from '@app/platform/browser-api/browserPdfValidation';
import {
    BrowserFileWriteOutcomeError,
    isFileSystemAccessDeniedError,
    pickFiles,
    pickSaveTarget,
    pickSingleFile,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
    writeDocumentRefToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {
    assertBrowserWorkingCopyDecrypted,
    createBrowserWorkingCopyFromBytes,
    decryptBrowserWorkingCopy,
    openDocumentPaths,
} from '@app/platform/browser-api/browserWorkingCopyService';
import {
    assertBrowserPathWithinFullReadBudget,
    BrowserExternalSaveSyncRequiredError,
    saveWorkingBytesToSource,
    saveWorkingBytesToSourceStructured,
} from '@app/platform/browser-api/browserSaveTargets';
import { createPlatformUnsupportedResult } from '@contracts/platformUnsupported';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {
    isBrowserPageOpsWasmFailure,
    tryRunBrowserPageOpsWithWasm,
} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import { decodeBrowserPdfAnnotationsOutput } from '@app/platform/browser-api/decodeBrowserPdfAnnotationsOutput';
import { writeRecentFilesToStorage } from '@app/platform/browser/browserRecentFilesStore';
import {
    commitBrowserStoreStagedArtifact,
    createBrowserStoreStagedArtifact,
} from '@app/platform/browser/browserStagedArtifact';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {nativePdfSemanticScope} from '@contracts/nativePdfSemanticScope';

const BROWSER_DEFAULT_PDF_APP_UNSUPPORTED = 'Opening via the default desktop PDF app is unavailable in the browser capability';
const BROWSER_NATIVE_PRINT_UNSUPPORTED = 'Printing via the native desktop dialog is unavailable in the browser capability';

export async function createBrowserCombinedPdfFromPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    const module = await import('@app/platform/browser-api/createCombinedPdfFromPaths');
    return module.createCombinedPdfFromPaths(paths, progressOptions);
}

interface ICreateBrowserDocumentsFileCapabilityOptions {
    clearSearchCaches: (pdfPath?: string) => void | Promise<void>;
    errorMessageProvider?: {
        largeSaveHandleHint: () => string;
        useNativeApp?: () => string;
    };
}
type TCanonicalDocumentsFileCapability = IDocumentsFileCapability;

async function sha256Hex(bytes: Uint8Array) {
    const ownedBytes = new Uint8Array(bytes.byteLength);
    ownedBytes.set(bytes);
    const digest = new Uint8Array(await crypto.subtle.digest(
        'SHA-256',
        ownedBytes,
    ));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function createCanceledSaveValidationResult(validation: IPdfValidationResult): IPdfValidationResult {
    return {
        ...validation,
        isValid: false,
        errors: [],
    };
}

export function createBrowserDocumentsFileCapability(
    options: ICreateBrowserDocumentsFileCapabilityOptions,
): IDocumentsFileCapability {
    const { clearSearchCaches } = options;
    const browserNativeMutationBindings = new Map<string, IPdfNativeSaveResult['identityBindings']>();
    const browserUseNativeAppMessageProvider = options.errorMessageProvider?.useNativeApp
        ?? (() => 'Use the native app for files this large.');

    async function cleanupTransientOpenRefs(paths: string[]) {
        await Promise.all(paths.map(async (path) => {
            try {
                await browserDocumentStore.remove(path);
            } catch {
                // Cleanup is best effort for failed transient opens.
            }
        }));
    }

    async function savePdfAsWithOptionalData(
        workingCopyPath: string,
        data?: Uint8Array,
        revisionOptions?: IDocumentMutationRevisionOptions,
        commitCallbacks?: Parameters<IDocumentsFileCapability['savePdfDataAs']>[4],
    ) {
        await browserDocumentStore.assertDocumentRevisionCurrent(
            workingCopyPath,
            revisionOptions?.expectedDocumentRevisionToken,
        );
        const saveTarget =
            await browserDocumentStore.getSaveTarget(workingCopyPath);
        const previousSourceRef =
            await browserDocumentStore.getSourceRef(workingCopyPath);
        const suggestedName = ensurePdfExtension(saveTarget.saveName);
        const saveResult = await pickSaveTarget({
            suggestedName,
            pickerTypes: buildPdfSaveTypes(),
        });

        if (saveResult.canceled) {
            return null;
        }
        if (data) {
            await commitCallbacks?.verifyBytesBeforeCommit?.(data);
        }
        await commitCallbacks?.assertBeforeCommit?.();

        let externalWriteCommitted: boolean | null = false;
        let savedSourceRef: string | null;
        try {
            savedSourceRef = await browserDocumentStore.runDocumentMutationWithSource(
                workingCopyPath,
                previousSourceRef,
                revisionOptions?.expectedDocumentRevisionToken,
                async (mutation) => {
                    let normalizedFileName = ensurePdfExtension(saveResult.fileName);
                    let savedHandle = saveResult.handle;
                    let sourceRef: string;

                    if (saveResult.handle) {
                        if (data) {
                            await writeBytesToHandle(saveResult.handle, data);
                        } else {
                            await writeDocumentRefToHandle(saveResult.handle, workingCopyPath);
                        }
                        externalWriteCommitted = true;
                        const size = data?.byteLength
                            ?? (await browserDocumentStore.stat(workingCopyPath)).size;
                        sourceRef = await browserDocumentStore.createStoredDocument(
                            normalizedFileName,
                            new Uint8Array(),
                            {
                                mimeType: 'application/pdf',
                                saveKind: 'pdf',
                                kind: 'source',
                                saveHandle: saveResult.handle,
                                storageMode: 'handle',
                            },
                        );
                        await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {
                            fileSize: size,
                            saveHandle: saveResult.handle,
                            saveName: normalizedFileName,
                        });
                        await browserDocumentStore.assignSaveTarget(
                            sourceRef,
                            normalizedFileName,
                            'pdf',
                            saveResult.handle,
                        );
                    } else {
                        let bytes: Uint8Array;
                        if (data) {
                            bytes = data;
                            if (bytes.byteLength > BROWSER_MAX_FULL_READ_BYTES) {
                                throw new Error(
                                    `Saving documents is unavailable in the browser for inputs larger than ${BROWSER_MAX_FULL_READ_BYTES / (1024 * 1024)}MB. ${browserUseNativeAppMessageProvider()}`,
                                );
                            }
                        } else {
                            await assertBrowserPathWithinFullReadBudget(
                                workingCopyPath,
                                'Saving documents',
                                browserUseNativeAppMessageProvider(),
                            );
                            bytes = await browserDocumentStore.read(workingCopyPath);
                        }
                        const downloadResult = await saveBytesToPickerOrDownload(bytes, {
                            suggestedName,
                            mimeType: 'application/pdf',
                            pickerTypes: buildPdfSaveTypes(),
                            downloadFallbackLabel: 'Saving documents',
                        });

                        if (downloadResult.canceled) {
                            return null;
                        }

                        externalWriteCommitted = true;
                        normalizedFileName = ensurePdfExtension(downloadResult.fileName);
                        savedHandle = downloadResult.handle;
                        sourceRef = await browserDocumentStore.createStoredDocument(
                            normalizedFileName,
                            bytes,
                            {
                                mimeType: 'application/pdf',
                                saveKind: 'pdf',
                                kind: 'source',
                                saveHandle: downloadResult.handle,
                            },
                        );
                    }
                    if (data) {
                        await mutation.write(data);
                    }
                    await mutation.replaceWorkingCopySource(
                        sourceRef,
                        normalizedFileName,
                        savedHandle,
                    );
                    await browserDocumentStore.touchRecentFile(sourceRef);
                    browserDocumentStore.unload(sourceRef);
                    return sourceRef;
                },
            );
        } catch (error) {
            if (error instanceof BrowserFileWriteOutcomeError) {
                externalWriteCommitted = error.externalWriteCommitted;
            }
            if (externalWriteCommitted !== false) {
                throw new BrowserExternalSaveSyncRequiredError(error, externalWriteCommitted);
            }
            throw error;
        }

        if (
            savedSourceRef
            && savedSourceRef !== previousSourceRef
            && previousSourceRef !== workingCopyPath
        ) {
            await browserDocumentStore.cleanupDetachedDocument(previousSourceRef)
                .catch(() => undefined);
        }
        return savedSourceRef;
    }

    async function copyChunkedDocument(sourcePath: string, targetPath: string, totalBytes: number) {
        await browserDocumentStore.prepareChunkedDocument(targetPath, {chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE});
        let copiedBytes = 0;
        let chunkIndex = 0;
        try {
            while (copiedBytes < totalBytes) {
                const length = Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, totalBytes - copiedBytes);
                const chunk = await browserDocumentStore.readRange(sourcePath, copiedBytes, length);
                if (chunk.byteLength !== length) {
                    throw new Error(`Browser document range copy returned ${chunk.byteLength} bytes for requested ${length} bytes`);
                }
                await browserDocumentStore.writeChunk(targetPath, chunkIndex, chunk);
                copiedBytes += chunk.byteLength;
                chunkIndex += 1;
            }
            await browserDocumentStore.finalizeChunkedDocument(targetPath, {
                fileSize: totalBytes,
                chunkCount: chunkIndex,
                chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
            });
        } catch (error) {
            await browserDocumentStore.clearChunkedDocument(targetPath)
                .catch(() => undefined);
            throw error;
        }
    }

    const capability: TCanonicalDocumentsFileCapability = {
        async openDocumentDialog() {
            const pickedFiles = await pickFiles({
                accept: OPEN_INPUT_ACCEPT,
                multiple: false,
                pickerTypes: buildOpenPdfPickerTypes(),
            });
            const picked = pickedFiles[0];
            if (!picked) {
                return null;
            }

            const registered = await browserDocumentStore.registerFileWithOwnership(picked.file, {
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: picked.handle ?? null,
            });

            try {
                return await openDocumentPaths([registered.ref], undefined, undefined, browserUseNativeAppMessageProvider());
            } catch (error) {
                if (registered.created) {
                    await cleanupTransientOpenRefs([registered.ref]);
                }
                throw error;
            }
        },
        openFolderDialog() {
            return Promise.resolve(null);
        },
        openFolderDialogStructured() {
            return Promise.resolve(createPlatformUnsupportedResult(
                'requires-native-backend',
                'Folder dialogs require the desktop app.',
            ));
        },
        async openCombineDialog() {
            const pickedFiles = await pickFiles({
                accept: OPEN_INPUT_ACCEPT,
                multiple: true,
                pickerTypes: buildOpenPdfPickerTypes(),
            });
            if (pickedFiles.length === 0) {
                return null;
            }

            const refs: string[] = [];
            for (const picked of pickedFiles) {
                const ref = await browserDocumentStore.registerFile(picked.file, {
                    kind: 'source',
                    retention: 'transient',
                    saveKind: 'generic',
                    saveHandle: null,
                });
                refs.push(ref);
            }

            try {
                return await openDocumentPaths(refs, undefined, undefined, browserUseNativeAppMessageProvider());
            } catch (error) {
                await cleanupTransientOpenRefs(refs);
                throw error;
            }
        },
        async openImageDialog() {
            const picked = await pickSingleFile({
                accept: OPEN_IMAGE_ACCEPT,
                pickerTypes: buildImagePickerTypes(),
            });
            if (!picked) {
                return null;
            }

            return browserDocumentStore.registerFile(picked.file, {
                kind: 'source',
                retention: 'transient',
                saveKind: 'generic',
                saveHandle: picked.handle ?? null,
            });
        },
        async openDocumentDirect(path, password) {
            if (!isBrowserDocumentRef(path)) {
                return null;
            }

            try {
                return await openDocumentPaths([path], undefined, password, browserUseNativeAppMessageProvider());
            } catch (error) {
                if (isFileSystemAccessDeniedError(error)) {
                    return null;
                }

                throw error;
            }
        },
        async openDocumentDirectBatch(paths, requestId) {
            if (paths.some((path) => !isBrowserDocumentRef(path))) {
                return null;
            }

            try {
                return await openDocumentPaths(
                    paths,
                    requestId ? { requestId } : undefined,
                    undefined,
                    browserUseNativeAppMessageProvider(),
                );
            } catch (error) {
                if (isFileSystemAccessDeniedError(error)) {
                    return null;
                }

                throw error;
            }
        },
        async savePdfAs(workingCopyPath, _options, revisionOptions) {
            return savePdfAsWithOptionalData(workingCopyPath, undefined, revisionOptions);
        },
        async savePdfDataAs(workingCopyPath, data, _options, serializedSaveOptions, commitCallbacks) {
            const validation = await validateBrowserPdfData(data);
            if (!validation.isValid) {
                return {
                    path: null,
                    validation,
                };
            }

            const path = await savePdfAsWithOptionalData(
                workingCopyPath,
                data,
                serializedSaveOptions,
                commitCallbacks,
            );
            return {
                path,
                validation,
            };
        },
        async savePdfDialog(suggestedName) {
            const nextName = ensurePdfExtension(suggestedName);
            const saveResult = await pickSaveTarget({
                suggestedName: nextName,
                pickerTypes: buildPdfSaveTypes(),
            });
            if (saveResult.canceled) {
                return null;
            }

            return browserDocumentStore.createStoredDocument(
                ensurePdfExtension(saveResult.fileName),
                new Uint8Array(),
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'output',
                    retention: 'transient',
                    saveHandle: saveResult.handle,
                },
            );
        },
        async saveDocxAs(workingCopyPath) {
            const fallbackName = ensureDocxExtension(
                getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
            );
            const saveResult = await pickSaveTarget({
                suggestedName: fallbackName,
                pickerTypes: buildDocxSaveTypes(),
            });
            if (saveResult.canceled) {
                return null;
            }

            return browserDocumentStore.createStoredDocument(
                ensureDocxExtension(saveResult.fileName),
                new Uint8Array(),
                {
                    mimeType:
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    saveKind: 'docx',
                    kind: 'output',
                    retention: 'transient',
                    saveHandle: saveResult.handle,
                },
            );
        },
        async readFile(path) {
            return browserDocumentStore.read(path);
        },
        async applyPdfNativeMutationsToWorkingCopy(
            path,
            mutations: IPdfNativeMutationSet,
            modifiedAt,
            options: IDocumentMutationRevisionOptions,
        ) {
            await assertBrowserPathWithinFullReadBudget(
                path,
                'Saving documents',
                `. ${browserUseNativeAppMessageProvider()}`,
            );
            await browserDocumentStore.assertDocumentRevisionCurrent(
                path,
                options.expectedDocumentRevisionToken,
            );
            const input = await browserDocumentStore.read(path);
            const wasmResult = await tryRunBrowserPageOpsWithWasm('saveMutations', {
                data: input,
                mutations,
                modifiedAt,
            });
            if (wasmResult === null) {
                throw new Error('Browser PDF save operation is unavailable');
            }
            if (isBrowserPageOpsWasmFailure(wasmResult)) {
                return {
                    applied: false,
                    validation: null,
                    error: {
                        code: 'native-failure',
                        message: wasmResult.error.message,
                    },
                } satisfies IPdfNativeSaveResult;
            }
            if (wasmResult.data.byteLength > BROWSER_MAX_FULL_READ_BYTES) {
                throw new Error(
                    `Saving documents is unavailable in the browser for inputs larger than ${BROWSER_MAX_FULL_READ_BYTES / (1024 * 1024)}MB. ${browserUseNativeAppMessageProvider()}`,
                );
            }
            await browserDocumentStore.assertDocumentRevisionCurrent(
                path,
                options.expectedDocumentRevisionToken,
            );
            const stagedPath = await browserDocumentStore.createStoredDocument(
                `${getBrowserDocumentFileName(path)}.staged-native-save.pdf`,
                wasmResult.data,
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'output',
                    retention: 'transient',
                },
            );
            try {
                const stagedOutput = await createBrowserStoreStagedArtifact(
                    browserDocumentStore,
                    stagedPath,
                    {
                        leaseId: crypto.randomUUID(),
                        sha256: await sha256Hex(wasmResult.data),
                        validations: {
                            qpdfCheck: false,
                            tailCheck: true,
                            semanticCheck: true,
                            semanticScopeSha256: nativePdfSemanticScope,
                            fsynced: false,
                        },
                    },
                );
                browserNativeMutationBindings.set(
                    stagedOutput.path,
                    wasmResult.identityBindings,
                );
                return {
                    applied: true,
                    validation: {
                        isValid: true,
                        tool: 'browser',
                        errors: [],
                        warnings: [],
                    },
                    nativeMutationPostconditionsVerified: true,
                    identityBindings: wasmResult.identityBindings,
                    stagedOutput,
                } satisfies IPdfNativeSaveResult;
            } catch (error) {
                await browserDocumentStore.remove(stagedPath).catch(() => undefined);
                throw error;
            }
        },
        async commitStagedPdfNativeMutations(
            path,
            stagedOutput: ITypedStagedArtifact,
            options,
        ) {
            if (!options?.expectedDocumentRevisionToken) {
                throw new Error('Browser staged PDF save requires the document revision');
            }
            let committed: boolean;
            try {
                committed = await commitBrowserStoreStagedArtifact(
                    browserDocumentStore,
                    stagedOutput,
                    path,
                    options.expectedDocumentRevisionToken,
                );
            } catch (error) {
                browserNativeMutationBindings.delete(stagedOutput.path);
                await browserDocumentStore.remove(stagedOutput.path).catch(() => undefined);
                throw error;
            }
            if (!committed) {
                browserNativeMutationBindings.delete(stagedOutput.path);
                await browserDocumentStore.remove(stagedOutput.path).catch(() => undefined);
                return {
                    applied: false,
                    validation: null,
                } satisfies IPdfNativeSaveResult;
            }
            const identityBindings = browserNativeMutationBindings.get(stagedOutput.path);
            browserNativeMutationBindings.delete(stagedOutput.path);
            await clearSearchCaches(path);
            return {
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'browser',
                    errors: [],
                    warnings: [],
                },
                nativeMutationPostconditionsVerified: true,
                ...(identityBindings ? {identityBindings} : {}),
            } satisfies IPdfNativeSaveResult;
        },
        async parsePdfAnnotations(path, options) {
            await assertBrowserPathWithinFullReadBudget(path, 'Parsing PDF annotations');
            await browserDocumentStore.assertDocumentRevisionCurrent(
                path,
                options.expectedDocumentRevisionToken,
            );
            const data = await browserDocumentStore.read(path);
            await browserDocumentStore.assertDocumentRevisionCurrent(
                path,
                options.expectedDocumentRevisionToken,
            );
            const wasmResult = await runBrowserPageOpsWorkerRequest(
                'parseAnnotations',
                {data},
                {
                    dedicated: true,
                    ...(options.signal ? {signal: options.signal} : {}),
                },
            );
            const parsed = decodeBrowserPdfAnnotationsOutput(wasmResult.data);
            await browserDocumentStore.assertDocumentRevisionCurrent(
                path,
                options.expectedDocumentRevisionToken,
            );
            return {
                documentRevisionToken: options.expectedDocumentRevisionToken,
                ...parsed,
            };
        },
        statFile(path) {
            return browserDocumentStore.stat(path);
        },
        readFileRange(path, offset, length) {
            return browserDocumentStore.readRange(path, offset, length);
        },
        async readFileChunks(path, options, onChunk) {
            const chunkBytes = options.chunkBytes ?? 8 * 1024 * 1024;
            if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
                throw new Error('readFileChunks.options.chunkBytes must be a positive integer');
            }
            const { size } = await browserDocumentStore.stat(path);
            let bytesRead = 0;
            let chunks = 0;
            while (bytesRead < size) {
                if (options.signal?.aborted) {
                    throw options.signal.reason instanceof Error
                        ? options.signal.reason
                        : new Error('The operation was aborted.');
                }
                const length = Math.min(chunkBytes, size - bytesRead);
                const chunk = await browserDocumentStore.readRange(path, bytesRead, length);
                await onChunk(chunk, bytesRead);
                bytesRead += chunk.byteLength;
                chunks += 1;
            }
            return {
                size,
                bytesRead,
                chunks,
            };
        },
        async readTextFile(path) {
            return browserDocumentStore.readText(path);
        },
        async fileExists(path) {
            return browserDocumentStore.exists(path);
        },
        getDocumentRevision(path) {
            return browserDocumentStore.getDocumentRevision(path);
        },
        onDocumentRevisionChanged(callback) {
            return browserDocumentStore.onDocumentRevisionChanged(callback);
        },
        async analyzePdfConformance(path) {
            return analyzeBrowserPdfConformance(path);
        },
        async validatePdfData(data) {
            return validateBrowserPdfData(data);
        },
        async validatePdfPath(path, _options) {
            return validateBrowserPdfPath(path);
        },
        openPdfInDefaultAppData() {
            return Promise.resolve({
                success: false,
                error: BROWSER_DEFAULT_PDF_APP_UNSUPPORTED,
                unsupportedReason: 'requires-native-backend',
            });
        },
        openPdfInDefaultAppPath() {
            return Promise.resolve({
                success: false,
                error: BROWSER_DEFAULT_PDF_APP_UNSUPPORTED,
                unsupportedReason: 'requires-native-backend',
            });
        },
        printPdfData() {
            return Promise.resolve({
                success: false,
                error: BROWSER_NATIVE_PRINT_UNSUPPORTED,
                unsupportedReason: 'requires-native-backend',
            });
        },
        printPdfPath() {
            return Promise.resolve({
                success: false,
                error: BROWSER_NATIVE_PRINT_UNSUPPORTED,
                unsupportedReason: 'requires-native-backend',
            });
        },
        async writeFile(path, data, options) {
            await clearSearchCaches();
            return browserDocumentStore.write(path, data, options);
        },
        async replaceWorkingCopyFromPath(workingCopyPath, sourcePath, options) {
            const bytes = await browserDocumentStore.read(sourcePath);
            await clearSearchCaches(workingCopyPath);
            return browserDocumentStore.write(workingCopyPath, bytes, options);
        },
        async savePdfData(path, data, options, commitCallbacks) {
            const validation = await validateBrowserPdfData(data);
            if (!validation.isValid) {
                return validation;
            }

            await commitCallbacks?.verifyBytesBeforeCommit?.(data);
            await commitCallbacks?.assertBeforeCommit?.();
            await browserDocumentStore.write(path, data, options);
            if (options?.workingCopyOnly === true) {
                await clearSearchCaches();
                return validation;
            }
            const revision = await browserDocumentStore.getDocumentRevision(path);
            const saved = await saveWorkingBytesToSource(
                path,
                browserUseNativeAppMessageProvider,
                {expectedDocumentRevisionToken: revision.token},
            );
            if (!saved) {
                return createCanceledSaveValidationResult(validation);
            }
            await clearSearchCaches();
            return validation;
        },
        async savePdfDataChunks(path, totalBytes, chunks, options, commitCallbacks) {
            if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
                throw new Error('savePdfDataChunks.totalBytes must be a positive safe integer');
            }
            let bytesRead = 0;
            let stagedChunkCount = 0;
            let stagingBuffer = new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE);
            let stagingOffset = 0;
            const stagingPath = await browserDocumentStore.createStoredDocument(
                `${getBrowserDocumentFileName(path)}.staged-save.pdf`,
                new Uint8Array(),
                {
                    mimeType: 'application/pdf',
                    kind: 'output',
                    retention: 'transient',
                    saveKind: 'pdf',
                },
            );

            await browserDocumentStore.prepareChunkedDocument(stagingPath, {chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE});

            try {
                for await (const chunk of chunks) {
                    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
                        throw new Error('savePdfDataChunks.chunks must yield non-empty Uint8Array chunks');
                    }
                    if (bytesRead + chunk.byteLength > totalBytes) {
                        throw new Error('savePdfDataChunks chunks exceed the declared total size');
                    }
                    bytesRead += chunk.byteLength;

                    let chunkOffset = 0;
                    while (chunkOffset < chunk.byteLength) {
                        const writableBytes = Math.min(
                            stagingBuffer.byteLength - stagingOffset,
                            chunk.byteLength - chunkOffset,
                        );
                        stagingBuffer.set(
                            chunk.subarray(chunkOffset, chunkOffset + writableBytes),
                            stagingOffset,
                        );
                        stagingOffset += writableBytes;
                        chunkOffset += writableBytes;

                        if (stagingOffset === stagingBuffer.byteLength) {
                            await browserDocumentStore.writeChunk(
                                stagingPath,
                                stagedChunkCount,
                                stagingBuffer,
                            );
                            stagedChunkCount += 1;
                            stagingBuffer = new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE);
                            stagingOffset = 0;
                        }
                    }
                }
                if (bytesRead !== totalBytes) {
                    throw new Error('savePdfDataChunks chunks did not match the declared total size');
                }
                if (stagingOffset > 0) {
                    await browserDocumentStore.writeChunk(
                        stagingPath,
                        stagedChunkCount,
                        stagingBuffer.subarray(0, stagingOffset),
                    );
                    stagedChunkCount += 1;
                }

                await browserDocumentStore.finalizeChunkedDocument(stagingPath, {
                    fileSize: totalBytes,
                    chunkCount: stagedChunkCount,
                    chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
                });

                const validation = await validateBrowserPdfPath(stagingPath);
                if (!validation.isValid) {
                    return validation;
                }

                if (commitCallbacks?.verifyBytesBeforeCommit) {
                    throw new Error('Chunked browser persistence cannot verify a contiguous byte frontier');
                }
                await commitCallbacks?.assertBeforeCommit?.();
                await browserDocumentStore.assertDocumentRevisionCurrent(
                    path,
                    options?.expectedDocumentRevisionToken,
                );
                await copyChunkedDocument(stagingPath, path, totalBytes);
                if (options?.workingCopyOnly === true) {
                    await clearSearchCaches();
                    return validation;
                }
                const revision = await browserDocumentStore.getDocumentRevision(path);
                const saved = await saveWorkingBytesToSource(
                    path,
                    browserUseNativeAppMessageProvider,
                    {expectedDocumentRevisionToken: revision.token},
                );
                if (!saved) {
                    return createCanceledSaveValidationResult(validation);
                }
                await clearSearchCaches();
                return validation;
            } catch (error) {
                await browserDocumentStore.clearChunkedDocument(stagingPath)
                    .catch(() => undefined);
                throw error;
            } finally {
                await browserDocumentStore.remove(stagingPath)
                    .catch(() => undefined);
            }
        },
        async writeDocxFile(path, data, signal) {
            try {
                signal?.throwIfAborted();
                const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                await browserDocumentStore.write(path, bytes);
                signal?.throwIfAborted();
                const saveTarget = await browserDocumentStore.getSaveTarget(path);
                signal?.throwIfAborted();

                if (saveTarget.saveHandle) {
                    await writeBytesToHandle(saveTarget.saveHandle, bytes, signal);
                } else {
                    await saveBytesToPickerOrDownload(bytes, {
                        suggestedName: ensureDocxExtension(saveTarget.saveName),
                        mimeType:
                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        pickerTypes: buildDocxSaveTypes(),
                        downloadFallbackLabel: 'Saving documents',
                        ...(signal === undefined ? {} : {signal}),
                    });
                }
                signal?.throwIfAborted();
                return true;
            } finally {
                if (signal?.aborted) {
                    await browserDocumentStore.remove(path).catch(() => undefined);
                }
            }
        },
        async createWorkingCopyFromData(fileName, data, originalPath, password) {
            return createBrowserWorkingCopyFromBytes({
                fileName,
                data,
                mimeType: 'application/pdf',
                ...(password === undefined ? {} : {password}),
                ...(originalPath && isBrowserDocumentRef(originalPath)
                    ? { sourceRef: originalPath }
                    : {}),
            });
        },
        async createWorkingCopyFromPath(sourcePath, originalPath, password) {
            const sourceEntry = await browserDocumentStore.requireEntry(sourcePath);
            const sourceRef =
                originalPath && isBrowserDocumentRef(originalPath)
                    ? originalPath
                    : (
                        sourceEntry.kind === 'working'
                            ? sourceEntry.sourceRef
                            : sourceEntry.ref
                    );
            if (sourceEntry.kind !== 'working') {
                const workingPath = await browserDocumentStore.cloneAsWorkingCopy(
                    sourceEntry.ref,
                    sourceEntry.fileName,
                );
                try {
                    const decryption = await decryptBrowserWorkingCopy(workingPath, password);
                    assertBrowserWorkingCopyDecrypted(decryption);
                    browserDocumentStore.unload(sourcePath);
                    return workingPath;
                } catch (error) {
                    await browserDocumentStore.remove(workingPath).catch(() => undefined);
                    throw error;
                }
            }

            const workingPath = await browserDocumentStore.cloneStoredDocument(
                sourceEntry.ref,
                {
                    fileName: sourceEntry.fileName,
                    kind: 'working',
                    retention: 'transient',
                    ...(sourceRef && isBrowserDocumentRef(sourceRef)
                        ? { sourceRef }
                        : {}),
                    saveKind: 'pdf',
                    saveHandle: null,
                },
            );
            try {
                const decryption = await decryptBrowserWorkingCopy(workingPath, password);
                assertBrowserWorkingCopyDecrypted(decryption);
            } catch (error) {
                await browserDocumentStore.remove(workingPath).catch(() => undefined);
                throw error;
            }
            return workingPath;
        },
        async saveFileStructured(path, revisionOptions) {
            const result = await saveWorkingBytesToSourceStructured(
                path,
                browserUseNativeAppMessageProvider,
                revisionOptions,
            );
            if (result.ok) {
                await clearSearchCaches();
            }
            return result;
        },
        async resyncWorkingCopy(path) {
            try {
                const sourceRef = await browserDocumentStore.getSourceRef(path);
                const bytes = await browserDocumentStore.read(sourceRef);
                await browserDocumentStore.writeForBootstrap(
                    path,
                    bytes,
                    'resync-after-external-change',
                );
                await clearSearchCaches(path);
                return {
                    ok: true,
                    externalWriteCommitted: false,
                    workingCopyRefreshed: true,
                    validation: null,
                };
            } catch (error) {
                return {
                    ok: false,
                    reason: 'write-failed',
                    message: error instanceof Error ? error.message : String(error),
                    externalWriteCommitted: false,
                    validation: null,
                };
            }
        },
        async cleanupFile(path) {
            const entry = await browserDocumentStore.ensureEntry(path);
            if (!entry) {
                return;
            }

            const sourceRef = entry.sourceRef ?? path;
            if (sourceRef !== path) {
                await browserDocumentStore.remove(path);
                await browserDocumentStore.cleanupDetachedDocument(sourceRef);
                await Promise.all([
                    clearSearchCaches(path),
                    clearSearchCaches(sourceRef),
                ]);
                return;
            }

            await browserDocumentStore.cleanupDetachedDocument(path);
            await clearSearchCaches(path);
        },
        async cleanupOcrTemp(_path) {},
        setWindowTitle(title) {
            if (typeof document !== 'undefined') {
                document.title = title;
            }
            syncBrowserWindowTitle();
            return Promise.resolve();
        },
        showItemInFolder(_path) {
            return Promise.resolve(false);
        },
        showItemInFolderStructured(_path) {
            return Promise.resolve(createPlatformUnsupportedResult(
                'requires-native-backend',
                'Showing files in a folder requires the desktop app.',
            ));
        },
        recentFiles: {
            async get() {
                const recentFiles = await browserDocumentStore.recoverRecentFilesIfStorageMissing();
                const validatedFiles: IRecentFile[] = [];
                let shouldBackfillStorage = false;

                for (const file of recentFiles) {
                    const {
                        available,
                        entry,
                    } = await browserDocumentStore.ensureEntryAvailability(file.originalPath);
                    if (!available) {
                        return recentFiles;
                    }
                    if (entry && entry.retention !== 'transient') {
                        const fileSize = typeof file.fileSize === 'number'
                            ? file.fileSize
                            : entry.fileSize;
                        shouldBackfillStorage ||= fileSize !== file.fileSize;
                        validatedFiles.push({
                            ...file,
                            fileSize,
                        });
                        continue;
                    }

                    await browserDocumentStore.removeRecentFile(file.originalPath);
                }

                if (shouldBackfillStorage) {
                    writeRecentFilesToStorage(validatedFiles);
                }

                return validatedFiles;
            },
            async remove(path) {
                await browserDocumentStore.removeRecentFile(path);
                await clearSearchCaches(path);
            },
            async removeIfMissing(path) {
                const {
                    available,
                    entry,
                } = await browserDocumentStore.ensureEntryAvailability(path);
                if (!available || (entry && entry.retention !== 'transient')) {
                    return false;
                }
                await browserDocumentStore.removeRecentFile(path);
                await clearSearchCaches(path);
                return true;
            },
            async clear() {
                await browserDocumentStore.clearRecentFiles();
                await clearSearchCaches();
            },
        },
        getPathForFile(file) {
            return browserDocumentStore.getRefForFile(file);
        },
        getPathsForFiles(files) {
            return files.map(file => browserDocumentStore.getRefForFile(file));
        },
        async registerFilesForOpen(files) {
            const refs: string[] = [];
            for (const file of files) {
                refs.push(await browserDocumentStore.registerFile(file));
            }
            return refs;
        },
        async createCombinedPdfFromFiles(files, options) {
            const refs: string[] = [];
            for (const file of files) {
                const ref = await browserDocumentStore.registerFile(file, {
                    kind: 'source',
                    retention: 'transient',
                    saveKind: 'generic',
                    saveHandle: null,
                });
                refs.push(ref);
            }

            try {
                return await createBrowserCombinedPdfFromPaths(refs, options);
            } finally {
                await cleanupTransientOpenRefs(refs);
            }
        },
    };

    return capability;
}
