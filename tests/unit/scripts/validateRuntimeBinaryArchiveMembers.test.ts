import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    validateRuntimeBinaryArchiveMembers,
    type IRuntimeBinaryArchiveMemberPolicy,
} from '@scripts/validateRuntimeBinaryArchiveMembers';

const executableEntry = 'qpdf-12.3.2-msvc64/bin/qpdf.exe';
const requiredAdjacentDllEntries = [
    'qpdf-12.3.2-msvc64/bin/concrt140.dll',
    'qpdf-12.3.2-msvc64/bin/qpdf30.dll',
];
const policy: IRuntimeBinaryArchiveMemberPolicy = {
    executableEntry,
    requiredAdjacentDllEntries,
};

function members(...extra: string[]) {
    return [
        'qpdf-12.3.2-msvc64/bin/',
        executableEntry,
        ...requiredAdjacentDllEntries,
        ...extra,
    ];
}

describe('runtime binary archive member policy', () => {
    it('selects the exact executable and every adjacent DLL deterministically', () => {
        expect(validateRuntimeBinaryArchiveMembers(members(
            'qpdf-12.3.2-msvc64/bin/fix-qdf.exe',
            'qpdf-12.3.2-msvc64/bin/zlib-flate.exe',
            'qpdf-12.3.2-msvc64/include/qpdf/QPDF.hh',
        ), policy)).toEqual({
            adjacentDllEntries: requiredAdjacentDllEntries,
            executableEntry,
            executableEntries: [executableEntry],
            requiredDirectoryEntries: [],
        });
    });

    it('validates multiple executables, excluded DLLs, and required directories', () => {
        const primary = 'poppler-24.08.0/Library/bin/pdftoppm.exe';
        const secondary = 'poppler-24.08.0/Library/bin/pdfinfo.exe';
        const optionalDll = 'poppler-24.08.0/Library/bin/poppler-glib.dll';
        const requiredDll = 'poppler-24.08.0/Library/bin/poppler.dll';
        const dataDirectory = 'poppler-24.08.0/share/poppler/';
        const value = validateRuntimeBinaryArchiveMembers([
            primary,
            secondary,
            optionalDll,
            requiredDll,
            dataDirectory,
        ], {
            executableEntry: primary,
            requiredExecutableEntries: [secondary],
            requiredAdjacentDllEntries: [requiredDll],
            excludedAdjacentDllEntries: [optionalDll],
            requiredDirectoryEntries: [dataDirectory],
        });

        expect(value).toEqual({
            adjacentDllEntries: [requiredDll],
            executableEntry: primary,
            executableEntries: [
                primary,
                secondary,
            ],
            requiredDirectoryEntries: [dataDirectory],
        });
    });

    it.each([
        [
            'missing executable',
            members().filter(member => member !== executableEntry),
            'missing executable member',
        ],
        [
            'missing DLL',
            members().filter(member => member !== requiredAdjacentDllEntries[0]),
            'missing required DLL member',
        ],
        [
            'unsafe traversal',
            members('../outside.dll'),
            'not a safe relative path',
        ],
        [
            'absolute path',
            members('/tmp/evil.dll'),
            'not a safe relative path',
        ],
        [
            'duplicate member',
            members(requiredAdjacentDllEntries[0]!),
            'duplicate members',
        ],
    ])('rejects %s', (_label, archiveMembers, message) => {
        expect(() => validateRuntimeBinaryArchiveMembers(archiveMembers, policy)).toThrow(message);
    });

    it('rejects a DLL requirement outside the executable directory', () => {
        expect(() => validateRuntimeBinaryArchiveMembers(members(), {
            ...policy,
            requiredAdjacentDllEntries: ['other/qpdf30.dll'],
        })).toThrow('outside executable directory');
    });

    it('rejects duplicate required DLL requirements', () => {
        expect(() => validateRuntimeBinaryArchiveMembers(members(), {
            ...policy,
            requiredAdjacentDllEntries: [
                requiredAdjacentDllEntries[0]!,
                requiredAdjacentDllEntries[0]!,
            ],
        })).toThrow('DLL requirements contain duplicates');
    });

    it('rejects a secondary executable or data directory that is missing', () => {
        const primary = 'poppler-24.08.0/Library/bin/pdftoppm.exe';
        const secondary = 'poppler-24.08.0/Library/bin/pdfinfo.exe';
        const dataDirectory = 'poppler-24.08.0/share/poppler/';
        const value = {
            executableEntry: primary,
            requiredExecutableEntries: [secondary],
            requiredAdjacentDllEntries: [],
            requiredDirectoryEntries: [dataDirectory],
        } satisfies IRuntimeBinaryArchiveMemberPolicy;

        expect(() => validateRuntimeBinaryArchiveMembers([primary], value)).toThrow('missing executable member');
        expect(() => validateRuntimeBinaryArchiveMembers([
            primary,
            secondary,
        ], value)).toThrow('missing required directory member');
    });

    it('accepts archives that omit an explicit directory entry when files prove its presence', () => {
        const primary = 'poppler-24.08.0/Library/bin/pdftoppm.exe';
        const secondary = 'poppler-24.08.0/Library/bin/pdfinfo.exe';
        const dataDirectory = 'poppler-24.08.0/share/poppler/';

        expect(validateRuntimeBinaryArchiveMembers([
            primary,
            secondary,
            `${dataDirectory}cidToUnicode`,
        ], {
            executableEntry: primary,
            requiredExecutableEntries: [secondary],
            requiredAdjacentDllEntries: [],
            requiredDirectoryEntries: [dataDirectory],
        }).requiredDirectoryEntries).toEqual([dataDirectory]);
    });

    it('rejects executable and excluded DLL requirements outside the primary bin directory', () => {
        const primary = 'poppler-24.08.0/Library/bin/pdftoppm.exe';
        expect(() => validateRuntimeBinaryArchiveMembers([
            primary,
            'other/pdfinfo.exe',
        ], {
            executableEntry: primary,
            requiredExecutableEntries: ['other/pdfinfo.exe'],
            requiredAdjacentDllEntries: [],
        })).toThrow('executable requirement is outside');
        expect(() => validateRuntimeBinaryArchiveMembers([primary], {
            executableEntry: primary,
            requiredAdjacentDllEntries: [],
            excludedAdjacentDllEntries: ['other/poppler-glib.dll'],
        })).toThrow('excluded DLL is outside');
    });
});
