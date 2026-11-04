import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    readLocalStorageItem,
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
    setLocalStorageItemOrThrow,
} from '@app/utils/localStorage';

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

    it('returns null when the localStorage property getter throws', () => {
        testGlobal.window = Object.defineProperty({}, 'localStorage', {get: () => { throw new Error('blocked'); }});

        expect(safeGetLocalStorageItem('key')).toBeNull();
    });

    it('returns stored value when available', () => {
        testGlobal.window = {localStorage: {getItem: (key: string) => (key === 'key' ? 'value' : null)}};

        expect(safeGetLocalStorageItem('key')).toBe('value');
    });
});

describe('readLocalStorageItem', () => {
    it('distinguishes an absent key from an unavailable storage backend', () => {
        testGlobal.window = {localStorage: {getItem: () => null}};
        expect(readLocalStorageItem('missing')).toEqual({status: 'absent'});

        testGlobal.window = {localStorage: {getItem: () => {
            throw new Error('blocked');
        }}};
        expect(readLocalStorageItem('missing')).toMatchObject({status: 'unavailable'});
    });

    it('returns the stored value without normalizing it', () => {
        testGlobal.window = {localStorage: {getItem: () => '  value  '}};
        expect(readLocalStorageItem('key')).toEqual({
            status: 'present',
            value: '  value  ',
        });
    });

    it('reports unavailable storage when the localStorage property getter throws', () => {
        testGlobal.window = Object.defineProperty({}, 'localStorage', {get: () => { throw new Error('blocked'); }});

        expect(readLocalStorageItem('key')).toMatchObject({status: 'unavailable'});
    });
});

describe('safeSetLocalStorageItem', () => {
    it('does not throw when localStorage is unavailable', () => {
        testGlobal.window = {};
        expect(safeSetLocalStorageItem('k', 'v')).toBe(false);
    });

    it('returns false when the localStorage property getter throws', () => {
        testGlobal.window = Object.defineProperty({}, 'localStorage', {get: () => { throw new Error('blocked'); }});

        expect(safeSetLocalStorageItem('k', 'v')).toBe(false);
    });

    it('writes value when setItem is available', () => {
        const setItem = vi.fn();
        testGlobal.window = {localStorage: { setItem }};

        expect(safeSetLocalStorageItem('k', 'v')).toBe(true);
        expect(setItem).toHaveBeenCalledWith('k', 'v');
    });

    it('reports a failed write without throwing', () => {
        const setItem = vi.fn(() => {
            throw new Error('quota exceeded');
        });
        testGlobal.window = {localStorage: { setItem }};

        expect(safeSetLocalStorageItem('k', 'v')).toBe(false);
    });
});

describe('required storage writes', () => {
    it.each([
        'QuotaExceededError',
        'SecurityError',
        'NotAllowedError',
    ])('preserves the original %s from setItem and the storage getter', (name) => {
        const error = new DOMException('RAW storage detail', name);
        for (const storage of [
            {localStorage: {setItem: () => { throw error; }}},
            Object.defineProperty({}, 'localStorage', {get: () => { throw error; }}),
        ]) {
            testGlobal.window = storage;
            expect(() => setLocalStorageItemOrThrow('key', 'value')).toThrow(error);
            try { setLocalStorageItemOrThrow('key', 'value'); } catch (caught) { expect(caught).toBe(error); }
            expect(safeSetLocalStorageItem('key', 'value')).toBe(false);
        }
    });
});
