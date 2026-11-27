import {resolve} from 'node:path';

const DEFAULT_TARGET_PDF_PATH = process.env.EVB_DIAGNOSTIC_PDF_PATH?.length
    ? process.env.EVB_DIAGNOSTIC_PDF_PATH
    : resolve(process.cwd(), '.devkit', 'manual-pdf-fixtures', 'page-jump-source.pdf');
const DEFAULT_OUT_PATH = '.devkit/pdf-navigation-blink-trace.json';

export interface IPdfNavigationBlinkTraceOptions {
    assert: boolean;
    clicks: number;
    clickDelayMs: number;
    direction: 'next' | 'previous';
    out: string;
    pdf: string;
    preClickWaitMs: number;
    scrollMode: 'continuous' | 'paged';
    settleMs: number;
    startPage: number;
    video: boolean;
    videoDir: string | null;
    videoFps: number;
    viewportDeviceScaleFactor: number;
    viewportHeight: number;
    viewportWidth: number;
    waitForStartCanvas: boolean;
}

export function readOptions(argv = process.argv.slice(2)): IPdfNavigationBlinkTraceOptions {
    const options: IPdfNavigationBlinkTraceOptions = {
        assert: false,
        clicks: 12,
        clickDelayMs: 20,
        direction: 'next',
        out: DEFAULT_OUT_PATH,
        pdf: DEFAULT_TARGET_PDF_PATH,
        preClickWaitMs: 500,
        scrollMode: 'continuous',
        settleMs: 2_000,
        startPage: 1,
        video: false,
        videoDir: null,
        videoFps: 30,
        viewportDeviceScaleFactor: 1,
        viewportHeight: 768,
        viewportWidth: 1_024,
        waitForStartCanvas: true,
    };

    const readIntegerOption = (value: string | undefined, fallback: number, min: number) => {
        const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === '--assert') {
            options.assert = true;
        } else if (arg === '--clicks' && next) {
            options.clicks = readIntegerOption(next, options.clicks, 1);
            index += 1;
        } else if (arg === '--click-delay-ms' && next) {
            options.clickDelayMs = readIntegerOption(next, options.clickDelayMs, 0);
            index += 1;
        } else if (arg === '--direction' && (next === 'next' || next === 'previous')) {
            options.direction = next;
            index += 1;
        } else if (arg === '--out' && next) {
            options.out = next;
            index += 1;
        } else if (arg === '--pdf' && next) {
            options.pdf = next;
            index += 1;
        } else if (arg === '--pre-click-wait-ms' && next) {
            options.preClickWaitMs = readIntegerOption(next, options.preClickWaitMs, 0);
            index += 1;
        } else if (arg === '--scroll-mode') {
            if (next !== 'continuous' && next !== 'paged') {
                throw new Error(`Invalid --scroll-mode value: ${next ?? '(missing)'}`);
            }
            options.scrollMode = next;
            index += 1;
        } else if (arg === '--settle-ms' && next) {
            options.settleMs = readIntegerOption(next, options.settleMs, 0);
            index += 1;
        } else if (arg === '--start-page' && next) {
            options.startPage = readIntegerOption(next, options.startPage, 1);
            index += 1;
        } else if (arg === '--skip-start-page-canvas-wait') {
            options.waitForStartCanvas = false;
        } else if (arg === '--video') {
            options.video = true;
        } else if (arg === '--video-dir' && next) {
            options.video = true;
            options.videoDir = next;
            index += 1;
        } else if (arg === '--video-fps' && next) {
            options.videoFps = readIntegerOption(next, options.videoFps, 1);
            index += 1;
        } else if (arg === '--viewport-device-scale-factor' && next) {
            options.viewportDeviceScaleFactor = readIntegerOption(next, options.viewportDeviceScaleFactor, 1);
            index += 1;
        } else if (arg === '--viewport-height' && next) {
            options.viewportHeight = readIntegerOption(next, options.viewportHeight, 320);
            index += 1;
        } else if (arg === '--viewport-width' && next) {
            options.viewportWidth = readIntegerOption(next, options.viewportWidth, 320);
            index += 1;
        }
    }

    return options;
}

export function resolveVideoDirectory(options: Pick<IPdfNavigationBlinkTraceOptions, 'out' | 'videoDir'>, cwd = process.cwd()) {
    if (options.videoDir) {
        return resolve(cwd, options.videoDir);
    }

    const outPath = resolve(cwd, options.out);
    const withoutJsonExtension = outPath.endsWith('.json') ? outPath.slice(0, -'.json'.length) : outPath;
    return `${withoutJsonExtension}-video`;
}
