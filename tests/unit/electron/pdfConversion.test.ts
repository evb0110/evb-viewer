import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const workerState: { mode: 'error' | 'success' } = { mode: 'error' };
    const workerCtor = vi.fn();
    const loggerWarn = vi.fn();
    const readFile = vi.fn(async () => new Uint8Array([
        1,
        2,
        3,
    ]));

    const addPage = vi.fn();
    const copyPages = vi.fn(async () => [{}]);
    const save = vi.fn(async () => new Uint8Array([
        9,
        9,
        9,
    ]));
    const create = vi.fn(async () => ({
        addPage,
        copyPages,
        save,
        embedPng: vi.fn(),
        embedJpg: vi.fn(),
    }));
    const load = vi.fn(async () => ({ getPageIndices: () => [0] }));

    return {
        workerState,
        workerCtor,
        loggerWarn,
        readFile,
        create,
        load,
    };
});

vi.mock('worker_threads', () => ({Worker: class {
    constructor(script: string, options: unknown) {
        mocks.workerCtor(script, options);
    }

    once(event: string, callback: (arg: unknown) => void) {
        if (mocks.workerState.mode === 'success' && event === 'message') {
            setTimeout(() => {
                callback({
                    ok: true,
                    data: new Uint8Array([
                        7,
                        7,
                    ]),
                });
            }, 0);
        }
        if (mocks.workerState.mode === 'error' && event === 'error') {
            setTimeout(() => {
                callback(new Error('Cannot find package pdf-lib from [eval1]'));
            }, 0);
        }
        return this;
    }
}}));

vi.mock('fs/promises', () => ({ readFile: mocks.readFile }));

vi.mock('pdf-lib', () => ({PDFDocument: {
    create: mocks.create,
    load: mocks.load,
}}));

vi.mock('electron', () => ({nativeImage: {createFromPath: vi.fn(() => ({
    isEmpty: () => true,
    toPNG: () => new Uint8Array(),
}))}}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
})}));

const { createPdfFromInputPaths } =
    await import('@electron/image/pdf-conversion');

describe('createPdfFromInputPaths worker fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerState.mode = 'error';
    });

    it('falls back to in-process conversion when worker combine fails', async () => {
        const result = await createPdfFromInputPaths(['/tmp/input.pdf']);

        expect(Array.from(result)).toEqual([
            9,
            9,
            9,
        ]);
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.create).toHaveBeenCalledTimes(1);
        expect(mocks.load).toHaveBeenCalledTimes(1);
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('returns worker result when worker combine succeeds', async () => {
        mocks.workerState.mode = 'success';

        const result = await createPdfFromInputPaths(['/tmp/input.pdf']);

        expect(Array.from(result)).toEqual([
            7,
            7,
        ]);
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.create).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });
});
