import {
    describe,
    expect,
    it,
} from 'vitest';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
    assertLinuxGlibcBaseline,
    compareNumericVersions,
    extractRequiredGlibcVersions,
} from '@scripts/release/assert-linux-glibc-baseline.mjs';
import {createTestTemporaryDirectory} from '@tests/helpers/removeTemporaryDirectory';

describe('Linux glibc release baseline', () => {
    it('orders numeric ABI versions without lexicographic mistakes', () => {
        expect(compareNumericVersions('2.9', '2.35')).toBeLessThan(0);
        expect(compareNumericVersions('2.38', '2.35')).toBeGreaterThan(0);
        expect(compareNumericVersions('2.35', '2.35.0')).toBe(0);
    });

    it('extracts and sorts required GLIBC symbol versions', () => {
        expect(extractRequiredGlibcVersions(`
          Name: GLIBC_2.38
          Name: GLIBC_2.2.5
          Name: GLIBC_2.35
          Name: GLIBC_2.38
        `)).toEqual([
            '2.2.5',
            '2.35',
            '2.38',
        ]);
    });

    it('fails closed when readelf cannot inspect a file with ELF magic', async () => {
        const directory = await createTestTemporaryDirectory('evb-glibc-malformed-elf-');
        const malformedElfPath = join(directory, 'broken');
        await writeFile(malformedElfPath, Buffer.from([
            0x7f,
            0x45,
            0x4c,
            0x46,
            0x00,
        ]));
        const runReadelf = (args: string[]) => {
            if (args[0] === '--version') {
                return '';
            }
            const error = new Error('fake readelf rejected malformed ELF');
            Object.assign(error, {stderr: 'malformed ELF fixture'});
            throw error;
        };

        await expect(assertLinuxGlibcBaseline(directory, '2.35', {runReadelf})).rejects.toThrow(
            `readelf could not inspect ELF file ${malformedElfPath}: malformed ELF fixture`,
        );
    });
});
