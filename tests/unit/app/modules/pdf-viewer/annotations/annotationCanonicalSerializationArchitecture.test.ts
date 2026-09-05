import {
    existsSync,
    readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

function source(path: string) {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/**
 * Matches a locally implemented `clearSelection*` callback in any form the
 * bridge could regrow one in: a function declaration, an arrow, or a function
 * expression. It deliberately does not match a name that is only imported,
 * destructured, or called, because delegating to the shared module is the
 * outcome these tests are protecting.
 */
const LOCAL_SELECTION_CLEANUP_CALLBACK = String.raw`(?:(?:^|\W)(?:async\s+)?function\s+clearSelection\w*\s*\(`
    + String.raw`|\b(?:const|let|var)\s+clearSelection\w*\s*(?::[^\n]*?)?=\s*(?:async\s*)?(?:function\b|\(|\w+\s*=>))`;

describe('local selection cleanup callback pattern', () => {
    it('recognises every form a local callback could be written in', () => {
        for (const localForm of [
            'const clearSelection = () => {',
            '    const clearSelectionClasses = (editor: IPdfjsEditor) => {',
            '    const clearSelectionVisuals = async () => {',
            '    const clearSelectionClasses = function () {',
            '    let clearSelection: () => void = () => {',
            'function clearSelectionClasses() {',
            '    async function clearSelectionVisuals(editor) {',
            '    const clearSelectionClasses = editor => {',
        ]) {
            expect(localForm).toMatch(new RegExp(LOCAL_SELECTION_CLEANUP_CALLBACK, 'u'));
        }
    });

    it('leaves delegating code alone', () => {
        for (const delegatingForm of [
            'import { clearSelectionCache } from \'@app/modules/pdf-viewer/runtime/annotations/selection\';',
            '        clearSelectionCache,',
            '        clearSelectionCache();',
            '            clearEditorSelectionVisuals({',
            '    const clearSelectionCache = cache.clear;',
            // An identifier that merely ends in a declaration keyword is not one.
            '    myconst clearSelection = () => {',
        ]) {
            expect(delegatingForm).not.toMatch(new RegExp(LOCAL_SELECTION_CLEANUP_CALLBACK, 'u'));
        }
    });
});

describe('canonical annotation serialization architecture', () => {
    it('does not retain raw PDF.js editors in deferred selection cleanup callbacks', () => {
        expect(existsSync(resolve(process.cwd(), 'app/modules/pdf-viewer/annotations/bridge'))).toBe(false);
    });

    it('keeps the highlight bridge delegating its selection cleanup', () => {
        expect(existsSync(resolve(process.cwd(), 'app/modules/pdf-viewer/annotations/bridge'))).toBe(false);
    });

    it('routes viewer annotation failures into the one shared workspace surface', () => {
        const contents = source('app/modules/workspace-shell/useWorkspaceOrchestration.ts');
        // The workspace is the last link in the chain that carries a rejected
        // annotation to the user; an unbound sink makes every viewer-side
        // failure silent again, which is the defect issue #91 fixed.
        expect(contents).toContain('onAnnotationFailure: failureSurface.reportAnnotationFailure');
    });

    it('keeps workspace annotation projections out of the PDF serializer', () => {
        const contents = source('app/modules/pdf-viewer/runtime/composables/pdf/pdfDocumentPersistence.ts');
        expect(contents).not.toContain('annotationComments: Ref<');
        expect(contents).not.toContain('getAnnotationCommentsSnapshot');
        expect(contents).not.toContain('mergeAnnotationCommentSaveSnapshot');
        expect(contents).not.toContain('applyAnnotationPayload');
        expect(contents).toContain('consumeNativePdfMutationProjection');
    });

    it('routes print serialization through the canonical viewer transaction', () => {
        const contents = source('app/modules/workspace-shell/composables/createPrintableSourceDataResolver.ts');
        const transactionStart = contents.indexOf('mode: \'print\'');
        const transactionEnd = contents.indexOf('resolvePdfViewerSaveTransactionFinalBytes(printTransaction)');
        expect(transactionStart).toBeGreaterThan(-1);
        expect(transactionEnd).toBeGreaterThan(transactionStart);
        const printTransaction = contents.slice(transactionStart, transactionEnd);
        expect(printTransaction).toContain('serializeResult: true');
        expect(printTransaction).toContain('source: deps.source');
        expect(contents).not.toContain('serializePrintableSourceData');
        expect(contents).not.toContain('commitAnnotationSave');
    });

    it('runs the dirty print transaction under the document operation lease', () => {
        const orchestration = source('app/modules/workspace-shell/useWorkspaceOrchestration.ts');
        const resolverStart = orchestration.indexOf('createPrintableSourceDataResolver({');
        const resolverEnd = orchestration.indexOf('async function ensurePrintReady');
        expect(resolverStart).toBeGreaterThan(-1);
        expect(resolverEnd).toBeGreaterThan(resolverStart);
        const printResolver = orchestration.slice(resolverStart, resolverEnd);
        expect(printResolver).toContain('runWithDocumentOperationLease: documentOperationLease.runExclusive');
        expect(orchestration).not.toContain('mode: \'print\'');
    });
});
