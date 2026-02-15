import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/local-storage';

interface ITestGlobal {window?: unknown;}

const testGlobal = globalThis as ITestGlobal;
const originalWindow = testGlobal.window;

afterEach(() => {
    testGlobal.window = originalWindow;
    vi.restoreAllMocks();
});

describe('safeGetLocalStorageItem', () => {
    it('returns null when localStorage is unavailable', () => {
        testGlobal.window = {};
        expect(safeGetLocalStorageItem('key')).toBeNull();
    });

    it('returns null when localStorage.getItem throws', () => {
        testGlobal.window = {localStorage: {getItem: () => {
            throw new Error('blocked');
        }}};

        expect(safeGetLocalStorageItem('key')).toBeNull();
    });

    it('returns stored value when available', () => {
        testGlobal.window = {localStorage: {getItem: (key: string) => (key === 'key' ? 'value' : null)}};

        expect(safeGetLocalStorageItem('key')).toBe('value');
    });
});

describe('safeSetLocalStorageItem', () => {
    it('does not throw when localStorage is unavailable', () => {
        testGlobal.window = {};
        expect(() => safeSetLocalStorageItem('k', 'v')).not.toThrow();
    });

    it('writes value when setItem is available', () => {
        const setItem = vi.fn();
        testGlobal.window = {localStorage: { setItem }};

        safeSetLocalStorageItem('k', 'v');
        expect(setItem).toHaveBeenCalledWith('k', 'v');
    });
});
