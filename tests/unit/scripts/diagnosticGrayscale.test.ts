import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {describe, expect, it} from 'vitest';
import {loadGrayscaleImage} from '@scripts/diagnostics/load-grayscale-image.mjs';

describe('diagnostic grayscale image loader', () => {
    it('composites onto white and returns one luminance byte per pixel', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-diagnostic-gray-'));
        const imagePath = join(directory, 'sample.png');
        try {
            const canvas = createCanvas(3, 1);
            const context = canvas.getContext('2d');
            context.fillStyle = '#000';
            context.fillRect(0, 0, 1, 1);
            context.fillStyle = '#00ff00';
            context.fillRect(1, 0, 1, 1);
            writeFileSync(imagePath, canvas.toBuffer('image/png'));

            const bitmap = await loadGrayscaleImage(imagePath);

            expect(bitmap.width).toBe(3);
            expect(bitmap.height).toBe(1);
            expect([...bitmap.data]).toEqual([0, 182, 255]);
            expect(readFileSync(imagePath).length).toBeGreaterThan(0);
        } finally {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });
});
