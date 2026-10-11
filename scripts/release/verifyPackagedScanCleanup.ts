import type {IArguments} from '@scripts/release/runPackagedScanCleanupVerification';
import path from 'node:path';

function parseArguments(argv: string[]): IArguments {
    const value = (name: string) => {
        const index = argv.indexOf(name);
        const result = index >= 0 ? argv[index + 1] : undefined;
        if (!result) {
            throw new Error(
                'Usage: verifyPackagedScanCleanup.ts '
                + '--executable <path> --source <pdf> --artifact-dir <directory> '
                + '--expected-pages <count>',
            );
        }
        return path.resolve(result);
    };
    const expectedPageCountIndex = argv.indexOf('--expected-pages');
    const expectedPageCount = expectedPageCountIndex >= 0
        ? Number(argv[expectedPageCountIndex + 1])
        : Number.NaN;
    if (!Number.isInteger(expectedPageCount) || expectedPageCount < 1) {
        throw new Error('--expected-pages <count> is required and must be a positive integer');
    }
    const optionalValue = (name: string) => {
        const index = argv.indexOf(name);
        if (index < 0) {
            return null;
        }
        const result = argv[index + 1];
        if (!result) {
            throw new Error(`Missing value for ${name}`);
        }
        return path.resolve(result);
    };
    const optionalRawValue = (name: string) => {
        const index = argv.indexOf(name);
        if (index < 0) {
            return null;
        }
        const result = argv[index + 1];
        if (!result) {
            throw new Error(`Missing value for ${name}`);
        }
        return result;
    };
    const sourcePages = optionalRawValue('--source-pages');
    if (sourcePages) {
        const pages = sourcePages
            .split(',')
            .map(value => Number.parseInt(value.trim(), 10));
        if (
            pages.length !== expectedPageCount
            || pages.some(page => !Number.isInteger(page) || page < 1)
        ) {
            throw new Error(
                '--source-pages must contain one positive source page per expected output page',
            );
        }
    }
    const result = {
        auditSourcePath: optionalValue('--audit-source'),
        artifactDir: value('--artifact-dir'),
        expectedPageCount,
        executablePath: value('--executable'),
        referenceMetadataDir: optionalValue('--reference-metadata-dir'),
        scaleOnly: argv.includes('--scale-only'),
        sourcePath: value('--source'),
        sourcePages,
        syntheticSpecPath: optionalValue('--synthetic-spec'),
    };
    if ((result.auditSourcePath === null) !== (result.sourcePages === null)) {
        throw new Error('--audit-source and --source-pages must be provided together');
    }
    if (!result.scaleOnly && !result.referenceMetadataDir) {
        throw new Error(
            '--reference-metadata-dir is required for final artifact verification',
        );
    }
    return result;
}

// Validate before loading the verifier: its module graph includes the Electron
// e2e session helpers, which a bad invocation must not wait for.
const args = parseArguments(process.argv.slice(2));
const {runPackagedScanCleanupVerification} = await import('@scripts/release/runPackagedScanCleanupVerification');
await runPackagedScanCleanupVerification(args);
