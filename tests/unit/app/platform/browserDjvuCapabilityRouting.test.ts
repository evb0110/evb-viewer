import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const mocks = vi.hoisted(() => ({
    createWorker: vi.fn(),
    getPageSizes: vi.fn(),
    readFile: vi.fn(),
    readFileRange: vi.fn(),
    statFile: vi.fn(),
}));

vi.mock('@app/platform/browser-api/createDjvuWorkerFromPath', () => ({
    createDjvuWorkerFromPath: mocks.createWorker,
    getDjvuWorkerPageSizes: mocks.getPageSizes,
    releaseBrowserDjvuViewingWorker: vi.fn(),
    retainBrowserDjvuViewingWorker: vi.fn(),
}));

const {browserDjvuCapability} = await import(
    '@app/platform/browser-api/browserDjvuCapability'
);

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
});
