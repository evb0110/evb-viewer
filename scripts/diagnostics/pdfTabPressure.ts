import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {sumBy} from 'es-toolkit/math';
import {sendCommand} from '@scripts/electron-run/sendCommand';
import {setCurrentSessionName} from '@scripts/electron-run/electronRunSessionPaths';

interface IPdfTabPressureOptions {
    fixture: string;
    fixtures: string[];
    tabs: number;
    cycles: number;
    out: string | null;
    session: string;
    idleMs: number;
    collectGc: boolean;
    failOnWarning: boolean;
    maxInactiveCanvases: number;
    maxInactiveRenderedPages: number;
    maxInactiveDjvuImages: number;
    maxInactiveCanvasPixels: number;
    maxHeapGrowthMb: number | null;
    sampleHeap: boolean;
}

interface IPageMetricsPayload {
    section: string;
    metrics?: Record<string, number>;
    viewport?: unknown;
    url?: string;
}

interface IDomPressureSnapshot {
    workspaceHosts: number;
    visibleWorkspaceHosts: number;
    activeWorkspaceHosts: number;
    pdfViewers: number;
    renderedPages: number;
    canvases: number;
    canvasPixels: number;
    textSpans: number;
    annotationLayerNodes: number;
    djvuImages: number;
    hosts: IDiagnosticWorkspacePressureSnapshot[];
}

interface IDiagnosticWorkspacePressureSnapshot {
    index: number;
    active: boolean;
    visible: boolean;
    pdfViewers: number;
    renderedPages: number;
    canvases: number;
    canvasPixels: number;
    textSpans: number;
    annotationLayerNodes: number;
    djvuImages: number;
}

interface IDiagnosticSnapshot {
    label: string;
    at: string;
    metrics: Record<string, number>;
    heap: IHeapSample | null;
    dom: IDomPressureSnapshot;
    warnings: string[];
    failures: string[];
}

const DEFAULT_FIXTURE = 'tests/fixtures/electron/generated-text.pdf';
const DEFAULT_MAX_INACTIVE_CANVASES = 0;
const DEFAULT_MAX_INACTIVE_RENDERED_PAGES = 0;
const DEFAULT_MAX_INACTIVE_DJVU_IMAGES = 0;
const DEFAULT_MAX_INACTIVE_CANVAS_PIXELS = 0;

interface IHeapSample {
    usedJSHeapSize: number | null;
    totalJSHeapSize: number | null;
    jsHeapSizeLimit: number | null;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
    const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number) {
    const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number | null) {
    const parsed = value ? Number.parseFloat(value) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptions(argv = process.argv.slice(2)): IPdfTabPressureOptions {
    const options: IPdfTabPressureOptions = {
        fixture: DEFAULT_FIXTURE,
        fixtures: [],
        tabs: 4,
        cycles: 2,
        out: '.tmp/pdf-tab-pressure.json',
        session: 'default',
        idleMs: 750,
        collectGc: false,
        failOnWarning: false,
        maxInactiveCanvases: DEFAULT_MAX_INACTIVE_CANVASES,
        maxInactiveRenderedPages: DEFAULT_MAX_INACTIVE_RENDERED_PAGES,
        maxInactiveDjvuImages: DEFAULT_MAX_INACTIVE_DJVU_IMAGES,
        maxInactiveCanvasPixels: DEFAULT_MAX_INACTIVE_CANVAS_PIXELS,
        maxHeapGrowthMb: null,
        sampleHeap: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === '--fixture' && next) {
            options.fixture = next;
            index += 1;
        } else if (arg === '--fixtures' && next) {
            options.fixtures = next
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
            index += 1;
        } else if (arg === '--tabs' && next) {
            options.tabs = parsePositiveInt(next, options.tabs);
            index += 1;
        } else if (arg === '--cycles' && next) {
            options.cycles = parsePositiveInt(next, options.cycles);
            index += 1;
        } else if (arg === '--out' && next) {
            options.out = next === '-' ? null : next;
            index += 1;
        } else if (arg === '--session' && next) {
            options.session = next;
            index += 1;
        } else if (arg === '--idle-ms' && next) {
            options.idleMs = parsePositiveInt(next, options.idleMs);
            index += 1;
        } else if (arg === '--gc') {
            options.collectGc = true;
        } else if (arg === '--fail-on-warning') {
            options.failOnWarning = true;
        } else if (arg === '--max-inactive-canvases' && next) {
            options.maxInactiveCanvases = parseNonNegativeInt(next, options.maxInactiveCanvases);
            index += 1;
        } else if (arg === '--max-inactive-rendered-pages' && next) {
            options.maxInactiveRenderedPages = parseNonNegativeInt(next, options.maxInactiveRenderedPages);
            index += 1;
        } else if (arg === '--max-inactive-djvu-images' && next) {
            options.maxInactiveDjvuImages = parseNonNegativeInt(next, options.maxInactiveDjvuImages);
            index += 1;
        } else if (arg === '--max-inactive-canvas-pixels' && next) {
            options.maxInactiveCanvasPixels = parseNonNegativeInt(next, options.maxInactiveCanvasPixels);
            index += 1;
        } else if (arg === '--max-heap-growth-mb' && next) {
            options.maxHeapGrowthMb = parsePositiveNumber(next, options.maxHeapGrowthMb);
            options.sampleHeap = true;
            index += 1;
        } else if (arg === '--sample-heap') {
            options.sampleHeap = true;
        }
    }

    return options;
}

