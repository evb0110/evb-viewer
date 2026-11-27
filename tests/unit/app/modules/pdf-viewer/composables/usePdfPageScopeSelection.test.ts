import {describe, expect, it} from 'vitest';
import {effectScope} from 'vue';
import {usePdfPageScopeSelection} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfPageScopeSelection';
import {createAllPageSelection} from '@app/utils/pdfPageSelection';

describe('usePdfPageScopeSelection', () => {
    it('reserves undefined for all pages and null for invalid scoped selections', () => {
        const scope = effectScope();

        scope.run(() => {
            const selection = usePdfPageScopeSelection({
                totalPages: () => 5,
                currentPage: () => 3,
                selectedPages: () => [],
                resolveRangePages: () => null,
            });

            selection.scope.value = 'all';
            expect(selection.resolveScopedPageNumbers()).toBeUndefined();

            selection.scope.value = 'range';
            expect(selection.resolveScopedPageNumbers()).toBeNull();

            selection.scope.value = 'selected';
            expect(selection.resolveScopedPageNumbers()).toBeNull();
        });

        scope.stop();
    });

    it('returns explicit page arrays for valid current, selected, and range scopes', () => {
        const scope = effectScope();

        scope.run(() => {
            const selection = usePdfPageScopeSelection({
                totalPages: () => 5,
                currentPage: () => 3,
                selectedPages: () => [5, 2, 2, 9],
                resolveRangePages: () => [1, 2],
            });

            selection.scope.value = 'current';
            expect(selection.resolveScopedPageNumbers()).toEqual([3]);

            selection.scope.value = 'selected';
            expect(selection.resolveScopedPageNumbers()).toEqual([2, 5]);

            selection.scope.value = 'range';
            expect(selection.resolveScopedPageNumbers()).toEqual([1, 2]);
        });

        scope.stop();
    });

    it('supports explicit all-page and parity scopes for page-operation dialogs', () => {
        const scope = effectScope();

        scope.run(() => {
            const selection = usePdfPageScopeSelection({
                totalPages: () => 5,
                currentPage: () => 3,
                selectedPages: () => [],
                resolveRangePages: () => null,
            });

            selection.scope.value = 'all';
            expect(selection.resolveScopedPageNumbers()).toBeUndefined();
            expect(selection.resolveScopedPageNumbers({includeAllPages: true})).toEqual([1, 2, 3, 4, 5]);

            selection.scope.value = 'even';
            expect(selection.resolveScopedPageNumbers()).toEqual([2, 4]);

            selection.scope.value = 'odd';
            expect(selection.resolveScopedPageNumbers()).toEqual([1, 3, 5]);

            selection.scope.value = 'range';
            selection.rangeInput.value = '1-2';
            selection.rangeTouched.value = true;
            selection.resetScopeForOpen('current');

            expect(selection.scope.value).toBe('current');
            expect(selection.rangeInput.value).toBe('');
            expect(selection.rangeTouched.value).toBe(false);
        });

        scope.stop();
    });

    it('uses compact selected state when choosing the default scope', () => {
        const scope = effectScope();

        scope.run(() => {
            const selection = usePdfPageScopeSelection({
                totalPages: () => 1_000_000,
                currentPage: () => 1,
                selectedPages: () => [],
                selectedPageSelection: () => createAllPageSelection(1_000_000),
            });

            selection.resetScopeForOpen();

            expect(selection.scope.value).toBe('selected');
        });

        scope.stop();
    });
});
