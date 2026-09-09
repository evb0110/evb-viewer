import {
    chmod,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const temporaryDirectories: string[] = [];

async function createWrongProtocolService() {
    const directory = await mkdtemp(join(tmpdir(), 'evb-search-service-'));
    temporaryDirectories.push(directory);
    const markerPath = join(directory, 'starts.txt');
    const executablePath = join(directory, 'evb-pdf-search');
    await writeFile(executablePath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(markerPath)}, 'started\\n');
process.stderr.write('x'.repeat(70 * 1024) + ' diagnostic-tail\\n');
setTimeout(() => process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 99}) + '\\n'), 20);
process.stdin.resume();
`, 'utf8');
    await chmod(executablePath, 0o755);
    return {
        executablePath,
        markerPath,
    };
}

async function createSearchService(source: string) {
    const directory = await mkdtemp(join(tmpdir(), 'evb-search-service-'));
    temporaryDirectories.push(directory);
    const executablePath = join(directory, 'evb-pdf-search');
    await writeFile(executablePath, `#!/usr/bin/env node\n${source}\n`, 'utf8');
    await chmod(executablePath, 0o755);
    return executablePath;
}

const request = {
    contextChars: 4,
    documentRevision: 'revision-1',
    indexPath: '/tmp/unused-search-index',
    limit: 10,
    matchCase: false,
    pageCount: 1,
    query: 'needle',
};

