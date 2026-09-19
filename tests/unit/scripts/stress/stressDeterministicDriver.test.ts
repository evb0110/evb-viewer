import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type * as TViewerAnnotations from '@tests/e2e/electron/helpers/viewerAnnotations';
import type * as TViewerCore from '@tests/e2e/electron/helpers/viewerCore';
import type * as TWorkspaceExpose from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createSeededRandom,
    planRandomPages,
    runStressDeterministicSteps,
} from '@scripts/stress/stressDeterministicDriver';

const mocks = vi.hoisted(() => ({
    callWorkspaceCommand: vi.fn(),
    createFreeTextAnnotationWithPointer: vi.fn(),
    getWorkspaceToolbarSnapshot: vi.fn(),
    setupScrollToPage: vi.fn(),
}));
vi.mock('@tests/e2e/electron/helpers/workspaceExpose', async importOriginal => ({
    ...await importOriginal<typeof TWorkspaceExpose>(),
    callWorkspaceCommand: mocks.callWorkspaceCommand,
    getWorkspaceToolbarSnapshot: mocks.getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarIdle: vi.fn(async () => undefined),
}));
vi.mock('@tests/e2e/electron/helpers/viewerAnnotations', async importOriginal => ({
    ...await importOriginal<typeof TViewerAnnotations>(),
    createFreeTextAnnotationWithPointer: mocks.createFreeTextAnnotationWithPointer,
}));
vi.mock('@tests/e2e/electron/helpers/viewerCore', async importOriginal => ({
    ...await importOriginal<typeof TViewerCore>(),
    setupScrollToPage: mocks.setupScrollToPage,
}));

afterEach(() => {
    vi.clearAllMocks();
});

describe('stress deterministic driver randomness', () => {
    it('replays the same sequence for the same seed', () => {
        const first = createSeededRandom(42);
        const second = createSeededRandom(42);
        const values = Array.from({length: 5}, () => first());
        expect(values).toEqual(Array.from({length: 5}, () => second()));
        for (const value of values) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
        expect(createSeededRandom(43)()).not.toBe(createSeededRandom(42)());
    });

    it('plans page jumps inside the document', () => {
        const pages = planRandomPages(4000, 50, 7);
        expect(pages).toHaveLength(50);
        for (const page of pages) {
            expect(page).toBeGreaterThanOrEqual(1);
            expect(page).toBeLessThanOrEqual(4000);
        }
        expect(planRandomPages(4000, 50, 7)).toEqual(pages);
        expect(planRandomPages(0, 3, 1)).toEqual([
            1,
            1,
            1,
        ]);
    });
});

describe('stress deterministic deadline cancellation', () => {
    it('cancels an active idle wait without leaving its timer running', async () => {
        const controller = new AbortController();
        const detach = vi.fn(async () => undefined);
        const session = Object.assign(Object.create(null) as IElectronE2ESession, { page: { createCDPSession: async () => ({ detach }) } });
        const run = runStressDeterministicSteps([
            {
                kind: 'idle',
                ms: 60_000,
            },
            {
                kind: 'phase',
                name: 'later',
            },
        ], {
            session,
            fixtures: new Map(),
            stepTimeoutMs: 100,
            signal: controller.signal,
            log: () => undefined,
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        controller.abort();
        expect((await run).map(record => record.status)).toEqual([
            'failed',
            'skipped',
        ]);
        expect(detach).toHaveBeenCalledOnce();
    });

    it('skips later steps and stops a timed-out command loop before its next action', async () => {
        let finishCommand = (_result: { called: boolean }) => {};
        mocks.callWorkspaceCommand.mockImplementation(() => new Promise<{ called: boolean }>(resolve => { finishCommand = resolve; }));
        const detach = vi.fn(async () => undefined);
        const session = Object.assign(Object.create(null) as IElectronE2ESession, { page: { createCDPSession: async () => ({ detach }) } });
        const records = await runStressDeterministicSteps([
            {
                kind: 'command',
                name: 'handleZoomIn',
                repeat: 2,
            },
            {
                kind: 'phase',
                name: 'must-not-run',
            },
        ], {
            session,
            fixtures: new Map(),
            stepTimeoutMs: 10,
            log: () => undefined,
        });
        expect(records.map(record => record.status)).toEqual([
            'failed',
            'skipped',
        ]);
        expect(detach).toHaveBeenCalledOnce();
        finishCommand({ called: true });
        for (let turn = 0; turn < 5; turn += 1) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        expect(mocks.callWorkspaceCommand).toHaveBeenCalledOnce();
    });
});

describe('stress deterministic free-text page targeting', () => {
    it('scrolls each target page before creating its text box', async () => {
        const calls: string[] = [];
        const logs: string[] = [];
        mocks.getWorkspaceToolbarSnapshot.mockResolvedValue({totalPages: 3});
        mocks.setupScrollToPage.mockImplementation(async (_page, pageNumber) => {
            calls.push(`scroll:${pageNumber}`);
        });
        mocks.createFreeTextAnnotationWithPointer.mockImplementation(async (_page, _text, _position, pageNumber) => {
            calls.push(`create:${pageNumber}`);
        });
        const detach = vi.fn(async () => undefined);
        const session = Object.assign(Object.create(null) as IElectronE2ESession, {page: {createCDPSession: async () => ({detach})}});

        const records = await runStressDeterministicSteps([{
            kind: 'freeText',
            count: 3,
            text: 'stress',
        }], {
            session,
            fixtures: new Map(),
            stepTimeoutMs: 1_000,
            log: line => logs.push(line),
        });

        expect(records).toMatchObject([{
            status: 'succeeded',
            detail: {created: 3},
        }]);
        expect(calls).toEqual([
            'scroll:1',
            'create:1',
            'scroll:2',
            'create:2',
            'scroll:3',
            'create:3',
        ]);
        expect(logs).toEqual([
            'step 0 freeText',
            'freeText 1/3 page 1 scroll',
            'freeText 1/3 page 1 create',
            'freeText 1/3 page 1 created',
            'freeText 2/3 page 2 scroll',
            'freeText 2/3 page 2 create',
            'freeText 2/3 page 2 created',
            'freeText 3/3 page 3 scroll',
            'freeText 3/3 page 3 create',
            'freeText 3/3 page 3 created',
        ]);
        expect(detach).toHaveBeenCalledOnce();
    });
});
