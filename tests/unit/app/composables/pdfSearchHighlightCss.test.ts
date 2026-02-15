import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

vi.mock('@app/constants/storage-keys', () => ({STORAGE_KEYS: {
    HIGHLIGHT_MODE: 'pdfHighlightMode',
    HIGHLIGHT_DEBUG: 'pdfHighlightDebug',
    HIGHLIGHT_DEBUG_VERBOSE: 'pdfHighlightDebugVerbose',
}}));

const {
    createCssHighlightState,
    registerHighlightRange,
    getHighlightMode,
    isHighlightDebugEnabled,
    isHighlightDebugVerboseEnabled,
} = await import('@app/composables/pdfSearchHighlightCss');

beforeEach(() => {
    vi.unstubAllGlobals();
});

function stubHighlightApi() {
    vi.stubGlobal('CSS', {highlights: new Map()});
    vi.stubGlobal('Highlight', vi.fn(() => ({enabled: true})));
}

describe('createCssHighlightState', () => {
    it('creates an empty state with all maps initialized', () => {
        const state = createCssHighlightState();

        expect(state.highlightRanges).toBeInstanceOf(Map);
        expect(state.currentHighlightRanges).toBeInstanceOf(Map);
        expect(state.layerRangeIds).toBeInstanceOf(WeakMap);
        expect(state.layerCurrentRanges).toBeInstanceOf(WeakMap);
        expect(state.highlightRanges.size).toBe(0);
        expect(state.currentHighlightRanges.size).toBe(0);
    });
});

describe('registerHighlightRange', () => {
    it('registers a normal (non-current) range', () => {
        const state = createCssHighlightState();
        const container = {} as HTMLElement;
        const range = {} as Range;

        registerHighlightRange(state, container, range, false, 'range-1');

        expect(state.highlightRanges.get('range-1')).toBe(range);
        expect(state.currentHighlightRanges.has('range-1')).toBe(false);
    });

    it('registers a current highlight range', () => {
        const state = createCssHighlightState();
        const container = {} as HTMLElement;
        const range = {} as Range;

        registerHighlightRange(state, container, range, true, 'range-current');

        expect(state.currentHighlightRanges.get('range-current')).toBe(range);
        expect(state.highlightRanges.has('range-current')).toBe(false);
    });

    it('tracks range IDs per container', () => {
        const state = createCssHighlightState();
        const container = {} as HTMLElement;
        const range1 = {} as Range;
        const range2 = {} as Range;

        registerHighlightRange(state, container, range1, false, 'r1');
        registerHighlightRange(state, container, range2, true, 'r2');

        const ids = (state.layerRangeIds as WeakMap<object, {
            normal: Set<string>;
            current: Set<string> 
        }>).get(container);
        expect(ids).toBeDefined();
        expect(ids!.normal.has('r1')).toBe(true);
        expect(ids!.current.has('r2')).toBe(true);
    });

    it('reuses existing ID set for the same container', () => {
        const state = createCssHighlightState();
        const container = {} as HTMLElement;

        registerHighlightRange(state, container, {} as Range, false, 'a');
        registerHighlightRange(state, container, {} as Range, false, 'b');

        expect(state.highlightRanges.size).toBe(2);
    });
});

describe('getHighlightMode', () => {
    it('returns dom when window is undefined', () => {
        expect(getHighlightMode()).toBe('dom');
    });

    it('returns css when highlight API and storage flag are available', () => {
        stubHighlightApi();
        vi.stubGlobal('window', { localStorage: {getItem: vi.fn((key: string) => key === 'pdfHighlightMode' ? 'css' : null)} });

        expect(getHighlightMode()).toBe('css');
    });

    it('falls back to dom when reading highlight mode throws', () => {
        stubHighlightApi();
        vi.stubGlobal('window', { localStorage: {getItem: vi.fn(() => {
            throw new Error('storage blocked');
        })} });

        expect(getHighlightMode()).toBe('dom');
    });
});

describe('isHighlightDebugEnabled', () => {
    it('returns false when window is undefined', () => {
        expect(isHighlightDebugEnabled()).toBe(false);
    });

    it('returns true when debug flag is enabled in storage', () => {
        vi.stubGlobal('window', { localStorage: {getItem: vi.fn((key: string) => key === 'pdfHighlightDebug' ? '1' : null)} });

        expect(isHighlightDebugEnabled()).toBe(true);
    });

    it('returns false when debug storage read throws', () => {
        vi.stubGlobal('window', { localStorage: {getItem: vi.fn(() => {
            throw new Error('storage blocked');
        })} });

        expect(isHighlightDebugEnabled()).toBe(false);
    });
});

describe('isHighlightDebugVerboseEnabled', () => {
    it('returns false when window is undefined', () => {
        expect(isHighlightDebugVerboseEnabled()).toBe(false);
    });

    it('returns true when verbose debug flag is enabled in storage', () => {
        vi.stubGlobal('window', { localStorage: {getItem: vi.fn((key: string) => key === 'pdfHighlightDebugVerbose' ? '1' : null)} });

        expect(isHighlightDebugVerboseEnabled()).toBe(true);
    });

    it('returns false when verbose debug storage read throws', () => {
        vi.stubGlobal('window', { localStorage: {getItem: vi.fn(() => {
            throw new Error('storage blocked');
        })} });

        expect(isHighlightDebugVerboseEnabled()).toBe(false);
    });
});
