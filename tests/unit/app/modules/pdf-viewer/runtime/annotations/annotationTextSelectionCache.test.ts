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

    it('consumes the native selection when the captured revision succeeds', () => {
        const viewer = document.createElement('div');
        const firstPage = addTextLayerPage(1, 'selected text');
        viewer.append(firstPage.page);
        document.body.append(viewer);
        const range = document.createRange();
        range.setStart(firstPage.textNode, 0);
        range.setEnd(firstPage.textNode, firstPage.textNode.length);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        const cache = useAnnotationTextSelectionCache({
            viewerContainer: ref(viewer),
            currentPage: ref(1),
        });
        cache.cacheCurrentTextSelection();
        const snapshot = cache.getSelectionSnapshotForToolActivation();

        expect(snapshot).not.toBeNull();
        cache.consumeSelection(snapshot!);

        expect(selection?.rangeCount).toBe(0);
        expect(cache.getSelectionSnapshotForToolActivation()).toBeNull();
        expect(cache.getSelectionSnapshotForCommentAction()).toBeNull();
    });

    it('does not consume a newer selection when an older geometry request finishes', () => {
        const viewer = document.createElement('div');
        const firstPage = addTextLayerPage(1, 'first selection');
        const secondPage = addTextLayerPage(2, 'second selection');
        viewer.append(firstPage.page, secondPage.page);
        document.body.append(viewer);
        const selection = document.getSelection();
        const cache = useAnnotationTextSelectionCache({
            viewerContainer: ref(viewer),
            currentPage: ref(1),
            allowCrossPage: true,
        });
        const firstRange = document.createRange();
        firstRange.setStart(firstPage.textNode, 0);
        firstRange.setEnd(firstPage.textNode, firstPage.textNode.length);
        selection?.removeAllRanges();
        selection?.addRange(firstRange);
        cache.cacheCurrentTextSelection();
        const firstSnapshot = cache.getSelectionSnapshotForToolActivation();

        const secondRange = document.createRange();
        secondRange.setStart(secondPage.textNode, 0);
        secondRange.setEnd(secondPage.textNode, secondPage.textNode.length);
        selection?.removeAllRanges();
        selection?.addRange(secondRange);
        cache.cacheCurrentTextSelection();
        const secondSnapshot = cache.getSelectionSnapshotForToolActivation();

        cache.consumeSelection(firstSnapshot!);

        expect(selection?.toString()).toBe('second selection');
        expect(cache.getSelectionSnapshotForToolActivation()?.revision).toBe(secondSnapshot?.revision);
        expect(cache.getSelectionSnapshotForCommentAction()?.range.toString()).toBe('second selection');
    });

    it('protects a repeated gesture from the pointer press through its next selection change', () => {
        const viewer = document.createElement('div');
        const firstPage = addTextLayerPage(1, 'same selection');
        viewer.append(firstPage.page);
        document.body.append(viewer);
        const range = document.createRange();
        range.setStart(firstPage.textNode, 0);
        range.setEnd(firstPage.textNode, firstPage.textNode.length);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const cache = useAnnotationTextSelectionCache({
            viewerContainer: ref(viewer),
            currentPage: ref(1),
        });
        cache.cacheCurrentTextSelection();
        const firstSnapshot = cache.getSelectionSnapshotForToolActivation();

        cache.beginSelectionGesture();
        cache.consumeSelection(firstSnapshot!);
        expect(selection?.toString()).toBe('same selection');
        selection?.removeAllRanges();
        selection?.addRange(range);
        cache.cacheCurrentTextSelection();
        const secondSnapshot = cache.getSelectionSnapshotForToolActivation();

        expect(secondSnapshot?.revision).toBeGreaterThan(firstSnapshot?.revision ?? 0);
        cache.consumeSelection(firstSnapshot!);
        expect(cache.getSelectionSnapshotForToolActivation()?.revision).toBe(secondSnapshot?.revision);
        expect(selection?.toString()).toBe('same selection');
    });

    it('invalidates automatic activation while preserving explicit cache access', () => {
        const viewer = document.createElement('div');
        const firstPage = addTextLayerPage(1, 'cached text');
        viewer.append(firstPage.page);
        document.body.append(viewer);
        const range = document.createRange();
        range.setStart(firstPage.textNode, 0);
        range.setEnd(firstPage.textNode, firstPage.textNode.length);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const cache = useAnnotationTextSelectionCache({
            viewerContainer: ref(viewer),
            currentPage: ref(1),
        });
        cache.cacheCurrentTextSelection();
        cache.invalidateSelectionForToolActivation();

        expect(cache.getSelectionSnapshotForToolActivation()).toBeNull();
        expect(cache.getSelectionSnapshotForCommentAction()?.range.toString()).toBe('cached text');
    });
});
