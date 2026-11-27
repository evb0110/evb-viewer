// @vitest-environment happy-dom

import {describe, expect, it} from 'vitest';
import {getPageContainer} from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';
import {setupPagePlaceholderSizes} from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/setupPagePlaceholderSizes';
import {requirePageIndex} from '@contracts/pageNumbers';

function createPageContainerRoot(pageNumbers: number[]) {
    const root = document.createElement('div');
    for (const pageNumber of pageNumbers) {
        const container = document.createElement('div');
        container.classList.add('page_container');
        container.dataset.page = String(pageNumber);
        root.append(container);
    }
    return root;
}

function createStyledPageContainerRoot(pageNumbers: number[]) {
    function createStyle() {
        const customProperties = new Map<string, string>();
        return {
            setProperty: (name: string, value: string) => customProperties.set(name, value),
            getPropertyValue: (name: string) => customProperties.get(name) ?? '',
        };
    }
    const root = document.createElement('div');
    const containers = pageNumbers.map((pageNumber) => {
        const container = document.createElement('div');
        container.classList.add('page_container');
        container.dataset.page = String(pageNumber);
        Object.defineProperty(container, 'style', {
            configurable: true,
            value: createStyle(),
        });
        root.append(container);
        return container;
    });
    return {
        containers,
        root,
    };
}

describe('pdfPageBufferManager.getPageContainer', () => {
    it('finds mounted page containers by data-page', () => {
        const root = createPageContainerRoot([41, 44]);

        const page41 = getPageContainer(root, requirePageIndex(40));
        const page44 = getPageContainer(root, requirePageIndex(43));

        expect(page41?.dataset.page).toBe('41');
        expect(page44?.dataset.page).toBe('44');
    });

    it('does not use positional fallback when target page is not mounted', () => {
        const root = createPageContainerRoot([41, 44]);

        expect(getPageContainer(root, requirePageIndex(0))).toBeNull();
    });

    it('sizes mounted placeholders from each page metric instead of one shared size', () => {
        const {containers, root} = createStyledPageContainerRoot([1, 2]);

        setupPagePlaceholderSizes(
            root,
            [
                {
                    width: 100,
                    height: 200,
                    userUnit: 2,
                },
                {
                    width: 50,
                    height: 80,
                },
            ],
            2,
        );

        expect(containers[0]?.style.width).toBe('200px');
        expect(containers[0]?.style.height).toBe('400px');
        expect(containers[1]?.style.width).toBe('100px');
        expect(containers[1]?.style.height).toBe('160px');
        expect(containers[0]?.style.getPropertyValue('--scale-factor')).toBe('2');
        expect(containers[0]?.style.getPropertyValue('--user-unit')).toBe('2');
        expect(containers[0]?.style.getPropertyValue('--total-scale-factor')).toBe('calc(var(--scale-factor, 1) * var(--user-unit, 1))');
    });

    it('accepts a committed scale per page while navigation changes the global scale', () => {
        const {containers, root} = createStyledPageContainerRoot([1, 2]);

        setupPagePlaceholderSizes(
            root,
            [
                {
                    width: 100,
                    height: 200,
                },
                {
                    width: 50,
                    height: 80,
                },
            ],
            2,
            (pageNumber) => (pageNumber === 1 ? 1.5 : 2),
        );

        expect(containers[0]?.style.width).toBe('150px');
        expect(containers[0]?.style.height).toBe('300px');
        expect(containers[0]?.style.getPropertyValue('--scale-factor')).toBe('1.5');
        expect(containers[1]?.style.width).toBe('100px');
        expect(containers[1]?.style.height).toBe('160px');
    });
});
