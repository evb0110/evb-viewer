import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    applyParsedHighlightTextToStore,
    commitPdfAnnotationParseToStore,
    type ICommitPdfAnnotationParseToStoreOptions,
} from '@app/modules/pdf-viewer/runtime/sessions/commitPdfAnnotationParseToStore';
import type {ITextMarkupEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';

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

describe('PDF annotation session behavior', () => {
    it('keeps enrichment tied to current markup geometry', () => {
        const store = new AnnotationStore();
        const parsedQuadPoints = [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }];
        const movedQuadPoints = [{
            left: 0.5,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }];
        const markup: ITextMarkupEntity = {
            kind: 'text-markup',
            identity: {
                id: asAnnotationId('parsed-highlight'),
                pdfRef: '12 0 R',
            },
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            subtype: 'Highlight',
            contents: '',
            quadPoints: parsedQuadPoints,
            color: '#ffff00',
            opacity: 1,
            selectedText: null,
        };
        const created = store.createTextMarkup(markup);
        const parsedMarkupGeometryByPdfRef = new Map([[
            '12 0 R',
            parsedQuadPoints,
        ]]);

        applyParsedHighlightTextToStore({
            targetStore: store,
            selectedTextByPdfRef: new Map([[
                '12 0 R',
                'selected text',
            ]]),
            parsedMarkupGeometryByPdfRef,
        });
        expect(store.get(created.identity.id)).toMatchObject({selectedText: 'selected text'});

        store.updateTextMarkup(created.identity.id, {
            color: '#00ff00',
            opacity: 0.5,
            contents: 'Authored note',
        });
        applyParsedHighlightTextToStore({
            targetStore: store,
            selectedTextByPdfRef: new Map([[
                '12 0 R',
                null,
            ]]),
            parsedMarkupGeometryByPdfRef,
        });
        expect(store.get(created.identity.id)).toMatchObject({
            contents: 'Authored note',
            selectedText: 'selected text',
        });

        store.updateTextMarkup(created.identity.id, {quadPoints: movedQuadPoints});
        applyParsedHighlightTextToStore({
            targetStore: store,
            selectedTextByPdfRef: new Map([[
                '12 0 R',
                'stale text',
            ]]),
            parsedMarkupGeometryByPdfRef,
        });
        expect(store.get(created.identity.id)).toMatchObject({selectedText: null});
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
            pageIndex: requirePageIndex(0),
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
