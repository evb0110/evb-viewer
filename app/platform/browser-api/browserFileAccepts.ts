import type { IFilePickerAcceptType } from '@app/platform/browser/browserCapabilityTier';

const SUPPORTED_IMAGE_EXTENSIONS = [
    '.apng',
    '.avif',
    '.bmp',
    '.gif',
    '.jpeg',
    '.jpg',
    '.png',
    '.svg',
    '.tif',
    '.tiff',
    '.webp',
    '.ico',
] as const;

const OPEN_IMAGE_ACCEPT = 'image/*';
const OPEN_PDF_ACCEPT = '.pdf,application/pdf';
const OPEN_DJVU_ACCEPT = '.djvu,.djv';
const OPEN_PDF_IMAGE_ACCEPT = [
    OPEN_PDF_ACCEPT,
    ...SUPPORTED_IMAGE_EXTENSIONS,
    '.jp2',
].join(',');
const OPEN_INPUT_ACCEPT = [
    OPEN_PDF_IMAGE_ACCEPT,
    OPEN_DJVU_ACCEPT,
].join(',');

const DEFAULT_FILE_PICKER_DESCRIPTIONS = {
    documents: 'Documents',
    images: 'Images',
    pdfDocuments: 'PDF Documents',
    wordDocuments: 'Word Documents',
    jpegImages: 'JPEG Images',
    pngImages: 'PNG Images',
    tiffImages: 'TIFF Images',
} as const;

type TBrowserFilePickerDescriptionKey = keyof typeof DEFAULT_FILE_PICKER_DESCRIPTIONS;
type TBrowserFilePickerDescriptionProvider = (
    key: TBrowserFilePickerDescriptionKey,
) => string;

let filePickerDescriptionProvider: TBrowserFilePickerDescriptionProvider = (
    key,
) => DEFAULT_FILE_PICKER_DESCRIPTIONS[key];

function configureBrowserFilePickerDescriptions(
    provider?: TBrowserFilePickerDescriptionProvider,
) {
    filePickerDescriptionProvider = provider ?? (
        (key) => DEFAULT_FILE_PICKER_DESCRIPTIONS[key]
    );
}

function getFilePickerDescription(key: TBrowserFilePickerDescriptionKey) {
    const description = filePickerDescriptionProvider(key).trim();
    return description.length > 0
        ? description
        : DEFAULT_FILE_PICKER_DESCRIPTIONS[key];
}

function buildOpenPdfPickerTypes(): IFilePickerAcceptType[] {
    return [{
        description: getFilePickerDescription('documents'),
        accept: {
            'application/pdf': ['.pdf'],
            'application/octet-stream': [
                '.djvu',
                '.djv',
            ],
            'image/*': [...SUPPORTED_IMAGE_EXTENSIONS],
            'image/jp2': ['.jp2'],
        },
    }];
}

function buildOpenPdfImagePickerTypes(): IFilePickerAcceptType[] {
    return [{
        description: getFilePickerDescription('documents'),
        accept: {
            'application/pdf': ['.pdf'],
            'image/*': [...SUPPORTED_IMAGE_EXTENSIONS],
            'image/jp2': ['.jp2'],
        },
    }];
}

function buildImagePickerTypes(): IFilePickerAcceptType[] {
    return [{
        description: getFilePickerDescription('images'),
        accept: { 'image/*': [...SUPPORTED_IMAGE_EXTENSIONS] },
    }];
}

function buildPdfSaveTypes(): IFilePickerAcceptType[] {
    return [{
        description: getFilePickerDescription('pdfDocuments'),
        accept: { 'application/pdf': ['.pdf'] },
    }];
}

function buildDocxSaveTypes(): IFilePickerAcceptType[] {
    return [{
        description: getFilePickerDescription('wordDocuments'),
        accept: {'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']},
    }];
}

function buildImageExportPickerTypes(): IFilePickerAcceptType[] {
    return [
        {
            description: getFilePickerDescription('jpegImages'),
            accept: { 'image/jpeg': [
                '.jpg',
                '.jpeg',
            ] },
        },
        {
            description: getFilePickerDescription('pngImages'),
            accept: { 'image/png': ['.png'] },
        },
        ...buildTiffSaveTypes(),
    ];
}

function buildTiffSaveTypes(): IFilePickerAcceptType[] {
    return [{
        description: getFilePickerDescription('tiffImages'),
        accept: { 'image/tiff': [
            '.tif',
            '.tiff',
        ] },
    }];
}

export {
    OPEN_IMAGE_ACCEPT,
    OPEN_INPUT_ACCEPT,
    OPEN_PDF_IMAGE_ACCEPT,
    buildDocxSaveTypes,
    buildImageExportPickerTypes,
    buildImagePickerTypes,
    buildOpenPdfImagePickerTypes,
    buildOpenPdfPickerTypes,
    buildPdfSaveTypes,
    buildTiffSaveTypes,
    configureBrowserFilePickerDescriptions,
};
export type { TBrowserFilePickerDescriptionKey };
export type { IFilePickerAcceptType } from '@app/platform/browser/browserCapabilityTier';
