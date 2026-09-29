#!/usr/bin/env node
import { getCliErrorMessage } from '../lib/cli-error.mjs';
import {
    copyFileSync,
    existsSync,
    readdirSync,
    readFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** @typedef {'ia32' | 'x64' | 'arm64'} TWindowsMachine */
/** @typedef {{virtualSize: number, virtualAddress: number, sizeOfRawData: number, pointerToRawData: number}} IWindowsPeSection */
/** @typedef {{machine: string, machineCode: number, imports: string[], linkerVersion: number, fileVersion: number | null}} IWindowsPeInfo */
/** @typedef {{allowedMachines: string[], files: string[], systemDllPattern: RegExp}} IVerifyWindowsPeDependenciesOptions */
/** @typedef {{allowedMachines: string[], fileListPath: string, systemDllPatternFile: string}} IVerifyCliOptions */

// The Visual C++ runtime is not part of Windows. Machines that have it carry
// whatever version some other program installed, and a runtime older than the
// toolset that built a tool can crash it: MSVC 14.40 changed std::mutex, so
// 14.40+ builds fault with STATUS_ACCESS_VIOLATION on an older msvcp140.dll.
// Each tool directory therefore carries its own runtime.
export const MSVC_RUNTIME_DLL_PATTERN = /^(?:msvcp140(?:_[a-z0-9_]+)?|vcruntime140(?:_[a-z0-9]+)?|concrt140)\.dll$/iu;

const MACHINE_NAMES = new Map([
    [
        0x014c,
        'ia32',
    ],
    [
        0x8664,
        'x64',
    ],
    [
        0xaa64,
        'arm64',
    ],
]);

/** @param {string} filePath @param {string} [platform] @returns {string} */
export function normalizeWindowsHostPath(filePath, platform = process.platform) {
    if (platform !== 'win32') {
        return filePath;
    }

    const msysDrivePath = /^\/([a-z])(?:\/(.*))?$/iu.exec(filePath);
    if (!msysDrivePath) {
        return filePath;
    }

    const [
        ,
        drive,
        remainder = '',
    ] = msysDrivePath;
    if (!drive) {
        return filePath;
    }
    return `${drive.toUpperCase()}:/${remainder}`;
}

/** @param {string} message @returns {never} */
function fail(message) {
    throw new Error(message);
}

/** @param {Buffer} buffer @param {number} offset @param {number} length @param {string} label */
function ensureRange(buffer, offset, length, label) {
    if (offset < 0 || length < 0 || offset + length > buffer.length) {
        fail(`${label} is outside the file bounds`);
    }
}

/** @param {Buffer} buffer @param {number} offset @param {string} label @returns {number} */
function readUInt16(buffer, offset, label) {
    ensureRange(buffer, offset, 2, label);
    return buffer.readUInt16LE(offset);
}

/** @param {Buffer} buffer @param {number} offset @param {string} label @returns {number} */
function readUInt32(buffer, offset, label) {
    ensureRange(buffer, offset, 4, label);
    return buffer.readUInt32LE(offset);
}

/** @param {Buffer} buffer @param {number} offset @param {string} label @returns {string} */
function readCString(buffer, offset, label) {
    ensureRange(buffer, offset, 1, label);
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0) {
        end += 1;
    }
    if (end >= buffer.length) {
        fail(`${label} is not null-terminated`);
    }

    return buffer.toString('ascii', offset, end);
}

/** @param {number} rva @param {IWindowsPeSection[]} sections @param {number} sizeOfHeaders @returns {number} */
function rvaToOffset(rva, sections, sizeOfHeaders) {
    if (rva < sizeOfHeaders) {
        return rva;
    }

    for (const section of sections) {
        const mappedSize = Math.max(section.virtualSize, section.sizeOfRawData);
        if (rva >= section.virtualAddress && rva < section.virtualAddress + mappedSize) {
            return section.pointerToRawData + (rva - section.virtualAddress);
        }
    }

    fail(`Unable to map PE RVA 0x${rva.toString(16)} to a file offset`);
}