describe('persistent native search service', () => {
    afterEach(async () => {
        const {shutdownPersistentNativeSearchServices} = await import('@electron/features/search/tryRunPersistentNativeSearch');
        await shutdownPersistentNativeSearchServices('test cleanup').catch(() => undefined);
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
            force: true,
            recursive: true,
        })));
    });

    it('rejects a mismatched daemon protocol immediately, retains bounded stderr, and evicts the daemon', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const {
            executablePath,
            markerPath,
        } = await createWrongProtocolService();
        const {tryRunPersistentNativeSearch} = await import('@electron/features/search/tryRunPersistentNativeSearch');
        const startedAt = Date.now();
        await expect(tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000}))
            .rejects.toThrow(/protocol mismatch: expected 1, got 99; \[native stderr truncated to 65536 bytes\] native stderr: .*diagnostic-tail/u);
        expect(Date.now() - startedAt).toBeLessThan(4_500);

        await expect(tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000}))
            .rejects.toThrow('protocol mismatch: expected 1, got 99');
        expect((await readFile(markerPath, 'utf8')).trim().split('\n')).toHaveLength(2);
    });

    it('awaits and reports spontaneous daemon cleanup already in flight', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const {executablePath} = await createWrongProtocolService();
        const {
            persistentNativeSearchRuntime,
            shutdownPersistentNativeSearchServices,
            tryRunPersistentNativeSearch,
        } = await import('@electron/features/search/tryRunPersistentNativeSearch');
        const terminate = persistentNativeSearchRuntime.terminateDetachedChildProcess;
        let markTerminationStarted!: () => void;
        const terminationStarted = new Promise<void>(resolve => {
            markTerminationStarted = resolve;
        });
        let releaseTermination!: () => void;
        const terminationGate = new Promise<void>(resolve => {
            releaseTermination = resolve;
        });
        vi.spyOn(persistentNativeSearchRuntime, 'terminateDetachedChildProcess').mockImplementation(async (...args) => {
            markTerminationStarted();
            await terminationGate;
            await terminate(...args);
            return false;
        });
        await expect(tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000}))
            .rejects.toThrow('protocol mismatch');
        await terminationStarted;
        const shutdownPromise = shutdownPersistentNativeSearchServices('app shutdown');
        const settled = vi.fn();
        void shutdownPromise.then(settled, settled);
        await Promise.resolve();

        expect(settled).not.toHaveBeenCalled();
        releaseTermination();

        await expect(shutdownPromise).rejects.toThrow('Persistent native search shutdown failed');
    });

    it('retains a spontaneous daemon cleanup failure until coordinated shutdown observes it', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const {executablePath} = await createWrongProtocolService();
        const {
            persistentNativeSearchRuntime,
            shutdownPersistentNativeSearchServices,
            tryRunPersistentNativeSearch,
        } = await import('@electron/features/search/tryRunPersistentNativeSearch');
        const terminate = persistentNativeSearchRuntime.terminateDetachedChildProcess;
        let cleanupFinished!: () => void;
        const cleanupCompletion = new Promise<void>(resolve => {
            cleanupFinished = resolve;
        });
        vi.spyOn(persistentNativeSearchRuntime, 'terminateDetachedChildProcess').mockImplementation(async (...args) => {
            await terminate(...args);
            cleanupFinished();
            return false;
        });
        await expect(tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000}))
            .rejects.toThrow('protocol mismatch');
        await cleanupCompletion;

        await expect(shutdownPersistentNativeSearchServices('app shutdown'))
            .rejects.toThrow('Persistent native search shutdown failed');
    });

    it('honors cancellation while daemon startup is still pending', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const executablePath = await createSearchService(`
setTimeout(() => process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n'), 250);
setTimeout(() => process.exit(0), 500);
process.stdin.resume();
`);
        const {tryRunPersistentNativeSearch} = await import('@electron/features/search/tryRunPersistentNativeSearch');
        const controller = new AbortController();
        const result = tryRunPersistentNativeSearch(executablePath, request, {
            signal: controller.signal,
            timeoutMs: 1_000,
        });
        controller.abort();

        await expect(result).rejects.toThrow('Native search canceled');
    });

    it('settles a timed-out request even when the daemon has closed stdin', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const executablePath = await createSearchService(`
process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n');
process.stdin.destroy();
setTimeout(() => process.exit(0), 500);
`);
        const {tryRunPersistentNativeSearch} = await import('@electron/features/search/tryRunPersistentNativeSearch');

        await expect(tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 30}))
            .rejects.toThrow(/request timeout|unavailable|EPIPE/u);
    });

    it('does not apply the service idle timeout while a request is pending', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const executablePath = await createSearchService(`
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'shutdown') process.exit(0);
    if (frame.type !== 'search') return;
    setTimeout(() => process.stdout.write(JSON.stringify({
        type: 'result',
        requestId: frame.requestId,
        result: {results: []}
    }) + '\\n'), 100);
});
`);
        const {tryRunPersistentNativeSearch} = await import('@electron/features/search/tryRunPersistentNativeSearch');

        await expect(tryRunPersistentNativeSearch(executablePath, request, {
            idleTimeoutMs: 30,
            timeoutMs: 500,
        }))
            .resolves.toEqual({results: []});
    });

    it('forwards worker cache resets to every live native daemon', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-service-reset-'));
        temporaryDirectories.push(directory);
        const markerPath = join(directory, 'reset.txt');
        const executablePath = await createSearchService(`
const fs = require('node:fs');
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'shutdown') process.exit(0);
    if (frame.type === 'reset-cache') {
        fs.appendFileSync(${JSON.stringify(markerPath)}, 'reset\\n');
        return;
    }
    if (frame.type === 'search') process.stdout.write(JSON.stringify({
        type: 'result',
        requestId: frame.requestId,
        result: {results: []}
    }) + '\\n');
});
`);
        const {
            resetPersistentNativeSearchServiceCaches,
            tryRunPersistentNativeSearch,
        } = await import('@electron/features/search/tryRunPersistentNativeSearch');
        await tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000});

        resetPersistentNativeSearchServiceCaches();

        await vi.waitFor(async () => {
            await expect(readFile(markerPath, 'utf8')).resolves.toBe('reset\n');
        });
    });

    it('shuts down an idle daemon cooperatively and waits for its exit', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-service-shutdown-'));
        temporaryDirectories.push(directory);
        const markerPath = join(directory, 'shutdown.txt');
        const executablePath = await createSearchService(`
const fs = require('node:fs');
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'search') {
        process.stdout.write(JSON.stringify({
            type: 'result',
            requestId: frame.requestId,
            result: {results: []}
        }) + '\\n');
    }
    if (frame.type === 'shutdown') {
        fs.writeFileSync(${JSON.stringify(markerPath)}, frame.type);
        process.exit(0);
    }
});
`);
        const {
            shutdownPersistentNativeSearchServices,
            tryRunPersistentNativeSearch,
        } = await import('@electron/features/search/tryRunPersistentNativeSearch');
        await tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000});

        await shutdownPersistentNativeSearchServices('app shutdown');

        await expect(readFile(markerPath, 'utf8')).resolves.toBe('shutdown');
    });

    it('settles active searches before persistent daemon shutdown returns', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const executablePath = await createSearchService(`
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'shutdown') process.exit(0);
});
`);
        const {
            shutdownPersistentNativeSearchServices,
            tryRunPersistentNativeSearch,
        } = await import('@electron/features/search/tryRunPersistentNativeSearch');
        const activeSearch = tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 10_000});
        const activeSettlement = vi.fn();
        void activeSearch.then(activeSettlement, activeSettlement);

        await shutdownPersistentNativeSearchServices('app shutdown');

        await expect(activeSearch).rejects.toThrow('app shutdown');
        expect(activeSettlement).toHaveBeenCalledOnce();
    });

    it('falls back to process-tree termination when a daemon ignores shutdown', async () => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-service-stubborn-'));
        temporaryDirectories.push(directory);
        const markerPath = join(directory, 'shutdown.txt');
        const executablePath = await createSearchService(`
const fs = require('node:fs');
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'search') {
        process.stdout.write(JSON.stringify({
            type: 'result',
            requestId: frame.requestId,
            result: {results: []}
        }) + '\\n');
    }
    if (frame.type === 'shutdown') {
        fs.writeFileSync(${JSON.stringify(markerPath)}, 'ignored');
    }
});
`);
        const {
            persistentNativeSearchRuntime,
            shutdownPersistentNativeSearchServices,
            tryRunPersistentNativeSearch,
        } = await import('@electron/features/search/tryRunPersistentNativeSearch');
        const terminate = persistentNativeSearchRuntime.terminateDetachedChildProcess;
        const terminateSpy = vi.spyOn(persistentNativeSearchRuntime, 'terminateDetachedChildProcess')
            .mockImplementation((...args) => terminate(...args));
        await tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000});

        await shutdownPersistentNativeSearchServices('app shutdown');

        expect(terminateSpy).toHaveBeenCalledOnce();
        await expect(readFile(markerPath, 'utf8')).resolves.toBe('ignored');
    });

    it.each([
        'false result',
        'rejection',
    ])('reports a process-tree termination %s', async (failureMode) => {
        vi.stubEnv('EVB_PDF_SEARCH_SERVICE_ENABLE', '1');
        const executablePath = await createSearchService(`
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type: 'ready', protocolVersion: 1}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'search') {
        process.stdout.write(JSON.stringify({
            type: 'result',
            requestId: frame.requestId,
            result: {results: []}
        }) + '\\n');
    }
});
`);
        const {
            persistentNativeSearchRuntime,
            shutdownPersistentNativeSearchServices,
            tryRunPersistentNativeSearch,
        } = await import('@electron/features/search/tryRunPersistentNativeSearch');
        const terminate = persistentNativeSearchRuntime.terminateDetachedChildProcess;
        vi.spyOn(persistentNativeSearchRuntime, 'terminateDetachedChildProcess').mockImplementation(async (...args) => {
            await terminate(...args);
            if (failureMode === 'rejection') {
                throw new Error('process-tree helper failed');
            }
            return false;
        });
        await tryRunPersistentNativeSearch(executablePath, request, {timeoutMs: 1_000});

        await expect(shutdownPersistentNativeSearchServices('app shutdown'))
            .rejects.toThrow('Persistent native search shutdown failed');
    });
});
