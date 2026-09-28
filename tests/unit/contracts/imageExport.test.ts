import {
    describe,
    expect,
    it,
} from 'vitest';
import { IMAGE_EXPORT_PLATFORM_FEATURE } from '@contracts/imageExportPlatformFeature';
import { requireRequestId } from '@contracts/shared';
import * as v from 'valibot';

describe('image export platform feature schemas', () => {
    const channels = IMAGE_EXPORT_PLATFORM_FEATURE.invokeChannels;
    const codecs = IMAGE_EXPORT_PLATFORM_FEATURE.ipcCodecs;

    it('preserves channels and registry-backed replay policy', () => {
        expect(channels).toEqual({
            rasterizePdfRegion: 'pdfExport:region',
            exportPdfToImages: 'pdfExport:images',
            exportPdfToMultiPageTiff: 'pdfExport:multipage-tiff',
            subscribeProgress: 'pdfExport:progress:subscribe',
        });
        expect(IMAGE_EXPORT_PLATFORM_FEATURE.eventChannels).toEqual({onProgress: 'pdfExport:progress'});
        expect(IMAGE_EXPORT_PLATFORM_FEATURE.events.onProgress.subscription.replay).toMatchObject({
            intervalMs: 50,
            mode: 'latest-per-key',
            owner: 'ipc-progress-pump',
            terminalRetentionMs: 30_000,
        });
    });

    it('round-trips source kinds and normalized page-list arguments', () => {
        const args = [
            '/tmp/book.djvu',
            [
                3,
                1,
            ],
            'export-1',
            'djvu',
        ];
        const codec = codecs[channels.exportPdfToImages]!;

        expect(codec.decodeArgs(codec.encodeArgs(args))).toEqual(args);
    });

    it('keeps validation and result envelopes stable', () => {
        expect(() => codecs[channels.exportPdfToImages]!.decodeArgs([
            '/tmp/book.pdf',
            [0],
        ])).toThrow('pageNumbers must contain positive safe integers');
        expect(() => codecs[channels.exportPdfToImages]!.decodeArgs([
            '/tmp/book.pdf',
            [
                1,
                1,
            ],
        ])).toThrow('pageNumbers must contain unique pages');
        expect(() => codecs[channels.exportPdfToImages]!.decodeArgs([
            '/tmp/book.pdf',
            [1],
            'x'.repeat(129),
        ])).toThrow('requestId exceeds maximum length (128)');
        expect(codecs[channels.exportPdfToImages]!.decodeArgs([
            '/tmp/book.pdf',
            [1],
            ' export-1 ',
        ])).toEqual([
            '/tmp/book.pdf',
            [1],
            'export-1',
            undefined,
        ]);
        expect(() => codecs[channels.exportPdfToImages]!.decodeArgs([
            '/tmp/book.pdf',
            [1],
            undefined,
            'epub',
        ])).toThrow('sourceKind must be pdf or djvu');
        expect(() => codecs[channels.exportPdfToImages]!.decodeResult({success: 'yes'}))
            .toThrow('invalid image export result');
        expect(() => codecs[channels.exportPdfToImages]!.decodeResult({
            success: true,
            outputPaths: Array.from({length: 100_001}, () => '/tmp/export.jpg'),
        })).toThrow('outputPaths exceeds maximum item count (100000)');
        expect(codecs[channels.exportPdfToMultiPageTiff]!.decodeResult({
            success: true,
            outputPath: '/tmp/export.tiff',
            outputPaths: ['/tmp/export.tiff'],
        })).toEqual({
            success: true,
            outputPath: '/tmp/export.tiff',
            outputPaths: ['/tmp/export.tiff'],
        });
    });

    it('validates progress and identifies terminal replay payloads', () => {
        const event = IMAGE_EXPORT_PLATFORM_FEATURE.events.onProgress;
        const progress = {
            requestId: requireRequestId('export-1'),
            format: 'images' as const,
            phase: 'rendering' as const,
            processed: 1,
            total: 4,
            percent: 25,
            status: 'running' as const,
        };

        expect(v.parse(event.payload, progress, {abortEarly: true})).toEqual(progress);
        expect(event.subscription.replay.key(progress)).toBe('export-1');
        expect(event.subscription.replay.terminal(progress)).toBe(false);
        expect(event.subscription.replay.terminal({
            ...progress,
            status: 'success',
        })).toBe(true);
        expect(() => v.parse(event.payload, {
            ...progress,
            processed: '1',
        }, {abortEarly: true}))
            .toThrow('invalid image export progress');
    });
});
