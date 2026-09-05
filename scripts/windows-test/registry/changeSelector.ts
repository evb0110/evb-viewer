import path from 'node:path';
import type { TWindowsTestSuite } from '@scripts/windows-test/contracts/windowsTestContracts';

export const windowsTestFamilies = {
    printing: 'Printing',
    saving: 'Saving, editing, identity and recovery',
    paths: 'Filesystem and paths',
    lifecycle: 'Installation, shell and application lifecycle',
    pdfNativeTools: 'PDF, native tools and conversion',
    inputDisplay: 'Input, display and accessibility',
    resources: 'Resources, security and network behavior',
} as const;

export type TWindowsTestFamily = typeof windowsTestFamilies[keyof typeof windowsTestFamilies];

export interface IWindowsTestChangeArea {
    id: string;
    reason: string;
    suites: TWindowsTestSuite[];
    families: TWindowsTestFamily[];
    paths: string[];
}

export interface IWindowsTestSuiteSelection {
    suites: TWindowsTestSuite[];
    families: TWindowsTestFamily[];
    areas: string[];
}

const suiteOrder: TWindowsTestSuite[] = [
    'smoke',
    'critical',
    'all',
];

const familyOrder: TWindowsTestFamily[] = [
    windowsTestFamilies.printing,
    windowsTestFamilies.saving,
    windowsTestFamilies.paths,
    windowsTestFamilies.lifecycle,
    windowsTestFamilies.pdfNativeTools,
    windowsTestFamilies.inputDisplay,
    windowsTestFamilies.resources,
];

export const windowsTestChangeAreas: readonly IWindowsTestChangeArea[] = [
    {
        id: 'electron-runtime',
        reason: 'Electron main, preload, window and protocol wiring changed.',
        suites: ['critical'],
        families: [
            windowsTestFamilies.lifecycle,
            windowsTestFamilies.inputDisplay,
            windowsTestFamilies.resources,
        ],
        paths: [
            'electron/main.ts',
            'electron/preload.ts',
            'electron/preload/**',
            'electron/bootstrap/**',
            'electron/window/**',
            'electron/hostEnvironment.ts',
            'electron/menu.ts',
            'package.json',
        ],
    },
    {
        id: 'print-and-csp',
        reason: 'Print handoff, renderer security policy or the print surface changed.',
        suites: ['critical'],
        families: [
            windowsTestFamilies.printing,
            windowsTestFamilies.resources,
        ],
        paths: [
            'electron/features/documents/main/print.ts',
            'electron/utils/printHandoff.ts',
            'electron/window/createWindowSecurity.ts',
            'electron/security/**',
            'electron/protocol.ts',
            'app/modules/pdf-viewer/components/PdfPrintDialog.vue',
            'app/modules/pdf-viewer/public/component-exports/pdfPrintDialog.ts',
        ],
    },
    {
        id: 'revision-and-save',
        reason: 'Document revision, save pipeline or page operations changed.',
        suites: ['critical'],
        families: [
            windowsTestFamilies.saving,
            windowsTestFamilies.pdfNativeTools,
        ],
        paths: [
            'electron/features/documents/main/**',
            'electron/file-access/**',
            'packages/pdf-core/**',
            'native/pdf-page-ops/**',
            'app/modules/pdf-viewer/runtime/save/**',
        ],
    },
    {
        id: 'native-tools',
        reason: 'Bundled Windows executables, workers or their packaging changed.',
        suites: ['critical'],
        families: [
            windowsTestFamilies.pdfNativeTools,
            windowsTestFamilies.resources,
        ],
        paths: [
            'electron/native-tools/**',
            'electron/ocr/**',
            'electron/djvu/**',
            'electron/search/**',
            'native/**',
            'resources/**',
            'scripts/bundle-tools-windows.sh',
        ],
    },
    {
        id: 'installer-and-updater',
        reason: 'Installer, electron-builder, updater or Store packaging configuration changed.',
        suites: ['critical'],
        families: [windowsTestFamilies.lifecycle],
        paths: [
            'electron-builder.yml',
            'build/**',
            'scripts/release/**',
            'electron/updates.ts',
            'electron/updates/**',
            'electron/promptSetDefaultViewer.ts',
            '.github/workflows/build-target.yml',
            '.github/workflows/store-appx.yml',
        ],
    },
    {
        id: 'windows-path-and-process',
        reason: 'Windows path identity, containment or process handling changed.',
        suites: ['critical'],
        families: [
            windowsTestFamilies.paths,
            windowsTestFamilies.saving,
        ],
        paths: [
            'electron/file-access/**',
            'electron/utils/atomicReplace.ts',
            'electron/utils/processTree.ts',
            'electron/bootstrap/externalOpen.ts',
            'electron/recentFiles.ts',
        ],
    },
    {
        id: 'desktop-input',
        reason: 'Desktop shell, toolbar or viewer input surfaces changed.',
        suites: ['critical'],
        families: [windowsTestFamilies.inputDisplay],
        paths: [
            'app/modules/workspace-shell/**',
            'app/modules/pdf-viewer/components/**',
            'electron/menu.ts',
        ],
    },
    {
        id: 'windows-lane',
        reason: 'The Windows lane itself changed, so the full catalogue is in scope.',
        suites: [
            'critical',
            'all',
        ],
        families: familyOrder,
        paths: [
            'scripts/windows-test/**',
            'tests/windows/**',
        ],
    },
];

function normalizePath(filePath: string) {
    return filePath.split(path.sep).join('/').replace(/^\.\//u, '');
}

export function matchesChangedAreaPattern(filePath: string, pattern: string) {
    const normalizedPath = normalizePath(filePath);
    const normalizedPattern = normalizePath(pattern);
    let expression = '^';
    for (let index = 0; index < normalizedPattern.length; index += 1) {
        const character = normalizedPattern[index] ?? '';
        if (character === '*' && normalizedPattern[index + 1] === '*') {
            expression += '.*';
            index += 1;
            continue;
        }
        if (character === '*') {
            expression += '[^/]*';
            continue;
        }
        expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
    return new RegExp(`${expression}$`, 'u').test(normalizedPath);
}

export function matchWindowsTestChangeAreas(files: readonly string[]) {
    const normalizedFiles = files.map(normalizePath).filter(file => file.length > 0);
    return windowsTestChangeAreas.filter(area => normalizedFiles.some(
        file => area.paths.some(pattern => matchesChangedAreaPattern(file, pattern)),
    ));
}

/**
 * The smoke suite is unconditional: an incomplete path map must never be able
 * to remove every Windows case from a change that touches the product.
 */
export function selectSuitesForChangedFiles(files: readonly string[] | null): IWindowsTestSuiteSelection {
    if (files === null) {
        return {
            suites: [...suiteOrder],
            families: [...familyOrder],
            areas: windowsTestChangeAreas.map(area => area.id),
        };
    }
    const matched = matchWindowsTestChangeAreas(files);
    const suites = new Set<TWindowsTestSuite>(['smoke']);
    const families = new Set<TWindowsTestFamily>();
    for (const area of matched) {
        for (const suite of area.suites) {
            suites.add(suite);
        }
        for (const family of area.families) {
            families.add(family);
        }
    }
    return {
        suites: suiteOrder.filter(suite => suites.has(suite)),
        families: familyOrder.filter(family => families.has(family)),
        areas: matched.map(area => area.id),
    };
}
