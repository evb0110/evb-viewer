// Generated from the evb-pdf-page-ops Rust WASM ABI; do not edit.
// Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops generated_typescript`.
// Layout fields are byte offsets; numeric fields are little-endian.

export const REQUEST_MAGIC = 'EPPO';
export const REQUEST_VERSION = 2;
export const REQUEST_VERSION_INSTRUCTED = 5;
export const REQUEST_VERSION_FILES = 6;
export const U32_BYTES = 4;
export const F64_BYTES = 8;
export const MAX_BUFFER_BYTES = 2147483647;
export const RESPONSE_MUTATION = 1;
export const RESPONSE_ANNOTATION_PARSE = 3;
export const RESPONSE_JSON = 5;
export const RESPONSE_TEXT_BOX_APPEARANCE = 6;
export const RESPONSE_REPORTED_PDF = 8;
export const RESPONSE_REPORTED_INCREMENT = 9;
export const RESPONSE_REPORTED_RASTER = 10;
export const RESPONSE_WRITTEN = 11;
export const MAX_U32 = 4294967295;
export const MAX_CATALOG_ENTRIES = 100000;

export const OPERATION_CODES = {
    deletePages: 1,
    extractPages: 2,
    reorderPages: 3,
    insertPages: 4,
    rotate: 5,
    crop: 6,
    removeCrop: 7,
    getPageGeometry: 8,
    decrypt: 9,
    parseAnnotations: 10,
    saveMutations: 11,
    readCatalog: 12,
    conformance: 13,
    mergePages: 14,
    printLayout: 15,
    textBoxAppearance: 16,
    ocrTextVisibility: 17,
    ocrTextLayer: 18,
    splitPages: 19,
    overlayText: 20,
    recompressImages: 21,
    replacePageImages: 22,
    inspectScanCleanupPdf: 23,
    renderScanCleanupRaster: 24,
    verifyWritten: 25,
} as const;

export const REQUEST_HEADER = {
    magic: 0,
    version: 4,
    operation: 8,
    pageCount: 12,
    pageNumber: 16,
    angle: 20,
    top: 24,
    bottom: 32,
    left: 40,
    right: 48,
    dataLength: 56,
    insertionDataLength: 60,
    passwordLength: 64,
    bytes: 68,
} as const;

export const INSTRUCTED_REQUEST_HEADER = {
    magic: 0,
    version: 4,
    operation: 8,
    dataLength: 12,
    instructionsLength: 16,
    attachmentCount: 20,
    bytes: 24,
} as const;

export const FILE_REQUEST_HEADER = {
    magic: 0,
    version: 4,
    operation: 8,
    sourceCount: 12,
    afterPage: 16,
    pageCount: 20,
    bytes: 24,
} as const;

export const WRITTEN_HEADER = {
    kind: 0,
    pageCount: 4,
    length: 8,
    bytes: 16,
} as const;

export const MUTATION_HEADER = {
    kind: 0,
    pageCount: 4,
    dataLength: 8,
    bytes: 12,
} as const;

export const BYTES_HEADER = {
    kind: 0,
    dataLength: 4,
    bytes: 8,
} as const;

export const REPORTED_HEADER = {
    kind: 0,
    pageCount: 4,
    dataLength: 8,
    reportLength: 12,
    bytes: 16,
} as const;

export const TEXT_BOX_APPEARANCE_HEADER = {
    kind: 0,
    dataLength: 4,
    metadataLength: 8,
    bytes: 12,
} as const;