/** @param {string} filePath @returns {IWindowsPeInfo} */
export function readWindowsPeInfo(filePath) {
    const buffer = readFileSync(normalizeWindowsHostPath(filePath));

    if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
        fail('Missing DOS MZ header');
    }

    const peOffset = readUInt32(buffer, 0x3c, 'PE header pointer');
    ensureRange(buffer, peOffset, 24, 'PE header');
    if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
        fail('Missing PE signature');
    }

    const coffOffset = peOffset + 4;
    const machineCode = readUInt16(buffer, coffOffset, 'COFF machine');
    const numberOfSections = readUInt16(buffer, coffOffset + 2, 'COFF section count');
    const sizeOfOptionalHeader = readUInt16(buffer, coffOffset + 16, 'COFF optional header size');
    const optionalHeaderOffset = coffOffset + 20;
    ensureRange(buffer, optionalHeaderOffset, sizeOfOptionalHeader, 'optional header');

    const optionalMagic = readUInt16(buffer, optionalHeaderOffset, 'optional header magic');
    ensureRange(buffer, optionalHeaderOffset + 2, 2, 'linker version');
    const linkerVersion = buffer.readUInt8(optionalHeaderOffset + 2) * 100 + buffer.readUInt8(optionalHeaderOffset + 3);
    const dataDirectoryOffset = optionalMagic === 0x10b
        ? optionalHeaderOffset + 96
        : optionalMagic === 0x20b
            ? optionalHeaderOffset + 112
            : fail(`Unsupported PE optional header magic 0x${optionalMagic.toString(16)}`);
    const numberOfRvaAndSizesOffset = dataDirectoryOffset - 4;
    const numberOfRvaAndSizes = readUInt32(buffer, numberOfRvaAndSizesOffset, 'data directory count');
    const sizeOfHeaders = readUInt32(buffer, optionalHeaderOffset + 60, 'PE headers size');

    const sectionHeaderOffset = optionalHeaderOffset + sizeOfOptionalHeader;
    const sections = [];
    for (let sectionIndex = 0; sectionIndex < numberOfSections; sectionIndex += 1) {
        const offset = sectionHeaderOffset + sectionIndex * 40;
        ensureRange(buffer, offset, 40, `section header ${sectionIndex}`);
        sections.push({
            virtualSize: readUInt32(buffer, offset + 8, `section ${sectionIndex} virtual size`),
            virtualAddress: readUInt32(buffer, offset + 12, `section ${sectionIndex} virtual address`),
            sizeOfRawData: readUInt32(buffer, offset + 16, `section ${sectionIndex} raw size`),
            pointerToRawData: readUInt32(buffer, offset + 20, `section ${sectionIndex} raw pointer`),
        });
    }

    const imports = [];
    if (numberOfRvaAndSizes > 1) {
        const importDirectoryEntryOffset = dataDirectoryOffset + 8;
        const importDirectoryRva = readUInt32(buffer, importDirectoryEntryOffset, 'import directory RVA');
        const importDirectorySize = readUInt32(buffer, importDirectoryEntryOffset + 4, 'import directory size');

        if (importDirectoryRva !== 0) {
            const importDirectoryOffset = rvaToOffset(importDirectoryRva, sections, sizeOfHeaders);
            const maxDescriptors = importDirectorySize > 0 ? Math.ceil(importDirectorySize / 20) : 4096;
            for (let descriptorIndex = 0; descriptorIndex < maxDescriptors; descriptorIndex += 1) {
                const descriptorOffset = importDirectoryOffset + descriptorIndex * 20;
                const originalFirstThunk = readUInt32(buffer, descriptorOffset, `import descriptor ${descriptorIndex} original thunk`);
                const nameRva = readUInt32(buffer, descriptorOffset + 12, `import descriptor ${descriptorIndex} name RVA`);
                const firstThunk = readUInt32(buffer, descriptorOffset + 16, `import descriptor ${descriptorIndex} first thunk`);

                if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) {
                    break;
                }
                if (nameRva === 0) {
                    fail(`Import descriptor ${descriptorIndex} has no DLL name RVA`);
                }

                imports.push(readCString(buffer, rvaToOffset(nameRva, sections, sizeOfHeaders), `import descriptor ${descriptorIndex} DLL name`));
            }
        }
    }

    return {
        machine: MACHINE_NAMES.get(machineCode) ?? `unknown-0x${machineCode.toString(16)}`,
        machineCode,
        imports,
        linkerVersion,
        fileVersion: readFixedFileVersion(buffer),
    };
}