async function waitForIdle(ms: number) {
    await sendCommand('run', [`await sleep(${JSON.stringify(ms)});`]);
}

async function collectGarbageIfRequested(collectGc: boolean) {
    if (!collectGc) {
        return;
    }

    await sendCommand('run', [
        `
        const client = await page.target().createCDPSession();
        try {
            await client.send('HeapProfiler.collectGarbage');
        } finally {
            await client.detach();
        }
    `,
    ]);
}

async function openFixtureInActiveTab(fixture: string) {
    await sendCommand(
        'run',
        [
            `
        const fixturePath = ${JSON.stringify(fixture)};
        await page.evaluate(async (path) => {
            const automationGrant = window.__allowRendererFileOpenForAutomation;
            if (typeof automationGrant === 'function') {
                await automationGrant(path);
            }

            const openFileDirect = window.__openFileDirect;
            if (typeof openFileDirect !== 'function') {
                throw new Error('window.__openFileDirect is not available');
            }
            await openFileDirect(path);
        }, fixturePath);
    `,
        ],
        150_000,
    );
}

async function createTabAndOpenFixture(fixture: string) {
    await sendCommand('run', [
        `
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        await page.keyboard.press('KeyT');
        await page.keyboard.up(modifier);
        await sleep(250);
    `,
    ]);
    await openFixtureInActiveTab(fixture);
}

function resolveFixtureForTab(fixtures: string[], index: number) {
    return fixtures[index % fixtures.length] ?? resolve(DEFAULT_FIXTURE);
}

async function activateTabByIndex(index: number) {
    await sendCommand('run', [
        `
        const tabs = await page.$$('.tab-bar [role="tab"], [data-tab-id], .tab-bar__tab');
        const target = tabs[${JSON.stringify(index)}];
        if (target) {
            await target.click();
        }
        await sleep(250);
    `,
    ]);
}

async function collectDomPressure(): Promise<IDomPressureSnapshot> {
    return (await sendCommand('eval', [
        `
        (() => {
            const isVisible = (element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && rect.width > 0
                    && rect.height > 0;
            };
            const countCanvasPixels = (root) => Array.from(root.querySelectorAll('canvas'))
                .reduce((total, canvas) => total + ((canvas.width || 0) * (canvas.height || 0)), 0);
            const summarizeHost = (host, index) => {
                const visible = isVisible(host);
                return {
                    index,
                    active: visible,
                    visible,
                    pdfViewers: host.querySelectorAll('#pdf-viewer, .pdfViewer').length,
                    renderedPages: host.querySelectorAll('.page_container--rendered').length,
                    canvases: host.querySelectorAll('canvas').length,
                    canvasPixels: countCanvasPixels(host),
                    textSpans: host.querySelectorAll('.text-layer span, .textLayer span').length,
                    annotationLayerNodes: host.querySelectorAll('.annotation-layer *, .annotation-editor-layer *').length,
                    djvuImages: host.querySelectorAll('[data-testid="document-page-source-image"]').length,
                };
            };
            const canvases = Array.from(document.querySelectorAll('canvas'));
            const hosts = Array.from(document.querySelectorAll('.workspace-host')).map(summarizeHost);
            return {
                workspaceHosts: hosts.length,
                visibleWorkspaceHosts: hosts.filter(host => host.visible).length,
                activeWorkspaceHosts: hosts.filter(host => host.active).length,
                pdfViewers: document.querySelectorAll('#pdf-viewer, .pdfViewer').length,
                renderedPages: document.querySelectorAll('.page_container--rendered').length,
                canvases: canvases.length,
                canvasPixels: canvases.reduce((total, canvas) => total + ((canvas.width || 0) * (canvas.height || 0)), 0),
                textSpans: document.querySelectorAll('.text-layer span, .textLayer span').length,
                annotationLayerNodes: document.querySelectorAll('.annotation-layer *, .annotation-editor-layer *').length,
                djvuImages: document.querySelectorAll('[data-testid="document-page-source-image"]').length,
                hosts,
            };
        })()
    `,
    ])) as IDomPressureSnapshot;
}

