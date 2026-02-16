import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const DIST_DIR = join(import.meta.dirname, '..', '..', '..', 'dist-electron');

interface IBundleCheck {
    file: string;
    requiredSymbols: string[];
}

const BUNDLE_CHECKS: IBundleCheck[] = [
    {
        file: 'pdf-combine-worker.js',
        requiredSymbols: [
            'readImageDpi',
            'pixelsToPdfPoints',
            'readTiffFrameDpi',
            'METERS_PER_INCH',
        ],
    },
    {
        file: 'ocr-worker.js',
        requiredSymbols: ['detectSourceDpi'],
    },
];

describe('electron bundle integrity', () => {
    for (const check of BUNDLE_CHECKS) {
        describe(check.file, () => {
            const bundlePath = join(DIST_DIR, check.file);

            it('exists in dist-electron', () => {
                expect(existsSync(bundlePath), `${check.file} not found — run "pnpm run build:electron"`).toBe(true);
            });

            for (const symbol of check.requiredSymbols) {
                it(`contains "${symbol}"`, async () => {
                    if (!existsSync(bundlePath)) {
                        throw new Error(`${check.file} not found — run "pnpm run build:electron"`);
                    }
                    const content = await readFile(bundlePath, 'utf-8');
                    expect(
                        content.includes(symbol),
                        `${check.file} is missing "${symbol}" — rebuild with "pnpm run build:electron"`,
                    ).toBe(true);
                });
            }
        });
    }
});
