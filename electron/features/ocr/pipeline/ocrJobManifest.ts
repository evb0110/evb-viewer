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
import * as v from 'valibot';

const OCR_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

const OCR_JOB_MANIFEST_SCHEMA = v.object({
    version: v.literal(1),
    fingerprint: v.string(),
    state: v.picklist(OCR_JOB_STATES),
    updatedAt: v.pipe(v.number(), v.finite()),
    nodes: v.strictObject({
        model: v.exactOptional(v.picklist(OCR_DAG_NODE_STATES)),
        'normalized-source': v.exactOptional(v.picklist(OCR_DAG_NODE_STATES)),
        'page-raster': v.exactOptional(v.picklist(OCR_DAG_NODE_STATES)),
        preprocessed: v.exactOptional(v.picklist(OCR_DAG_NODE_STATES)),
        'recognized-page': v.exactOptional(v.picklist(OCR_DAG_NODE_STATES)),
        'assembled-document': v.exactOptional(v.picklist(OCR_DAG_NODE_STATES)),
        'verified-result': v.exactOptional(v.picklist(OCR_DAG_NODE_STATES)),
    }),
    verifiedPages: v.array(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
});
type IOcrDurableJobManifest = v.InferOutput<typeof OCR_JOB_MANIFEST_SCHEMA>;
type TOcrDagNode = keyof IOcrDurableJobManifest['nodes'];

function decodeManifest(value: unknown, fingerprint: string): IOcrDurableJobManifest | null {
    const result = v.safeParse(OCR_JOB_MANIFEST_SCHEMA, value, {abortEarly: true});
    return result.success && result.output.fingerprint === fingerprint
        ? result.output
        : null;
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
    const loaded: unknown = await readFile(manifestPath, 'utf8')
        .then(raw => JSON.parse(raw) as unknown)
        .catch(() => null);
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