function buildSnapshotWarnings(dom: IDomPressureSnapshot) {
    const warnings: string[] = [];
    const inactiveHostsWithCanvases = dom.hosts.filter((host) => !host.active && host.canvases > 0);
    if (inactiveHostsWithCanvases.length > 0) {
        warnings.push(`Inactive hosts still have ${sumBy(inactiveHostsWithCanvases, (host) => host.canvases)} canvas element(s).`);
    }

    const inactiveHostsWithRenderedPages = dom.hosts.filter((host) => !host.active && host.renderedPages > 0);
    if (inactiveHostsWithRenderedPages.length > 0) {
        warnings.push(`Inactive hosts still have ${sumBy(inactiveHostsWithRenderedPages, (host) => host.renderedPages)} rendered page(s).`);
    }

    return warnings;
}

function buildSnapshotFailures(
    dom: IDomPressureSnapshot,
    options: Pick<
        IPdfTabPressureOptions,
        'maxInactiveCanvases' | 'maxInactiveRenderedPages' | 'maxInactiveDjvuImages' | 'maxInactiveCanvasPixels'
    >,
) {
    const failures: string[] = [];
    const inactiveHosts = dom.hosts.filter((host) => !host.active);
    const inactiveCanvases = sumBy(inactiveHosts, (host) => host.canvases);
    const inactiveRenderedPages = sumBy(inactiveHosts, (host) => host.renderedPages);
    const inactiveDjvuImages = sumBy(inactiveHosts, (host) => host.djvuImages);
    const inactiveCanvasPixels = sumBy(inactiveHosts, (host) => host.canvasPixels);

    if (inactiveCanvases > options.maxInactiveCanvases) {
        failures.push(`Inactive canvas count ${inactiveCanvases} exceeded threshold ${options.maxInactiveCanvases}.`);
    }
    if (inactiveRenderedPages > options.maxInactiveRenderedPages) {
        failures.push(`Inactive rendered page count ${inactiveRenderedPages} exceeded threshold ${options.maxInactiveRenderedPages}.`);
    }
    if (inactiveDjvuImages > options.maxInactiveDjvuImages) {
        failures.push(`Inactive DjVu image count ${inactiveDjvuImages} exceeded threshold ${options.maxInactiveDjvuImages}.`);
    }
    if (inactiveCanvasPixels > options.maxInactiveCanvasPixels) {
        failures.push(`Inactive canvas pixels ${inactiveCanvasPixels} exceeded threshold ${options.maxInactiveCanvasPixels}.`);
    }

    return failures;
}

async function collectHeapSample(sampleHeap: boolean): Promise<IHeapSample | null> {
    if (!sampleHeap) {
        return null;
    }

    return (await sendCommand('eval', [
        `
        (() => {
            const memory = performance.memory;
            if (!memory) {
                return {
                    usedJSHeapSize: null,
                    totalJSHeapSize: null,
                    jsHeapSizeLimit: null,
                };
            }
            return {
                usedJSHeapSize: Number.isFinite(memory.usedJSHeapSize) ? memory.usedJSHeapSize : null,
                totalJSHeapSize: Number.isFinite(memory.totalJSHeapSize) ? memory.totalJSHeapSize : null,
                jsHeapSizeLimit: Number.isFinite(memory.jsHeapSizeLimit) ? memory.jsHeapSizeLimit : null,
            };
        })()
    `,
    ])) as IHeapSample;
}

