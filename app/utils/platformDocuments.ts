import type { IDocxExportFileCapability } from '@contracts/docxExport';
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
import { assertDocumentAllocationSize } from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IImageExportCapability } from '@contracts/imageExportPlatformFeature';
import type { IPageOpsCapability } from '@contracts/pageOpsPlatformFeature';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import { getPlatformAPI } from '@app/utils/platform';
import { isBrowserFullReadTooLargeError } from '@app/platform/browser/browserDocumentReadError';

export function getDocumentPickerCapability(): IDocumentsPickerCapability {
    return getPlatformAPI().documentPicker;
}

export function getDocumentOpenCapability(): IDocumentsOpenCapability {
    return getPlatformAPI().documentOpen;
}

export function getDocumentWorkingCopyCapability(): IDocumentsWorkingCopyCapability {
    return getPlatformAPI().documentWorkingCopy;
}

export function getDocumentFilesCapability(): IDocumentsFileIoCapability & IDocxExportFileCapability {
    return getPlatformAPI().documentFiles;
}

export function getDocumentPdfCapability(): IDocumentsPdfCapability {
    return getPlatformAPI().documentPdf;
}

export function getDocumentRecentFilesCapability(): IDocumentsRecentFilesCapability {
    return getPlatformAPI().documentRecentFiles;
}

export function getDocumentWindowCapability(): IDocumentsWindowCapability {
    return getPlatformAPI().documentWindow;
}

export function getDocumentMenuCapability(): IDocumentsMenuCapability {
    return getPlatformAPI().documentMenu;
}

export function getPageOpsCapability(): IPageOpsCapability {
    return getPlatformAPI().pageOps;
}

export function getImageExportCapability(): IImageExportCapability {
    return getPlatformAPI().imageExport;
}

const FULL_READ_FALLBACK_CHUNK_SIZE = 4 * 1024 * 1024;

export async function readDocumentFileFully(path: TDocumentRef) {
    const documentFiles = getDocumentFilesCapability();
    try {
        return await documentFiles.readFile(path);
    } catch (error) {
        if (!isBrowserFullReadTooLargeError(error)) {
            throw error;
        }
    }

    const { size } = await documentFiles.statFile(path);
    const output = new Uint8Array(assertDocumentAllocationSize(size));
    let offset = 0;
    while (offset < size) {
        const length = Math.min(FULL_READ_FALLBACK_CHUNK_SIZE, size - offset);
        const chunk = await documentFiles.readFileRange(path, offset, length);
        if (chunk.byteLength === 0) {
            throw new Error(`Range read returned no bytes before EOF at offset ${offset} of ${size}`);
        }
        output.set(chunk, offset);
        offset += chunk.byteLength;
        if (offset < size) {
            await yieldToBrowser();
        }
    }
    return output;
}

interface INativePrintResult {
    success: boolean;
    canceled?: boolean;
    error?: string;
    unsupportedReason?: string;
}

export function isNativePrintCapabilityUnavailable(result: INativePrintResult) {
    return result.success !== true
        && result.canceled !== true
        && result.unsupportedReason === 'requires-native-backend';
}

export function shouldRefreshWorkingCopyAfterSaveAs(
    savedPath: TDocumentRef | null | undefined,
    previousWorkingPath: TDocumentRef | null | undefined,
) {
    return Boolean(
        savedPath
        && previousWorkingPath
        && savedPath !== previousWorkingPath
        && isBrowserDocumentRef(savedPath),
    );
}
