import {
    describe,
    expect,
    it,
} from 'vitest';
import {createPageNavigationRequest} from '@app/modules/document-viewer/public';
import {createPdfPageNavigationRequest} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/createPdfPageNavigationRequest';

describe('createPdfPageNavigationRequest', () => {
    it('preserves a fully formed request supplied by a destination resolver', () => {
        const request = createPageNavigationRequest(4, 'bookmark');

        expect(createPdfPageNavigationRequest(9, {
            navigationRequest: request,
            navigationSource: 'search',
        })).toBe(request);
    });

    it('keeps search text identity and readiness in the shared request', () => {
        const request = createPdfPageNavigationRequest(6, {
            navigationSource: 'search',
            searchNavigationId: 12,
            textAnchor: {
                text: 'lexical item',
                searchRange: {
                    startOffset: 3,
                    endOffset: 15,
                },
                pageMatchIndex: 2,
            },
        });

        expect(request).toMatchObject({
            searchNavigationId: 12,
            source: 'search',
            alignment: 'rect-center',
            readiness: 'text-layer',
            postArrival: 'search-highlight',
            target: {
                kind: 'text-anchor',
                page: 6,
                text: 'lexical item',
                pageMatchIndex: 2,
            },
        });
    });

    it('infers annotation readiness for marker targets and clamps ratio targets', () => {
        expect(createPdfPageNavigationRequest(
            3,
            {markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            }},
        )).toMatchObject({
            source: 'annotation',
            alignment: 'rect-center',
            readiness: 'annotation-editor',
            postArrival: 'annotation-pulse',
            target: {
                kind: 'rect',
                page: 3,
            },
        });

        expect(createPdfPageNavigationRequest(8, {
            navigationSource: 'bookmark',
            pageYRatio: 4,
        })).toMatchObject({
            source: 'bookmark',
            alignment: 'page-top',
            target: {
                kind: 'rect',
                page: 8,
                rect: {
                    left: 0.5,
                    top: 1,
                    width: 0,
                    height: 0,
                },
            },
        });
    });
});
