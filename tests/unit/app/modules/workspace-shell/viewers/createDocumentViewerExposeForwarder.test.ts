import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { shallowRef } from 'vue';
import { createDocumentViewerExposeForwarder } from '@app/modules/workspace-shell/viewers/createDocumentViewerExposeForwarder';

describe('createDocumentViewerExposeForwarder', () => {
    it('keeps one exposed port while the chassis swaps source feature packs', () => {
        const pdfScroll = vi.fn();
        const djvuScroll = vi.fn();
        const target = shallowRef<Record<PropertyKey, unknown> | null>({scrollToPage: pdfScroll});
        const exposed = createDocumentViewerExposeForwarder(target);
        const options = {navigationSource: 'annotation' as const};
        const scrollToPage = (page: number) => {
            const method = Reflect.get(exposed, 'scrollToPage');
            if (typeof method !== 'function') {
                throw new Error('scrollToPage is unavailable');
            }
            method(page);
        };

        scrollToPage(3);
        target.value = {scrollToPage: djvuScroll};
        scrollToPage(7);

        expect(pdfScroll).toHaveBeenCalledWith(3);
        expect(djvuScroll).toHaveBeenCalledWith(7);

        const method = Reflect.get(exposed, 'scrollToPage');
        if (typeof method !== 'function') {
            throw new Error('scrollToPage is unavailable');
        }
        method(11, options);
        expect(djvuScroll).toHaveBeenLastCalledWith(11, options);
    });

    it('keeps stable chassis navigation callable while a feature pack is absent or swapping', () => {
        const transientPdfScroll = vi.fn();
        const target = shallowRef<Record<PropertyKey, unknown> | null>(null);
        const stableScroll = vi.fn();
        const exposed = createDocumentViewerExposeForwarder(target, {
            getPendingNavigationTargetPage: () => 6,
            scrollToPage: stableScroll,
        });
        const scrollToPage = (page: number) => {
            const method = Reflect.get(exposed, 'scrollToPage');
            if (typeof method !== 'function') {
                throw new Error('scrollToPage is unavailable');
            }
            method(page);
        };

        for (let page = 2; page <= 6; page += 1) {
            scrollToPage(page);
        }
        target.value = {scrollToPage: transientPdfScroll};
        expect(Reflect.get(exposed, 'getPendingNavigationTargetPage')()).toBe(6);

        expect(stableScroll).toHaveBeenCalledTimes(5);
        expect(stableScroll).toHaveBeenLastCalledWith(6);
        expect(transientPdfScroll).not.toHaveBeenCalled();
    });
});
