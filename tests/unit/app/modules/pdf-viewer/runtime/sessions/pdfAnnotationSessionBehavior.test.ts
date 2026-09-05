import {
    existsSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    commitPdfAnnotationParseToStore,
    type ICommitPdfAnnotationParseToStoreOptions,
} from '@app/modules/pdf-viewer/runtime/sessions/commitPdfAnnotationParseToStore';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';

const root = process.cwd();
const sessionPath = 'app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession.ts';

function read(path: string) {
    return readFileSync(join(root, path), 'utf8');
}

function TypeScriptFiles(path: string): string[] {
    return readdirSync(join(root, path), {withFileTypes: true}).flatMap((entry) => {
        const child = join(path, entry.name);
        return entry.isDirectory()
            ? TypeScriptFiles(child)
            : entry.name.endsWith('.ts')
                ? [child]
                : [];
    });
}

const revisionToken = requireDocumentRevisionToken('drt1:annotation-session-behavior-test');

function writerParseResult(): IPdfAnnotationParseResult {
    return {
        documentRevisionToken: revisionToken,
        pageCount: 1,
        entities: [{
            kind: 'text-box',
            pageIndex: requirePageIndex(0),
            objectNumber: 11,
            generationNumber: 0,
            name: 'writer-text-box',
            author: null,
            createdAt: null,
            modifiedAt: null,
            text: 'writer text',
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            },
            rotation: 0,
            fontSize: 12,
            color: '#336699',
        }],
        foreign: [{
            kind: 'foreign',
            pageIndex: requirePageIndex(0),
            objectNumber: 12,
            generationNumber: 0,
            name: 'link-12',
            subtype: 'Link',
            reason: 'Unsupported annotation subtype /Link',
        }],
    };
}

function commitOptions(
    store: AnnotationStore,
    overrides: Partial<ICommitPdfAnnotationParseToStoreOptions> = {},
): ICommitPdfAnnotationParseToStoreOptions {
    return {
        result: writerParseResult(),
        request: 1,
        currentRequest: 1,
        isTransitionCurrent: () => true,
        targetStore: store,
        currentStore: store,
        targetStoreMutationEpoch: store.mutationEpoch,
        workingCopyPath: '/tmp/working.pdf',
        currentWorkingCopyPath: '/tmp/working.pdf',
        expectedRevisionToken: revisionToken,
        currentRevisionToken: revisionToken,
        ...overrides,
    };
}

describe('PDF annotation session authority', () => {
    it('is the only runtime constructor of the canonical Store and Application', () => {
        const constructors = [
            ...TypeScriptFiles('app/modules/pdf-viewer/runtime'),
            ...TypeScriptFiles('app/modules/pdf-viewer/tools'),
        ].filter(path => /new (?:AnnotationStore|AnnotationApplication)\b/.test(read(path)));

        expect(constructors).toEqual([sessionPath]);
        expect(read(sessionPath)).toMatch(
            /new AnnotationApplication\(documentKey, new AnnotationStore\(/,
        );
    });

    it('has no detached runtime, orchestrator, or rendering-port authority', () => {
        [
            'app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime.ts',
            'app/modules/pdf-viewer/runtime/annotations/useAnnotationOrchestrator.ts',
            'app/modules/pdf-viewer/runtime/annotations/createAttachablePdfAnnotationRenderingPort.ts',
            'app/modules/pdf-viewer/runtime/annotations/annotationOrchestrator.ts',
            'app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntimeBridge.ts',
        ].forEach(path => expect(existsSync(join(root, path))).toBe(false));

        const source = read(sessionPath);
        expect(source).not.toMatch(/attachRenderingPort|renderingPort/);
        expect(source).toMatch(/rendering\.renderVisiblePages/);
        expect(source).not.toMatch(/rendering\.renderAnnotationEditorLayerForPage/);
        expect(source).toContain('usePdfAnnotationEditorSurface');
        expect(source).not.toContain('shouldSuppressSidebarComment');
    });

    it('allows direct path parses to acquire their revision before publishing', () => {
        const watcher = read(sessionPath).match(
            /watch\(\(\) => \[\s*options\.workingCopyPath\.value,[\s\S]*?immediate: true,\s*\}\);/,
        )?.[0];

        expect(watcher).toBeDefined();
        expect(watcher).toContain('if (!documentSession.pdfDocument.value)');
        expect(watcher).not.toContain('!options.documentRevisionToken.value');
        expect(read(sessionPath)).toContain('getDocumentFilesCapability().getDocumentRevision(parsePath)');
    });

    it('commits current writer results and ignores stale store mutations', () => {
        const store = new AnnotationStore();
        const replaceFromDocument = vi.spyOn(store, 'replaceFromDocument');

        expect(commitPdfAnnotationParseToStore(commitOptions(store))).toBe(true);
        expect(replaceFromDocument).toHaveBeenCalledTimes(1);
        expect(store.list()).toMatchObject([{
            kind: 'text-box',
            text: 'writer text',
            identity: {pdfRef: '11 0 R'},
        }]);
        expect(store.foreign).toMatchObject([{
            subtype: 'Link',
            name: 'link-12',
        }]);

        const staleStore = new AnnotationStore();
        const local = staleStore.createTextBox({
            identity: {id: asAnnotationId('local-text-box')},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            kind: 'text-box',
            text: 'local text',
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            },
            rotation: 0,
            fontSize: 12,
            color: '#336699',
        });
        const parseStartEpoch = staleStore.mutationEpoch;
        staleStore.updateTextBox(local.identity.id, {text: 'local edit'});
        const staleReplaceFromDocument = vi.spyOn(staleStore, 'replaceFromDocument');
        const staleOptions = commitOptions(staleStore, {targetStoreMutationEpoch: parseStartEpoch});

        expect(commitPdfAnnotationParseToStore(staleOptions)).toBe(false);
        expect(staleReplaceFromDocument).not.toHaveBeenCalled();
        expect(staleStore.get(local.identity.id)).toMatchObject({text: 'local edit'});
    });

});
