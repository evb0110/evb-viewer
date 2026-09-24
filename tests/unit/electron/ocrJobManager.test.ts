import {
    mkdtemp,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {OCR_COMPLETE_EVENT_CHANNEL} from '@contracts/electronApiOcr';
import type {IOcrJob} from '@electron/features/ocr/pipeline/runOcrJob';
import type {TOcrJobResult} from '@electron/features/ocr/pipeline/types';

const mocks = vi.hoisted(() => ({
    runOcrJob: vi.fn(),
    prepareLanguageModelsForJob: vi.fn(),
    sendPlatformEvent: vi.fn(),
    getWorkingCopyRevision: vi.fn(),
}));

vi.mock('electron', () => ({BrowserWindow: {getAllWindows: () => [{webContents: {id: 7}}]}}));
vi.mock('@electron/utils/sendPlatformEvent', () => ({sendPlatformEvent: mocks.sendPlatformEvent}));
vi.mock('@electron/features/ocr/pipeline/runOcrJob', () => ({runOcrJob: mocks.runOcrJob}));
vi.mock('@electron/features/ocr/main/prepareLanguageModelsForJob.modelPrep', () => ({prepareLanguageModelsForJob: mocks.prepareLanguageModelsForJob}));
vi.mock('@electron/features/ocr/main/paths', () => ({resolveOcrPipelinePaths: async () => ({})}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({getWorkingCopyRevision: mocks.getWorkingCopyRevision}));

const jobManager = await import('@electron/features/ocr/main/jobManager');

let root: string;
let documentPath: string;
const revisionToken = parseDocumentRevisionToken('revision-1')!;

function createContext() {
    return {
        senderId: 7,
        sender: {
            id: 7,
            isDestroyed: () => false,
            once: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
        },
    };
}

function completionEvents() {
    return mocks.sendPlatformEvent.mock.calls
        .filter(([
            , channel,
        ]) => channel === OCR_COMPLETE_EVENT_CHANNEL)
        .map(([
            , , payload,
        ]) => payload as Record<string, unknown>);
}

async function waitForCompletion(count = 1) {
    await vi.waitFor(() => expect(completionEvents()).toHaveLength(count));
    return completionEvents().at(-1)!;
}

function startJob(requestId: string) {
    return jobManager.handleOcrCreateSearchablePdfAsync(
        createContext() as never,
        documentPath,
        [{
            pageNumber: requirePageNumber(1),
            languages: ['eng'],
        }],
        requireRequestId(requestId),
    );
}

async function stageResult(name: string): Promise<TOcrJobResult> {
    const pdfPath = join(root, name);
    await writeFile(pdfPath, 'searchable');
    return {
        success: true,
        pdfPath,
        sourceDocumentRevisionToken: revisionToken,
        resultSha256: 'sha',
        requiresCleanupAck: true,
        errors: [],
    };
}

describe('OCR job manager on the main job registry', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        root = await mkdtemp(join(tmpdir(), 'evb-ocr-job-manager-'));
        documentPath = join(root, 'document.pdf');
        await writeFile(documentPath, '%PDF-1.7');
        mocks.prepareLanguageModelsForJob.mockResolvedValue(undefined);
        mocks.getWorkingCopyRevision.mockImplementation(async (path: string) => ({
            version: 1,
            documentRef: path,
            authority: 'electron-working-copy',
            token: revisionToken,
            contentRevision: 1,
            mintedAt: 1,
        }));
    });

    afterEach(async () => {
        await rm(root, {
            recursive: true,
            force: true,
        });
    });

    it('delivers a staged result that only its document revision can apply, then acknowledges it away', async () => {
        const result = await stageResult('ocr-1-merged.pdf');
        mocks.runOcrJob.mockResolvedValueOnce(result);

        await expect(startJob('ocr-1')).resolves.toMatchObject({started: true});
        expect(await waitForCompletion()).toMatchObject({
            requestId: 'ocr-1',
            success: true,
            pdfPath: result.success ? result.pdfPath : '',
        });
        const documentRef = parseDocumentRef(documentPath)!;
        expect(jobManager.findOcrResultForDocument(join(root, 'ocr-1-merged.pdf'), documentRef, revisionToken))
            .toEqual({
                requestId: 'ocr-1',
                resultSha256: 'sha',
            });
        expect(jobManager.findOcrResultForDocument(
            join(root, 'ocr-1-merged.pdf'),
            documentRef,
            parseDocumentRevisionToken('revision-2')!,
        )).toBeNull();

        await expect(jobManager.handleOcrAcknowledgeResultFile(createContext() as never, 'ocr-1'))
            .resolves.toEqual({cleaned: true});
        await expect(stat(join(root, 'ocr-1-merged.pdf'))).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('reports a cancelled run as a cancelled completion', async () => {
        mocks.runOcrJob.mockImplementationOnce((job: IOcrJob) => new Promise((_resolve, reject) => {
            job.signal.addEventListener('abort', () => reject(job.signal.reason));
        }));

        await expect(startJob('ocr-2')).resolves.toMatchObject({started: true});
        await vi.waitFor(() => expect(mocks.runOcrJob).toHaveBeenCalled());
        expect(jobManager.handleOcrCancel(createContext() as never, requireRequestId('ocr-2'))).toEqual({canceled: true});
        expect(await waitForCompletion()).toMatchObject({
            requestId: 'ocr-2',
            success: false,
            errors: ['OCR job was cancelled'],
            errorEnvelope: {details: 'explicit cancel request'},
        });
    });

    it('keeps every recognition error of a failed run and passes a no-pages outcome through', async () => {
        mocks.runOcrJob.mockResolvedValueOnce({
            success: false,
            errors: [
                'Page 1: engine failed',
                'Page 2: engine failed',
            ],
        });
        await startJob('ocr-3');
        expect(await waitForCompletion()).toMatchObject({
            success: false,
            errors: [
                'Page 1: engine failed',
                'Page 2: engine failed',
            ],
            errorEnvelope: {message: 'Page 1: engine failed'},
        });

        mocks.runOcrJob.mockResolvedValueOnce({
            success: false,
            errors: [],
            outcome: 'no-pages-to-process',
        });
        await startJob('ocr-4');
        const noPages = await waitForCompletion(2);
        expect(noPages).toMatchObject({
            success: false,
            outcome: 'no-pages-to-process',
        });
        expect(noPages).not.toHaveProperty('errorEnvelope');
    });

    it('reports a language-model failure through the start result instead of a completion', async () => {
        mocks.prepareLanguageModelsForJob.mockRejectedValueOnce(new Error('model download failed'));

        await expect(startJob('ocr-5')).resolves.toMatchObject({
            started: false,
            error: 'model download failed',
        });
        expect(mocks.runOcrJob).not.toHaveBeenCalled();
        expect(completionEvents()).toEqual([]);
    });

    it('removes staged results nobody applied when the manager shuts down', async () => {
        mocks.runOcrJob.mockResolvedValueOnce(await stageResult('ocr-6-merged.pdf'));
        await startJob('ocr-6');
        await waitForCompletion();

        await jobManager.shutdownOcrJobManager();

        await vi.waitFor(() => expect(stat(join(root, 'ocr-6-merged.pdf'))).rejects.toMatchObject({code: 'ENOENT'}));
    });
});
