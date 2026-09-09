import type * as TViMockOriginalModule from '@electron/features/ocr/main/resolveTesseractLanguageConfig';
import type * as TViMockOriginalModule2 from '@electron/features/ocr/main/buildTesseractEnv';
import type * as TViMockOriginalModule3 from '@electron/utils/parseIntegerEnv';

import { EventEmitter } from 'events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runOcrFileBased } from '@electron/features/ocr/worker/tesseractRunner';

const mocks = vi.hoisted(() => ({
    execFile: vi.fn(),
    spawn: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    terminateDetachedChildProcess: vi.fn(),
}));

vi.mock('child_process', () => ({
    execFile: mocks.execFile,
    spawn: mocks.spawn,
}));

vi.mock('fs/promises', () => ({
    open: vi.fn(),
    readFile: mocks.readFile,
    stat: mocks.stat,
    unlink: mocks.unlink,
}));

vi.mock('@electron/features/ocr/main/resolveTesseractLanguageConfig', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    resolveTesseractLanguageConfig: (languages: string[]) => ({
        orderedLanguages: languages,
        extraConfigArgs: [],
    }),
}));

vi.mock('@electron/features/ocr/main/buildTesseractEnv', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    buildTesseractEnv: () => ({}),
}));

vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));

vi.mock('@electron/utils/parseIntegerEnv', async (importOriginal_2) => ({
    ...(await importOriginal_2<typeof TViMockOriginalModule3>()),
    parseIntegerEnv: (name: string, fallback: number) => (
        name === 'EVB_OCR_FILE_BASED_KILL_GRACE_MS'
            ? 5
            : fallback
    ),
}));

function createMockChildProcess() {
    const child = new EventEmitter() as EventEmitter & {
        stdout: { resume: () => void };
        stderr: EventEmitter;
        kill: () => void;
    };
    child.stdout = { resume: vi.fn() };
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
}

describe('runOcrFileBased abort handling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.unlink.mockResolvedValue(undefined);
        mocks.terminateDetachedChildProcess.mockReturnValue(new Promise(() => undefined));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('settles aborted file-based OCR even when the child never emits close', async () => {
        mocks.spawn.mockReturnValue(createMockChildProcess());
        const abortController = new AbortController();

        const resultPromise = runOcrFileBased(
            '/tmp/page.png',
            ['eng'],
            100,
            100,
            300,
            '/bin/tesseract',
            '/share/tessdata',
            1,
            abortController.signal,
        );

        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
        abortController.abort();
        await vi.advanceTimersByTimeAsync(1_006);

        await expect(resultPromise).resolves.toMatchObject({
            success: false,
            pageData: null,
            pdfPath: null,
            error: 'Tesseract aborted',
            terminationUnproven: expect.stringContaining('was not proven dead'),
        });
        expect(mocks.unlink).not.toHaveBeenCalledWith('/tmp/page-ocr.tsv');
        expect(mocks.unlink).not.toHaveBeenCalledWith('/tmp/page-ocr.pdf');
    });

    it('propagates a false native termination result instead of treating cancellation as clean', async () => {
        const child = createMockChildProcess();
        mocks.spawn.mockReturnValue(child);
        mocks.terminateDetachedChildProcess.mockResolvedValue(false);
        const abortController = new AbortController();

        const resultPromise = runOcrFileBased(
            '/tmp/false-termination.png',
            ['eng'],
            100,
            100,
            300,
            '/bin/tesseract',
            '/share/tessdata',
            1,
            abortController.signal,
        );

        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
        abortController.abort();
        await vi.advanceTimersByTimeAsync(1_006);

        await expect(resultPromise).resolves.toMatchObject({
            success: false,
            terminationUnproven: expect.stringContaining('false-termination.png'),
        });
    });
});
