import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {
    createPdfPageOpsWasmRunner,
    executeDesktopPageOpsCommand,
    isPdfPageOpsWasmPath,
    loadPdfPageOpsWasmModule,
    resolvePdfPageOpsWasmPath,
} from '@node-runtime/pdfPageOpsWasmRunner';
import {computeNativeBuildId} from '@scripts/native-build-id.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--build-id') {
        process.stdout.write(`${computeNativeBuildId(projectRoot, 'pdf-page-ops')}\n`);
        return;
    }
    const envPath = process.env.EVB_PDF_PAGE_OPS_PATH?.trim();
    const wasmPath = resolvePdfPageOpsWasmPath({
        ...(envPath && isPdfPageOpsWasmPath(envPath) ? {envOverridePath: envPath} : {}),
    }) ?? undefined;
    const wasmModule = await loadPdfPageOpsWasmModule(wasmPath);
    const runner = createPdfPageOpsWasmRunner(wasmModule);
    try {
        const result = executeDesktopPageOpsCommand(runner, args);
        if (result.stdout.length > 0) {
            process.stdout.write(result.stdout);
        }
        if (result.stderr.length > 0) {
            process.stderr.write(result.stderr);
        }
    } finally {
        runner.dispose();
    }
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (hasNativeErrorCode(error)) {
        process.stderr.write(`${JSON.stringify({
            code: error.code,
            message,
        })}\n`);
    } else {
        process.stderr.write(`${message}\n`);
    }
    process.exit(1);
});
