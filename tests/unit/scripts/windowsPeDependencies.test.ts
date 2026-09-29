import {
    copyFileSync,
    mkdtempSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IWindowsPeDependenciesModule {
    bundleWindowsMsvcRuntime: (options: {
        directories: string[];
        sourceDirectories: Partial<Record<keyof typeof machineCodes, string>>;
    }) => string[];
    normalizeWindowsHostPath: (filePath: string, platform?: NodeJS.Platform) => string;
    readWindowsPeInfo: (filePath: string) => {
        fileVersion: number | null;
        imports: string[];
        linkerVersion: number;
        machine: string;
        machineCode: number;
    };
    verifyWindowsPeDependencies: (options: {
        allowedMachines: string[];
        files: string[];
        systemDllPattern: RegExp;
    }) => string[];
}

const {
    bundleWindowsMsvcRuntime,
    normalizeWindowsHostPath,
    readWindowsPeInfo,
    verifyWindowsPeDependencies,
} = await import(pathToFileURL(join(process.cwd(), 'scripts/release/windows-pe-dependencies.mjs')).href) as IWindowsPeDependenciesModule;

const machineCodes = {
    arm64: 0xaa64,
    ia32: 0x014c,
    x64: 0x8664,
};

function createPeFixture(
    machine: keyof typeof machineCodes,
    imports: string[],
    /** major * 100 + minor, as the module reports it */
    linkerVersion = 1444,
    fileVersion?: number,
) {
    const buffer = Buffer.alloc(4096);
    const peOffset = 0x80;
    const optionalHeaderOffset = peOffset + 24;
    const sectionHeaderOffset = optionalHeaderOffset + 0xf0;
    const sectionRawOffset = 0x200;
    const sectionVirtualAddress = 0x1000;
    const importDirectoryRva = imports.length > 0 ? sectionVirtualAddress : 0;
    const importDirectorySize = imports.length > 0 ? (imports.length + 1) * 20 : 0;

    buffer.write('MZ', 0, 'ascii');
    buffer.writeUInt32LE(peOffset, 0x3c);
    buffer.write('PE\u0000\u0000', peOffset, 'ascii');
    buffer.writeUInt16LE(machineCodes[machine], peOffset + 4);
    buffer.writeUInt16LE(1, peOffset + 6);
    buffer.writeUInt16LE(0xf0, peOffset + 20);

    buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
    buffer.writeUInt8(Math.floor(linkerVersion / 100), optionalHeaderOffset + 2);
    buffer.writeUInt8(linkerVersion % 100, optionalHeaderOffset + 3);
    buffer.writeUInt32LE(0x200, optionalHeaderOffset + 60);
    buffer.writeUInt32LE(16, optionalHeaderOffset + 108);
    buffer.writeUInt32LE(importDirectoryRva, optionalHeaderOffset + 120);
    buffer.writeUInt32LE(importDirectorySize, optionalHeaderOffset + 124);

    buffer.write('.rdata\u0000\u0000', sectionHeaderOffset, 'ascii');
    buffer.writeUInt32LE(0x1000, sectionHeaderOffset + 8);
    buffer.writeUInt32LE(sectionVirtualAddress, sectionHeaderOffset + 12);
    buffer.writeUInt32LE(0x1000, sectionHeaderOffset + 16);
    buffer.writeUInt32LE(sectionRawOffset, sectionHeaderOffset + 20);

    let nameOffset = sectionRawOffset + 0x100;
    for (const [
        index,
        importName,
    ] of imports.entries()) {
        const descriptorOffset = sectionRawOffset + index * 20;
        const nameRva = sectionVirtualAddress + (nameOffset - sectionRawOffset);
        buffer.writeUInt32LE(nameRva, descriptorOffset + 12);
        buffer.writeUInt32LE(0x2000 + index * 8, descriptorOffset + 16);
        buffer.write(`${importName}\u0000`, nameOffset, 'ascii');
        nameOffset += importName.length + 1;
    }

    if (fileVersion !== undefined) {
        const fixedFileInfoOffset = 0x800;
        buffer.writeUInt32LE(0xfeef04bd, fixedFileInfoOffset);
        buffer.writeUInt32LE((Math.floor(fileVersion / 100) << 16) | fileVersion % 100, fixedFileInfoOffset + 8);
    }

    const fixturePath = join(mkdtempSync(join(tmpdir(), 'evb-pe-fixture-')), `${machine}.dll`);
    writeFileSync(fixturePath, buffer);
    return fixturePath;
}

function createPeFile(
    filePath: string,
    machine: keyof typeof machineCodes,
    imports: string[],
    linkerVersion?: number,
    fileVersion?: number,
) {
    copyFileSync(createPeFixture(machine, imports, linkerVersion, fileVersion), filePath);
    return filePath;
}

describe('Windows PE dependency helpers', () => {
    it('normalizes MSYS drive paths before Windows Node filesystem access', () => {
        expect(normalizeWindowsHostPath('/d/a/evb-viewer/resources/qpdf.exe', 'win32'))
            .toBe('D:/a/evb-viewer/resources/qpdf.exe');
        expect(normalizeWindowsHostPath('D:\\a\\evb-viewer\\resources\\qpdf.exe', 'win32'))
            .toBe('D:\\a\\evb-viewer\\resources\\qpdf.exe');
        expect(normalizeWindowsHostPath('/d/a/evb-viewer/resources/qpdf.exe', 'darwin'))
            .toBe('/d/a/evb-viewer/resources/qpdf.exe');
    });

    it('reads ARM64 PE machine type and import DLL names without objdump', () => {
        const filePath = createPeFixture('arm64', [
            'KERNEL32.dll',
            'glib-2.0-0.dll',
        ]);

        expect(readWindowsPeInfo(filePath)).toMatchObject({
            machine: 'arm64',
            imports: [
                'KERNEL32.dll',
                'glib-2.0-0.dll',
            ],
        });
    });

    it('validates bundled dependencies, system DLLs, and lib-prefixed aliases', () => {
        const toolPath = createPeFixture('arm64', [
            'KERNEL32.dll',
            'glib-2.0-0.dll',
        ]);
        const bundledAliasPath = join(dirname(toolPath), 'libglib-2.0-0.dll');
        copyFileSync(createPeFixture('arm64', []), bundledAliasPath);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['arm64'],
            files: [
                toolPath,
                bundledAliasPath,
            ],
            systemDllPattern: /^(kernel32\.dll)$/iu,
        })).toEqual([]);
    });

    it('does not satisfy an import with a DLL bundled beside another tool', () => {
        const toolPath = createPeFixture('arm64', ['custom-runtime.dll']);
        const siblingToolDirectory = mkdtempSync(join(tmpdir(), 'evb-pe-other-tool-'));
        const misplacedDllPath = join(siblingToolDirectory, 'custom-runtime.dll');
        copyFileSync(createPeFixture('arm64', []), misplacedDllPath);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['arm64'],
            files: [
                toolPath,
                misplacedDllPath,
            ],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([expect.stringContaining('Missing bundled DLL dependency "custom-runtime.dll"')]);
    });

    it('allows mixed ia32 and x64 PE files in Windows x64 packages', () => {
        expect(verifyWindowsPeDependencies({
            allowedMachines: [
                'ia32',
                'x64',
            ],
            files: [
                createPeFixture('ia32', []),
                createPeFixture('x64', []),
            ],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([]);
    });

    it('rejects orphan MSYS2 training DLLs with unbundled runtime dependencies', () => {
        const trainingDllPath = createPeFixture('arm64', [
            'libpango-1.0-0.dll',
            'libpangocairo-1.0-0.dll',
        ]);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['arm64'],
            files: [trainingDllPath],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([
            expect.stringContaining('Missing bundled DLL dependency "libpango-1.0-0.dll"'),
            expect.stringContaining('Missing bundled DLL dependency "libpangocairo-1.0-0.dll"'),
        ]);
    });

    it('reports missing bundled DLLs and architecture mismatches', () => {
        const toolPath = createPeFixture('x64', ['custom-runtime.dll']);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['arm64'],
            files: [toolPath],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([
            expect.stringContaining('expected one of arm64, got x64'),
            expect.stringContaining('Missing bundled DLL dependency "custom-runtime.dll"'),
        ]);
    });

    it('requires the Visual C++ runtime beside each tool even when the host pattern lists it', () => {
        const toolPath = createPeFixture('x64', [
            'KERNEL32.dll',
            'MSVCP140.dll',
        ]);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['x64'],
            files: [toolPath],
            systemDllPattern: /^(kernel32\.dll|msvcp140\.dll)$/iu,
        })).toEqual([expect.stringContaining('Missing bundled DLL dependency "MSVCP140.dll"')]);
    });

    it('rejects a bundled Visual C++ runtime older than the toolset that built the tool', () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-pe-runtime-'));
        const toolPath = createPeFile(join(directory, 'tool.exe'), 'x64', ['MSVCP140.dll'], 1451);
        const runtimePath = createPeFile(join(directory, 'msvcp140.dll'), 'x64', [], 1444);

        expect(verifyWindowsPeDependencies({
            allowedMachines: ['x64'],
            files: [
                toolPath,
                runtimePath,
            ],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([expect.stringContaining('Bundled MSVCP140.dll 14.44 is older than the MSVC 14.51 toolset')]);
    });

    it('bundles the imported Visual C++ runtime and its own runtime imports into each tool directory', () => {
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-pe-system32-'));
        // The 14.51 runtime release is itself linked by the 14.50 toolset.
        createPeFile(join(sourceDirectory, 'msvcp140.dll'), 'x64', [
            'KERNEL32.dll',
            'VCRUNTIME140.dll',
            'VCRUNTIME140_1.dll',
        ], 1450, 1451);
        createPeFile(join(sourceDirectory, 'vcruntime140.dll'), 'x64', ['KERNEL32.dll'], 1451);
        createPeFile(join(sourceDirectory, 'vcruntime140_1.dll'), 'x64', ['VCRUNTIME140.dll'], 1451);
        createPeFile(join(sourceDirectory, 'concrt140.dll'), 'x64', [], 1451);
        const popplerBin = mkdtempSync(join(tmpdir(), 'evb-pe-poppler-'));
        createPeFile(join(popplerBin, 'pdftotext.exe'), 'x64', [
            'KERNEL32.dll',
            'MSVCP140.dll',
        ], 1451);
        const qpdfBin = mkdtempSync(join(tmpdir(), 'evb-pe-qpdf-'));
        createPeFile(join(qpdfBin, 'qpdf.exe'), 'x64', ['VCRUNTIME140.dll'], 1444);
        createPeFile(join(qpdfBin, 'vcruntime140.dll'), 'x64', [], 1444);

        bundleWindowsMsvcRuntime({
            directories: [
                popplerBin,
                qpdfBin,
            ],
            sourceDirectories: {x64: sourceDirectory},
        });

        expect(readdirSync(popplerBin).sort()).toEqual([
            'msvcp140.dll',
            'pdftotext.exe',
            'vcruntime140.dll',
            'vcruntime140_1.dll',
        ]);
        expect(bundleWindowsMsvcRuntime({
            directories: [qpdfBin],
            sourceDirectories: {},
        })).toEqual([]);
        expect(readdirSync(qpdfBin).sort()).toEqual([
            'qpdf.exe',
            'vcruntime140.dll',
        ]);
        expect(verifyWindowsPeDependencies({
            allowedMachines: ['x64'],
            files: readdirSync(popplerBin).map(name => join(popplerBin, name)),
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([]);
    });

    it('replaces a bundled runtime older than the toolset that built a tool beside it', () => {
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-pe-system32-'));
        createPeFile(join(sourceDirectory, 'vcruntime140.dll'), 'x64', [], 1450, 1451);
        const toolBin = mkdtempSync(join(tmpdir(), 'evb-pe-mixed-'));
        createPeFile(join(toolBin, 'old-tool.exe'), 'x64', ['VCRUNTIME140.dll'], 1444);
        createPeFile(join(toolBin, 'new-tool.exe'), 'x64', ['VCRUNTIME140.dll'], 1451);
        createPeFile(join(toolBin, 'vcruntime140.dll'), 'x64', [], 1444, 1444);

        expect(bundleWindowsMsvcRuntime({
            directories: [toolBin],
            sourceDirectories: {x64: sourceDirectory},
        })).toEqual([join(toolBin, 'vcruntime140.dll')]);
        expect(readWindowsPeInfo(join(toolBin, 'vcruntime140.dll')).fileVersion).toBe(1451);
    });

    it('takes each directory\'s runtime from the source for its importers\' architecture', () => {
        const system32 = mkdtempSync(join(tmpdir(), 'evb-pe-system32-'));
        createPeFile(join(system32, 'vcruntime140.dll'), 'x64', [], 1451);
        const sysWow64 = mkdtempSync(join(tmpdir(), 'evb-pe-syswow64-'));
        createPeFile(join(sysWow64, 'vcruntime140.dll'), 'ia32', [], 1451);
        const djvuBin = mkdtempSync(join(tmpdir(), 'evb-pe-djvulibre-'));
        createPeFile(join(djvuBin, 'ddjvu.exe'), 'ia32', ['VCRUNTIME140.dll'], 1423);
        const mixedBin = mkdtempSync(join(tmpdir(), 'evb-pe-mixed-'));
        createPeFile(join(mixedBin, 'tool32.exe'), 'ia32', ['VCRUNTIME140.dll'], 1423);
        createPeFile(join(mixedBin, 'tool64.exe'), 'x64', ['VCRUNTIME140.dll'], 1444);
        const sourceDirectories = {
            x64: system32,
            ia32: sysWow64,
        };

        bundleWindowsMsvcRuntime({
            directories: [djvuBin],
            sourceDirectories,
        });
        expect(readWindowsPeInfo(join(djvuBin, 'vcruntime140.dll')).machine).toBe('ia32');
        expect(() => bundleWindowsMsvcRuntime({
            directories: [mixedBin],
            sourceDirectories,
        })).toThrow(/mixes Visual C\+\+ runtime importers of (ia32 and x64|x64 and ia32)/u);
    });

    it('rejects a bundled DLL of another architecture than its importer', () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-pe-arch-'));
        const toolPath = createPeFile(join(directory, 'ddjvu.exe'), 'ia32', ['VCRUNTIME140.dll'], 1423);
        const runtimePath = createPeFile(join(directory, 'vcruntime140.dll'), 'x64', [], 1451);

        expect(verifyWindowsPeDependencies({
            allowedMachines: [
                'ia32',
                'x64',
            ],
            files: [
                toolPath,
                runtimePath,
            ],
            systemDllPattern: /^kernel32\.dll$/iu,
        })).toEqual([expect.stringContaining('Bundled vcruntime140.dll is x64 but')]);
    });

    it('refuses to bundle a host runtime older than a tool\'s toolset or of another architecture', () => {
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-pe-system32-'));
        createPeFile(join(sourceDirectory, 'vcruntime140.dll'), 'x64', [], 1444);
        const toolBin = mkdtempSync(join(tmpdir(), 'evb-pe-tesseract-'));
        createPeFile(join(toolBin, 'tesseract.exe'), 'x64', ['VCRUNTIME140.dll'], 1451);

        expect(() => bundleWindowsMsvcRuntime({
            directories: [toolBin],
            sourceDirectories: {x64: sourceDirectory},
        })).toThrow(/vcruntime140\.dll 14\.44 is older than the MSVC 14\.51 toolset/u);
        const arm64ToolBin = mkdtempSync(join(tmpdir(), 'evb-pe-arm64-'));
        createPeFile(join(arm64ToolBin, 'tesseract.exe'), 'arm64', ['VCRUNTIME140.dll'], 1444);
        expect(() => bundleWindowsMsvcRuntime({
            directories: [arm64ToolBin],
            sourceDirectories: {arm64: sourceDirectory},
        })).toThrow(/vcruntime140\.dll is x64; .* needs arm64/u);
    });
});
