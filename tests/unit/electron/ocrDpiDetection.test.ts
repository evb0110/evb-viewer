import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    detectSourceDpi,
    detectSourceDpiDetails,
} from '@electron/features/ocr/worker/dpiDetection';
import {detectSourceDpiFromPageSizes} from '@electron/pdf/sourceDpiDetection';

const mocks = vi.hoisted(() => ({runOcrCommand: vi.fn()}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runOcrCommand}));

describe('ocr dpi detection', () => {
    beforeEach(() => {
        mocks.runOcrCommand.mockReset();
    });

    it('derives every page raster from verified full-page image metadata', () => {
        const result = detectSourceDpiFromPageSizes([
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 439.6,
                heightPoints: 670,
                rotation: 0,
                dominantImageWidthPx: 2198,
                dominantImageHeightPx: 3350,
                dominantImageWidthPoints: 439.6,
                dominantImageHeightPoints: 670,
            },
            {
                pageNumber: 2,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 424,
                heightPoints: 640.4,
                rotation: 0,
                dominantImageWidthPx: 2120,
                dominantImageHeightPx: 3202,
                dominantImageWidthPoints: 424,
                dominantImageHeightPoints: 640.4,
            },
        ]);

        expect(result?.documentDpi).toBe(360);
        expect(result?.pageRasterByNumber.get(1)).toEqual({
            dpi: 360,
            width: 2198,
            height: 3350,
        });
        expect(result?.pageRasterByNumber.get(2)).toEqual({
            dpi: 360,
            width: 2120,
            height: 3202,
        });
    });

    it('falls back when any page lacks verified full-page raster metadata', () => {
        expect(detectSourceDpiFromPageSizes([{
            pageNumber: 1,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        }])).toBeNull();
    });

    it('uses each page dominant raster instead of a tiny high-DPI object', async () => {
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: [
                'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
                '--------------------------------------------------------------------------------------------',
                '   4     3 image    2630  2159  rgb     3   8  image  no      3721  0    72    72 4986K  30%',
                '   5     4 image    1617  2800  sep     1   8  image  no      4330  0   239   239 90.9K 2.1%',
                '   5     5 image     100   100  sep     1   8  image  no      4331  0   300   300  1.0K 1.0%',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        const result = await detectSourceDpiDetails('/tmp/input.pdf', '/bin/pdfimages', vi.fn());

        expect(result.documentDpi).toBe(239);
        expect(result.pageDpiByNumber.get(4)).toBe(72);
        expect(result.pageDpiByNumber.get(5)).toBe(239);
        expect(result.pageRasterByNumber.get(4)).toEqual({
            dpi: 72,
            width: 2630,
            height: 2159,
        });
        expect(result.pageRasterByNumber.get(5)).toEqual({
            dpi: 239,
            width: 1617,
            height: 2800,
        });
    });

    it('keeps a compact layered source background separate from its text-mask grid', async () => {
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: [
                'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
                '33 0 image 706 1067 rgb 3 8 jpx no 253 0 120 120 1347B 0.1%',
                '33 1 image 2119 3204 rgb 3 8 jpx no 255 0 360 360 8418B 0.0%',
                '33 2 smask 2119 3204 gray 1 1 jbig2 no 255 0 360 360 81.2K 9.8%',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        const result = await detectSourceDpiDetails('/tmp/input.pdf', '/bin/pdfimages', vi.fn());

        expect(result.pageRasterByNumber.get(33)).toEqual({
            dpi: 360,
            width: 2119,
            height: 3204,
            hasBilevelLayer: true,
            hasDominantBilevelLayer: true,
            backgroundDpi: 120,
        });
    });

    it('does not treat an incidental small one-bit image as the dominant source grid', async () => {
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: [
                'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
                '1 0 image 2400 3600 rgb 3 8 jpeg no 10 0 300 300 1M 10%',
                '1 1 mask 200 200 gray 1 1 jbig2 no 11 0 300 300 1K 1%',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        const result = await detectSourceDpiDetails('/tmp/input.pdf', '/bin/pdfimages', vi.fn());

        expect(result.pageRasterByNumber.get(1)).toEqual({
            dpi: 300,
            width: 2400,
            height: 3600,
            hasBilevelLayer: true,
            backgroundDpi: 300,
        });
    });

    it('retains the finer selection-mask grid over a lower-resolution tonal image', async () => {
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: [
                'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
                '1 0 image 800 1200 rgb 3 8 jpx no 10 0 100 100 1M 10%',
                '1 1 smask 4800 7200 gray 1 1 jbig2 no 11 0 600 600 1M 1%',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        const result = await detectSourceDpiDetails('/tmp/input.pdf', '/bin/pdfimages', vi.fn());

        expect(result.pageRasterByNumber.get(1)).toEqual({
            dpi: 600,
            width: 4800,
            height: 7200,
            hasBilevelLayer: true,
            hasDominantBilevelLayer: true,
            backgroundDpi: 100,
        });
    });

    it('keeps the finer continuous grid when a nearly full-page mask is coarser', async () => {
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: [
                'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
                '1 0 image 3000 4000 rgb 3 8 jpx no 10 0 600 600 1M 10%',
                '1 1 mask 2950 3900 gray 1 1 jbig2 no 11 0 590 590 1M 1%',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        const result = await detectSourceDpiDetails('/tmp/input.pdf', '/bin/pdfimages', vi.fn());

        expect(result.pageRasterByNumber.get(1)).toEqual({
            dpi: 600,
            width: 3000,
            height: 4000,
            hasBilevelLayer: true,
            hasDominantBilevelLayer: true,
            backgroundDpi: 600,
        });
    });

    it('recognizes pdfimages stencil rows as dominant bilevel sources', async () => {
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: [
                'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
                '1 0 image 1200 1800 rgb 3 8 jpeg no 10 0 300 300 1M 10%',
                '1 1 stencil 1200 1800 gray 1 1 jbig2 no 11 0 300 300 1M 1%',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        const result = await detectSourceDpiDetails('/tmp/input.pdf', '/bin/pdfimages', vi.fn());

        expect(result.pageRasterByNumber.get(1)).toEqual({
            dpi: 300,
            width: 1200,
            height: 1800,
            hasBilevelLayer: true,
            hasDominantBilevelLayer: true,
            backgroundDpi: 300,
        });
    });

    it('returns the document dpi for the legacy detector', async () => {
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: [
                'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
                '   1     0 image    1262  1036  gray    1   8  jpeg   no      3421  0   200   200 62.8K 4.9%',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        await expect(detectSourceDpi('/tmp/input.pdf', '/bin/pdfimages', vi.fn())).resolves.toBe(200);
    });

    it('probes selected OCR pages without scanning unselected gaps', async () => {
        mocks.runOcrCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });

        await detectSourceDpiDetails(
            '/tmp/input.pdf',
            '/bin/pdfimages',
            vi.fn(),
            undefined,
            undefined,
            [
                9,
                4,
                4,
            ],
        );

        expect(mocks.runOcrCommand.mock.calls.map(([
            ,
            args,
        ]) => args)).toEqual([
            [
                '-f',
                '4',
                '-l',
                '4',
                '-list',
                '/tmp/input.pdf',
            ],
            [
                '-f',
                '9',
                '-l',
                '9',
                '-list',
                '/tmp/input.pdf',
            ],
        ]);
    });

    it('keeps sparse selected OCR pages in separate pdfimages probes', async () => {
        mocks.runOcrCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });

        await detectSourceDpiDetails(
            '/tmp/input.pdf',
            '/bin/pdfimages',
            vi.fn(),
            undefined,
            undefined,
            [
                1,
                1_024,
            ],
        );

        expect(mocks.runOcrCommand).toHaveBeenCalledTimes(2);
        expect(mocks.runOcrCommand.mock.calls.map(([
            ,
            args,
        ]) => args)).toEqual([
            [
                '-f',
                '1',
                '-l',
                '1',
                '-list',
                '/tmp/input.pdf',
            ],
            [
                '-f',
                '1024',
                '-l',
                '1024',
                '-list',
                '/tmp/input.pdf',
            ],
        ]);
    });

    it('probes every page in bounded chunks for long documents', async () => {
        const firstBatchEntered = Promise.withResolvers<undefined>();
        let activeProbes = 0;
        let peakProbes = 0;
        let enteredProbes = 0;
        const probeTimeouts: number[] = [];
        mocks.runOcrCommand.mockImplementation(async (
            _binary,
            args: string[],
            options: {timeoutMs?: number},
        ) => {
            probeTimeouts.push(options.timeoutMs ?? 0);
            activeProbes += 1;
            peakProbes = Math.max(peakProbes, activeProbes);
            enteredProbes += 1;
            if (enteredProbes === 4) firstBatchEntered.resolve(undefined);
            await firstBatchEntered.promise;
            try {
                const firstPage = Number(args[args.indexOf('-f') + 1]);
                const lastPage = Number(args[args.indexOf('-l') + 1]);
                return {
                    stdout: [
                        'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
                        ...Array.from({length: lastPage - firstPage + 1}, (_value, index) => {
                            const page = firstPage + index;
                            return `   ${page}     0 image    1800  2700  gray    1   8  image  no      3421  0   360   360 1.0K 1.0%`;
                        }),
                    ].join('\n'),
                    stderr: '',
                    exitCode: 0,
                };
            } finally {
                activeProbes -= 1;
            }
        });
        const progress: Array<[number, number]> = [];

        const result = await detectSourceDpiDetails(
            '/tmp/input.pdf',
            '/bin/pdfimages',
            vi.fn(),
            undefined,
            undefined,
            Array.from({ length: 4096 }, (_value, index) => index + 1),
            (completed, total) => progress.push([
                completed,
                total,
            ]),
        );

        expect(mocks.runOcrCommand).toHaveBeenCalledTimes(4);
        expect(peakProbes).toBe(4);
        expect(probeTimeouts).toEqual([
            30_000,
            30_000,
            30_000,
            30_000,
        ]);
        expect(progress.at(-1)).toEqual([
            4096,
            4096,
        ]);
        expect(mocks.runOcrCommand.mock.calls[0]?.[1]).toEqual([
            '-f',
            '1',
            '-l',
            '1024',
            '-list',
            '/tmp/input.pdf',
        ]);
        expect(mocks.runOcrCommand.mock.calls.at(-1)?.[1]).toEqual([
            '-f',
            '3073',
            '-l',
            '4096',
            '-list',
            '/tmp/input.pdf',
        ]);
        expect(mocks.runOcrCommand).not.toHaveBeenCalledWith(
            '/bin/pdfimages',
            [
                '-f',
                '1',
                '-l',
                '392',
                '-list',
                '/tmp/input.pdf',
            ],
            expect.anything(),
        );
        expect(result.documentDpi).toBe(360);
        expect(result.pageDpiByNumber.size).toBe(4096);
        expect(result.pageDpiByNumber.get(1)).toBe(360);
        expect(result.pageDpiByNumber.get(196)).toBe(360);
        expect(result.pageDpiByNumber.get(392)).toBe(360);
    });

    it('downgrades recoverable pdfimages runner errors to debug logs', async () => {
        const log = vi.fn();
        mocks.runOcrCommand.mockImplementationOnce(async (_command, _args, options) => {
            options.log?.('error', 'pdfimages(-list) timed out after 30000ms; cmd=/bin/pdfimages -list /tmp/input.pdf');
            throw new Error('pdfimages(-list) timed out after 30000ms');
        });

        const result = await detectSourceDpiDetails('/tmp/input.pdf', '/bin/pdfimages', log);

        expect(result.documentDpi).toBeNull();
        expect(result.pageDpiByNumber.size).toBe(0);
        expect(log).toHaveBeenCalledWith(
            'debug',
            expect.stringContaining('pdfimages(-list) timed out after 30000ms'),
        );
        expect(log).not.toHaveBeenCalledWith('error', expect.any(String));
    });
});
