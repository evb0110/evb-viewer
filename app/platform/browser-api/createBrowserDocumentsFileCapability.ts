import {closeBrowserWorkingCopyWork} from '@app/platform/browser-api/browserWorkingCopyClose';
import type {
    IDocumentMutationRevisionOptions,
    IDocumentsFileCapability,
    IPdfNativeSaveResult,
    IPdfOptimizeOptions,
    TPreparedPdfOptimizeCopy,
} from '@contracts/electronApiDocuments';
import {isPdfOptimizePreset} from '@contracts/electronApiDocuments';
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
import {syncBrowserWindowTitle} from '@app/platform/browserWindowTabs';
import {BrowserDocumentSourceChangedError} from '@app/platform/browser/browserDocumentRepository';
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
    getOptimizedPdfName,
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
    pickSaveTarget,
    pickSingleFile,
    type IBrowserOutputSink,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import { showBrowserDocumentInDownloads } from '@app/platform/browser-api/showBrowserDocumentInDownloads';
import {
    assertBrowserWorkingCopyDecrypted,
    createBrowserWorkingCopyFromBytes,
    decryptBrowserWorkingCopy,
    openDocumentPaths,
    startOpenedWorkingCopyClean,
} from '@app/platform/browser-api/browserWorkingCopyService';
import {
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
import {browserSettingsCapability} from '@app/platform/browser-api/browserSettingsCapability';
import {
    createBrowserStoreStagedArtifact,
    readBrowserStoreStagedArtifact,
    sha256Hex,
} from '@app/platform/browser/browserStagedArtifact';
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

type TPickedSaveTarget = Awaited<ReturnType<typeof pickSaveTarget>>;

/**
 * Opens the Optimize picker now, in the caller's task, so a click's user
 * activation reaches it: no await precedes the picker call.
 */
function pickOptimizeTarget(nameFrom: string) {
    return pickSaveTarget({
        suggestedName: getOptimizedPdfName(getBrowserDocumentFileName(nameFrom)),
        pickerTypes: buildPdfSaveTypes(),
    });
}

/** Optimize bound to the target it was picked for; it owns nothing else. */
function bindOptimizeTarget(target: TPickedSaveTarget): TPreparedPdfOptimizeCopy {
    return async (path, options, requestId, revisionOptions, signal) => {
        if (!isPdfOptimizePreset((options as Partial<IPdfOptimizeOptions> | undefined)?.preset)) {
            throw new Error('Invalid PDF optimize options');
        }
        const {optimizeBrowserPdfAsCopy} = await import('@app/platform/browser-api/optimizeBrowserPdfAsCopy');
        return optimizeBrowserPdfAsCopy(path, {preset: options.preset}, requestId, revisionOptions, {
            target,
            ...(signal ? {signal} : {}),
        });
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

    async function discardWorkingCopy(path: TDocumentRef, leaseId?: string) {
        if (leaseId !== undefined) browserNativeMutationLeases.delete(leaseId);
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
        const name = saveResult.handle?.name ?? normalizeName(saveResult.fileName);
        return browserDocumentStore.createStoredDocument(name, new Uint8Array(), {
            mimeType: saveKind === 'pdf' ? 'application/pdf' : DOCX_MIME_TYPE,
            saveKind,
            kind: 'output',
            retention: 'transient',
            saveHandle: saveResult.handle,
        });
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

    return {
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
            return isBrowserDocumentRef(path) ? openDocumentPaths([path], undefined, password) : null;
        },
        async openDocumentDirectBatch(paths, requestId) {
            return paths.every(path => isBrowserDocumentRef(path))
                ? openDocumentPaths(paths, requestId ? { requestId } : undefined)
                : null;
        },
        async savePdfAs(workingCopyPath, saveOptions, revisionOptions?) {
            return savePdfAsFromWorkingCopy(workingCopyPath, saveOptions, revisionOptions);
        },
        prepareOptimizePdfAsCopy(nameFrom) {
            return pickOptimizeTarget(nameFrom).then(target => (target.canceled ? null : bindOptimizeTarget(target)));
        },
        // A direct caller picks before any of its own work, as desktop does.
        async optimizePdfAsCopy(path, options, requestId, revisionOptions) {
            return bindOptimizeTarget(await pickOptimizeTarget(path))(path, options, requestId, revisionOptions);
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
            const stagedPath = await browserDocumentStore.createStoredDocument(stagedName, wasmResult.data, {
                mimeType: 'application/pdf',
                saveKind: 'pdf',
                kind: 'output',
                retention: 'transient',
            });
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
            stagedOutput,
            options,
        ) {
            if (!options?.expectedDocumentRevisionToken) {
                throw new Error('Browser staged PDF save requires the document revision');
            }
            const identityBindings = browserNativeMutationLeases.get(stagedOutput.leaseId)?.identityBindings;
            let committed: Awaited<ReturnType<typeof saveWorkingBytesToSource>>;
            try {
                committed = await saveWorkingBytesToSource(path, options, stagedOutput);
            } catch (error) {
                // The file changed since it was opened: a save result that offers Save As.
                if (!(error instanceof BrowserDocumentSourceChangedError)) throw error;
                return {
                    applied: false,
                    validation: null,
                    reason: 'original-changed',
                    externalWriteCommitted: false,
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
                documentRevision: committed,
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
        getDocumentRevision(path) {
            return browserDocumentStore.getDocumentRevision(path);
        },
        onDocumentRevisionChanged(callback) {
            return browserDocumentStore.onDocumentRevisionChanged(callback);
        },
        analyzePdfConformance: (path, options) => analyzeBrowserPdfConformance(path, options),
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
            if (!saved) return {
                ...validation,
                isValid: false,
                errors: [],
            };
            await clearSearchCaches();
            return validation;
        },
        // Streams a DOCX into the file chosen for `path`, or, without a file
        // handle, into `path`'s own record and then a download.
        async beginDocxFileStream(path) {
            const {
                saveHandle: handle, saveName,
            } = await browserDocumentStore.getSaveTarget(path);
            const sink = await openBrowserOutputSink({
                fileName: handle?.name ?? ensureDocxExtension(saveName),
                ...(handle ? {handle} : {stagingRef: path}),
            }, {mimeType: DOCX_MIME_TYPE});
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
            // A working copy's copy is a fork: an independent document with its bytes, baseline and drafts.
            const sourceEntry = await browserDocumentStore.requireEntry(sourcePath);
            const workingPath = await browserDocumentStore.cloneAsWorkingCopy(sourcePath);
            const workingEntry = await browserDocumentStore.requireEntry(workingPath);
            const sourceRef = originalPath && isBrowserDocumentRef(originalPath) ? parseDocumentRef(originalPath) : null;
            if (sourceRef) workingEntry.sourceRef = sourceRef;
            try {
                assertBrowserWorkingCopyDecrypted(await decryptBrowserWorkingCopy(workingPath, password));
                if (sourceEntry.kind !== 'working') {
                    await startOpenedWorkingCopyClean(workingPath);
                    browserDocumentStore.unload(sourcePath);
                }
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
            await closeBrowserWorkingCopyWork(path);
            const sourceRef = await browserDocumentStore.getSourceRef(path).catch(() => path);
            for (const ref of new Set([
                path,
                sourceRef,
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
        showItemInFolder: showBrowserDocumentInDownloads,
        recentFiles: {
            // An entry whose file or stored copy is gone leaves the list; storage that cannot answer keeps it.
            async get() {
                const recentFiles = browserDocumentStore.getRecentFiles();
                const kept: IRecentFile[] = [];
                for (const file of recentFiles) {
                    const stored = await browserDocumentStore.isStored(file.originalPath).catch(() => true);
                    if (stored) kept.push(file);
                    else await browserDocumentStore.removeRecentFile(file.originalPath);
                }
                return kept;
            },
            async remove(path) {
                await browserDocumentStore.removeRecentFile(path);
                await clearSearchCaches(path);
            },
            // Gone means its file or stored copy is gone; storage that cannot answer keeps the entry.
            async removeIfMissing(path) {
                if (await browserDocumentStore.isStored(path).catch(() => true)) {
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
}
