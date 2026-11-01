import type {
    IDocumentMutationRevisionOptions,
    IDocumentsFileCapability,
    IPdfNativeSaveResult,
} from '@contracts/electronApiDocuments';
import { readBrowserPdfCatalogPart } from '@contracts/browserPdfCatalog';
import {
    PDF_PAGE_LABEL_STYLE_VALUES,
    type IPdfPageLabelRange,
} from '@contracts/pdfPageLabels';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import {
    createSessionId,
    type IRecentFile,
    type TSessionId,
} from '@contracts/shared';
import type { IDocxExportFileCapability } from '@contracts/docxExport';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import {
    syncBrowserWindowTitle,
    retireBrowserDocumentWorkingCopy,
    reserveBrowserDocumentWorkingCopy,
    handoffBrowserDocumentWorkingCopy,
} from '@app/platform/browserWindowTabs';
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
    getExtension,
} from '@app/platform/browser-api/browserFileName';
import type { IBrowserBatchOpenProgressOptions } from '@app/platform/browser-api/createCombinedPdfFromPaths';
import {
    analyzeBrowserPdfConformance,
    validateBrowserPdfData,
    validateBrowserPdfPath,
} from '@app/platform/browser-api/browserPdfValidation';
import {
    openBrowserOutputSink,
    type IPickedBrowserFile,
    pickFiles,
    pickFolderFiles,
    pickSaveTarget,
    pickSingleFile,
    type IBrowserOutputSink,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {
    assertBrowserWorkingCopyDecrypted,
    createBrowserWorkingCopyFromBytes,
    decryptBrowserWorkingCopy,
    openDocumentPaths,
} from '@app/platform/browser-api/browserWorkingCopyService';
import {
    BrowserExternalSaveSyncRequiredError,
    savePdfAsFromWorkingCopy,
    saveWorkingBytesToSource,
    saveWorkingBytesToSourceStructured,
} from '@app/platform/browser-api/browserSaveTargets';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {
    findIndirectDjvuSelection,
    setBrowserDjvuComponentFiles,
} from '@app/platform/browser-api/browserDjvuComponents';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import { decodeBrowserPdfAnnotationsOutput } from '@app/platform/browser-api/decodeBrowserPdfAnnotationsOutput';
import {runSerializedRecentFilesStorageMutation} from '@app/platform/browser/browserRecentFilesStore';
import {browserSettingsCapability} from '@app/platform/browser-api/browserSettingsCapability';
import {
    createBrowserStoreStagedArtifact,
    readBrowserStoreStagedArtifact,
    sha256Hex,
} from '@app/platform/browser/browserStagedArtifact';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {nativePdfSemanticScope} from '@contracts/nativePdfSemanticScope';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    DOCUMENT_LIST_HEADER,
    REQUEST_HEADER,
    REQUEST_ORIGINAL_APPEARANCE_SOURCE_HEADER,
    U32_BYTES,
} from '@contracts/browserPageOpsWasm.generated';
import { createEpochMs } from '@contracts/timestamps';
import { isOneOf } from '@contracts/runtimeGuards';
import {
    compareFolderEntryNames,
    isSupportedOpenExtension,
    MAX_OPEN_INPUT_PATHS,
} from '@pdf-core/documentOpenFileTypes';

const BROWSER_NATIVE_PRINT_UNSUPPORTED = 'Printing via the native desktop dialog is unavailable in the browser capability';

export async function createBrowserCombinedPdfFromPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    const module = await import('@app/platform/browser-api/createCombinedPdfFromPaths');
    return module.createCombinedPdfFromPaths(paths, progressOptions);
}

interface IBrowserNativeMutationLease {
    path: TDocumentRef;
    identityBindings: IPdfNativeSaveResult['identityBindings'];
}

