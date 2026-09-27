import { REQUIRED_WEB_WASM_ASSETS } from './wasm-artifacts.mjs';

export { REQUIRED_WEB_WASM_ASSETS };

const REQUIRED_WEB_FILE_ASSETS = [
    { relativePath: 'pdf/pdf.worker.min.mjs' },
    { relativePath: 'pdf/wasm/openjpeg.wasm' },
    { relativePath: 'pdf/wasm/jbig2.wasm' },
    { relativePath: 'pdf/wasm/qcms_bg.wasm' },
    { relativePath: 'vendor/djvujs/djvu.js' },
    { relativePath: 'pdf/cmaps/Adobe-CNS1-UCS2.bcmap' },
    { relativePath: 'pdf/cmaps/Adobe-GB1-UCS2.bcmap' },
    { relativePath: 'pdf/cmaps/Adobe-Japan1-UCS2.bcmap' },
    { relativePath: 'pdf/cmaps/Adobe-Korea1-UCS2.bcmap' },
];

export const REQUIRED_WEB_OUTPUT_CONTRACTS = ['index.html'];

export const REQUIRED_WEB_DEPLOY_ASSETS = [
    ...REQUIRED_WEB_WASM_ASSETS,
    ...REQUIRED_WEB_FILE_ASSETS,
];