async function collectSnapshot(
    label: string,
    options: Pick<
        IPdfTabPressureOptions,
        | 'collectGc'
        | 'sampleHeap'
        | 'maxInactiveCanvases'
        | 'maxInactiveRenderedPages'
        | 'maxInactiveDjvuImages'
        | 'maxInactiveCanvasPixels'
    >,
): Promise<IDiagnosticSnapshot> {
    await collectGarbageIfRequested(options.collectGc);
    const [metricsPayload, dom, heap] = await Promise.all([
        sendCommand('devtools', ['metrics']) as Promise<IPageMetricsPayload>,
        collectDomPressure(),
        collectHeapSample(options.sampleHeap),
    ]);

    return {
        label,
        at: new Date().toISOString(),
        metrics: metricsPayload.metrics ?? {},
        heap,
        dom,
        warnings: buildSnapshotWarnings(dom),
        failures: buildSnapshotFailures(dom, options),
    };
}

function buildHeapFailures(snapshots: IDiagnosticSnapshot[], maxHeapGrowthMb: number | null) {
    if (!maxHeapGrowthMb) {
        return [];
    }

    const samples = snapshots.flatMap((snapshot) => {
        const used = snapshot.heap?.usedJSHeapSize;
        return typeof used === 'number'
            ? [
                  {
                      label: snapshot.label,
                      used,
                  },
              ]
            : [];
    });
    const baseline = samples[0];
    const last = samples.at(-1);

    if (!baseline || !last) {
        return ['JS heap sampling was requested but performance.memory was not exposed by the renderer.'];
    }

    const growthMb = (last.used - baseline.used) / 1024 / 1024;
    return growthMb > maxHeapGrowthMb
        ? [`JS heap grew ${growthMb.toFixed(1)}MB from ${baseline.label} to ${last.label}, exceeding ${maxHeapGrowthMb}MB.`]
        : [];
}

async function runDiagnostics(options: IPdfTabPressureOptions) {
    setCurrentSessionName(options.session);
    const fixtures = (options.fixtures.length > 0 ? options.fixtures : [options.fixture]).map((fixture) => resolve(fixture));
    const snapshots: IDiagnosticSnapshot[] = [];

    snapshots.push(await collectSnapshot('baseline', options));
    await openFixtureInActiveTab(resolveFixtureForTab(fixtures, 0));
    await waitForIdle(options.idleMs);
    snapshots.push(await collectSnapshot('tab-1-opened', options));

    for (let index = 1; index < options.tabs; index += 1) {
        await createTabAndOpenFixture(resolveFixtureForTab(fixtures, index));
        await waitForIdle(options.idleMs);
        snapshots.push(await collectSnapshot(`tab-${index + 1}-opened`, options));
    }

    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
        for (let index = 0; index < options.tabs; index += 1) {
            await activateTabByIndex(index);
            await waitForIdle(options.idleMs);
            snapshots.push(await collectSnapshot(`cycle-${cycle}-tab-${index + 1}`, options));
        }
    }

    const warnings = snapshots.flatMap((snapshot) => snapshot.warnings.map((warning) => `${snapshot.label}: ${warning}`));
    const thresholdFailures = snapshots.flatMap((snapshot) => snapshot.failures.map((failure) => `${snapshot.label}: ${failure}`));
    const heapFailures = buildHeapFailures(snapshots, options.maxHeapGrowthMb);
    const failures = [...thresholdFailures, ...heapFailures, ...(options.failOnWarning ? warnings : [])];

    return {
        fixtures,
        tabs: options.tabs,
        cycles: options.cycles,
        idleMs: options.idleMs,
        collectGc: options.collectGc,
        thresholds: {
            maxInactiveCanvases: options.maxInactiveCanvases,
            maxInactiveRenderedPages: options.maxInactiveRenderedPages,
            maxInactiveDjvuImages: options.maxInactiveDjvuImages,
            maxInactiveCanvasPixels: options.maxInactiveCanvasPixels,
            maxHeapGrowthMb: options.maxHeapGrowthMb,
        },
        generatedAt: new Date().toISOString(),
        warnings,
        failures,
        snapshots,
    };
}

const options = readOptions();
const result = await runDiagnostics(options);
const output = JSON.stringify(result, null, 2);

if (options.out) {
    const outPath = resolve(options.out);
    mkdirSync(dirname(outPath), {recursive: true});
    writeFileSync(outPath, `${output}\n`);
    console.log(`Wrote PDF tab pressure diagnostics to ${outPath}`);
    if (result.warnings.length > 0) {
        console.warn(`Diagnostics completed with ${result.warnings.length} warning(s). See ${outPath}`);
    }
} else {
    console.log(output);
}

if (result.failures.length > 0) {
    for (const failure of result.failures) {
        console.error(failure);
    }
    process.exitCode = 1;
}
