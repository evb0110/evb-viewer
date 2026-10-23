export const WASM_TARGET = 'wasm32-unknown-unknown';

/** @typedef {{relativePath: string, requiredExports: string[]}} IRequiredWebWasmAsset */
/** @typedef {{builtFileName: string, crateName: string, label: string, manifestPath: string, publicRelativePath: string, requiredExports: string[], rustflags: string[]}} IWasmArtifact */
/** @typedef {{bytes: number, label: string, publicRelativePath: string, sha256: string, url: string}} IPrebuiltWasmFile */

/** @type {IRequiredWebWasmAsset[]} */
export const REQUIRED_WEB_WASM_ASSETS = [
    {
        relativePath: 'wasm/evb-pdf-image-combine.wasm',
        requiredExports: [
            'memory',
            'evb_wasm_request_allocation_abi_version',
            'evb_pdf_image_combine_alloc',
            'evb_pdf_image_combine_free',
            'evb_pdf_image_combine_build_pdf',
            'evb_pdf_image_combine_output_ptr',
            'evb_pdf_image_combine_output_len',
            'evb_pdf_image_combine_error_ptr',
            'evb_pdf_image_combine_error_len',
        ],
    },
    {
        relativePath: 'wasm/evb-pdf-page-ops.wasm',
        requiredExports: [
            'memory',
            'evb_wasm_request_allocation_abi_version',
            'evb_pdf_page_ops_alloc',
            'evb_pdf_page_ops_free',
            'evb_pdf_page_ops_run',
            'evb_pdf_page_ops_output_ptr',
            'evb_pdf_page_ops_output_len',
            'evb_pdf_page_ops_error_ptr',
            'evb_pdf_page_ops_error_len',
        ],
    },
    // Emscripten minifies the engine's export names; its pinned digest is the identity.
    {
        relativePath: 'wasm/evb-tesseract.wasm',
        requiredExports: [],
    },
];

const requiredExportsByRelativePath = new Map(
    REQUIRED_WEB_WASM_ASSETS.map(asset => [
        asset.relativePath,
        asset.requiredExports,
    ]),
);

/** @param {string} relativePath @returns {string[]} */
function getRequiredExports(relativePath) {
    const requiredExports = requiredExportsByRelativePath.get(relativePath);
    if (!requiredExports) {
        throw new Error(`Missing required exports for WASM asset: ${relativePath}`);
    }
    return requiredExports;
}

/** @type {IWasmArtifact[]} */
export const WASM_ARTIFACTS = [
    {
        builtFileName: 'evb_pdf_image_combine.wasm',
        crateName: 'pdf-image-combine',
        label: 'PDF image combine WASM',
        manifestPath: 'native/pdf-image-combine/Cargo.toml',
        publicRelativePath: 'public/wasm/evb-pdf-image-combine.wasm',
        requiredExports: getRequiredExports('wasm/evb-pdf-image-combine.wasm'),
        rustflags: [],
    },
    {
        builtFileName: 'evb_pdf_page_ops.wasm',
        crateName: 'pdf-page-ops',
        label: 'PDF page ops WASM',
        manifestPath: 'native/pdf-page-ops/Cargo.toml',
        publicRelativePath: 'public/wasm/evb-pdf-page-ops.wasm',
        requiredExports: getRequiredExports('wasm/evb-pdf-page-ops.wasm'),
        rustflags: [
            '--cfg',
            'getrandom_backend="custom"',
        ],
    },
];

const PREBUILT_WASM_BASE_URL = 'https://github.com/evb0110/evb-viewer/releases/download/runtime-binaries-v2';

/**
 * Browser files built by a pinned toolchain outside cargo, fetched by digest.
 * The browser OCR engine is scripts/build-tesseract-wasm.sh output; rebuilding
 * it with the same toolchain reproduces these bytes.
 * @type {IPrebuiltWasmFile[]}
 */
export const PREBUILT_WASM_FILES = [
    {
        bytes: 2536662,
        label: 'Tesseract OCR engine WASM',
        publicRelativePath: 'public/wasm/evb-tesseract.wasm',
        sha256: 'affb1417875bbea1df8980fc55b3a5f95f4bb6d0638410cf1f40314e5f6bcbd1',
        url: `${PREBUILT_WASM_BASE_URL}/evb-tesseract-5.5.3-r2.wasm`,
    },
    {
        bytes: 70908,
        label: 'Tesseract OCR engine module',
        publicRelativePath: 'public/wasm/evb-tesseract.mjs',
        sha256: 'f82b9c7173d9ccc34db0d45ebf49db690dcb905b6be5caee295ff8e24b84a848',
        url: `${PREBUILT_WASM_BASE_URL}/evb-tesseract-5.5.3-r1.mjs`,
    },
];

/** Every browser WASM file under public/, built or fetched. */
export const BROWSER_WASM_PUBLIC_PATHS = [
    ...WASM_ARTIFACTS.map(artifact => artifact.publicRelativePath),
    ...PREBUILT_WASM_FILES.map(file => file.publicRelativePath),
];

/** @param {string} crateName @returns {IWasmArtifact} */
export function getWasmArtifactByCrateName(crateName) {
    const artifact = WASM_ARTIFACTS.find(entry => entry.crateName === crateName);
    if (!artifact) {
        throw new Error(`Unknown WASM artifact crate: ${crateName}`);
    }
    return artifact;
}
