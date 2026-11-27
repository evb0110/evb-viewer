import {afterEach, describe, expect, it} from 'vitest';
import {ensurePdfjsSsrGlobals} from '@app/services/pdfjs/ensurePdfjsSsrGlobals';

interface IGlobalWithDomMatrix {
    DOMMatrix?: unknown;
}

const globalScope = globalThis as IGlobalWithDomMatrix;
const originalDomMatrix = globalScope.DOMMatrix;

afterEach(() => {
    if (originalDomMatrix === undefined) {
        delete globalScope.DOMMatrix;
        return;
    }

    globalScope.DOMMatrix = originalDomMatrix;
});

describe('ensurePdfjsSsrGlobals', () => {
    it('installs DOMMatrix in Node-like test runtimes that are not marked as SSR', () => {
        delete globalScope.DOMMatrix;

        ensurePdfjsSsrGlobals();

        expect(globalScope.DOMMatrix).toBeTypeOf('function');
        expect(new (globalScope.DOMMatrix as new () => {a: number})().a).toBe(1);
    });
});
