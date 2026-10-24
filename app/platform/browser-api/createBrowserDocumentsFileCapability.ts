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
import type { IRecentFile } from '@contracts/shared';
import {
    BROWSER_MAX_FULL_READ_BYTES,
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
} from '@app/platform/browser-api/browserFileName';
import type { IBrowserBatchOpenProgressOptions } from '@app/platform/browser-api/createCombinedPdfFromPaths';
import {
    analyzeBrowserPdfConformance,
    validateBrowserPdfData,
    validateBrowserPdfPath,
} from '@app/platform/browser-api/browserPdfValidation';
import {
    pickFiles,
    pickSaveTarget,
    pickSingleFile,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {
    assertBrowserWorkingCopyDecrypted,
    createBrowserWorkingCopyFromBytes,
    decryptBrowserWorkingCopy,
    openDocumentPaths,
} from '@app/platform/browser-api/browserWorkingCopyService';
import {
    assertBrowserPathWithinFullReadBudget,
    savePdfAsFromWorkingCopy,
    saveWorkingBytesToSource,
    saveWorkingBytesToSourceStructured,
} from '@app/platform/browser-api/browserSaveTargets';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import { decodeBrowserPdfAnnotationsOutput } from '@app/platform/browser-api/decodeBrowserPdfAnnotationsOutput';
import {runSerializedRecentFilesStorageMutation} from '@app/platform/browser/browserRecentFilesStore';
import {
    createBrowserStoreStagedArtifact,
    sha256Hex,
} from '@app/platform/browser/browserStagedArtifact';
import {isBrowserStoreStagedArtifact} from '@contracts/stagedArtifacts';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {nativePdfSemanticScope} from '@contracts/nativePdfSemanticScope';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {REQUEST_HEADER} from '@contracts/browserPageOpsWasm.generated';
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
    errorMessageProvider?: {
        largeSaveHandleHint: () => string;
        useNativeApp?: () => string;
    };
}
type TCanonicalDocumentsFileCapability = IDocumentsFileCapability;

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
    const browserNativeMutationLeases = new Map<string, IBrowserNativeMutationLease>();
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
                return await openDocumentPaths([registered.ref]);
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
                return await openDocumentPaths(refs);
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
            return savePdfAsFromWorkingCopy(workingCopyPath, revisionOptions, saveOptions?.stagedOutput, browserUseNativeAppMessageProvider());
        },
        savePdfDialog: suggestedName => pickOutputTarget(suggestedName, 'pdf'),
        saveDocxAs: workingCopyPath => pickOutputTarget(
            getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
            'docx',
        ),
        readFile: path => browserDocumentStore.read(path),
        async readPdfPageLabelRanges(path) {
            await assertBrowserPathWithinFullReadBudget(
                path,
                'Reading PDF page labels',
                `. ${browserUseNativeAppMessageProvider()}`,
            );
            const data = await browserDocumentStore.read(path);
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
            const originalAppearanceSource = mutations.originalAppearanceSource;
            if (originalAppearanceSource) await assertBrowserPathWithinFullReadBudget(originalAppearanceSource, 'Restoring text appearances', `. ${browserUseNativeAppMessageProvider()}`);
            const originalAppearanceSourceData = originalAppearanceSource ? await browserDocumentStore.read(originalAppearanceSource) : undefined;
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
            if (wasmResult.data.byteLength > BROWSER_MAX_FULL_READ_BYTES) {
                throw new Error(
                    `Saving documents is unavailable in the browser for inputs larger than ${BROWSER_MAX_FULL_READ_BYTES / (1024 * 1024)}MB. ${browserUseNativeAppMessageProvider()}`,
                );
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
                await retireBrowserDocumentWorkingCopy(stagedPath);
                await browserDocumentStore.remove(stagedPath).catch(() => undefined);
                throw error;
            }
        },
        async releaseManagedTempFileHandle(leaseId) {
            const stagedPath = browserNativeMutationLeases.get(leaseId)?.path;
            if (!stagedPath) {
                return false;
            }
            browserNativeMutationLeases.delete(leaseId);
            await retireBrowserDocumentWorkingCopy(stagedPath);
            await browserDocumentStore.remove(stagedPath).catch(() => undefined);
            return true;
        },
        async cloneStagedPdfNativeMutationToWorkingCopy(stagedOutput, originalPath) {
            if (!isBrowserStoreStagedArtifact(stagedOutput)) {
                throw new Error('Expected a browser-store staged artifact');
            }
            const bytes = await browserDocumentStore.read(stagedOutput.path);
            if (bytes.byteLength !== stagedOutput.size || await sha256Hex(bytes) !== stagedOutput.sha256) {
                throw new Error('Browser staged artifact content does not match its receipt');
            }
            const clonePath = await createBrowserWorkingCopyFromBytes({
                fileName: getBrowserDocumentFileName(stagedOutput.path),
                data: bytes,
                ...(originalPath ? {sourceRef: originalPath} : {}),
            });
            browserNativeMutationLeases.delete(stagedOutput.leaseId);
            await retireBrowserDocumentWorkingCopy(stagedOutput.path);
            await browserDocumentStore.remove(stagedOutput.path).catch(() => undefined);
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
            let committed: boolean;
            try {
                committed = await saveWorkingBytesToSource(path, browserUseNativeAppMessageProvider, options, stagedOutput);
            } catch (error) {
                browserNativeMutationLeases.delete(stagedOutput.leaseId);
                await retireBrowserDocumentWorkingCopy(stagedOutput.path);
                await browserDocumentStore.remove(stagedOutput.path).catch(() => undefined);
                throw error;
            }
            if (!committed) {
                browserNativeMutationLeases.delete(stagedOutput.leaseId);
                await retireBrowserDocumentWorkingCopy(stagedOutput.path);
                await browserDocumentStore.remove(stagedOutput.path).catch(() => undefined);
                return {
                    applied: false,
                    validation: null,
                } satisfies IPdfNativeSaveResult;
            }
            const identityBindings = browserNativeMutationLeases.get(stagedOutput.leaseId)?.identityBindings;
            browserNativeMutationLeases.delete(stagedOutput.leaseId);
            await retireBrowserDocumentWorkingCopy(stagedOutput.path);
            await browserDocumentStore.remove(stagedOutput.path).catch(() => undefined);
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
        analyzePdfConformance(path) {
            const analysis = analyzeBrowserPdfConformance(path);
            handoffBrowserDocumentWorkingCopy(path, path, () => analysis.then(() => undefined, () => undefined));
            return analysis;
        },
        validatePdfPath: path => validateBrowserPdfPath(path),
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
                await retireBrowserDocumentWorkingCopy(workingPath);
                await browserDocumentStore.remove(workingPath).catch(() => undefined);
                throw error;
            }
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
            // A browser document's stored bytes are refreshed from its file
            // handle without an admission identity, so no view is kept for it.
            readingView: () => Promise.resolve(null),
            rememberReadingView: () => Promise.resolve(undefined),
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
