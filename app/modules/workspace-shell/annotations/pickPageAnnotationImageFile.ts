import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { parseDocumentRef } from '@contracts/documentRef';
import {
    getDocumentFilesCapability,
    getDocumentPickerCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS } from '@app/platform/browser-api/public';

function mimeTypeFromPath(path: string) {
    const normalized = path.toLowerCase();
    if (normalized.endsWith('.apng')) {
        return 'image/apng';
    }
    if (normalized.endsWith('.avif')) {
        return 'image/avif';
    }
    if (normalized.endsWith('.bmp')) {
        return 'image/bmp';
    }
    if (normalized.endsWith('.gif')) {
        return 'image/gif';
    }
    if (normalized.endsWith('.jpeg') || normalized.endsWith('.jpg')) {
        return 'image/jpeg';
    }
    if (normalized.endsWith('.png')) {
        return 'image/png';
    }
    if (normalized.endsWith('.svg') || normalized.endsWith('.svgz')) {
        return 'image/svg+xml';
    }
    if (normalized.endsWith('.webp')) {
        return 'image/webp';
    }
    if (normalized.endsWith('.ico')) {
        return 'image/x-icon';
    }
    return 'image/png';
}

function extensionForMimeType(mimeType: string) {
    switch (mimeType) {
        case 'image/apng':
            return 'apng';
        case 'image/avif':
            return 'avif';
        case 'image/bmp':
            return 'bmp';
        case 'image/gif':
            return 'gif';
        case 'image/jpeg':
            return 'jpg';
        case 'image/png':
            return 'png';
        case 'image/webp':
            return 'webp';
        case 'image/x-icon':
            return 'ico';
        default:
            return 'img';
    }
}

export async function pickPageAnnotationImageFile() {
    const selectedPath = await getDocumentPickerCapability().openImageDialog();
    const imagePath = parseDocumentRef(selectedPath);
    if (imagePath === null) {
        return null;
    }

    try {
        const documentFiles = getDocumentFilesCapability();
        const {size} = await documentFiles.statFile(imagePath);
        if (size <= 0 || size > PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS.maxEncodedBytes) {
            throw new RangeError('ERR_BROWSER_IMAGE_ENCODED_SIZE_TOO_LARGE');
        }
        const bytes = await documentFiles.readFile(imagePath);
        if (bytes.byteLength !== size || bytes.byteLength > PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS.maxEncodedBytes) {
            throw new RangeError('ERR_BROWSER_IMAGE_ENCODED_SIZE_TOO_LARGE');
        }
        const mimeType = mimeTypeFromPath(imagePath);
        const fileName = imagePath.split(/[\\/]/).pop() ?? `image.${extensionForMimeType(mimeType)}`;
        const file = new File([bytes as BlobPart], fileName, {
            type: mimeType,
            lastModified: Date.now(),
        });
        return file;
    } finally {
        if (isBrowserDocumentRef(imagePath)) {
            await getDocumentWorkingCopyCapability().cleanupFile(imagePath).catch(() => {});
        }
    }
}