// VS_FIXEDFILEINFO starts with this signature; dwFileVersionMS follows two
// DWORDs later with the major version in its high word.
const FIXED_FILE_INFO_SIGNATURE = Buffer.from([
    0xbd,
    0x04,
    0xef,
    0xfe,
]);

/** @param {Buffer} buffer @returns {number | null} major * 100 + minor */
function readFixedFileVersion(buffer) {
    const offset = buffer.lastIndexOf(FIXED_FILE_INFO_SIGNATURE);
    if (offset < 0 || offset + 12 > buffer.length) {
        return null;
    }
    const fileVersionMs = buffer.readUInt32LE(offset + 8);
    return (fileVersionMs >>> 16) * 100 + (fileVersionMs & 0xffff);
}

/**
 * A Visual C++ runtime must be at least as new as the toolset that built its
 * importer. Its file version says which release it is; its own linker version
 * can trail that release.
 * @param {IWindowsPeInfo} info
 */
function runtimeVersion(info) {
    return info.fileVersion ?? info.linkerVersion;
}

/** @param {number} version major * 100 + minor @returns {string} */
function formatVersion(version) {
    return `${Math.floor(version / 100)}.${version % 100}`;
}

/** @param {string} patternFilePath @returns {RegExp} */
function readSystemDllPattern(patternFilePath) {
    const source = readFileSync(patternFilePath, 'utf8');
    const match = /^system_dll_pattern='([^']+)'/mu.exec(source);
    const pattern = match?.[1];
    if (!pattern) {
        fail(`Unable to read system_dll_pattern from ${patternFilePath}`);
    }

    return new RegExp(pattern, 'iu');
}

/** @param {IVerifyWindowsPeDependenciesOptions} options @returns {string[]} */
export function verifyWindowsPeDependencies({
    allowedMachines,
    files,
    systemDllPattern,
}) {
    files = files.map(file => normalizeWindowsHostPath(file));
    const allowedMachineSet = new Set(allowedMachines);
    const bundledDllsByDirectory = new Map();
    for (const file of files.filter(file => /\.dll$/iu.test(file))) {
        const directory = path.resolve(path.dirname(file));
        const names = bundledDllsByDirectory.get(directory) ?? new Set();
        names.add(path.basename(file).toLowerCase());
        bundledDllsByDirectory.set(directory, names);
    }
    const errors = [];

    if (files.length === 0) {
        return ['Error: No Windows PE files were found for dependency verification'];
    }

    /** @type {Map<string, IWindowsPeInfo>} */
    const infoByPath = new Map();
    for (const file of files) {
        try {
            infoByPath.set(path.resolve(file).toLowerCase(), readWindowsPeInfo(file));
        } catch (error) {
            errors.push(`Error: Unable to read Windows PE headers for ${file}\n  ${getCliErrorMessage(error)}`);
        }
    }

    for (const file of files) {
        const info = infoByPath.get(path.resolve(file).toLowerCase());
        if (!info) {
            continue;
        }

        if (!allowedMachineSet.has(info.machine)) {
            errors.push(`Error: Architecture mismatch for ${file}: expected one of ${allowedMachines.join(', ')}, got ${info.machine}`);
        }

        for (const dependency of info.imports) {
            const dependencyName = dependency.toLowerCase();
            const localBundledDlls = bundledDllsByDirectory.get(path.resolve(path.dirname(file))) ?? new Set();
            if (MSVC_RUNTIME_DLL_PATTERN.test(dependencyName) && localBundledDlls.has(dependencyName)) {
                const runtime = infoByPath.get(path.resolve(path.dirname(file), dependencyName).toLowerCase());
                if (runtime && runtime.machine !== info.machine) {
                    errors.push(`Error: Bundled ${dependencyName} is ${runtime.machine} but ${file} is ${info.machine}`);
                } else if (runtime && runtimeVersion(runtime) < info.linkerVersion) {
                    errors.push(`Error: Bundled ${dependency} ${formatVersion(runtimeVersion(runtime))} is older than the MSVC ${formatVersion(info.linkerVersion)} toolset that built ${file}`);
                }
                continue;
            }
            if (!MSVC_RUNTIME_DLL_PATTERN.test(dependencyName) && systemDllPattern.test(dependencyName)) {
                continue;
            }
            if (!localBundledDlls.has(dependencyName) && !localBundledDlls.has(`lib${dependencyName}`)) {
                errors.push(`Error: Missing bundled DLL dependency "${dependency}" for ${file}`);
                continue;
            }
            const bundledName = localBundledDlls.has(dependencyName) ? dependencyName : `lib${dependencyName}`;
            const bundled = infoByPath.get(path.resolve(path.dirname(file), bundledName).toLowerCase());
            if (bundled && bundled.machine !== info.machine) {
                errors.push(`Error: Bundled ${bundledName} is ${bundled.machine} but ${file} is ${info.machine}`);
            }
        }
    }

    return errors;
}

