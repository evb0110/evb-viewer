import type {
    IDocumentsFileIoCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import type {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import type { IImageExportCapability } from '@contracts/imageExportPlatformFeature';
import type { IPageOpsCapability } from '@contracts/pageOpsPlatformFeature';
import {
    OPEN_PDF_IMAGE_ACCEPT,
    buildOpenPdfImagePickerTypes,
    configureBrowserFilePickerDescriptions,
} from '@app/platform/browser-api/browserFileAccepts';
import type { TBrowserFilePickerDescriptionKey } from '@app/platform/browser-api/browserFileAccepts';
import {
    createBrowserCombinedPdfFromPaths,
    createBrowserDocumentsFileCapability,
} from '@app/platform/browser-api/createBrowserDocumentsFileCapability';
import {
    configureBrowserFilePickerMessages,
    pickFiles,
    pickSaveTarget,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import { createBrowserImageExportCapability } from '@app/platform/browser-api/createBrowserImageExportCapability';
import {
    browserDocumentsMenuCapability,
    onBrowserOpenDocumentDirectBatchProgress,
} from '@app/platform/browser-api/documentsMenuCapability';
import { createBrowserPageOpsCapability } from '@app/platform/browser-api/createBrowserPageOpsCapability';
import type {
    TLocale,
    TTranslateFn,
    TTranslationKey,
} from '@i18n-app';
import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    isLocaleMessageSource,
    normalizeTranslationParams,
} from '@i18n-core';
import { safeDecodeURIComponent } from '@app/utils/browserSafe';

interface ICreateBrowserDocumentsCapabilityOptions {clearSearchCaches: (pdfPath?: string) => void | Promise<void>;}

export interface IBrowserDocumentCapabilities {
    documentPicker: IDocumentsPickerCapability;
    documentOpen: IDocumentsOpenCapability;
    documentWorkingCopy: IDocumentsWorkingCopyCapability;
    documentFiles: IDocumentsFileIoCapability;
    documentPdf: IDocumentsPdfCapability;
    documentRecentFiles: IDocumentsRecentFilesCapability;
    documentWindow: IDocumentsWindowCapability;
    documentMenu: IDocumentsMenuCapability;
    imageExport: IImageExportCapability;
    pageOps: IPageOpsCapability;
}

const SUPPORTED_LOCALES = new Set<string>(LOCALE_CODES);

function getBrowserLocale(): TLocale {
    const cookieMatch = typeof document !== 'undefined'
        ? document.cookie.match(/(?:^|;\s*)i18n_redirected=([^;]+)/u)
        : null;
    const cookieLocale = cookieMatch?.[1]
        ? safeDecodeURIComponent(cookieMatch[1])
        : null;

    if (cookieLocale && SUPPORTED_LOCALES.has(cookieLocale)) {
        return cookieLocale as TLocale;
    }

    const navigatorLocale = typeof navigator !== 'undefined'
        ? navigator.language.split('-')[0]
        : null;
    return navigatorLocale && SUPPORTED_LOCALES.has(navigatorLocale)
        ? navigatorLocale as TLocale
        : DEFAULT_LOCALE;
}

// Read messages from the already-loaded vue-i18n composer so resolving this capability
// does not download every locale pack.
const translateBrowserMessage: TTranslateFn = (key, ...args) => {
    const params = normalizeTranslationParams(args[0]);
    const locale = getBrowserLocale();
    const composer: unknown = tryUseNuxtApp()?.$i18n;
    const leaf = isLocaleMessageSource(composer)
        ? getNestedTranslationLeaf(composer.getLocaleMessage(locale), key)
            ?? getNestedTranslationLeaf(composer.getLocaleMessage(DEFAULT_LOCALE), key)
            ?? key
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

export function createBrowserDocumentsCapability(
    options: ICreateBrowserDocumentsCapabilityOptions,
): IBrowserDocumentCapabilities {
    const errorMessageProvider = {
        largeSaveHandleHint: () => translateBrowserMessage('errors.browser.largeSaveHandleHint'),
        useNativeApp: () => translateBrowserMessage('errors.browser.useNativeApp'),
    };
    configureBrowserFilePickerMessages(errorMessageProvider);
    configureBrowserFilePickerDescriptions((key) =>
        translateBrowserMessage(BROWSER_FILE_PICKER_DESCRIPTION_MESSAGE_KEYS[key]),
    );
    const fileCapability = createBrowserDocumentsFileCapability({
        ...options,
        errorMessageProvider,
    });
    const imageExportCapability = createBrowserImageExportCapability();
    const pageOpsCapability = createBrowserPageOpsCapability({
        clearSearchCaches: options.clearSearchCaches,
        openInputAccept: OPEN_PDF_IMAGE_ACCEPT,
        pickFiles,
        buildOpenPdfPickerTypes: buildOpenPdfImagePickerTypes,
        createCombinedPdfFromPaths: createBrowserCombinedPdfFromPaths,
        pickSaveTarget,
        saveBytesToPickerOrDownload,
        writeBytesToHandle,
    });
    const documentPicker = {
        openDocumentDialog: fileCapability.openDocumentDialog,
        openCombineDialog: fileCapability.openCombineDialog,
        openFolderDialog: fileCapability.openFolderDialog,
        openFolderDialogStructured: fileCapability.openFolderDialogStructured!,
        openImageDialog: fileCapability.openImageDialog,
        getPathForFile: fileCapability.getPathForFile,
        getPathsForFiles: fileCapability.getPathsForFiles,
        registerFilesForOpen: fileCapability.registerFilesForOpen,
        createCombinedPdfFromFiles: fileCapability.createCombinedPdfFromFiles!,
    } satisfies IDocumentsPickerCapability
        & TFeatureBrowserBindings<typeof DOCUMENT_PICKER_PLATFORM_FEATURE>;
    const documentOpen = {
        openDocumentDirect: fileCapability.openDocumentDirect,
        openDocumentDirectBatch: fileCapability.openDocumentDirectBatch,
        onOpenDocumentDirectBatchProgress: onBrowserOpenDocumentDirectBatchProgress,
    } satisfies IDocumentsOpenCapability
        & TFeatureBrowserBindings<typeof DOCUMENT_OPEN_PLATFORM_FEATURE>;
    const documentWorkingCopy = {
        createWorkingCopyFromData: fileCapability.createWorkingCopyFromData,
        createWorkingCopyFromPath: fileCapability.createWorkingCopyFromPath,
        parsePdfAnnotations: fileCapability.parsePdfAnnotations,
        cleanupFile: fileCapability.cleanupFile,
        cleanupOcrTemp: fileCapability.cleanupOcrTemp,
    } satisfies IDocumentsWorkingCopyCapability;
    const optionalDocumentFileMethods = {
        ...(fileCapability.createManagedTempFileHandle
            ? {createManagedTempFileHandle: fileCapability.createManagedTempFileHandle}
            : {}),
        ...(fileCapability.releaseManagedTempFileHandle
            ? {releaseManagedTempFileHandle: fileCapability.releaseManagedTempFileHandle}
            : {}),
        ...(fileCapability.repairPdf ? {repairPdf: fileCapability.repairPdf} : {}),
        ...(fileCapability.optimizePdfForInteraction ? {optimizePdfForInteraction: fileCapability.optimizePdfForInteraction} : {}),
        ...(fileCapability.optimizePdfAsCopy ? {optimizePdfAsCopy: fileCapability.optimizePdfAsCopy} : {}),
        ...(fileCapability.savePdfNoteTextUpdates ? {savePdfNoteTextUpdates: fileCapability.savePdfNoteTextUpdates} : {}),
        ...(fileCapability.savePdfNoteChanges ? {savePdfNoteChanges: fileCapability.savePdfNoteChanges} : {}),
        ...(fileCapability.savePdfNativeMutations ? {savePdfNativeMutations: fileCapability.savePdfNativeMutations} : {}),
        ...(fileCapability.applyPdfNativeMutationsToWorkingCopy
            ? {applyPdfNativeMutationsToWorkingCopy: fileCapability.applyPdfNativeMutationsToWorkingCopy}
            : {}),
        ...(fileCapability.commitStagedPdfNativeMutations
            ? {commitStagedPdfNativeMutations: fileCapability.commitStagedPdfNativeMutations}
            : {}),
    };
    const documentFiles = {
        readFile: fileCapability.readFile,
        statFile: fileCapability.statFile,
        readFileRange: fileCapability.readFileRange,
        readFileChunks: fileCapability.readFileChunks,
        readTextFile: fileCapability.readTextFile,
        fileExists: fileCapability.fileExists,
        getDocumentRevision: fileCapability.getDocumentRevision,
        onDocumentRevisionChanged: fileCapability.onDocumentRevisionChanged,
        savePdfAs: fileCapability.savePdfAs,
        savePdfDataAs: fileCapability.savePdfDataAs,
        savePdfDialog: fileCapability.savePdfDialog,
        saveDocxAs: fileCapability.saveDocxAs,
        writeFile: fileCapability.writeFile,
        replaceWorkingCopyFromPath: fileCapability.replaceWorkingCopyFromPath,
        writeDocxFile: fileCapability.writeDocxFile,
        saveFileStructured: fileCapability.saveFileStructured,
        ...(fileCapability.resyncWorkingCopy ? {resyncWorkingCopy: fileCapability.resyncWorkingCopy} : {}),
        savePdfData: fileCapability.savePdfData,
        savePdfDataChunks: fileCapability.savePdfDataChunks,
        ...optionalDocumentFileMethods,
    } satisfies IDocumentsFileIoCapability;
    const documentPdf = {
        analyzePdfConformance: fileCapability.analyzePdfConformance,
        validatePdfData: fileCapability.validatePdfData,
        validatePdfPath: fileCapability.validatePdfPath,
        openPdfInDefaultAppData: fileCapability.openPdfInDefaultAppData,
        openPdfInDefaultAppPath: fileCapability.openPdfInDefaultAppPath,
        printPdfData: fileCapability.printPdfData,
        printPdfPath: fileCapability.printPdfPath,
    } satisfies IDocumentsPdfCapability;
    const recentFiles = {
        get: fileCapability.recentFiles.get,
        remove: async (path: string) => {
            await fileCapability.recentFiles.remove(path);
            return undefined;
        },
        removeIfMissing: fileCapability.recentFiles.removeIfMissing,
        clear: async () => {
            await fileCapability.recentFiles.clear();
            return undefined;
        },
    } satisfies
        TFeatureBrowserBindings<typeof DOCUMENT_RECENT_FILES_PLATFORM_FEATURE>;
    const documentRecentFiles = {recentFiles} satisfies IDocumentsRecentFilesCapability;
    const documentWindow = {
        setWindowTitle: async (title: string) => {
            await fileCapability.setWindowTitle(title);
            return undefined;
        },
        showItemInFolder: fileCapability.showItemInFolder,
        showItemInFolderStructured: fileCapability.showItemInFolderStructured!,
    } satisfies IDocumentsWindowCapability
        & TFeatureBrowserBindings<typeof DOCUMENT_WINDOW_PLATFORM_FEATURE>;
    const documentMenu = {...browserDocumentsMenuCapability} satisfies IDocumentsMenuCapability
        & TFeatureBrowserBindings<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;
    return {
        documentPicker,
        documentOpen,
        documentWorkingCopy,
        documentFiles,
        documentPdf,
        documentRecentFiles,
        documentWindow,
        documentMenu,
        imageExport: imageExportCapability,
        pageOps: pageOpsCapability,
    };
}
