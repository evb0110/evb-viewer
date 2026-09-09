import {randomUUID} from 'node:crypto';
import {
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

type TOcrDagNode = 'model' | 'normalized-source' | 'page-raster' | 'preprocessed' | 'recognized-page' | 'assembled-document' | 'text-catalog' | 'verified-result';

interface IOcrDurableJobManifest {
    version: 1;
    fingerprint: string;
    state: 'running' | 'completed' | 'failed' | 'cancelled';
    updatedAt: number;
    nodes: Partial<Record<TOcrDagNode, 'pending' | 'running' | 'verified'>>;
    verifiedPages: number[];
}

const OCR_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OCR_DAG_NODES = [
    'model',
    'normalized-source',
    'page-raster',
    'preprocessed',
    'recognized-page',
    'assembled-document',
    'text-catalog',
    'verified-result',
] as const satisfies readonly TOcrDagNode[];
const OCR_DAG_NODE_STATES = [
    'pending',
    'running',
    'verified',
] as const;
const OCR_JOB_STATES = [
    'running',
    'completed',
    'failed',
    'cancelled',
] as const;

function parseJson(raw: string): unknown {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
}

function decodeManifest(value: unknown, fingerprint: string): IOcrDurableJobManifest | null {
    if (
        !isRecord(value)
        || value.version !== 1
        || value.fingerprint !== fingerprint
        || !isOneOf(OCR_JOB_STATES, value.state)
        || typeof value.updatedAt !== 'number'
        || !Number.isFinite(value.updatedAt)
        || !isRecord(value.nodes)
        || !Array.isArray(value.verifiedPages)
        || value.verifiedPages.some(page => (
            typeof page !== 'number'
            || !Number.isSafeInteger(page)
            || page < 1
        ))
    ) {
        return null;
    }
    const nodes: IOcrDurableJobManifest['nodes'] = {};
    for (const [
        node,
        state,
    ] of Object.entries(value.nodes)) {
        if (!isOneOf(OCR_DAG_NODES, node) || !isOneOf(OCR_DAG_NODE_STATES, state)) {
            return null;
        }
        nodes[node] = state;
    }
    const verifiedPages = value.verifiedPages.filter((page): page is number => typeof page === 'number');
    return {
        version: 1,
        fingerprint,
        state: value.state,
        updatedAt: value.updatedAt,
        nodes,
        verifiedPages,
    };
}

async function writeManifestAtomic(path: string, manifest: IOcrDurableJobManifest) {
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(manifest), 'utf8');
    await rename(tempPath, path);
}

export async function cleanupStaleOcrJobDirectories(rootDir: string, now = Date.now()) {
    const entries = await readdir(rootDir, {withFileTypes: true}).catch(() => []);
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
        const path = join(rootDir, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && now - info.mtimeMs > OCR_JOB_TTL_MS) {
            await rm(path, {
                recursive: true,
                force: true,
            });
        }
    }));
}

export async function createOcrJobManifestController(jobDir: string, fingerprint: string) {
    await mkdir(jobDir, {recursive: true});
    const manifestPath = join(jobDir, 'manifest.json');
    const loaded: unknown = await readFile(manifestPath, 'utf8').then(parseJson).catch(() => null);
    const manifest: IOcrDurableJobManifest = decodeManifest(loaded, fingerprint) ?? {
        version: 1,
        fingerprint,
        state: 'running',
        updatedAt: Date.now(),
        nodes: {},
        verifiedPages: [],
    };
    manifest.state = 'running';
    let writeTail = Promise.resolve();
    const persist = () => {
        manifest.updatedAt = Date.now();
        writeTail = writeTail.then(() => writeManifestAtomic(manifestPath, manifest));
        return writeTail;
    };
    await persist();

    return {
        verifiedPages: new Set(manifest.verifiedPages),
        markNode(node: TOcrDagNode, state: 'pending' | 'running' | 'verified') {
            manifest.nodes[node] = state;
            return persist();
        },
        markPageVerified(pageNumber: number) {
            if (!manifest.verifiedPages.includes(pageNumber)) {
                manifest.verifiedPages.push(pageNumber);
                manifest.verifiedPages.sort((a, b) => a - b);
            }
            return persist();
        },
        setTerminal(state: 'completed' | 'failed' | 'cancelled') {
            manifest.state = state;
            return persist();
        },
    };
}
