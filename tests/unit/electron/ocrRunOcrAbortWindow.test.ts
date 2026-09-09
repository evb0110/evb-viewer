import { EventEmitter } from 'events';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runOcr } from '@electron/features/ocr/main/runOcr';

const mocks = vi.hoisted(() => ({
    execFile: vi.fn(),
    spawn: vi.fn(),
    ensureTessdataLanguages: vi.fn(async () => {}),
    getOcrPaths: vi.fn(),
}));

vi.mock('child_process', () => ({
    execFile: mocks.execFile,
    spawn: mocks.spawn,
}));

vi.mock('@electron/features/ocr/languageModels', () => ({ ensureTessdataLanguages: mocks.ensureTessdataLanguages }));

vi.mock('@electron/features/ocr/main/paths', () => ({ getOcrPaths: mocks.getOcrPaths }));

vi.mock('@electron/features/ocr/main/resolveTesseractLanguageConfig', () => ({ resolveTesseractLanguageConfig: (languages: string[]) => ({
    orderedLanguages: languages,
    extraConfigArgs: [],
}) }));

vi.mock('@electron/features/ocr/main/buildTesseractEnv', () => ({ buildTesseractEnv: () => ({}) }));

function createMockTesseractProcess() {
    const stdin = new EventEmitter() as EventEmitter & {end: (buffer: Buffer, callback: (error?: Error | null) => void) => void};
    stdin.end = vi.fn((_buffer, callback) => {
        callback(null);
    });
    const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: typeof stdin;
        kill: (signal: string) => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = stdin;
    child.kill = vi.fn(() => true);
    return child;
}

describe('runOcr abort window', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // Resolving the tool paths is the last await before the spawn, and the
    // abort listener attached afterwards never replays a signal that aborted
    // during it. Without a re-check the caller waits out the two-minute
    // Tesseract timeout for work nobody is going to read.
    it('kills a Tesseract run that was aborted while its tool paths resolved', async () => {
        const child = createMockTesseractProcess();
        mocks.spawn.mockReturnValue(child);
        const controller = new AbortController();
        const resolving = Promise.withResolvers<undefined>();
        const paused = Promise.withResolvers<undefined>();
        mocks.getOcrPaths.mockImplementation(async () => {
            resolving.resolve(undefined);
            await paused.promise;
            return {
                binary: '/bin/tesseract',
                tessdata: '/share/tessdata',
            };
        });

        const result = runOcr(Buffer.from('page'), ['eng'], {signal: controller.signal});
        await resolving.promise;
        controller.abort();
        paused.resolve(undefined);

        await expect(result).resolves.toEqual({
            success: false,
            text: '',
            error: 'Tesseract aborted',
        });
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
});
