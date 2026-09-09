import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mapScanCleanupRasterPages,
    readAvailableScratchBytes,
    resolveRasterHandoff,
    resolveRequiredScratchBytes,
    resolveStagedRasterWindow,
} from '@evb/scan-cleanup/core/resolveRasterHandoff';

const mocks = vi.hoisted(() => ({statfs: vi.fn()}));

vi.mock('fs/promises', () => ({statfs: mocks.statfs}));

const MIB = 1024 * 1024;

const plans = [{
    renderDpi: 300,
    raster: {
        dpi: 300,
        height: 10_000,
        width: 10_000,
    },
}];

describe('scan-cleanup raster handoff scratch budget', () => {
    it('preserves a known zero-byte statfs result', async () => {
        mocks.statfs.mockResolvedValue({
            bavail: 0,
            bsize: 4_096,
        });

        await expect(readAvailableScratchBytes('/scratch')).resolves.toBe(0);
        await expect(resolveRasterHandoff(
            plans,
            '/scratch',
            readAvailableScratchBytes,
        )).resolves.toMatchObject({
            budgetBytes: 0,
            format: 'png',
        });
    });

    it('keeps the fallback floor when scratch availability is unknown', async () => {
        const result = await resolveRasterHandoff(
            plans,
            '/scratch',
            vi.fn(async () => null),
        );

        expect(result).toMatchObject({
            budgetBytes: 512 * MIB,
            format: 'ppm',
        });
    });

    it('caps the floor at known free space minus the reserve', async () => {
        const result = await resolveRasterHandoff(
            plans,
            '/scratch',
            vi.fn(async () => 700 * MIB),
        );

        expect(result).toMatchObject({
            budgetBytes: 188 * MIB,
            format: 'png',
        });
    });

    it('allows no raw-raster budget when known free space cannot cover the reserve', async () => {
        const result = await resolveRasterHandoff(
            plans,
            '/scratch',
            vi.fn(async () => 512 * MIB),
        );

        expect(result).toMatchObject({
            budgetBytes: 0,
            format: 'png',
        });
    });

    it('includes conservative per-file overhead above the raw RGB payload', async () => {
        const result = await resolveRasterHandoff([{
            renderDpi: 300,
            raster: {
                dpi: 300,
                height: 100,
                width: 100,
            },
        }], '/scratch', vi.fn(async () => null));

        expect(result.estimatedBytes).toBe(100 * 100 * 3 + 64 * 1024);
    });

    it('budgets the largest simultaneous producer and native scratch copies', async () => {
        const result = await resolveRasterHandoff([
            {
                renderDpi: 300,
                raster: {
                    dpi: 300,
                    height: 100,
                    width: 100,
                },
            },
            {
                renderDpi: 300,
                raster: {
                    dpi: 300,
                    height: 200,
                    width: 200,
                },
            },
            {
                renderDpi: 300,
                raster: {
                    dpi: 300,
                    height: 300,
                    width: 300,
                },
            },
        ], '/scratch', vi.fn(async () => null), 2);

        expect(result.estimatedBytes).toBe(
            300 * 300 * 3 + 64 * 1024
            + 200 * 200 * 3 + 64 * 1024,
        );
    });

    it('counts canonical analysis scratch and primary raster copies per resident page', async () => {
        const result = await resolveRasterHandoff([{
            renderDpi: 300,
            additionalRenderDpis: [150],
            renderCopies: 2,
            raster: {
                dpi: 300,
                height: 400,
                width: 200,
            },
        }], '/scratch', vi.fn(async () => null), 1);

        const workingBytes = 200 * 400 * 3 + 64 * 1024;
        const canonicalBytes = 100 * 200 * 3 + 64 * 1024;
        expect(result.estimatedBytes).toBe(workingBytes * 2 + canonicalBytes);
    });

    it('admits the widest window that fits and narrows it under scratch pressure', async () => {
        // 3,000 × 3,000 pages, each staged beside the copy its render publishes
        // from: 54 MiB of scratch per resident page.
        const pageBytes = 3_000 * 3_000 * 3 + Math.ceil(3_000 * 3_000 * 3 * 0.01);
        const plansOf = (pages: number) => Array.from({length: pages}, () => ({
            renderDpi: 150,
            renderCopies: 2,
            raster: {
                dpi: 150,
                height: 3_000,
                width: 3_000,
            },
        }));
        const admit = (pages: number, availableBytes: number | null) => resolveStagedRasterWindow(
            plansOf(pages),
            4,
            '/scratch',
            vi.fn(async () => availableBytes),
        );

        await expect(admit(30, 4_096 * MIB)).resolves.toMatchObject({
            admitted: true,
            windowPages: 4,
            requiredBytes: null,
        });
        // The document is far past the budget; only the window has to fit.
        await expect(admit(30, 700 * MIB)).resolves.toMatchObject({
            admitted: true,
            windowPages: 3,
            wholeDocumentBytes: 30 * pageBytes * 2,
        });
        await expect(admit(30, 632 * MIB)).resolves.toMatchObject({
            admitted: true,
            windowPages: 2,
        });
        await expect(admit(30, 572 * MIB)).resolves.toMatchObject({
            admitted: true,
            windowPages: 1,
        });
        // Below one safe window the run genuinely cannot start, and says by how
        // much: free space has to cover the window and the reserve it keeps off
        // the filesystem.
        await expect(admit(30, 520 * MIB)).resolves.toMatchObject({
            admitted: false,
            windowPages: 1,
            windowBytes: pageBytes * 2,
            requiredBytes: pageBytes * 2 + 512 * MIB,
        });
        // A document with no pages left to stage needs no window at all.
        await expect(admit(0, 1)).resolves.toMatchObject({
            admitted: true,
            windowPages: 0,
        });
    });

    it('admits the narrowest window when a page cannot be measured at all', async () => {
        // An unmeasurable page is not a short filesystem: refusing it would
        // report a shortfall with no figures in it and block a run over an
        // unknown, so the single-page window is admitted instead.
        const unmeasurable = [
            {
                renderDpi: 150,
                renderCopies: 2,
                raster: {
                    dpi: 150,
                    height: 3_000,
                    width: 3_000,
                },
            },
            {
                renderDpi: 150,
                renderCopies: 2,
                raster: undefined,
            },
        ];

        await expect(resolveStagedRasterWindow(
            unmeasurable,
            4,
            '/scratch',
            vi.fn(async () => 8 * MIB),
        )).resolves.toEqual({
            admitted: true,
            windowPages: 1,
            windowBytes: null,
            budgetBytes: 0,
            availableBytes: 8 * MIB,
            wholeDocumentBytes: null,
            requiredBytes: null,
        });
        // Unknown free space is a separate unknown and keeps the same answer.
        await expect(resolveStagedRasterWindow(
            unmeasurable,
            4,
            '/scratch',
            vi.fn(async () => null),
        )).resolves.toMatchObject({
            admitted: true,
            windowPages: 1,
            windowBytes: null,
            requiredBytes: null,
        });
        // A measurable page that does not fit is still refused, with the
        // shortfall a user can act on.
        await expect(resolveStagedRasterWindow(
            [unmeasurable[0]!],
            4,
            '/scratch',
            vi.fn(async () => 520 * MIB),
        )).resolves.toMatchObject({
            admitted: false,
            windowPages: 1,
            requiredBytes: expect.any(Number),
        });
    });

    it('inverts the budget into the free space that would admit a window', () => {
        // Under the floor the reserve is what binds; above it, the quarter
        // share of free space is.
        expect(resolveRequiredScratchBytes(64 * MIB)).toBe(64 * MIB + 512 * MIB);
        expect(resolveRequiredScratchBytes(512 * MIB)).toBe(1_024 * MIB);
        expect(resolveRequiredScratchBytes(600 * MIB)).toBe(2_400 * MIB);
    });

    it('waits for every raster worker before rethrowing a sibling failure', async () => {
        const siblingStarted = Promise.withResolvers<undefined>();
        const releaseSibling = Promise.withResolvers<undefined>();
        let settled = false;
        const run = mapScanCleanupRasterPages([
            1,
            2,
        ], 2, async (_value, index) => {
            if (index === 0) {
                await Promise.resolve();
                throw new Error('first raster failed');
            }
            siblingStarted.resolve(undefined);
            await releaseSibling.promise;
            return index;
        }).finally(() => {
            settled = true;
        });

        await siblingStarted.promise;
        await Promise.resolve();
        expect(settled).toBe(false);

        releaseSibling.resolve(undefined);
        await expect(run).rejects.toThrow('first raster failed');
        expect(settled).toBe(true);
    });
});
