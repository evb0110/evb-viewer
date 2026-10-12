export const WASM_TARGET = 'wasm32-unknown-unknown';

/** @typedef {{relativePath: string, requiredExports: string[]}} IRequiredWebWasmAsset */
/** @typedef {{builtFileName: string, crateName: string, label: string, manifestPath: string, publicRelativePath: string, requiredExports: string[], rustflags: string[]}} IWasmArtifact */

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

/** @param {string} crateName @returns {IWasmArtifact} */
export function getWasmArtifactByCrateName(crateName) {
    const artifact = WASM_ARTIFACTS.find(entry => entry.crateName === crateName);
    if (!artifact) {
        throw new Error(`Unknown WASM artifact crate: ${crateName}`);
    }
    return artifact;
}