/**
 * Copies the Visual C++ runtime DLLs each directory's PE files import, with
 * the runtime's own runtime imports, into that directory. The runtime comes
 * from the source directory for the importers' architecture, such as System32
 * for x64 and SysWOW64 for ia32 on an x64 host. A runtime DLL the directory
 * already carries is kept unless an importer was built by a newer toolset.
 * @param {{directories: string[], sourceDirectories: Partial<Record<TWindowsMachine, string>>}} options
 * @returns {string[]} the copied files
 */
export function bundleWindowsMsvcRuntime({
    directories,
    sourceDirectories,
}) {
    const copied = [];
    for (const directory of directories.map(entry => normalizeWindowsHostPath(entry))) {
        /** @type {Map<string, IWindowsPeInfo>} */
        const localPeInfo = new Map();
        for (const name of readdirSync(directory)) {
            if (/\.(?:exe|dll)$/iu.test(name)) {
                localPeInfo.set(name.toLowerCase(), readWindowsPeInfo(path.join(directory, name)));
            }
        }
        // A directory holds one copy of each runtime DLL, so all its runtime
        // importers must share one architecture.
        const importerMachines = new Set([...localPeInfo.values()]
            .filter(info => info.imports.some(dependency => MSVC_RUNTIME_DLL_PATTERN.test(dependency)))
            .map(info => info.machine));
        if (importerMachines.size === 0) {
            continue;
        }
        if (importerMachines.size > 1) {
            fail(`${directory} mixes Visual C++ runtime importers of ${[...importerMachines].join(' and ')}`);
        }
        const [machine] = importerMachines;
        const sourceDirectory = sourceDirectories[/** @type {TWindowsMachine} */ (machine)];
        if (sourceDirectory === undefined) {
            fail(`${directory} needs a ${machine} Visual C++ runtime, which this host does not provide`);
        }

        /** @type {Map<string, {requiredVersion: number, importer: string}>} */
        const required = new Map();
        /** @param {IWindowsPeInfo} info @param {string} importer */
        const requireRuntimeImports = (info, importer) => {
            for (const dependency of info.imports) {
                const name = dependency.toLowerCase();
                if (!MSVC_RUNTIME_DLL_PATTERN.test(name)) {
                    continue;
                }
                const local = localPeInfo.get(name);
                if (local && local.machine === machine && runtimeVersion(local) >= info.linkerVersion) {
                    continue;
                }
                const current = required.get(name);
                if (!current || current.requiredVersion < info.linkerVersion) {
                    required.set(name, {
                        requiredVersion: info.linkerVersion,
                        importer,
                    });
                }
            }
        };
        for (const [
            name,
            info,
        ] of localPeInfo) {
            requireRuntimeImports(info, path.join(directory, name));
        }

        /** @type {Map<string, IWindowsPeInfo>} */
        const sources = new Map();
        for (let pending = [...required.keys()]; pending.length > 0; pending = [...required.keys()].filter(name => !sources.has(name))) {
            for (const name of pending) {
                const sourcePath = path.join(sourceDirectory, name);
                if (!existsSync(sourcePath)) {
                    fail(`The Visual C++ runtime DLL ${name} needed by ${required.get(name)?.importer} is missing from ${sourceDirectory}`);
                }
                const info = readWindowsPeInfo(sourcePath);
                if (info.machine !== machine) {
                    fail(`${sourcePath} is ${info.machine}; ${directory} needs ${machine}`);
                }
                sources.set(name, info);
                requireRuntimeImports(info, sourcePath);
            }
        }

        for (const [
            name,
            requirement,
        ] of required) {
            const source = sources.get(name);
            if (!source) {
                continue;
            }
            if (runtimeVersion(source) < requirement.requiredVersion) {
                fail(`${path.join(sourceDirectory, name)} ${formatVersion(runtimeVersion(source))} is older than the MSVC ${formatVersion(requirement.requiredVersion)} toolset that built ${requirement.importer}`);
            }
            const destination = path.join(directory, name);
            copyFileSync(path.join(sourceDirectory, name), destination);
            copied.push(destination);
        }
    }
    return copied;
}

