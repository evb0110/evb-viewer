import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    appendFile,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const mocks = vi.hoisted(() => ({detectDjvuHasText: vi.fn()}));

vi.mock('@electron/features/djvu/main/textSearch', () => ({detectDjvuHasText: mocks.detectDjvuHasText}));

const temporaryDirectories: string[] = [];

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

async function createSource(name: string, contents = 'djvu') {
    const directory = await mkdtemp(join(tmpdir(), 'evb-djvu-text-capability-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, name);
    await writeFile(filePath, contents);
    return filePath;
}

async function loadCacheModule() {
    vi.resetModules();
    return import('@electron/features/djvu/main/getCachedDjvuHasText');
}

describe('DjVu text capability cache', () => {
    beforeEach(() => {
        mocks.detectDjvuHasText.mockReset();
    });

    afterAll(async () => {
        await Promise.all(temporaryDirectories.map(directory => rm(directory, {
            force: true,
            recursive: true,
        })));
    });

    it('caches both capability outcomes and invalidates them when the source changes', async () => {
        const filePath = await createSource('mutable.djvu');
        mocks.detectDjvuHasText
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const {getCachedDjvuHasText} = await loadCacheModule();

        await expect(getCachedDjvuHasText(filePath)).resolves.toBe(false);
        await expect(getCachedDjvuHasText(filePath)).resolves.toBe(false);
        expect(mocks.detectDjvuHasText).toHaveBeenCalledTimes(1);

        await appendFile(filePath, '-with-text');

        await expect(getCachedDjvuHasText(filePath)).resolves.toBe(true);
        expect(mocks.detectDjvuHasText).toHaveBeenCalledTimes(2);
    });

    it('uses bounded least-recently-used retention', async () => {
        const sources = await Promise.all(Array.from({length: 65}, (_unused, index) => (
            createSource(`${String(index)}.djvu`)
        )));
        mocks.detectDjvuHasText.mockResolvedValue(true);
        const {getCachedDjvuHasText} = await loadCacheModule();

        await getCachedDjvuHasText(sources[0]!);
        await getCachedDjvuHasText(sources[1]!);
        await getCachedDjvuHasText(sources[0]!);
        for (const source of sources.slice(2)) {
            await getCachedDjvuHasText(source);
        }
        await getCachedDjvuHasText(sources[1]!);

        expect(mocks.detectDjvuHasText).toHaveBeenCalledTimes(66);
    });

    it('deduplicates concurrent scans for the same source fingerprint', async () => {
        const filePath = await createSource('shared.djvu');
        const scan = createDeferred<boolean>();
        mocks.detectDjvuHasText.mockReturnValue(scan.promise);
        const {getCachedDjvuHasText} = await loadCacheModule();

        const first = getCachedDjvuHasText(filePath);
        const second = getCachedDjvuHasText(filePath);
        await vi.waitFor(() => expect(mocks.detectDjvuHasText).toHaveBeenCalledTimes(1));
        scan.resolve(true);

        await expect(Promise.all([
            first,
            second,
        ])).resolves.toEqual([
            true,
            true,
        ]);
    });

    it('cancels only the departing consumer while another consumer still needs the scan', async () => {
        const filePath = await createSource('shared-cancel.djvu');
        const scan = createDeferred<boolean>();
        let sharedSignal: AbortSignal | undefined;
        mocks.detectDjvuHasText.mockImplementation((_path: string, signal: AbortSignal) => {
            sharedSignal = signal;
            return scan.promise;
        });
        const {getCachedDjvuHasText} = await loadCacheModule();
        const firstController = new AbortController();
        const secondController = new AbortController();

        const first = getCachedDjvuHasText(filePath, firstController.signal);
        const second = getCachedDjvuHasText(filePath, secondController.signal);
        await vi.waitFor(() => expect(mocks.detectDjvuHasText).toHaveBeenCalledTimes(1));
        firstController.abort();

        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        expect(sharedSignal?.aborted).toBe(false);
        scan.resolve(true);
        await expect(second).resolves.toBe(true);
    });

    it('aborts the streaming scan when every consumer leaves', async () => {
        const filePath = await createSource('abandoned.djvu');
        let sharedSignal: AbortSignal | undefined;
        mocks.detectDjvuHasText.mockImplementation((_path: string, signal: AbortSignal) => (
            new Promise((_resolve, reject) => {
                sharedSignal = signal;
                signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            })
        ));
        const {getCachedDjvuHasText} = await loadCacheModule();
        const firstController = new AbortController();
        const secondController = new AbortController();

        const first = getCachedDjvuHasText(filePath, firstController.signal);
        const second = getCachedDjvuHasText(filePath, secondController.signal);
        await vi.waitFor(() => expect(mocks.detectDjvuHasText).toHaveBeenCalledTimes(1));
        firstController.abort();
        secondController.abort();

        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        await expect(second).rejects.toMatchObject({name: 'AbortError'});
        expect(sharedSignal?.aborted).toBe(true);
    });

    it('does not cache a scan result if the source mutates while it is running', async () => {
        const filePath = await createSource('mid-scan-mutation.djvu');
        const firstScan = createDeferred<boolean>();
        mocks.detectDjvuHasText
            .mockReturnValueOnce(firstScan.promise)
            .mockResolvedValueOnce(false);
        const {getCachedDjvuHasText} = await loadCacheModule();

        const pending = getCachedDjvuHasText(filePath);
        await vi.waitFor(() => expect(mocks.detectDjvuHasText).toHaveBeenCalledTimes(1));
        await appendFile(filePath, '-replaced');
        firstScan.resolve(true);
        await expect(pending).resolves.toBe(true);

        await expect(getCachedDjvuHasText(filePath)).resolves.toBe(false);
        expect(mocks.detectDjvuHasText).toHaveBeenCalledTimes(2);
    });
});
