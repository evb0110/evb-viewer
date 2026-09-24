import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createLandingFailureReporter,
    landingFailureReporter,
} from '@landing/server/utils/landingFailureReporter';

const createInput = () => ({
    code: 'UNCLASSIFIED_MAIN_ERROR' as const,
    context: {
        attempt: 1,
        phase: 'operation' as const,
        recovered: false,
    },
    local: {
        cause: {secret: 'local-cause-sentinel'},
        data: {secret: 'local-data-sentinel'},
        message: 'local-message-sentinel',
        source: 'landing-test',
    },
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('landing failure reporter', () => {
    it('returns a receipt while the default adapter makes no network request', () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);

        const receipt = landingFailureReporter.capture(createInput());

        expect(receipt).toMatchObject({
            code: 'UNCLASSIFIED_MAIN_ERROR',
            severity: 'error',
        });
        expect(receipt.eventId).toMatch(/^[0-9a-f]{32}$/u);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('passes only a closed landing-nitro record to an injected adapter', () => {
        const send = vi.fn();
        const reporter = createLandingFailureReporter({send});

        reporter.capture(createInput());

        expect(send).toHaveBeenCalledOnce();
        const record = send.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
        expect(record).toMatchObject({
            code: 'UNCLASSIFIED_MAIN_ERROR',
            context: {
                attempt: 1,
                phase: 'operation',
                recovered: false,
            },
            frames: [],
            runtime: 'landing-nitro',
            schemaVersion: 1,
        });
        expect(record).not.toHaveProperty('local');
        expect(JSON.stringify(record)).not.toContain('local-message-sentinel');
        expect(JSON.stringify(record)).not.toContain('local-cause-sentinel');
        expect(JSON.stringify(record)).not.toContain('local-data-sentinel');
    });

    it('does not let an adapter failure escape capture', () => {
        const reporter = createLandingFailureReporter({send: () => {
            throw new Error('adapter unavailable');
        }});

        expect(() => reporter.capture(createInput())).not.toThrow();
    });
});
