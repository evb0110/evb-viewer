#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
    delimiter,
    dirname,
    join,
} from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const userHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
const cargoBin = process.env.CARGO_HOME
    ? join(process.env.CARGO_HOME, 'bin')
    : userHome ? join(userHome, '.cargo', 'bin') : '';
const PATH = [
    cargoBin,
    process.env.PATH ?? '',
].filter(Boolean).join(delimiter);

function run(command, commandArgs = [], options = {}) {
    const result = spawnSync(command, commandArgs, {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH,
        },
        timeout: options.timeout ?? 20_000,
    });

    return {
        command: [
            command,
            ...commandArgs,
        ].join(' '),
        error: result.error ? result.error.message : null,
        ok: result.status === 0,
        status: result.status,
        stderr: (result.stderr ?? '').trim(),
        stdout: (result.stdout ?? '').trim(),
    };
}

function commandPath(command) {
    const result = process.platform === 'win32'
        ? run('where', [command], { timeout: 5_000 })
        : run('sh', [
            '-lc',
            `command -v ${command}`,
        ], { timeout: 5_000 });
    return result.ok ? (result.stdout.split('\n')[0] ?? '').trim() || null : null;
}

function nodeProbe(source) {
    return run(process.execPath, [
        '-e',
        source,
    ]);
}

function isDir(path) {
    return existsSync(path);
}

export function isNode24(version) {
    return /^v24\./.test(version);
}

export function resolveHostTag() {
    const platformMap = {
        darwin: 'darwin',
        linux: 'linux',
        win32: 'win32',
    };
    const archMap = {
        arm64: 'arm64',
        x64: 'x64',
    };
    const platform = platformMap[process.platform];
    const arch = archMap[process.arch];
    return platform && arch ? `${platform}-${arch}` : null;
}

function resolveDisplay() {
    const nativeDisplay = process.platform === 'linux'
        ? Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
        : process.platform === 'darwin' || process.platform === 'win32';
    const xvfbPath = commandPath('Xvfb');
    const xvfbRunPath = commandPath('xvfb-run');

    return {
        display: process.env.DISPLAY ?? '',
        headed: nativeDisplay,
        mode: nativeDisplay ? 'headed' : 'headless',
        virtualDisplayAvailable: Boolean(xvfbPath),
        waylandDisplay: process.env.WAYLAND_DISPLAY ?? '',
        wrapper: !nativeDisplay && xvfbPath ? 'pnpm run electron:run:headless -- <command>' : null,
        xdgSessionType: process.env.XDG_SESSION_TYPE ?? '',
        xvfbPath,
        xvfbRunPath,
    };
}

export function statusFromBoolean(ok, missingStatus = 'missing') {
    return ok ? 'ok' : missingStatus;
}

