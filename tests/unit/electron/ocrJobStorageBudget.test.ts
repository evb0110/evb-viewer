import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    createOcrJobStorageBudget,
    OcrStorageBudgetError,
} from '@electron/features/ocr/worker/ocrJobStorageBudget';
import {persistOcrPageCheckpoint} from '@electron/features/ocr/worker/persistOcrPageCheckpoint';

function createBudget(options: {
    inspect: () => Promise<{
        availableBytes: number;
        usedBytes: number
    }>;
    maxBytes?: number;
    minFreeBytes?: number;
    pollIntervalMs?: number;
    checkpointDir?: string;
    tempDir?: string;
}) {
    const abortController = new AbortController();
    const cleanupCheckpoint = vi.fn(async () => undefined);
    const budget = createOcrJobStorageBudget({
        abortController,
        checkpointDir: options.checkpointDir ?? '/tmp/checkpoints',
        maxBytes: options.maxBytes ?? 100,
        minFreeBytes: options.minFreeBytes ?? 10,
        pollIntervalMs: options.pollIntervalMs ?? 5,
        sessionId: 'ocr-test',
        tempDir: options.tempDir ?? '/tmp',
        cleanupCheckpoint,
        inspect: options.inspect,
    });
    return {
        abortController,
        budget,
        cleanupCheckpoint,
    };
}

