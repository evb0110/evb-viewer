import { createHash } from 'node:crypto';
import {
    mkdir,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { isDirectCliInvocation } from '@scripts/windows-test/cli/windowsTestCliIo';
import { generateFontsFixture } from '@scripts/windows-test/fixtures/generateFontsFixture';
import { generateMetadataFixture } from '@scripts/windows-test/fixtures/generateMetadataFixture';
import {
    generateBlankControl,
    generateCorruptSidecarControl,
    generateTruncatedControl,
    generateWrongMarkerControl,
} from '@scripts/windows-test/fixtures/generateNegativeControls';
import { generateNumberedFixture } from '@scripts/windows-test/fixtures/generateNumberedFixture';
import { generateLargePdfE2eFixture } from '@scripts/generate-large-pdf-e2e-fixture.mjs';

export const WINDOWS_FIXTURE_GENERATED_DIRECTORY = path.join('tests', 'windows', 'fixtures', 'generated');

export interface IWindowsFixtureArtifact {
    fixtureId: string;
    fileName: string;
    build?: () => Promise<Uint8Array>;
    write?: (outputPath: string) => Promise<void>;
}

export interface IWindowsFixtureGenerationEntry {
    fixtureId: string;
    relativePath: string;
    bytes: number;
    sha256: string;
    written: boolean;
}

export interface IWindowsFixtureGenerationResult {
    outputDirectory: string;
    entries: IWindowsFixtureGenerationEntry[];
    written: boolean;
}

function encodeText(value: string) {
    return new TextEncoder().encode(value);
}

export function windowsFixtureArtifacts(): IWindowsFixtureArtifact[] {
    return [
        {
            fixtureId: 'F01-numbered-12p',
            fileName: 'f01-numbered-12p.pdf',
            build: () => generateNumberedFixture(),
        },
        {
            fixtureId: 'F02-metadata-6p',
            fileName: 'f02-metadata-6p.pdf',
            build: () => generateMetadataFixture(),
        },
        {
            fixtureId: 'F04-fonts-languages',
            fileName: 'f04-fonts-languages.pdf',
            build: () => generateFontsFixture(),
        },
        {
            fixtureId: 'F05-control-blank',
            fileName: 'f05-control-blank.pdf',
            build: () => generateBlankControl(),
        },
        {
            fixtureId: 'F05-control-wrong-markers',
            fileName: 'f05-control-wrong-markers.pdf',
            build: () => generateWrongMarkerControl(),
        },
        {
            fixtureId: 'F05-control-truncated',
            fileName: 'f05-control-truncated.pdf',
            build: () => generateTruncatedControl(),
        },
        {
            fixtureId: 'F08-control-corrupt-sidecar',
            fileName: 'f08-control-corrupt-sidecar.json',
            build: () => Promise.resolve(encodeText(generateCorruptSidecarControl())),
        },
        {
            fixtureId: 'F10-save-witness-65mib',
            fileName: 'f10-save-witness-65mib.pdf',
            write: outputPath => generateLargePdfE2eFixture({
                outputPath,
                pageCount: 431,
                targetBytes: 65 * 1024 * 1024,
            }).then(() => undefined),
        },
        {
            fixtureId: 'F10-save-witness-513mib',
            fileName: 'f10-save-witness-513mib.pdf',
            write: outputPath => generateLargePdfE2eFixture({
                outputPath,
                pageCount: 431,
                targetBytes: 513 * 1024 * 1024,
            }).then(() => undefined),
        },
    ];
}

export interface IWindowsFixtureGenerationOptions {
    outputDirectory: string;
    write: boolean;
    relativeTo?: string;
}

export async function runWindowsFixtureGeneration(
    options: IWindowsFixtureGenerationOptions,
): Promise<IWindowsFixtureGenerationResult> {
    const entries: IWindowsFixtureGenerationEntry[] = [];
    if (options.write) {
        await mkdir(options.outputDirectory, { recursive: true });
    }
    for (const artifact of windowsFixtureArtifacts()) {
        const absolutePath = path.join(options.outputDirectory, artifact.fileName);
        if (artifact.write !== undefined) {
            if (options.write) {
                await artifact.write(absolutePath);
            }
            const identity = options.write
                ? {
                    bytes: (await stat(absolutePath)).size,
                    sha256: createHash('sha256').update(await readFile(absolutePath)).digest('hex'),
                }
                : {
                    bytes: 0,
                    sha256: '',
                };
            entries.push({
                fixtureId: artifact.fixtureId,
                relativePath: options.relativeTo === undefined
                    ? absolutePath
                    : path.relative(options.relativeTo, absolutePath).split(path.sep).join('/'),
                ...identity,
                written: options.write,
            });
            continue;
        }
        if (artifact.build === undefined) {
            throw new Error(`Fixture ${artifact.fixtureId} has neither a byte builder nor a file writer.`);
        }
        const bytes = await artifact.build();
        if (options.write) await writeFile(absolutePath, bytes);
        entries.push({
            fixtureId: artifact.fixtureId,
            relativePath: options.relativeTo === undefined
                ? absolutePath
                : path.relative(options.relativeTo, absolutePath).split(path.sep).join('/'),
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            written: options.write,
        });
    }
    return {
        outputDirectory: options.outputDirectory,
        entries,
        written: options.write,
    };
}

export interface IWindowsFixtureCliOptions {
    argv: readonly string[];
    cwd: string;
    log: (message: string) => void;
}

export function parseWindowsFixtureCliArgs(argv: readonly string[], cwd: string) {
    const outputArgument = argv.find(argument => argument.startsWith('--out='));
    return {
        write: argv.includes('--write'),
        outputDirectory: outputArgument === undefined
            ? path.join(cwd, WINDOWS_FIXTURE_GENERATED_DIRECTORY)
            : path.resolve(cwd, outputArgument.slice('--out='.length)),
    };
}

export async function runWindowsFixturesCli(options: IWindowsFixtureCliOptions) {
    const parsed = parseWindowsFixtureCliArgs(options.argv, options.cwd);
    const result = await runWindowsFixtureGeneration({
        outputDirectory: parsed.outputDirectory,
        write: parsed.write,
        relativeTo: options.cwd,
    });
    options.log(JSON.stringify({
        written: result.written,
        outputDirectory: result.outputDirectory,
        entries: result.entries,
    }, null, 4));
    return result;
}

void isDirectCliInvocation(import.meta.url).then(isDirect => {
    if (!isDirect) return;
    return runWindowsFixturesCli({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        log: message => process.stdout.write(`${message}\n`),
    });
}).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