function usage() {
    return [
        'Usage:',
        '  node scripts/release/windows-pe-dependencies.mjs info <file>',
        '  node scripts/release/windows-pe-dependencies.mjs imports <file>',
        '  node scripts/release/windows-pe-dependencies.mjs verify --allowed-machines <ia32,x64|arm64> --system-dll-pattern-file <path> --file-list <path>',
    ].join('\n');
}

/** @param {string} fileListPath @returns {string[]} */
function readFileList(fileListPath) {
    return readFileSync(fileListPath, 'utf8')
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean);
}

/** @param {string[]} args @returns {IVerifyCliOptions} */
function parseVerifyArgs(args) {
    /** @type {IVerifyCliOptions} */
    const options = {
        allowedMachines: [],
        fileListPath: '',
        systemDllPatternFile: '',
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const value = args[index + 1];
        if (arg === '--allowed-machines' && value) {
            options.allowedMachines = value.split(',')
                .map(machine => machine.trim())
                .filter(Boolean);
            index += 1;
        } else if (arg === '--system-dll-pattern-file' && value) {
            options.systemDllPatternFile = value;
            index += 1;
        } else if (arg === '--file-list' && value) {
            options.fileListPath = value;
            index += 1;
        } else {
            fail(`Unknown or incomplete option: ${arg}`);
        }
    }

    if (options.allowedMachines.length === 0 || !options.systemDllPatternFile || !options.fileListPath) {
        fail('Missing required verify options');
    }

    return options;
}

function runCli() {
    const [
        command,
        ...args
    ] = process.argv.slice(2);

    if (command === 'info' || command === 'imports') {
        const filePath = args[0];
        if (!filePath) {
            fail(usage());
        }

        const info = readWindowsPeInfo(filePath);
        if (command === 'imports') {
            process.stdout.write(`${info.imports.join('\n')}${info.imports.length > 0 ? '\n' : ''}`);
        } else {
            process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
        }
        return;
    }

    if (command === 'verify') {
        const options = parseVerifyArgs(args);
        const errors = verifyWindowsPeDependencies({
            allowedMachines: options.allowedMachines,
            files: readFileList(options.fileListPath),
            systemDllPattern: readSystemDllPattern(options.systemDllPatternFile),
        });
        if (errors.length > 0) {
            process.stderr.write(`${errors.join('\n')}\n`);
            process.exitCode = 1;
        }
        return;
    }

    fail(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        runCli();
    } catch (error) {
        process.stderr.write(`${getCliErrorMessage(error)}\n`);
        process.exitCode = 1;
    }
}
