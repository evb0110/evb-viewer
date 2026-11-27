import {afterEach, describe, expect, it, vi} from 'vitest';
import {createBrowserSafeId, safeDecodeURIComponent, safeGetSessionStorageItem, safeSetSessionStorageItem} from '@app/utils/browserSafe';

interface ITestGlobal {
    crypto?: unknown;
    window?: unknown;
}

const testGlobal = globalThis as ITestGlobal;
const originalCrypto = testGlobal.crypto;
const originalWindow = testGlobal.window;

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('crypto', originalCrypto);
    vi.stubGlobal('window', originalWindow);
});

describe('safeDecodeURIComponent', () => {
    it('returns null for malformed percent encoding', () => {
        expect(safeDecodeURIComponent('%E0%A4%A')).toBeNull();
    });

    it('decodes valid URI component values', () => {
        expect(safeDecodeURIComponent('hello%20world')).toBe('hello world');
    });
});

describe('createBrowserSafeId', () => {
    it('uses randomUUID when available', () => {
        vi.stubGlobal('crypto', {randomUUID: () => 'uuid-1'});

        expect(createBrowserSafeId('search')).toBe('search-uuid-1');
    });

    it('falls back to getRandomValues when randomUUID throws', () => {
        vi.stubGlobal('crypto', {
            randomUUID: () => {
                throw new Error('blocked');
            },
            getRandomValues: (bytes: Uint8Array) => {
                bytes.fill(0xab);
                return bytes;
            },
        });

        expect(createBrowserSafeId()).toBe('abababababababababababababababab');
    });

    it('falls back to date and Math.random when crypto is unavailable', () => {
        vi.stubGlobal('crypto', undefined);
        vi.spyOn(Date, 'now').mockReturnValue(123_456);
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        expect(createBrowserSafeId()).toBe('2n9c-i');
    });
});

describe('session storage safe helpers', () => {
    it('treats throwing storage reads as missing state', () => {
        vi.stubGlobal('window', {
            sessionStorage: {
                getItem: () => {
                    throw new Error('blocked');
                },
            },
        });

        expect(safeGetSessionStorageItem('key')).toBeNull();
    });

    it('does not throw when storage writes fail', () => {
        vi.stubGlobal('window', {
            sessionStorage: {
                setItem: () => {
                    throw new Error('blocked');
                },
            },
        });

        expect(() => safeSetSessionStorageItem('key', 'value')).not.toThrow();
    });

    it('reads and writes session storage when available', () => {
        const values = new Map<string, string>();
        vi.stubGlobal('window', {
            sessionStorage: {
                getItem: (key: string) => values.get(key) ?? null,
                setItem: (key: string, value: string) => values.set(key, value),
            },
        });

        safeSetSessionStorageItem('key', 'value');

        expect(safeGetSessionStorageItem('key')).toBe('value');
    });
});