interface ICreateBrowserDocumentsFileCapabilityOptions {
    clearSearchCaches: (pdfPath?: string) => void | Promise<void>;
    errorMessageProvider?: {folderEmpty?: () => string;};
}
type TCanonicalDocumentsFileCapability = IDocumentsFileCapability & IDocxExportFileCapability;
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function createValidBrowserOutputResult(): IPdfValidationResult {
    return {
        isValid: true,
        tool: 'browser',
        errors: [],
        warnings: [],
    };
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
): TCanonicalDocumentsFileCapability {
    const { clearSearchCaches } = options;
    const browserNativeMutationLeases = new Map<string, IBrowserNativeMutationLease>();
    const docxStreams = new Map<TSessionId, IBrowserOutputSink>();

    function requireDocxStream(sessionId: TSessionId) {
        const sink = docxStreams.get(sessionId);
        if (!sink) throw new Error('Unknown DOCX stream session');
        return sink;
    }
    const folderEmptyMessageProvider = options.errorMessageProvider?.folderEmpty
        ?? (() => 'No supported documents were found in the selected folder');

    async function discardWorkingCopy(path: TDocumentRef, leaseId?: string) {
        if (leaseId !== undefined) browserNativeMutationLeases.delete(leaseId);
        await retireBrowserDocumentWorkingCopy(path);
        await browserDocumentStore.remove(path).catch(() => undefined);
    }

    // Cleanup is best effort for failed transient opens.
    async function cleanupTransientOpenRefs(paths: string[]) {
        await Promise.all(paths.map(path => browserDocumentStore.remove(path).catch(() => undefined)));
    }


    async function pickOutputTarget(suggestedName: string, saveKind: 'pdf' | 'docx') {
        const normalizeName = saveKind === 'pdf' ? ensurePdfExtension : ensureDocxExtension;
        const saveResult = await pickSaveTarget({
            suggestedName: normalizeName(suggestedName),
            pickerTypes: saveKind === 'pdf' ? buildPdfSaveTypes() : buildDocxSaveTypes(),
        });
        if (saveResult.canceled) return null;
        const name = normalizeName(saveResult.fileName);
        const ref = await reserveBrowserDocumentWorkingCopy(name);
        try {
            return await browserDocumentStore.createStoredDocument(name, new Uint8Array(), {
                ref,
                mimeType: saveKind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                saveKind,
                kind: 'output',
                retention: 'transient',
                saveHandle: saveResult.handle,
            });
        } catch (error) {
            await retireBrowserDocumentWorkingCopy(ref);
            throw error;
        }
    }

    // One picked file opens as itself, saved back to its handle and kept in Recent.
    // An indirect DjVu index reads its pages from the component files picked with it.
    async function openPickedDocument(picked: IPickedBrowserFile, djvuComponents?: readonly File[]) {
        const registered = await browserDocumentStore.registerFileWithOwnership(picked.file, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: picked.handle ?? null,
        });
        if (djvuComponents) {
            setBrowserDjvuComponentFiles(registered.ref, djvuComponents);
        }

        try {
            return await openDocumentPaths([registered.ref]);
        } catch (error) {
            if (registered.created) {
                await cleanupTransientOpenRefs([registered.ref]);
            }
            throw error;
        }
    }

    // Several picked files open as one generated PDF, in the order given.
    async function openPickedBatch(pickedFiles: IPickedBrowserFile[]) {
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
            return await openDocumentPaths(refs);
        } catch (error) {
            await cleanupTransientOpenRefs(refs);
            throw error;
        }
    }

    const capability: TCanonicalDocumentsFileCapability = {
        async openDocumentDialog() {
            // Several files open as one combined document, as on desktop. An
            // indirect DjVu index picked with the files beside it opens as
            // that DjVu, reading its pages from those files.
            const pickedFiles = await pickFiles({
                accept: OPEN_INPUT_ACCEPT,
                multiple: true,
                pickerTypes: buildOpenPdfPickerTypes(),
            });
            const indirectDjvu = await findIndirectDjvuSelection<IPickedBrowserFile>(pickedFiles);
            if (pickedFiles.length > 1 && !indirectDjvu) {
                return openPickedBatch(pickedFiles);
            }
            const picked = indirectDjvu?.index ?? pickedFiles[0];
            return picked ? openPickedDocument(picked, indirectDjvu?.components) : null;
        },
        // As on desktop: the folder's own supported files, in natural name
        // order, open as the Open dialog would open them.
        async openFolderDialog() {
            const pickedFiles = await pickFolderFiles();
            if (!pickedFiles) {
                return null;
            }
            const supported = pickedFiles
                .filter(({file}) => isSupportedOpenExtension(getExtension(file.name)))
                .sort((left, right) => compareFolderEntryNames(left.file.name, right.file.name));
            const [first] = supported;
            if (!first) {
                throw new Error(folderEmptyMessageProvider());
            }
            if (supported.length > MAX_OPEN_INPUT_PATHS) {
                throw new Error(`Open batch exceeds maximum size (${MAX_OPEN_INPUT_PATHS})`);
            }
            return supported.length === 1 ? openPickedDocument(first) : openPickedBatch(supported);
        },
        async openCombineDialog() {
            const pickedFiles = await pickFiles({
                accept: OPEN_INPUT_ACCEPT,
                multiple: true,
                pickerTypes: buildOpenPdfPickerTypes(),
            });
            return pickedFiles.length > 0 ? openPickedBatch(pickedFiles) : null;
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
                return await openDocumentPaths([path], undefined, password);
            } finally {
                await retireBrowserDocumentWorkingCopy(path);
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
                );
            } finally {
                await Promise.all(paths.map(retireBrowserDocumentWorkingCopy));
            }
        },
        async savePdfAs(workingCopyPath, saveOptions, revisionOptions?) {
            return savePdfAsFromWorkingCopy(workingCopyPath, saveOptions, revisionOptions);
        },
        savePdfDialog: suggestedName => pickOutputTarget(suggestedName, 'pdf'),
        saveDocxAs: workingCopyPath => pickOutputTarget(
            getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
            'docx',
        ),
        readFile: path => browserDocumentStore.read(path),
        async readPdfPageLabelRanges(path) {
            const data = await browserDocumentStore.read(path, {maxBytes: BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - DOCUMENT_LIST_HEADER.bytes - U32_BYTES});
            const catalog = await runBrowserPageOpsWorkerRequest('readCatalog', {data}, {dedicated: true});
            return readBrowserPdfCatalogPart(catalog, 'pageLabels').map((range): IPdfPageLabelRange => ({
                startPage: range.pageIndex + 1,
                style: range.style !== undefined && isOneOf(PDF_PAGE_LABEL_STYLE_VALUES, range.style)
                    ? range.style
                    : null,
                prefix: range.prefix ?? '',
                startNumber: range.start && range.start > 0 ? range.start : 1,
            }));
        },
        async applyPdfNativeMutationsToWorkingCopy(
            path,
            mutations,
            modifiedAt,
            options: IDocumentMutationRevisionOptions,
        ) {
            await browserDocumentStore.assertDocumentRevisionCurrent(
                path,
                options.expectedDocumentRevisionToken,
            );
            // The document and its original appearance source share one
            // engine request; the engine refuses the framed remainder exactly.
            const requestBudget = BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - REQUEST_ORIGINAL_APPEARANCE_SOURCE_HEADER.bytes;
            const input = await browserDocumentStore.read(path, {maxBytes: requestBudget});
            const originalAppearanceSource = mutations.originalAppearanceSource;
            const originalAppearanceSourceData = originalAppearanceSource
                ? await browserDocumentStore.read(originalAppearanceSource, {maxBytes: requestBudget - input.byteLength})
                : undefined;
            const wasmResult = await runBrowserPageOpsWorkerRequest('saveMutations', {
                data: input,
                ...(originalAppearanceSourceData ? {originalAppearanceSourceData} : {}),
                mutations,
                modifiedAt,
            });
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
            await browserDocumentStore.assertDocumentRevisionCurrent(
                path,
                options.expectedDocumentRevisionToken,
            );
            const stagedName = `${getBrowserDocumentFileName(path)}.staged-native-save.pdf`;
            const stagedPath = await reserveBrowserDocumentWorkingCopy(stagedName);
            try {
                await browserDocumentStore.createStoredDocument(stagedName, wasmResult.data, {
                    ref: stagedPath,
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'output',
                    retention: 'transient',
                });
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
                browserNativeMutationLeases.set(stagedOutput.leaseId, {
                    path: stagedOutput.path,
                    identityBindings: wasmResult.identityBindings,
                });
                return {
                    applied: true,
                    validation: createValidBrowserOutputResult(),
                    nativeMutationPostconditionsVerified: true,
                    identityBindings: wasmResult.identityBindings,
                    stagedOutput,
                } satisfies IPdfNativeSaveResult;
            } catch (error) {
                await discardWorkingCopy(stagedPath);
                throw error;
            }
        },
        async releaseManagedTempFileHandle(leaseId) {
            const stagedPath = browserNativeMutationLeases.get(leaseId)?.path;
            if (!stagedPath) {
                return false;
            }
            await discardWorkingCopy(stagedPath, leaseId);
            return true;
        },
        async cloneStagedPdfNativeMutationToWorkingCopy(stagedOutput, originalPath) {
            const {bytes} = await readBrowserStoreStagedArtifact(browserDocumentStore, stagedOutput);
            const clonePath = await createBrowserWorkingCopyFromBytes({
                fileName: getBrowserDocumentFileName(stagedOutput.path),
                data: bytes,
                ...(originalPath ? {sourceRef: originalPath} : {}),
            });
            await discardWorkingCopy(stagedOutput.path, stagedOutput.leaseId);
            return clonePath;
        },
        async commitStagedPdfNativeMutations(
            path,
            stagedOutput: ITypedStagedArtifact,
            options,
        ) {
            if (!options?.expectedDocumentRevisionToken) {
                throw new Error('Browser staged PDF save requires the document revision');
            }
            const identityBindings = browserNativeMutationLeases.get(stagedOutput.leaseId)?.identityBindings;
            let committed: boolean;
            try {
                committed = await saveWorkingBytesToSource(path, options, stagedOutput);
            } catch (error) {
                // Written, but local bookkeeping failed: a save result, not a writer failure.
                if (!(error instanceof BrowserExternalSaveSyncRequiredError)) throw error;
                return {
                    applied: false,
                    validation: null,
                    reason: 'working-copy-sync-required',
                    externalWriteCommitted: error.externalWriteCommitted,
                    workingCopySyncRequired: true,
                    error: {
                        code: 'io',
                        message: error.message,
                    },
                } satisfies IPdfNativeSaveResult;
            } finally {
                await discardWorkingCopy(stagedOutput.path, stagedOutput.leaseId);
            }
            if (!committed) {
                return {
                    applied: false,
                    validation: null,
                } satisfies IPdfNativeSaveResult;
            }
            await clearSearchCaches(path);
            return {
                applied: true,
                validation: createValidBrowserOutputResult(),
                nativeMutationPostconditionsVerified: true,
                ...(identityBindings ? {identityBindings} : {}),
            } satisfies IPdfNativeSaveResult;
        },
        async parsePdfAnnotations(path, options) {
            await browserDocumentStore.assertDocumentRevisionCurrent(
                path,
                options.expectedDocumentRevisionToken,
            );
            const data = await browserDocumentStore.read(path, {maxBytes: BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - REQUEST_HEADER.bytes});
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
        async statFile(path) {
            const stat = await browserDocumentStore.stat(path);
            const {
                modifiedAt,
                ...rest
            } = stat;
            return {
                ...rest,
                ...(modifiedAt === undefined ? {} : {modifiedAt: createEpochMs(modifiedAt)}),
            };
        },
        readFileRange(path, offset, length) {
            return browserDocumentStore.readRange(path, offset, length);
        },
        readTextFile: path => browserDocumentStore.readText(path),
        fileExists: path => browserDocumentStore.exists(path),
        getDocumentRevision(path) {
            return browserDocumentStore.getDocumentRevision(path);
        },
        onDocumentRevisionChanged(callback) {
            return browserDocumentStore.onDocumentRevisionChanged(callback);
        },
        analyzePdfConformance(path, options) {
            const analysis = analyzeBrowserPdfConformance(path, options);
            handoffBrowserDocumentWorkingCopy(path, path, () => analysis.then(() => undefined, () => undefined));
            return analysis;
        },
        validatePdfPath: (path, options) => validateBrowserPdfPath(path, options),
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
        // Only an OCR result replaces a working copy; it is applied through
        // the receipt staged for that document and revision.
        async replaceWorkingCopyFromPath(workingCopyPath, sourcePath, options) {
            const {commitBrowserOcrResult} = await import('@app/platform/browser-api/browserOcrCapability');
            const committed = await commitBrowserOcrResult(
                workingCopyPath,
                sourcePath,
                options?.expectedDocumentRevisionToken,
            );
            await clearSearchCaches(workingCopyPath);
            return committed;
        },
        async savePdfData(path, data, options, commitCallbacks) {
            const {saveName} = await browserDocumentStore.getSaveTarget(path);
            const validation = await validateBrowserPdfData(data, {fileName: saveName});
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
                {expectedDocumentRevisionToken: revision.token},
            );
            if (!saved) {
                return createCanceledSaveValidationResult(validation);
            }
            await clearSearchCaches();
            return validation;
        },
        // Streams a DOCX into the file chosen for `path`, or, without a file
        // handle, into `path`'s own record and then a download.
        async beginDocxFileStream(path) {
            const saveTarget = await browserDocumentStore.getSaveTarget(path);
            const fileName = ensureDocxExtension(saveTarget.saveName);
            const sink = await openBrowserOutputSink(
                saveTarget.saveHandle
                    ? {
                        fileName,
                        handle: saveTarget.saveHandle,
                    }
                    : {
                        fileName,
                        stagingRef: path,
                    },
                {mimeType: DOCX_MIME_TYPE},
            );
            const sessionId = createSessionId('browser-docx');
            docxStreams.set(sessionId, sink);
            return {sessionId};
        },
        async writeDocxFileStreamChunk(sessionId, chunk) {
            await requireDocxStream(sessionId).write(chunk);
            return true;
        },
        async commitDocxFileStream(sessionId) {
            await requireDocxStream(sessionId).close().finally(() => docxStreams.delete(sessionId));
            return true;
        },
        async cancelDocxFileStream(sessionId) {
            const sink = docxStreams.get(sessionId);
            docxStreams.delete(sessionId);
            return sink ? sink.abort() : false;
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
            const workingPath = await reserveBrowserDocumentWorkingCopy(sourceEntry.fileName, sourceRef ? parseDocumentRef(sourceRef) ?? undefined : undefined);
            try {
                if (sourceEntry.kind !== 'working') {
                    await browserDocumentStore.cloneAsWorkingCopy(sourceEntry.ref, sourceEntry.fileName, workingPath);
                } else {
                    await browserDocumentStore.cloneStoredDocument(sourceEntry.ref, {
                        ref: workingPath,
                        fileName: sourceEntry.fileName,
                        kind: 'working',
                        retention: 'transient',
                        ...(sourceRef ? {sourceRef} : {}),
                        saveKind: 'pdf',
                        saveHandle: null,
                    });
                }
                assertBrowserWorkingCopyDecrypted(await decryptBrowserWorkingCopy(workingPath, password));
                browserDocumentStore.unload(sourcePath);
                return workingPath;
            } catch (error) {
                await discardWorkingCopy(workingPath);
                throw error;
            }
        },
        async saveFileStructured(path, revisionOptions) {
            const result = await saveWorkingBytesToSourceStructured(
                path,
                revisionOptions,
            );
            if (result.ok) {
                await clearSearchCaches();
            }
            return result;
        },
        async cleanupFile(path) {
            await retireBrowserDocumentWorkingCopy(path);
            const entry = await browserDocumentStore.ensureEntry(path);
            if (!entry) {
                return;
            }

            for (const ref of new Set([
                path,
                entry.sourceRef ?? path,
            ])) {
                await browserDocumentStore.cleanupDetachedDocument(ref);
                await clearSearchCaches(ref);
            }
        },
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
                    await runSerializedRecentFilesStorageMutation(() => ({
                        files: validatedFiles,
                        value: undefined,
                    }));
                }

                return validatedFiles;
            },
            async remove(path) {
                await browserDocumentStore.removeRecentFile(path);
                await clearSearchCaches(path);
            },
            // Gone means its stored bytes are gone, or were kept only for the
            // session; storage that cannot answer keeps the entry.
            async removeIfMissing(path) {
                const {
                    available,
                    entry,
                } = await browserDocumentStore.ensureEntryAvailability(path);
                if (!available || (entry && entry.retention !== 'transient')) {
                    return false;
                }
                const removed = await browserDocumentStore.removeRecentFile(path);
                await clearSearchCaches(path);
                return removed;
            },
            async clear() {
                await browserDocumentStore.clearRecentFiles();
                await clearSearchCaches();
            },
            async readingView(workingCopy) {
                return (await browserSettingsCapability.get()).rememberDocumentView
                    ? browserDocumentStore.readRecentReadingView(workingCopy)
                    : null;
            },
            async rememberReadingView(workingCopy, view) {
                await browserDocumentStore.rememberRecentReadingView(workingCopy, view);
                return undefined;
            },
        },
        getPathForFile(file) {
            return browserDocumentStore.getRefForFile(file);
        },
        getPathsForFiles(files) {
            return files.map(file => browserDocumentStore.getRefForFile(file));
        },
        async registerFilesForOpen(files) {
            const refs: TDocumentRef[] = [];
            for (const file of files) {
                const ref = parseDocumentRef(await browserDocumentStore.registerFile(file));
                if (!ref) {
                    throw new Error('Browser file registration returned an invalid document reference');
                }
                refs.push(ref);
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
