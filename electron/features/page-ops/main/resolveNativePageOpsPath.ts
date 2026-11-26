import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolvePdfPageOpsWasmPath } from '@node-runtime/pdfPageOpsWasmRunner';
import {runtimeConfig} from '@electron/runtimeConfig';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');

export function resolveNativePageOpsPath() {
    return resolvePdfPageOpsWasmPath({
        currentDir: __dirname,
        ...(runtimeConfig.pdfPageOpsPath === undefined ? {} : {envOverridePath: runtimeConfig.pdfPageOpsPath}),
        isPackaged,
    });
}
