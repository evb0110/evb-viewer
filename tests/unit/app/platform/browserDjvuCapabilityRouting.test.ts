import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import type {IDjvuOpenResult} from '@contracts/electronApiDjvu';
import {requireRequestId} from '@contracts/shared';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const mocks = vi.hoisted(() => ({
    createWorker: vi.fn(),
    getPageSizes: vi.fn(),
    readFile: vi.fn(),
    readFileRange: vi.fn(),
    retainViewingWorker: vi.fn(),
    statFile: vi.fn(),
}));

vi.mock('@app/platform/browser-api/createDjvuWorkerFromPath', () => ({
    createDjvuWorkerFromPath: mocks.createWorker,
    getDjvuWorkerPageSizes: mocks.getPageSizes,
    releaseBrowserDjvuViewingWorker: vi.fn(),
    retainBrowserDjvuViewingWorker: mocks.retainViewingWorker,
}));

const {browserDjvuCapability} = await import(
    '@app/platform/browser-api/browserDjvuCapability'
);
const {assertBrowserDjvuRasterDimensions} = await import(
    '@app/platform/browser-api/assertBrowserDjvuRasterDimensions'
);

function openForViewing(djvuPath: string) {
    return new Promise<IDjvuOpenResult>((resolve) => {
        const stop = browserDjvuCapability.onOpenComplete((result) => {
            stop();
            resolve(result);
        });
        void browserDjvuCapability.startOpenForViewing(requireDocumentRef(djvuPath), requireRequestId('djvu-open-test'));
    });
}

describe('browserDjvuCapability routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const electronApi = createElectronPlatformApiFixture({documentFiles: {
            readFile: mocks.readFile,
            readFileRange: mocks.readFileRange,
            statFile: mocks.statFile,
        }});
        Reflect.deleteProperty(electronApi.djvu, 'getInfo');
        vi.stubGlobal('window', {electronAPI: electronApi});
        mocks.createWorker.mockRejectedValue(new Error('browser DjVu worker must not be created'));
        mocks.getPageSizes.mockResolvedValue([{
            dpi: 300,
            height: 200,
            width: 100,
        }]);
    });

    it('refuses an absolute path without a native bridge before worker or file access', async () => {
        await expect(browserDjvuCapability.getPageSizes(requireDocumentRef('/tmp/native.djvu')))
            .rejects.toMatchObject({
                code: 'native-unavailable',
                name: 'PdfCombineCapabilityError',
                operation: 'djvu-page-sizes',
            });

        expect(mocks.createWorker).not.toHaveBeenCalled();
        expect(mocks.statFile).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.readFileRange).not.toHaveBeenCalled();
    });

    it('keeps browser document references on the browser worker route', async () => {
        mocks.createWorker.mockResolvedValue({terminate: vi.fn()});

        await expect(browserDjvuCapability.getPageSizes(requireDocumentRef('browser://documents/book.djvu')))
            .resolves.toEqual([{
                dpi: 300,
                height: 200,
                width: 100,
            }]);

        expect(mocks.createWorker).toHaveBeenCalledWith('browser://documents/book.djvu');
    });

    it('admits pages by validity first and then by the full-resolution raster limit', () => {
        expect(() => assertBrowserDjvuRasterDimensions(6000, 7500)).not.toThrow();
        for (const [
            width,
            height,
            code,
        ] of [
                [
                    10_000,
                    8001,
                    'djvu-raster-limit',
                ],
                [
                    32_769,
                    1,
                    'djvu-raster-limit',
                ],
                [
                    0,
                    100,
                    'invalid-djvu',
                ],
                [
                    100,
                    Number.NaN,
                    'invalid-djvu',
                ],
                [
                    1.5,
                    100,
                    'invalid-djvu',
                ],
            ] as const) {
            expect(() => assertBrowserDjvuRasterDimensions(width, height, 'DjVu page 1')).toThrow(expect.objectContaining({errorEnvelope: expect.objectContaining({code})}));
        }
    });

    it('reports the typed reason for a refused open on either worker route', async () => {
        const worker = {terminate: vi.fn()};
        mocks.createWorker.mockResolvedValue(worker);
        mocks.retainViewingWorker.mockResolvedValue(worker);
        mocks.statFile.mockResolvedValue({size: 1});
        mocks.getPageSizes.mockResolvedValue([]);

        await expect(openForViewing('browser://documents/empty.djvu')).resolves.toMatchObject({
            success: false,
            error: 'DjVu document has no pages',
            errorEnvelope: {code: 'invalid-djvu'},
        });

        let limitError: unknown;
        try {
            assertBrowserDjvuRasterDimensions(10_000, 8001, 'DjVu page 1');
        } catch (error) {
            limitError = error;
        }
        mocks.getPageSizes.mockRejectedValueOnce(limitError);
        await expect(openForViewing('browser://documents/huge.djvu')).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('10000x8001'),
            errorEnvelope: {code: 'djvu-raster-limit'},
        });

        // An unexplained worker failure is not presented as damage.
        mocks.getPageSizes.mockRejectedValueOnce(new Error('worker crashed'));
        const unexplained = await openForViewing('browser://documents/crash.djvu');
        expect(unexplained).toMatchObject({
            success: false,
            error: 'worker crashed',
        });
        expect(unexplained).not.toHaveProperty('errorEnvelope');
    });
});
