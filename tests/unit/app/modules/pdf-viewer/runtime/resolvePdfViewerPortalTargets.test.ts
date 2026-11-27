import {requirePageNumber} from '@contracts/pageNumbers';
import {describe, expect, it} from 'vitest';
import {resolvePdfViewerPortalTargets} from '@app/modules/pdf-viewer/runtime/portal/resolvePdfViewerPortalTargets';

function toElement<T extends object>(value: T) {
    return value as HTMLElement;
}

describe('resolvePdfViewerPortalTargets', () => {
    it('resolves only mounted page targets', () => {
        const pageOne = toElement({id: 'page-1'});
        const pageThree = toElement({id: 'page-3'});
        const targetsBySelector = new Map<string, HTMLElement>([
            ['.page_container[data-page="1"]', pageOne],
            ['.page_container[data-page="3"]', pageThree],
        ]);
        const viewerContainer = toElement({querySelector: (selector: string) => targetsBySelector.get(selector) ?? null});

        const targets = resolvePdfViewerPortalTargets(viewerContainer, [requirePageNumber(1), requirePageNumber(2), requirePageNumber(3)]);

        expect(targets.get(1)).toBe(pageOne);
        expect(targets.has(2)).toBe(false);
        expect(targets.get(3)).toBe(pageThree);
    });

    it('returns an empty map when the viewer container is missing', () => {
        expect(resolvePdfViewerPortalTargets(null, [requirePageNumber(1), requirePageNumber(2)])).toEqual(new Map());
    });
});
