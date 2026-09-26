import type { IAgentAssistantImageAttachment } from '@contracts/agent';
import {
    ASSISTANT_IMAGE_RESOURCE_LIMITS,
    createStaticBrowserImagePreview,
    probeBrowserImageFile,
    readBlobAsDataUrl,
    type IProbedBrowserImage,
} from '@app/platform/browser-api/public';

export type TAssistantComposerImage = IAgentAssistantImageAttachment & {previewDataUrl?: string;};

export const ASSISTANT_MAX_IMAGE_ATTACHMENTS = 8;
export const ASSISTANT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ASSISTANT_IMAGE_SIZE_LIMIT_LABEL = `${Math.round(ASSISTANT_MAX_IMAGE_BYTES / (1024 * 1024))} MB`;

export interface IExpandedImageItem {
    src: string;
    name: string;
}

export interface IExpandedImagePreview {
    images: IExpandedImageItem[];
    index: number;
}

export type TAssistantComposerImageError =
    | {
        type: 'unsupported';
        name: string 
    }
    | {
        type: 'too-large';
        name: string;
        size: string 
    }
    | {
        type: 'limit';
        count: number 
    }
    | {
        type: 'read-failed';
        name: string 
    };

interface IBuildComposerImageAttachmentsOptions {
    files: readonly File[];
    existingImages: readonly TAssistantComposerImage[];
    fallbackName: (index: number) => string;
    createId?: () => string;
    readFile?: (file: File) => Promise<string>;
    probeFile?: (file: File) => Promise<IProbedBrowserImage>;
    buildPreview?: (image: IProbedBrowserImage) => Promise<string>;
}

function createAssistantImageAttachmentId() {
    return globalThis.crypto.randomUUID();
}

function isAssistantImageFile(file: File | null): file is File {
    return Boolean(file?.type.toLowerCase().startsWith('image/'));
}

export function getClipboardImageFiles(dataTransfer: DataTransfer | null) {
    if (!dataTransfer) {
        return [];
    }

    const directFiles = Array.from(dataTransfer.files).filter(isAssistantImageFile);
    if (directFiles.length > 0) {
        return directFiles;
    }

    return Array.from(dataTransfer.items)
        .flatMap(item => (
            item.kind === 'file' && item.type.toLowerCase().startsWith('image/')
                ? [item.getAsFile()]
                : []
        ))
        .filter(isAssistantImageFile);
}

function readImageFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read image'));
        reader.onload = () => {
            if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) {
                resolve(reader.result);
                return;
            }
            reject(new Error('Invalid image data'));
        };
        reader.readAsDataURL(file);
    });
}

async function probeAssistantImageFile(file: File) {
    return probeBrowserImageFile(file, ASSISTANT_IMAGE_RESOURCE_LIMITS);
}

async function buildAssistantImagePreview(image: IProbedBrowserImage) {
    return readBlobAsDataUrl(await createStaticBrowserImagePreview(image, 1_024));
}

function normalizeImageName(file: File, index: number, fallbackName: (index: number) => string) {
    return file.name.trim() || fallbackName(index);
}

export async function buildComposerImageAttachments({
    files,
    existingImages,
    fallbackName,
    createId = createAssistantImageAttachmentId,
    readFile = readImageFileAsDataUrl,
    probeFile = probeAssistantImageFile,
    buildPreview = buildAssistantImagePreview,
}: IBuildComposerImageAttachmentsOptions) {
    const nextImages = [...existingImages];
    let error: TAssistantComposerImageError | null = null;

    for (const file of files) {
        const name = normalizeImageName(file, nextImages.length, fallbackName);
        if (!isAssistantImageFile(file)) {
            error = {
                type: 'unsupported',
                name, 
            };
            continue;
        }
        if (file.size <= 0 || file.size > ASSISTANT_MAX_IMAGE_BYTES) {
            error = {
                type: 'too-large',
                name,
                size: ASSISTANT_IMAGE_SIZE_LIMIT_LABEL,
            };
            continue;
        }
        if (nextImages.length >= ASSISTANT_MAX_IMAGE_ATTACHMENTS) {
            error = {
                type: 'limit',
                count: ASSISTANT_MAX_IMAGE_ATTACHMENTS,
            };
            break;
        }

        try {
            const probedImage = await probeFile(file);
            const dataUrl = await readFile(file);
            const previewDataUrl = await buildPreview(probedImage);
            nextImages.push({
                type: 'image',
                id: createId(),
                name,
                mimeType: file.type.toLowerCase(),
                sizeBytes: file.size,
                dataUrl,
                previewDataUrl,
            });
        } catch {
            error = {
                type: 'read-failed',
                name, 
            };
        }
    }

    return {
        images: nextImages,
        error,
    };
}

export function buildExpandedImagePreview(
    images: readonly TAssistantComposerImage[],
    selectedImageId: string,
): IExpandedImagePreview | null {
    const previewableImages = images
        .filter(image => getAssistantImagePreviewUrl(image).startsWith('data:image/'))
        .map(image => ({
            id: image.id,
            src: getAssistantImagePreviewUrl(image),
            name: image.name,
        }));
    if (previewableImages.length === 0) {
        return null;
    }
    const selectedIndex = previewableImages.findIndex(image => image.id === selectedImageId);
    if (selectedIndex < 0) {
        return null;
    }
    return {
        images: previewableImages.map(image => ({
            src: image.src,
            name: image.name,
        })),
        index: selectedIndex,
    };
}

export function getAssistantImagePreviewUrl(image: TAssistantComposerImage) {
    return image.previewDataUrl ?? image.dataUrl;
}

export function navigateExpandedImagePreview(
    preview: IExpandedImagePreview | null,
    direction: -1 | 1,
) {
    if (!preview || preview.images.length <= 1) {
        return preview;
    }
    return {
        ...preview,
        index: (preview.index + direction + preview.images.length) % preview.images.length,
    };
}