function main() {
    const args = new Set(process.argv.slice(2));
    const jsonOutput = args.has('--json');
    const strict = args.has('--strict');

    if (args.has('-h') || args.has('--help')) {
        process.stdout.write(`Usage: node scripts/check-dev-environment.mjs [--strict] [--json]

Checks the local EVB Viewer development environment and reports whether the
current host is headed or headless.

Options:
  --strict   Exit non-zero when required tooling is missing or misconfigured.
  --json     Print the machine-readable report.
`);
        process.exit(0);
    }

    const checks = [];

    function addCheck(check) {
        checks.push({
            detail: check.detail ?? '',
            name: check.name,
            remedy: check.remedy ?? '',
            required: check.required ?? false,
            status: check.status,
        });
    }

    const display = resolveDisplay();
    const hostTag = resolveHostTag();

    const nodeVersion = process.version;
    addCheck({
        detail: nodeVersion,
        name: 'Node.js 24',
        remedy: 'Install Node.js 24.x before running the app or build scripts.',
        required: true,
        status: isNode24(nodeVersion) ? 'ok' : 'fail',
    });

    const pnpmResult = run('pnpm', ['--version'], { timeout: 10_000 });
    addCheck({
        detail: pnpmResult.ok ? pnpmResult.stdout : pnpmResult.stderr || pnpmResult.error,
        name: 'pnpm',
        remedy: 'Enable Corepack or install pnpm 10.x.',
        required: true,
        status: pnpmResult.ok ? 'ok' : 'missing',
    });

    addCheck({
        detail: isDir(join(projectRoot, 'node_modules', '.pnpm')) ? 'node_modules/.pnpm' : '',
        name: 'Root workspace dependencies',
        remedy: 'Run node scripts/ci-install-dependencies.mjs --frozen-lockfile.',
        required: true,
        status: statusFromBoolean(isDir(join(projectRoot, 'node_modules', '.pnpm'))),
    });

    const electronResult = run(process.execPath, ['scripts/check-electron-install.mjs']);
    addCheck({
        detail: electronResult.ok ? electronResult.stdout.split('\n').at(-1) : electronResult.stderr || electronResult.error,
        name: 'Electron binary',
        remedy: 'Run node scripts/ci-install-dependencies.mjs --frozen-lockfile and allow the electron postinstall script.',
        required: true,
        status: electronResult.ok ? 'ok' : 'fail',
    });

    if (process.platform === 'linux' && !display.headed) {
        addCheck({
            detail: display.xvfbPath ?? '',
            name: 'Virtual X display for headless Linux',
            remedy: 'Install xvfb and use pnpm run electron:run:headless -- <command> for Electron sessions.',
            required: true,
            status: display.virtualDisplayAvailable ? 'ok' : 'missing',
        });
    }

    const playwrightResult = nodeProbe(`
const fs = require('node:fs');
const { chromium } = require('playwright');
const executablePath = chromium.executablePath();
if (!fs.existsSync(executablePath)) {
  console.error(executablePath);
  process.exit(1);
}
console.log(executablePath);
`);
    addCheck({
        detail: playwrightResult.ok ? playwrightResult.stdout : playwrightResult.stderr || playwrightResult.error,
        name: 'Playwright Chromium',
        remedy: 'Run pnpm exec playwright install chromium.',
        required: true,
        status: playwrightResult.ok ? 'ok' : 'missing',
    });

    const rustcResult = run('rustc', ['--version']);
    addCheck({
        detail: rustcResult.ok ? rustcResult.stdout : rustcResult.stderr || rustcResult.error,
        name: 'Rust compiler',
        remedy: 'Install rustup, then run rustup toolchain install 1.89.0 --profile minimal.',
        required: true,
        status: rustcResult.ok ? 'ok' : 'missing',
    });

    const wasmTargetResult = run('rustup', [
        'target',
        'list',
        '--installed',
    ]);
    const hasWasmTarget = wasmTargetResult.ok && wasmTargetResult.stdout.split('\n').includes('wasm32-unknown-unknown');
    addCheck({
        detail: wasmTargetResult.ok ? wasmTargetResult.stdout.split('\n').join(', ') : wasmTargetResult.stderr || wasmTargetResult.error,
        name: 'Rust wasm32 target',
        remedy: 'Run rustup target add wasm32-unknown-unknown.',
        required: true,
        status: hasWasmTarget ? 'ok' : 'missing',
    });

    if (hostTag) {
        const nativeResourcePaths = [
            [
                'tesseract',
                join(projectRoot, 'resources', 'tesseract', hostTag, 'bin', process.platform === 'win32' ? 'tesseract.exe' : 'tesseract'),
            ],
            [
                'unpaper',
                join(projectRoot, 'resources', 'tesseract', hostTag, 'bin', process.platform === 'win32' ? 'unpaper.exe' : 'unpaper'),
            ],
            [
                'pdfinfo',
                join(projectRoot, 'resources', 'poppler', hostTag, 'bin', process.platform === 'win32' ? 'pdfinfo.exe' : 'pdfinfo'),
            ],
            [
                'pdftoppm',
                join(projectRoot, 'resources', 'poppler', hostTag, 'bin', process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm'),
            ],
            [
                'pdftotext',
                join(projectRoot, 'resources', 'poppler', hostTag, 'bin', process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext'),
            ],
            [
                'qpdf',
                join(projectRoot, 'resources', 'qpdf', hostTag, 'bin', process.platform === 'win32' ? 'qpdf.exe' : 'qpdf'),
            ],
            [
                'ddjvu',
                join(projectRoot, 'resources', 'djvulibre', hostTag, 'bin', process.platform === 'win32' ? 'ddjvu.exe' : 'ddjvu'),
            ],
            [
                'djvused',
                join(projectRoot, 'resources', 'djvulibre', hostTag, 'bin', process.platform === 'win32' ? 'djvused.exe' : 'djvused'),
            ],
            [
                'djvudump',
                join(projectRoot, 'resources', 'djvulibre', hostTag, 'bin', process.platform === 'win32' ? 'djvudump.exe' : 'djvudump'),
            ],
        ];
        const missingNativeResources = nativeResourcePaths
            .filter(([
                , path,
            ]) => !existsSync(path))
            .map(([label]) => label);
        addCheck({
            detail: missingNativeResources.length === 0 ? hostTag : `${hostTag}: missing ${missingNativeResources.join(', ')}`,
            name: 'Bundled native document tools',
            remedy: process.platform === 'linux'
                ? 'Run bash scripts/bundle-tools-linux.sh.'
                : 'Run the platform bundling scripts documented in the release workflow.',
            required: true,
            status: missingNativeResources.length === 0 ? 'ok' : 'missing',
        });
    }

    if (process.platform === 'linux') {
        const missingSystemTools = [
            'tesseract',
            'pdfinfo',
            'pdftoppm',
            'pdftotext',
            'qpdf',
            'ddjvu',
            'djvused',
            'djvudump',
            'unpaper',
            'patchelf',
        ]
            .filter(command => !commandPath(command));
        addCheck({
            detail: missingSystemTools.length === 0 ? 'apt native tools available' : `missing ${missingSystemTools.join(', ')}`,
            name: 'Linux native-tool bundling prerequisites',
            remedy: 'Run bash scripts/setup-linux-dev-host.sh or install the packages listed in docs/contributing/headless-vps-setup.md.',
            required: true,
            status: missingSystemTools.length === 0 ? 'ok' : 'missing',
        });

        const fpmResult = run('fpm', ['--version'], { timeout: 10_000 });
        addCheck({
            detail: fpmResult.ok ? fpmResult.stdout : fpmResult.stderr || fpmResult.error,
            name: 'Linux packaging fpm',
            remedy: 'Install ruby-dev and run sudo gem install fpm --no-document.',
            required: true,
            status: fpmResult.ok ? 'ok' : 'missing',
        });
    }

    for (const command of [
        'codex',
        'claude',
    ]) {
        const path = commandPath(command);
        const version = path ? run(command, ['--version'], { timeout: 10_000 }) : null;
        addCheck({
            detail: version?.ok ? `${path} (${version.stdout || version.stderr})` : path ?? '',
            name: `${command} CLI`,
            remedy: `Install ${command} if this host should run agent sessions directly.`,
            required: false,
            status: path ? 'ok' : 'warn',
        });
    }

    const requiredFailures = checks.filter(check => check.required && check.status !== 'ok');
    const report = {
        checks,
        display,
        host: {
            arch: process.arch,
            platform: process.platform,
            tag: hostTag,
        },
        ok: requiredFailures.length === 0,
        strict,
    };

    if (jsonOutput) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        process.stdout.write('EVB Viewer dev environment preflight\n');
        process.stdout.write(`Host: ${process.platform} ${process.arch}${hostTag ? ` (${hostTag})` : ''}\n`);
        if (display.mode === 'headless') {
            process.stdout.write('Display: headless (DISPLAY and WAYLAND_DISPLAY are empty)\n');
            process.stdout.write(display.wrapper
                ? `Electron wrapper: ${display.wrapper}\n`
                : 'Electron/browser wrapper: unavailable until xvfb-run is installed\n');
        } else {
            const displayDetail = process.platform === 'linux'
                ? `DISPLAY=${display.display || '(empty)'} WAYLAND_DISPLAY=${display.waylandDisplay || '(empty)'}`
                : 'native desktop session expected';
            process.stdout.write(`Display: headed (${displayDetail})\n`);
        }
        process.stdout.write('\nChecks:\n');
        for (const check of checks) {
            const label = check.status.toUpperCase().padEnd(7, ' ');
            process.stdout.write(`  ${label} ${check.name}${check.detail ? `: ${check.detail}` : ''}\n`);
            if (check.status !== 'ok' && check.remedy) {
                process.stdout.write(`          Remedy: ${check.remedy}\n`);
            }
        }
        process.stdout.write(`\nSummary: ${report.ok ? 'ready' : 'not ready'}${strict ? ' (strict)' : ''}\n`);
    }

    if (strict && requiredFailures.length > 0) {
        process.exit(1);
    }
}

const isDirectCliRun = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectCliRun) {
    main();
}
