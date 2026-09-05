import { ensurePdfjsSsrGlobals } from '@app/services/pdfjs/ensurePdfjsSsrGlobals';
import pdfjsLib, { assertPdfjsRuntimeCompatibility } from '@app/services/pdfjs/runtimeLib';

ensurePdfjsSsrGlobals();
assertPdfjsRuntimeCompatibility(pdfjsLib);

(globalThis as typeof globalThis & { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib;

const pdfjsViewerLib = await import('pdfjs-dist/web/pdf_viewer.mjs');

export function getPdfjsViewerRuntimeProbeFailures(runtime: unknown = pdfjsViewerLib) {
    if ((typeof runtime !== 'object' || runtime === null) && typeof runtime !== 'function') {
        return ['PDF.js viewer runtime is not an object'];
    }
    const runtimeRecord = runtime as Record<PropertyKey, unknown>;
    const failures: string[] = [];
    if (typeof runtimeRecord.EventBus !== 'function') {
        failures.push('EventBus export is not a constructor');
    }
    if (typeof runtimeRecord.GenericL10n !== 'function') {
        failures.push('GenericL10n export is not a constructor');
    }
    return failures;
}

function assertPdfjsViewerRuntimeCompatibility(runtime: unknown = pdfjsViewerLib) {
    const failures = getPdfjsViewerRuntimeProbeFailures(runtime);
    if (failures.length === 0) {
        return;
    }
    throw new Error(`PDF.js viewer runtime is incompatible: ${failures.join('; ')}`);
}

assertPdfjsViewerRuntimeCompatibility(pdfjsViewerLib);
