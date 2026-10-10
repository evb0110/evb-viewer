// Generated from the evb-pdf-page-ops Rust WASM ABI; do not edit.
// Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops generated_typescript`.
// Layout fields are byte offsets; numeric fields are little-endian.

export const REQUEST_MAGIC = 'EPPO';
export const REQUEST_VERSION = 2;
export const REQUEST_VERSION_DOCUMENT_LIST = 3;
export const U32_BYTES = 4;
export const F64_BYTES = 8;
export const MAX_DOCUMENTS = 500;
export const RESPONSE_MUTATION = 1;
export const RESPONSE_GEOMETRY = 2;
export const RESPONSE_ANNOTATION_PARSE = 3;
export const RESPONSE_NATIVE_MUTATIONS = 4;
export const RESPONSE_JSON = 5;
export const NATIVE_MUTATION_POSTCONDITIONS_VERIFIED = 1;
export const MAX_U32 = 4294967295;

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
} as const;

export const REQUEST_HEADER = {
    magic: 0,
    version: 4,
    operation: 8,
    pageCount: 12,
    pageNumber: 16,
    afterPage: 20,
    angle: 24,
    top: 28,
    bottom: 36,
    left: 44,
    right: 52,
    dataLength: 60,
    insertionDataLength: 64,
    passwordLength: 68,
    bytes: 72,
} as const;

export const DOCUMENT_LIST_HEADER = {
    magic: 0,
    version: 4,
    operation: 8,
    documentCount: 12,
    bytes: 16,
} as const;

export const MUTATION_HEADER = {
    kind: 0,
    pageCount: 4,
    dataLength: 8,
    bytes: 12,
} as const;

export const BOX_LAYOUT = {
    x: 0,
    y: 8,
    width: 16,
    height: 24,
    bytes: 32,
} as const;

export const GEOMETRY_HEADER = {
    kind: 0,
    rotation: 4,
    mediaBox: 8,
    hasCropBox: 40,
    cropBox: 44,
    bytes: 76,
} as const;

export const BYTES_HEADER = {
    kind: 0,
    dataLength: 4,
    bytes: 8,
} as const;

export const NATIVE_MUTATION_HEADER = {
    kind: 0,
    pageCount: 4,
    dataLength: 8,
    identityBindingsLength: 12,
    postconditionsVerified: 16,
    bytes: 20,
} as const;