describe('OCR aggregate job storage budget', () => {
    it('persists a validated checkpoint through reserved temporary storage', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-ocr-checkpoint-'));
        const sourcePdfPath = path.join(root, 'page.pdf');
        const checkpointPdfPath = path.join(root, 'checkpoint.pdf');
        const checkpointJsonPath = path.join(root, 'checkpoint.json');
        const {budget: storageBudget} = createBudget({inspect: async () => ({
            availableBytes: 1_000,
            usedBytes: 0,
        })});
        try {
            await writeFile(sourcePdfPath, 'pdf bytes', 'utf8');

            await persistOcrPageCheckpoint({
                checkpointData: {completedPages: 1},
                checkpointJsonPath,
                checkpointPdfPath,
                pageNumber: 1,
                sha256File: vi.fn(async () => 'sha256'),
                signal: new AbortController().signal,
                sourcePdfPath,
                storageBudget,
            });

            expect(await readFile(checkpointPdfPath, 'utf8')).toBe('pdf bytes');
            expect(JSON.parse(await readFile(checkpointJsonPath, 'utf8'))).toMatchObject({
                completedPages: 1,
                pdfSha256: 'sha256',
                version: 2,
            });
        } finally {
            await storageBudget.stop();
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('continuously aborts a job when native output grows beyond its aggregate ceiling', async () => {
        let usedBytes = 20;
        const {
            abortController,
            budget,
            cleanupCheckpoint,
        } = createBudget({inspect: async () => ({
            availableBytes: 1_000,
            usedBytes,
        })});

        await budget.assertWithinBudget();
        usedBytes = 101;
        await expect.poll(() => abortController.signal.aborted, {timeout: 1_000}).toBe(true);
        expect(abortController.signal.reason).toMatchObject({code: 'OCR_STORAGE_QUOTA_EXCEEDED'});
        await budget.stop();
        expect(cleanupCheckpoint).toHaveBeenCalledOnce();
    });

    it('turns ENOSPC from a filesystem probe into a shared job abort', async () => {
        const noSpace = Object.assign(new Error('simulated full filesystem'), {code: 'ENOSPC'});
        const {
            abortController,
            budget,
        } = createBudget({inspect: async () => {
            throw noSpace;
        }});

        await expect(budget.assertWithinBudget()).rejects.toBeInstanceOf(OcrStorageBudgetError);
        expect(abortController.signal.aborted).toBe(true);
        expect(abortController.signal.reason).toMatchObject({code: 'OCR_STORAGE_RESERVE_EXHAUSTED'});
        await budget.stop();
    });

    it('serializes concurrent copy reservations so checkpoint doubling cannot bypass the ceiling', async () => {
        const {
            abortController,
            budget,
        } = createBudget({inspect: async () => ({
            availableBytes: 1_000,
            usedBytes: 40,
        })});

        const firstRelease = await budget.reserve(40);
        await expect(budget.reserve(30)).rejects.toMatchObject({code: 'OCR_STORAGE_QUOTA_EXCEEDED'});
        expect(abortController.signal.aborted).toBe(true);
        firstRelease.release();
        await budget.stop();
    });

    it('includes outstanding reservations in plain budget assertions', async () => {
        let usedBytes = 70;
        const {
            abortController,
            budget,
        } = createBudget({inspect: async () => ({
            availableBytes: 1_000,
            usedBytes,
        })});

        const release = await budget.reserve(20);
        usedBytes = 81;
        await expect(budget.assertWithinBudget()).rejects.toMatchObject({code: 'OCR_STORAGE_QUOTA_EXCEEDED'});
        expect(abortController.signal.aborted).toBe(true);
        release.release();
        await budget.stop();
    });

    it('preserves the configured free-space reserve before allocating a duplicate', async () => {
        const {
            abortController,
            budget,
        } = createBudget({
            inspect: async () => ({
                availableBytes: 55,
                usedBytes: 10,
            }),
            minFreeBytes: 20,
        });

        await expect(budget.reserve(36)).rejects.toMatchObject({code: 'OCR_STORAGE_RESERVE_EXHAUSTED'});
        expect(abortController.signal.aborted).toBe(true);
        await budget.stop();
    });

    it('transfers the exact PDF and JSON checkpoint bytes into committed accounting', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-ocr-committed-bytes-'));
        const checkpointDir = path.join(root, 'checkpoints');
        const sourcePdfPath = path.join(root, 'page.pdf');
        const checkpointPdfPath = path.join(checkpointDir, 'page-1.pdf');
        const checkpointJsonPath = path.join(checkpointDir, 'page-1.json');
        const {
            abortController,
            budget,
        } = createBudget({
            inspect: async () => ({
                availableBytes: 1_000,
                usedBytes: 0,
            }),
            checkpointDir,
            maxBytes: 1_000,
            tempDir: root,
        });
        try {
            await mkdir(checkpointDir, {recursive: true});
            await writeFile(sourcePdfPath, 'pdf bytes', 'utf8');
            await persistOcrPageCheckpoint({
                checkpointData: {completedPages: 1},
                checkpointJsonPath,
                checkpointPdfPath,
                pageNumber: 1,
                sha256File: vi.fn(async () => 'sha256'),
                signal: new AbortController().signal,
                sourcePdfPath,
                storageBudget: budget,
            });

            const committedBytes = (await stat(checkpointPdfPath)).size + (await stat(checkpointJsonPath)).size;
            const reconciliationBudget = createOcrJobStorageBudget({
                abortController: new AbortController(),
                checkpointDir,
                maxBytes: committedBytes,
                minFreeBytes: 10,
                sessionId: 'ocr-test',
                tempDir: root,
                inspect: async () => ({
                    availableBytes: 1_000,
                    usedBytes: 0,
                }),
            });
            await expect(reconciliationBudget.reconcileCheckpoints()).resolves.toBeUndefined();
            await reconciliationBudget.stop();
            expect(abortController.signal.aborted).toBe(false);
        } finally {
            await budget.stop();
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('reconciles external checkpoint growth and deletion on an explicit sweep', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-ocr-reconcile-'));
        const checkpointDir = path.join(root, 'checkpoints');
        const abortController = new AbortController();
        const budget = createOcrJobStorageBudget({
            abortController,
            checkpointDir,
            maxBytes: 100,
            minFreeBytes: 10,
            sessionId: 'ocr-test',
            tempDir: root,
            inspect: async () => ({
                availableBytes: 1_000,
                usedBytes: 0,
            }),
        });
        try {
            await mkdir(checkpointDir, {recursive: true});
            const checkpointPath = path.join(checkpointDir, 'page-1.pdf');
            const removedPath = path.join(checkpointDir, 'page-2.pdf');
            await writeFile(checkpointPath, '1234567890', 'utf8');
            await writeFile(removedPath, '1234567890', 'utf8');
            await budget.reconcileCheckpoints();
            await writeFile(checkpointPath, '123456789012345678901234567890', 'utf8');
            await rm(removedPath);
            await expect(budget.reconcileCheckpoints()).resolves.toBeUndefined();
            await expect(budget.assertWithinBudget()).resolves.toMatchObject({usedBytes: 0});
            expect(abortController.signal.aborted).toBe(false);
        } finally {
            await budget.stop();
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
