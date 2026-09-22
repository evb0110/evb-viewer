import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {
    basename,
    dirname,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = 'pdfjs-dist';
const VERSION_STAMP = 'public/pdf/.pdfjs-version';

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function resolvePdfjsArchive(root = projectRoot) {
    const dependency = readJson(join(root, 'package.json')).dependencies?.[PACKAGE_NAME];
    if (typeof dependency !== 'string' || !dependency.startsWith('file:')) {
        throw new Error(`The ${PACKAGE_NAME} dependency must point to a local archive.`);
    }
    return resolve(root, dependency.slice('file:'.length));
}

function readArchiveVersion(archivePath) {
    const packageJson = execFileSync('tar', [
        '-xOzf',
        basename(archivePath),
        'package/package.json',
    ], {
        encoding: 'utf8',
        cwd: dirname(archivePath),
    });
    return readJsonFromText(packageJson).version;
}

function readJsonFromText(text) {
    return JSON.parse(text);
}

export function readPdfjsDevIdentity(root = projectRoot) {
    const archivePath = resolvePdfjsArchive(root);
    const installedPackagePath = join(root, 'node_modules', PACKAGE_NAME, 'package.json');
    let installedVersion = null;
    try {
        installedVersion = readJson(installedPackagePath).version ?? null;
    } catch {
        installedVersion = null;
    }

    let publicVersion = null;
    try {
        publicVersion = readFileSync(join(root, VERSION_STAMP), 'utf8').trim() || null;
    } catch {
        publicVersion = null;
    }

    return {
        archivePath,
        expectedVersion: readArchiveVersion(archivePath),
        installedPackagePath,
        installedVersion,
        publicStampPath: join(root, VERSION_STAMP),
        publicVersion,
    };
}

export function getPdfjsDevIdentityProblems(identity) {
    const problems = [];
    if (identity.installedVersion !== identity.expectedVersion) {
        problems.push(`installed ${identity.installedVersion ?? 'missing'} != expected ${identity.expectedVersion}`);
    }
    if (identity.publicVersion !== identity.expectedVersion) {
        problems.push(`public assets ${identity.publicVersion ?? 'missing'} != expected ${identity.expectedVersion}`);
    }
    return problems;
}

export function formatPdfjsDevIdentityFailure(identity, problems) {
    return [
        'PDF.js development assets are out of sync.',
        ...problems,
        `Expected archive: ${identity.archivePath}`,
        'Run pnpm install --frozen-lockfile and restart the development app.',
    ].join(' ');
}

export function ensurePdfjsDevInstall({
    root = projectRoot,
    install = () => execFileSync(
        process.platform === 'win32' ? 'cmd.exe' : 'pnpm',
        process.platform === 'win32' ? [
            '/d',
            '/s',
            '/c',
            'pnpm.cmd install --frozen-lockfile',
        ] : [
            'install',
            '--frozen-lockfile',
        ],
        {
            cwd: root,
            stdio: 'inherit',
        },
    ),
    readIdentity = () => readPdfjsDevIdentity(root),
} = {}) {
    let identity = readIdentity();
    const initialProblems = getPdfjsDevIdentityProblems(identity);
    if (initialProblems.length === 0) {
        return {
            repaired: false,
            identity,
        };
    }

    console.warn(`[PDF.js] ${formatPdfjsDevIdentityFailure(identity, initialProblems)}`);
    install();
    identity = readIdentity();
    const remainingProblems = getPdfjsDevIdentityProblems(identity);
    if (remainingProblems.length > 0) {
        throw new Error(formatPdfjsDevIdentityFailure(identity, remainingProblems));
    }
    console.log(`[PDF.js] Repaired development install to ${identity.expectedVersion}.`);
    return {
        repaired: true,
        identity,
    };
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
    try {
        ensurePdfjsDevInstall();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
