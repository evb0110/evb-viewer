import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createBrowserDocumentRefValue,
    createNativeDocumentRefValue,
    inferDocumentRefBackend,
    isBrowserStructuredDocumentRef,
    isNativeStructuredDocumentRef,
    requireDocumentRef,
} from '@contracts/documentRef';
import {
    getDocumentRefBaseName,
    getDocumentRefDisplayLabel,
    isBrowserDocumentRef,
    isNativeDocumentRef,
    resolveDocumentRefBackend,
} from '@app/utils/documentRef';
import {createBrowserDocumentRef} from '@app/platform/browser/browserDocumentRefs';
import type {TDocumentRef} from '@contracts/documentRef';

function isDocumentRefFixture(value: unknown): value is TDocumentRef {
    // Legacy document refs are branded strings, so the brand has no runtime
    // marker. Keep the malformed relative value at the boundary intentionally.
    return typeof value === 'string';
}

describe('documentRef discrimination', () => {
    it('distinguishes browser refs from native absolute paths', () => {
        expect(isBrowserDocumentRef(requireDocumentRef('browser://documents/source-1'))).toBe(true);
        expect(isNativeDocumentRef(requireDocumentRef('browser://documents/source-1'))).toBe(false);
        expect(resolveDocumentRefBackend(requireDocumentRef('browser://documents/source-1'))).toBe('browser');

        expect(isNativeDocumentRef(requireDocumentRef('/Users/example/document.pdf'))).toBe(true);
        expect(isBrowserDocumentRef(requireDocumentRef('/Users/example/document.pdf'))).toBe(false);
        expect(resolveDocumentRefBackend(requireDocumentRef('/Users/example/document.pdf'))).toBe('electron');

        const relativeRef: unknown = 'relative/document.pdf';
        if (!isDocumentRefFixture(relativeRef)) {
            throw new TypeError('Invalid document reference fixture');
        }
        expect(inferDocumentRefBackend(relativeRef)).toBe('unknown');
        expect(resolveDocumentRefBackend(relativeRef)).toBeUndefined();
    });

    it('brands structured browser and native refs with backend identity', () => {
        const browserRef = createBrowserDocumentRefValue('browser://documents/source-2');
        const nativeRef = createNativeDocumentRefValue('/Users/example/native.pdf');

        expect(isBrowserStructuredDocumentRef(browserRef)).toBe(true);
        expect(browserRef.backend).toBe('browser');
        expect(isNativeStructuredDocumentRef(nativeRef)).toBe(true);
        expect(nativeRef.backend).toBe('electron');
    });

    it('shows a native basename literally, percent sequences included', () => {
        const nativeRef = requireDocumentRef('/documents/report%20final.pdf');

        expect(getDocumentRefBaseName(nativeRef)).toBe('report%20final.pdf');
        expect(getDocumentRefDisplayLabel(nativeRef)).toBe('/documents/report%20final.pdf');
        expect(getDocumentRefBaseName(requireDocumentRef('/documents/report final.pdf'))).toBe('report final.pdf');
    });

    it('decodes a browser basename exactly once', () => {
        const percentRef = createBrowserDocumentRef('report%20final.pdf');
        const spaceRef = createBrowserDocumentRef('report final.pdf');
        const cyrillicRef = createBrowserDocumentRef('Галактика 100%.pdf');

        expect(getDocumentRefBaseName(percentRef)).toBe('report%20final.pdf');
        expect(getDocumentRefBaseName(spaceRef)).toBe('report final.pdf');
        expect(getDocumentRefBaseName(cyrillicRef)).toBe('Галактика 100%.pdf');
        expect(getDocumentRefDisplayLabel(percentRef)).toBe('report%20final.pdf');
    });

    it('keeps a browser basename with a malformed escape raw', () => {
        expect(getDocumentRefBaseName(requireDocumentRef('browser://documents/source/100%.pdf'))).toBe('100%.pdf');
    });
});
