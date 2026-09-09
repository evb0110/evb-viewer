import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { join } from 'path';

const mocks = vi.hoisted(() => ({existsSync: vi.fn()}));

vi.mock('fs', () => ({existsSync: (path: string) => mocks.existsSync(path)}));

describe('resolveOcrResourcesBase', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.spyOn(process, 'cwd').mockReturnValue('/repo');
        Object.defineProperty(process, 'resourcesPath', {
            configurable: true,
            value: '/app/Contents/Resources',
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses Electron resources in packaged builds', async () => {
        const { resolveOcrResourcesBase } = await import('@electron/features/ocr/main/resolveOcrResourcesBase');

        expect(resolveOcrResourcesBase('/app/Contents/Resources/app.asar/dist-electron', true))
            .toBe('/app/Contents/Resources');
    });

    it('resolves the repository resources directory from source modules', async () => {
        mocks.existsSync.mockImplementation((path: string) => path === join('/repo/resources', 'tesseract'));
        const { resolveOcrResourcesBase } = await import('@electron/features/ocr/main/resolveOcrResourcesBase');

        expect(resolveOcrResourcesBase('/repo/electron/ocr', false))
            .toBe('/repo/resources');
    });

    it('resolves the repository resources directory from dist-electron bundles', async () => {
        mocks.existsSync.mockImplementation((path: string) => path === join('/repo/resources', 'tesseract'));
        const { resolveOcrResourcesBase } = await import('@electron/features/ocr/main/resolveOcrResourcesBase');

        expect(resolveOcrResourcesBase('/repo/dist-electron', false))
            .toBe('/repo/resources');
    });
});
