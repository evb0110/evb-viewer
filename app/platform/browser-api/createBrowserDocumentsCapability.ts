import type {IDocxExportFileCapability} from '@contracts/docxExport';
import type {
    IDocumentsFileCapability,
    IDocumentsFileIoCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
    IPdfOptimizeOptions,
    TPreparedPdfOptimizeCopy,
} from '@contracts/electronApiDocuments';
import {isPdfOptimizePreset} from '@contracts/electronApiDocuments';
import type {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import type {TPageOpsPageSelection} from '@contracts/electronApiPageOps';
import type {TFeatureBrowserBindings} from '@contracts/platformFeature';
import type {IImageExportCapability} from '@contracts/imageExportPlatformFeature';
import type {IPageOpsCapability} from '@contracts/pageOpsPlatformFeature';
import type {TDocumentRef} from '@contracts/documentRef';
import type {IRecentFile} from '@contracts/shared';
import {
    OPEN_IMAGE_ACCEPT,
    OPEN_INPUT_ACCEPT,
    OPEN_PDF_IMAGE_ACCEPT,
    buildDocxSaveTypes,
    buildImagePickerTypes,
    buildOpenPdfImagePickerTypes,
    buildOpenPdfPickerTypes,
    buildPdfSaveTypes,
    configureBrowserFilePickerDescriptions,
    type TBrowserFilePickerDescriptionKey,
} from '@app/platform/browser-api/browserFileAccepts';
import {ensureDocxExtension, ensurePdfExtension, getOptimizedPdfName} from '@app/platform/browser-api/browserFileName';
import {
    configureBrowserFilePickerMessages,
    pickFiles,
    pickSaveTarget,
    pickSingleFile,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
    type IPickedBrowserFile,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {browserSettingsCapability} from '@app/platform/browser-api/browserSettingsCapability';
import {createBrowserImageExportCapability} from '@app/platform/browser-api/createBrowserImageExportCapability';
import {browserDocumentsMenuCapability, onBrowserOpenDocumentDirectBatchProgress} from '@app/platform/browser-api/documentsMenuCapability';
import {browserDocumentStore, getBrowserDocumentFileName} from '@app/platform/browserDocumentStore';
import {syncBrowserWindowTitle} from '@app/platform/browserWindowTabs';
import type {TLocale, TTranslateFn, TTranslationKey} from '@i18n-app';
import {
    DEFAULT_LOCALE,
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    isLocaleMessageSource,
    isSupportedLocale,
    normalizeTranslationParams,
    resolveLocale,
} from '@i18n-core';
import {safeDecodeURIComponent} from '@app/utils/browserSafe';

interface ICreateBrowserDocumentsCapabilityOptions {
    clearSearchCaches: (pdfPath?: string) => void | Promise<void>;
}

export interface IBrowserDocumentCapabilities {
    documentPicker: IDocumentsPickerCapability;
    documentOpen: IDocumentsOpenCapability;
    documentWorkingCopy: IDocumentsWorkingCopyCapability;
    documentFiles: IDocumentsFileIoCapability & IDocxExportFileCapability;
    documentPdf: IDocumentsPdfCapability;
    documentRecentFiles: IDocumentsRecentFilesCapability;
    documentWindow: IDocumentsWindowCapability;
    documentMenu: IDocumentsMenuCapability;
    imageExport: IImageExportCapability;
    pageOps: IPageOpsCapability;
}

type TLoadedDocumentsFileCapability = IDocumentsFileCapability & IDocxExportFileCapability;
type TPickedSaveTarget = Awaited<ReturnType<typeof pickSaveTarget>>;

interface IPendingPreLoadPageOperation {
    workingCopyPath: string;
    canceled: boolean;
    cancel: () => void;
}

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const CANCELED_PAGE_OP_RESULT = {
    success: false,
    canceled: true,
} as const;

function hasSelectedPagesForExtract(pages: TPageOpsPageSelection) {
    if (Array.isArray(pages)) {
        return pages.length > 0;
    }
    return pages.ranges.some((range) => range.endPage >= range.startPage);
}

function getBrowserLocale(): TLocale {
    const cookieMatch = typeof document !== 'undefined' ? document.cookie.match(/(?:^|;\s*)i18n_redirected=([^;]+)/u) : null;
    const cookieLocale = cookieMatch?.[1] ? safeDecodeURIComponent(cookieMatch[1]) : null;

    if (cookieLocale) {
        if (isSupportedLocale(cookieLocale)) {
            return resolveLocale(cookieLocale);
        }
    }

    return typeof navigator !== 'undefined' ? resolveLocale(navigator.language) : DEFAULT_LOCALE;
}

// Read messages from the already-loaded vue-i18n composer so resolving this capability
// does not download every locale pack.
const translateBrowserMessage: TTranslateFn = (key, ...args) => {
    const params = normalizeTranslationParams(args[0]);
    const locale = getBrowserLocale();
    const composer: unknown = typeof tryUseNuxtApp === 'function' ? tryUseNuxtApp()?.$i18n : undefined;
    const leaf = isLocaleMessageSource(composer)
        ? (getNestedTranslationLeaf(composer.getLocaleMessage(locale), key) ??
          getNestedTranslationLeaf(composer.getLocaleMessage(DEFAULT_LOCALE), key) ??
          key)
        : key;

    return formatTranslationLeaf(leaf, params, locale);
};

const BROWSER_FILE_PICKER_DESCRIPTION_MESSAGE_KEYS = {
    documents: 'browser.filePicker.documents',
    images: 'browser.filePicker.images',
    pdfDocuments: 'browser.filePicker.pdfDocuments',
    wordDocuments: 'browser.filePicker.wordDocuments',
    jpegImages: 'browser.filePicker.jpegImages',
    pngImages: 'browser.filePicker.pngImages',
    tiffImages: 'browser.filePicker.tiffImages',
} as const satisfies Record<TBrowserFilePickerDescriptionKey, TTranslationKey>;

function pickOptimizeTarget(nameFrom: string) {
    return pickSaveTarget({
        suggestedName: getOptimizedPdfName(getBrowserDocumentFileName(nameFrom)),
        pickerTypes: buildPdfSaveTypes(),
    });
}

function bindOptimizeTarget(target: TPickedSaveTarget): TPreparedPdfOptimizeCopy {
    return async (path, optimizeOptions, requestId, revisionOptions, signal) => {
        if (!isPdfOptimizePreset((optimizeOptions as Partial<IPdfOptimizeOptions> | undefined)?.preset)) {
            throw new Error('Invalid PDF optimize options');
        }
        const {optimizeBrowserPdfAsCopy} = await import('@app/platform/browser-api/optimizeBrowserPdfAsCopy');
        return optimizeBrowserPdfAsCopy(path, {preset: optimizeOptions.preset}, requestId, revisionOptions, {
            target,
            ...(signal ? {signal} : {}),
        });
    };
}

export function createBrowserDocumentsCapability(options: ICreateBrowserDocumentsCapabilityOptions): IBrowserDocumentCapabilities {
    configureBrowserFilePickerMessages({
        saveExtensionMismatch: (extensions: string) => translateBrowserMessage('errors.browser.saveExtensionMismatch', {extensions}),
    });
    configureBrowserFilePickerDescriptions((key) => translateBrowserMessage(BROWSER_FILE_PICKER_DESCRIPTION_MESSAGE_KEYS[key]));

    let loadedFileCapability: TLoadedDocumentsFileCapability | null = null;
    let fileCapabilityPromise: Promise<TLoadedDocumentsFileCapability> | null = null;
    let loadedPageOpsCapability: IPageOpsCapability | null = null;
    let pageOpsPromise: Promise<IPageOpsCapability> | null = null;
    const pendingPreLoadPageOps = new Set<IPendingPreLoadPageOperation>();
    let prePickedExtractTarget: {suggestedName: string; result: TPickedSaveTarget} | null = null;
    // Keep image export eager so capture-handle registration has one owner and
    // export/snip pickers always run synchronously inside transient user activation.
    const imageExport = createBrowserImageExportCapability();

    function loadFileCapability(): Promise<TLoadedDocumentsFileCapability> {
        if (loadedFileCapability) {
            return Promise.resolve(loadedFileCapability);
        }
        fileCapabilityPromise ??= import('@app/platform/browser-api/createBrowserDocumentsFileCapability')
            .then(({createBrowserDocumentsFileCapability}) => {
                const capability = createBrowserDocumentsFileCapability(options);
                loadedFileCapability = capability;
                return capability;
            })
            .catch((error: unknown) => {
                fileCapabilityPromise = null;
                throw error;
            });
        return fileCapabilityPromise;
    }

    function prewarmFileCapability() {
        if (!loadedFileCapability && !fileCapabilityPromise) {
            void loadFileCapability().catch(() => undefined);
        }
    }

    function loadPageOpsCapability(): Promise<IPageOpsCapability> {
        if (loadedPageOpsCapability) {
            return Promise.resolve(loadedPageOpsCapability);
        }
        pageOpsPromise ??= Promise.all([
            import('@app/platform/browser-api/createBrowserDocumentsFileCapability'),
            import('@app/platform/browser-api/createBrowserPageOpsCapability'),
            import('@app/platform/browser-api/browserWorkingCopyService'),
        ])
            .then(([{createBrowserCombinedPdfFromPaths}, {createBrowserPageOpsCapability}, {repairBrowserWorkingCopy}]) => {
                const capability = createBrowserPageOpsCapability({
                    clearSearchCaches: options.clearSearchCaches,
                    openInputAccept: OPEN_PDF_IMAGE_ACCEPT,
                    pickFiles,
                    buildOpenPdfPickerTypes: buildOpenPdfImagePickerTypes,
                    createCombinedPdfFromPaths: createBrowserCombinedPdfFromPaths,
                    pickSaveTarget: (pickerOptions) => {
                        if (prePickedExtractTarget && prePickedExtractTarget.suggestedName === pickerOptions.suggestedName) {
                            const matched = prePickedExtractTarget.result;
                            prePickedExtractTarget = null;
                            return Promise.resolve(matched);
                        }
                        return pickSaveTarget(pickerOptions);
                    },
                    saveBytesToPickerOrDownload,
                    writeBytesToHandle,
                    repairWorkingCopy: repairBrowserWorkingCopy,
                });
                loadedPageOpsCapability = capability;
                return capability;
            })
            .catch((error: unknown) => {
                pageOpsPromise = null;
                throw error;
            });
        return pageOpsPromise;
    }

    function registerPreLoadPageOp(workingCopyPath: string) {
        const canceled = Promise.withResolvers<null>();
        const pendingOp: IPendingPreLoadPageOperation = {
            workingCopyPath,
            canceled: false,
            cancel: () => {
                pendingOp.canceled = true;
                canceled.resolve(null);
            },
        };
        pendingPreLoadPageOps.add(pendingOp);
        return {
            pendingOp,
            canceledPromise: canceled.promise,
        };
    }

    async function runCancellablePageOp<TResult>(
        workingCopyPath: string,
        run: (capability: IPageOpsCapability) => Promise<TResult>,
    ): Promise<TResult | typeof CANCELED_PAGE_OP_RESULT> {
        if (loadedPageOpsCapability) {
            return run(loadedPageOpsCapability);
        }
        const {pendingOp, canceledPromise} = registerPreLoadPageOp(workingCopyPath);
        try {
            const capability = await Promise.race([loadPageOpsCapability(), canceledPromise]);
            if (pendingOp.canceled || capability === null) {
                return CANCELED_PAGE_OP_RESULT;
            }
            pendingPreLoadPageOps.delete(pendingOp);
            return await run(capability);
        } finally {
            pendingPreLoadPageOps.delete(pendingOp);
        }
    }

    async function cleanupTransientOpenRefs(paths: string[]) {
        await Promise.all(paths.map((path) => browserDocumentStore.remove(path).catch(() => undefined)));
    }

    async function openPickedDocument(picked: IPickedBrowserFile, djvuComponents?: readonly File[]) {
        const registered = await browserDocumentStore.registerFileWithOwnership(picked.file, {
            kind: 'source',
            saveKind: 'pdf',
            saveHandle: picked.handle ?? null,
        });
        try {
            const [{openDocumentPaths}, djvuModule] = await Promise.all([
                import('@app/platform/browser-api/browserWorkingCopyService'),
                djvuComponents ? import('@app/platform/browser-api/browserDjvuComponents') : Promise.resolve(null),
            ]);
            if (djvuComponents && djvuModule) {
                djvuModule.setBrowserDjvuComponentFiles(registered.ref, djvuComponents);
            }
            prewarmFileCapability();
            return await openDocumentPaths([registered.ref]);
        } catch (error) {
            if (registered.created) {
                await cleanupTransientOpenRefs([registered.ref]);
            }
            throw error;
        }
    }

    async function openPickedBatch(pickedFiles: IPickedBrowserFile[]) {
        const refs: string[] = [];
        try {
            for (const picked of pickedFiles) {
                const ref = await browserDocumentStore.registerFile(picked.file, {
                    kind: 'source',
                    retention: 'transient',
                    saveKind: 'generic',
                    saveHandle: null,
                });
                refs.push(ref);
            }
            prewarmFileCapability();
            const {openDocumentPaths} = await import('@app/platform/browser-api/browserWorkingCopyService');
            return await openDocumentPaths(refs);
        } catch (error) {
            await cleanupTransientOpenRefs(refs);
            throw error;
        }
    }

    async function pickOutputTarget(suggestedName: string, saveKind: 'pdf' | 'docx') {
        const normalizeName = saveKind === 'pdf' ? ensurePdfExtension : ensureDocxExtension;
        // Invoke the picker synchronously in the caller's task before any dynamic import.
        const saveResult = await pickSaveTarget({
            suggestedName: normalizeName(suggestedName),
            pickerTypes: saveKind === 'pdf' ? buildPdfSaveTypes() : buildDocxSaveTypes(),
        });
        if (saveResult.canceled) {
            return null;
        }
        const name = saveResult.handle?.name ?? normalizeName(saveResult.fileName);
        return browserDocumentStore.createStoredDocument(name, new Uint8Array(), {
            mimeType: saveKind === 'pdf' ? 'application/pdf' : DOCX_MIME_TYPE,
            saveKind,
            kind: 'output',
            retention: 'transient',
            saveHandle: saveResult.handle,
        });
    }

    const documentPicker = {
        async openDocumentDialog() {
            // Invoke the picker before any dynamic import so transient user activation reaches it.
            const pickedFiles = await pickFiles({
                accept: OPEN_INPUT_ACCEPT,
                multiple: true,
                pickerTypes: buildOpenPdfPickerTypes(),
            });
            if (pickedFiles.length === 0) {
                return null;
            }
            const {findIndirectDjvuSelection} = await import('@app/platform/browser-api/browserDjvuComponents');
            const indirectDjvu = await findIndirectDjvuSelection<IPickedBrowserFile>(pickedFiles);
            if (pickedFiles.length > 1 && !indirectDjvu) {
                return openPickedBatch(pickedFiles);
            }
            const picked = indirectDjvu?.index ?? pickedFiles[0];
            return picked ? openPickedDocument(picked, indirectDjvu?.components) : null;
        },
        async openCombineDialog() {
            // Invoke the picker before any dynamic import so transient user activation reaches it.
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
        getPathForFile: (file) => browserDocumentStore.getRefForFile(file),
        getPathsForFiles: (files) => files.map((file) => browserDocumentStore.getRefForFile(file)),
        registerFilesForOpen: (files) =>
            loadedFileCapability
                ? loadedFileCapability.registerFilesForOpen(files)
                : loadFileCapability().then((capability) => capability.registerFilesForOpen(files)),
        createCombinedPdfFromFiles: (files, combineOptions) =>
            loadedFileCapability
                ? loadedFileCapability.createCombinedPdfFromFiles!(files, combineOptions)
                : loadFileCapability().then((capability) => capability.createCombinedPdfFromFiles!(files, combineOptions)),
    } satisfies IDocumentsPickerCapability & TFeatureBrowserBindings<typeof DOCUMENT_PICKER_PLATFORM_FEATURE>;

    const documentOpen = {
        openDocumentDirect: (path, request?) =>
            loadedFileCapability
                ? loadedFileCapability.openDocumentDirect(path, request)
                : loadFileCapability().then((capability) => capability.openDocumentDirect(path, request)),
        openDocumentDirectBatch: (paths, requestId) =>
            loadedFileCapability
                ? loadedFileCapability.openDocumentDirectBatch(paths, requestId)
                : loadFileCapability().then((capability) => capability.openDocumentDirectBatch(paths, requestId)),
        onOpenDocumentDirectBatchProgress: onBrowserOpenDocumentDirectBatchProgress,
    } satisfies IDocumentsOpenCapability & TFeatureBrowserBindings<typeof DOCUMENT_OPEN_PLATFORM_FEATURE>;

    const documentWorkingCopy = {
        createWorkingCopyFromData: (fileName, data, originalPath, password) =>
            loadedFileCapability
                ? loadedFileCapability.createWorkingCopyFromData(fileName, data, originalPath, password)
                : loadFileCapability().then((capability) => capability.createWorkingCopyFromData(fileName, data, originalPath, password)),
        createWorkingCopyFromPath: (sourcePath, originalPath, password) =>
            loadedFileCapability
                ? loadedFileCapability.createWorkingCopyFromPath(sourcePath, originalPath, password)
                : loadFileCapability().then((capability) => capability.createWorkingCopyFromPath(sourcePath, originalPath, password)),
        parsePdfAnnotations: (path, parseOptions) =>
            loadedFileCapability
                ? loadedFileCapability.parsePdfAnnotations(path, parseOptions)
                : loadFileCapability().then((capability) => capability.parsePdfAnnotations(path, parseOptions)),
        restoreDocumentRevision: (path, revision, revisionOptions) =>
            browserDocumentStore.restoreRevision(path, revision, revisionOptions?.expectedDocumentRevisionToken),
        retainDocumentRevisions: (path, revisions) => browserDocumentStore.retainRevisions(path, revisions),
        cleanupFile: (path) =>
            loadedFileCapability
                ? loadedFileCapability.cleanupFile(path)
                : loadFileCapability().then((capability) => capability.cleanupFile(path)),
    } satisfies IDocumentsWorkingCopyCapability;

    const documentFiles = {
        readFile: (path) => browserDocumentStore.read(path),
        readPdfPageLabelRanges: (path) =>
            loadedFileCapability
                ? loadedFileCapability.readPdfPageLabelRanges(path)
                : loadFileCapability().then((capability) => capability.readPdfPageLabelRanges(path)),
        statFile: (path) =>
            loadedFileCapability
                ? loadedFileCapability.statFile(path)
                : loadFileCapability().then((capability) => capability.statFile(path)),
        readFileRange: (path, offset, length) => browserDocumentStore.readRange(path, offset, length),
        getDocumentRevision: (path) => browserDocumentStore.getDocumentRevision(path),
        onDocumentRevisionChanged: (callback) => browserDocumentStore.onDocumentRevisionChanged(callback),
        savePdfAs: (workingCopyPath, saveOptions, revisionOptions) =>
            loadedFileCapability
                ? loadedFileCapability.savePdfAs(workingCopyPath, saveOptions, revisionOptions)
                : loadFileCapability().then((capability) => capability.savePdfAs(workingCopyPath, saveOptions, revisionOptions)),
        savePdfDialog: (suggestedName) => pickOutputTarget(suggestedName, 'pdf'),
        saveDocxAs: (workingCopyPath) => pickOutputTarget(getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''), 'docx'),
        writeFile: (path, data, writeOptions) =>
            loadedFileCapability
                ? loadedFileCapability.writeFile(path, data, writeOptions)
                : loadFileCapability().then((capability) => capability.writeFile(path, data, writeOptions)),
        replaceWorkingCopyFromPath: (workingCopyPath, sourcePath, replaceOptions) =>
            loadedFileCapability
                ? loadedFileCapability.replaceWorkingCopyFromPath(workingCopyPath, sourcePath, replaceOptions)
                : loadFileCapability().then((capability) =>
                      capability.replaceWorkingCopyFromPath(workingCopyPath, sourcePath, replaceOptions),
                  ),
        beginDocxFileStream: (path) =>
            loadedFileCapability
                ? loadedFileCapability.beginDocxFileStream(path)
                : loadFileCapability().then((capability) => capability.beginDocxFileStream(path)),
        writeDocxFileStreamChunk: (sessionId, chunk) =>
            loadedFileCapability
                ? loadedFileCapability.writeDocxFileStreamChunk(sessionId, chunk)
                : loadFileCapability().then((capability) => capability.writeDocxFileStreamChunk(sessionId, chunk)),
        commitDocxFileStream: (sessionId) =>
            loadedFileCapability
                ? loadedFileCapability.commitDocxFileStream(sessionId)
                : loadFileCapability().then((capability) => capability.commitDocxFileStream(sessionId)),
        cancelDocxFileStream: (sessionId) =>
            loadedFileCapability
                ? loadedFileCapability.cancelDocxFileStream(sessionId)
                : loadFileCapability().then((capability) => capability.cancelDocxFileStream(sessionId)),
        saveFileStructured: (path, revisionOptions) =>
            loadedFileCapability
                ? loadedFileCapability.saveFileStructured(path, revisionOptions)
                : loadFileCapability().then((capability) => capability.saveFileStructured(path, revisionOptions)),
        savePdfData: (path, data, saveOptions, commitCallbacks) =>
            loadedFileCapability
                ? loadedFileCapability.savePdfData(path, data, saveOptions, commitCallbacks)
                : loadFileCapability().then((capability) => capability.savePdfData(path, data, saveOptions, commitCallbacks)),
        getPdfNativePageSizes: (path, pageSizeOptions) =>
            loadedFileCapability
                ? loadedFileCapability.getPdfNativePageSizes!(path, pageSizeOptions)
                : loadFileCapability().then((capability) => capability.getPdfNativePageSizes!(path, pageSizeOptions)),
        releaseManagedTempFileHandle: (leaseId) =>
            loadedFileCapability
                ? loadedFileCapability.releaseManagedTempFileHandle!(leaseId)
                : loadFileCapability().then((capability) => capability.releaseManagedTempFileHandle!(leaseId)),
        cloneStagedPdfNativeMutationToWorkingCopy: (stagedOutput, originalPath) =>
            loadedFileCapability
                ? loadedFileCapability.cloneStagedPdfNativeMutationToWorkingCopy!(stagedOutput, originalPath)
                : loadFileCapability().then((capability) =>
                      capability.cloneStagedPdfNativeMutationToWorkingCopy!(stagedOutput, originalPath),
                  ),
        // Invoke the save picker synchronously in the caller's task before loading the optimizer.
        optimizePdfAsCopy: async (path, optimizeOptions, requestId, revisionOptions) => {
            const target = await pickOptimizeTarget(path);
            return bindOptimizeTarget(target)(path, optimizeOptions, requestId, revisionOptions);
        },
        prepareOptimizePdfAsCopy: (nameFrom) =>
            pickOptimizeTarget(nameFrom).then((target) => (target.canceled ? null : bindOptimizeTarget(target))),
        applyPdfNativeMutationsToWorkingCopy: (path, mutations, modifiedAt, mutationOptions) =>
            loadedFileCapability
                ? loadedFileCapability.applyPdfNativeMutationsToWorkingCopy!(path, mutations, modifiedAt, mutationOptions)
                : loadFileCapability().then((capability) =>
                      capability.applyPdfNativeMutationsToWorkingCopy!(path, mutations, modifiedAt, mutationOptions),
                  ),
        commitStagedPdfNativeMutations: (path, stagedOutput, commitOptions) =>
            loadedFileCapability
                ? loadedFileCapability.commitStagedPdfNativeMutations!(path, stagedOutput, commitOptions)
                : loadFileCapability().then((capability) => capability.commitStagedPdfNativeMutations!(path, stagedOutput, commitOptions)),
        replaceWorkingCopyFromStagedPdfNativeMutation: (path, stagedOutput, replaceOptions) =>
            loadedFileCapability
                ? loadedFileCapability.replaceWorkingCopyFromStagedPdfNativeMutation!(path, stagedOutput, replaceOptions)
                : loadFileCapability().then((capability) =>
                      capability.replaceWorkingCopyFromStagedPdfNativeMutation!(path, stagedOutput, replaceOptions),
                  ),
    } satisfies IDocumentsFileIoCapability & IDocxExportFileCapability;

    const documentPdf = {
        analyzePdfConformance: (path, conformanceOptions) =>
            loadedFileCapability
                ? loadedFileCapability.analyzePdfConformance(path, conformanceOptions)
                : loadFileCapability().then((capability) => capability.analyzePdfConformance(path, conformanceOptions)),
        validatePdfPath: (path, validationOptions) =>
            loadedFileCapability
                ? loadedFileCapability.validatePdfPath(path, validationOptions)
                : loadFileCapability().then((capability) => capability.validatePdfPath(path, validationOptions)),
        printPdfData: (...args) =>
            loadedFileCapability
                ? loadedFileCapability.printPdfData(...args)
                : loadFileCapability().then((capability) => capability.printPdfData(...args)),
        printPdfPath: (path, printOptions) =>
            loadedFileCapability
                ? loadedFileCapability.printPdfPath(path, printOptions)
                : loadFileCapability().then((capability) => capability.printPdfPath(path, printOptions)),
    } satisfies IDocumentsPdfCapability;

    const recentFiles = {
        async get() {
            const entries = browserDocumentStore.getRecentFiles();
            const kept: IRecentFile[] = [];
            for (const file of entries) {
                const stored = await browserDocumentStore.isStored(file.originalPath).catch(() => true);
                if (stored) {
                    kept.push(file);
                } else {
                    await browserDocumentStore.removeRecentFile(file.originalPath);
                }
            }
            return kept;
        },
        async removeIfMissing(path: TDocumentRef) {
            if (await browserDocumentStore.isStored(path).catch(() => true)) {
                return false;
            }
            const removed = await browserDocumentStore.removeRecentFile(path);
            await options.clearSearchCaches(path);
            return removed;
        },
        async readingView(workingCopy: TDocumentRef) {
            return (await browserSettingsCapability.get()).rememberDocumentView
                ? browserDocumentStore.readRecentReadingView(workingCopy)
                : null;
        },
        async rememberReadingView(workingCopy: TDocumentRef, view) {
            await browserDocumentStore.rememberRecentReadingView(workingCopy, view);
            return undefined;
        },
        async remove(path: TDocumentRef) {
            await browserDocumentStore.removeRecentFile(path);
            await options.clearSearchCaches(path);
            return undefined;
        },
        async clear() {
            await browserDocumentStore.clearRecentFiles();
            await options.clearSearchCaches();
            return undefined;
        },
    } satisfies TFeatureBrowserBindings<typeof DOCUMENT_RECENT_FILES_PLATFORM_FEATURE>;

    const documentRecentFiles = {recentFiles} satisfies IDocumentsRecentFilesCapability;

    const documentWindow = {
        setWindowTitle(title: string) {
            if (typeof document !== 'undefined') {
                document.title = title;
            }
            syncBrowserWindowTitle();
            return Promise.resolve(undefined);
        },
        showItemInFolder: (path) =>
            loadedFileCapability
                ? loadedFileCapability.showItemInFolder(path)
                : loadFileCapability().then((capability) => capability.showItemInFolder(path)),
    } satisfies IDocumentsWindowCapability & TFeatureBrowserBindings<typeof DOCUMENT_WINDOW_PLATFORM_FEATURE>;

    const documentMenu = {...browserDocumentsMenuCapability} satisfies IDocumentsMenuCapability &
        TFeatureBrowserBindings<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;

    const pageOps: IPageOpsCapability = {
        renderTextBoxAppearance: (workingCopyPath, request, renderOptions) =>
            loadedPageOpsCapability
                ? loadedPageOpsCapability.renderTextBoxAppearance(workingCopyPath, request, renderOptions)
                : loadPageOpsCapability().then((capability) => capability.renderTextBoxAppearance(workingCopyPath, request, renderOptions)),
        delete: (workingCopyPath, pages, totalPages, mutationOptions) =>
            runCancellablePageOp(workingCopyPath, (capability) => capability.delete(workingCopyPath, pages, totalPages, mutationOptions)),
        deleteRanges: (workingCopyPath, ranges, totalPages, mutationOptions) =>
            runCancellablePageOp(workingCopyPath, (capability) =>
                capability.deleteRanges(workingCopyPath, ranges, totalPages, mutationOptions),
            ),
        extract: (workingCopyPath, pages) => {
            if (loadedPageOpsCapability) {
                return loadedPageOpsCapability.extract(workingCopyPath, pages);
            }
            if (!hasSelectedPagesForExtract(pages)) {
                return runCancellablePageOp(workingCopyPath, (capability) => capability.extract(workingCopyPath, pages));
            }
            // Register for cancellation and invoke the save picker synchronously
            // before any dynamic import so transient user activation reaches it.
            const {pendingOp, canceledPromise} = registerPreLoadPageOp(workingCopyPath);
            const sourceName = getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, '');
            const suggestedName = ensurePdfExtension(`${sourceName}-extract`);
            const saveTargetPromise = pickSaveTarget({
                suggestedName,
                pickerTypes: buildPdfSaveTypes(),
            });
            const loadPromise = loadPageOpsCapability();
            void saveTargetPromise.catch(() => undefined);
            void loadPromise.catch(() => undefined);
            return (async () => {
                try {
                    const saveTarget = await Promise.race([saveTargetPromise, canceledPromise]);
                    if (pendingOp.canceled || saveTarget === null || saveTarget.canceled) {
                        return CANCELED_PAGE_OP_RESULT;
                    }
                    const capability = await Promise.race([loadPromise, canceledPromise]);
                    if (pendingOp.canceled || capability === null) {
                        return CANCELED_PAGE_OP_RESULT;
                    }
                    pendingPreLoadPageOps.delete(pendingOp);
                    prePickedExtractTarget = {
                        suggestedName,
                        result: saveTarget,
                    };
                    let extractPromise: ReturnType<IPageOpsCapability['extract']>;
                    try {
                        extractPromise = capability.extract(workingCopyPath, pages);
                    } finally {
                        prePickedExtractTarget = null;
                    }
                    return await extractPromise;
                } finally {
                    pendingPreLoadPageOps.delete(pendingOp);
                }
            })();
        },
        reorder: (workingCopyPath, newOrder, mutationOptions) =>
            runCancellablePageOp(workingCopyPath, (capability) => capability.reorder(workingCopyPath, newOrder, mutationOptions)),
        move: (workingCopyPath, startPage, endPage, insertAt, totalPages, mutationOptions) =>
            runCancellablePageOp(workingCopyPath, (capability) =>
                capability.move(workingCopyPath, startPage, endPage, insertAt, totalPages, mutationOptions),
            ),
        moveRanges: (workingCopyPath, ranges, insertAt, totalPages, mutationOptions) =>
            runCancellablePageOp(workingCopyPath, (capability) =>
                capability.moveRanges(workingCopyPath, ranges, insertAt, totalPages, mutationOptions),
            ),
        insert: (workingCopyPath, totalPages, afterPage, mutationOptions) => {
            if (loadedPageOpsCapability) {
                return loadedPageOpsCapability.insert(workingCopyPath, totalPages, afterPage, mutationOptions);
            }
            // Register for cancellation and invoke the file picker synchronously
            // before any dynamic import so both activation and Cancel work while cold.
            const {pendingOp, canceledPromise} = registerPreLoadPageOp(workingCopyPath);
            const pickedPromise = pickFiles({
                accept: OPEN_PDF_IMAGE_ACCEPT,
                multiple: true,
                pickerTypes: buildOpenPdfImagePickerTypes(),
            });
            const loadPromise = loadPageOpsCapability();
            void pickedPromise.catch(() => undefined);
            void loadPromise.catch(() => undefined);
            return (async () => {
                const sourcePaths: string[] = [];
                try {
                    const pickedFiles = await Promise.race([pickedPromise, canceledPromise]);
                    if (pendingOp.canceled || pickedFiles === null || pickedFiles.length === 0) {
                        return CANCELED_PAGE_OP_RESULT;
                    }
                    for (const picked of pickedFiles) {
                        if (pendingOp.canceled) {
                            return CANCELED_PAGE_OP_RESULT;
                        }
                        sourcePaths.push(
                            await browserDocumentStore.registerFile(picked.file, {
                                kind: 'source',
                                retention: 'transient',
                                saveKind: 'generic',
                                saveHandle: picked.handle ?? null,
                            }),
                        );
                    }
                    if (pendingOp.canceled) {
                        return CANCELED_PAGE_OP_RESULT;
                    }
                    const capability = await Promise.race([loadPromise, canceledPromise]);
                    if (pendingOp.canceled || capability === null) {
                        return CANCELED_PAGE_OP_RESULT;
                    }
                    pendingPreLoadPageOps.delete(pendingOp);
                    return await capability.insertFile(workingCopyPath, totalPages, afterPage, sourcePaths, undefined, mutationOptions);
                } finally {
                    pendingPreLoadPageOps.delete(pendingOp);
                    if (sourcePaths.length > 0) {
                        await Promise.allSettled(sourcePaths.map((sourcePath) => browserDocumentStore.cleanupDetachedDocument(sourcePath)));
                    }
                }
            })();
        },
        insertFile: (workingCopyPath, totalPages, afterPage, sourcePaths, requestId, mutationOptions) =>
            runCancellablePageOp(workingCopyPath, (capability) =>
                capability.insertFile(workingCopyPath, totalPages, afterPage, sourcePaths, requestId, mutationOptions),
            ),
        rotate: (workingCopyPath, pages, totalPages, angle, mutationOptions) =>
            runCancellablePageOp(workingCopyPath, (capability) =>
                capability.rotate(workingCopyPath, pages, totalPages, angle, mutationOptions),
            ),
        crop: (workingCopyPath, pages, totalPages, margins, mutationOptions) =>
            runCancellablePageOp(workingCopyPath, (capability) =>
                capability.crop(workingCopyPath, pages, totalPages, margins, mutationOptions),
            ),
        removeCrop: (workingCopyPath, pages, totalPages, mutationOptions) =>
            runCancellablePageOp(workingCopyPath, (capability) =>
                capability.removeCrop(workingCopyPath, pages, totalPages, mutationOptions),
            ),
        async cancelActive(workingCopyPath) {
            let preLoadCanceled = 0;
            for (const pendingOp of [...pendingPreLoadPageOps]) {
                if (pendingOp.workingCopyPath !== workingCopyPath || pendingOp.canceled) {
                    continue;
                }
                pendingPreLoadPageOps.delete(pendingOp);
                pendingOp.cancel();
                preLoadCanceled += 1;
            }
            if (!loadedPageOpsCapability) {
                return {
                    canceled: preLoadCanceled,
                    committing: 0,
                };
            }
            const loadedResult = await loadedPageOpsCapability.cancelActive(workingCopyPath);
            return {
                canceled: preLoadCanceled + loadedResult.canceled,
                committing: loadedResult.committing,
            };
        },
        getPageGeometry: (workingCopyPath, pageNumber) =>
            loadedPageOpsCapability
                ? loadedPageOpsCapability.getPageGeometry(workingCopyPath, pageNumber)
                : loadPageOpsCapability().then((capability) => capability.getPageGeometry(workingCopyPath, pageNumber)),
        readOutline: (workingCopyPath) =>
            loadedPageOpsCapability
                ? loadedPageOpsCapability.readOutline(workingCopyPath)
                : loadPageOpsCapability().then((capability) => capability.readOutline(workingCopyPath)),
    };

    return {
        documentPicker,
        documentOpen,
        documentWorkingCopy,
        documentFiles,
        documentPdf,
        documentRecentFiles,
        documentWindow,
        documentMenu,
        imageExport,
        pageOps,
    };
}
