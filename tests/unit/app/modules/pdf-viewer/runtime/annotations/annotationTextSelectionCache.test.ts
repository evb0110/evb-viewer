// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useAnnotationTextSelectionCache } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationTextSelectionCache';

function addTextLayerPage(pageNumber: number, text: string) {
    const page = document.createElement('div');
    page.className = 'page_container';
    page.dataset.page = String(pageNumber);
    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    const span = document.createElement('span');
    span.append(document.createTextNode(text));
    textLayer.append(span);
    page.append(textLayer);
    return {
        page,
        textNode: span.firstChild as Text,
    };
}

describe('useAnnotationTextSelectionCache', () => {
    afterEach(() => {
        document.body.replaceChildren();
        document.getSelection()?.removeAllRanges();
    });

    it('caches a selection whose endpoints are in different page text layers', () => {
        const viewer = document.createElement('div');
        const firstPage = addTextLayerPage(1, 'first page');
        const secondPage = addTextLayerPage(2, 'second page');
        viewer.append(firstPage.page, secondPage.page);
        document.body.append(viewer);

        const range = document.createRange();
        range.setStart(firstPage.textNode, 0);
        range.setEnd(secondPage.textNode, secondPage.textNode.length);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        const cache = useAnnotationTextSelectionCache({
            viewerContainer: ref(viewer),
            currentPage: ref(1),
            allowCrossPage: true,
        });

        cache.cacheCurrentTextSelection();
        selection?.removeAllRanges();

        expect(cache.doesRangeSpanTextLayers(range)).toBe(true);
        expect(cache.getSelectionRangeForCommentAction()?.toString()).toContain('first page');
        expect(cache.getSelectionRangeForCommentAction()?.toString()).toContain('second page');
    });
});
