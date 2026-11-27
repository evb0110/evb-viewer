import type { Page } from 'puppeteer-core';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import {
    expect,
    it,
} from 'vitest';
import { startElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { clickAnnotationTool } from '@tests/e2e/electron/helpers/viewerAnnotations';
import { clickAsUser } from '@tests/e2e/electron/helpers/userInput';
import {
    createBlankFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    readWorkspaceStateValues,
    waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';

interface IPdfInkStats {
    annotationCount: number;
    strokeCount: number;
    strokePointCounts: number[];
    totalPoints: number;
}

const SEEDED_HEAVY_INK_SHAPES = 26;
const POINTS_PER_SEEDED_SHAPE = 4_000;
const SEEDED_INK_POINTS = SEEDED_HEAVY_INK_SHAPES * POINTS_PER_SEEDED_SHAPE;
const EXPECTED_SAVED_SHAPES = SEEDED_HEAVY_INK_SHAPES + 2;

async function readPdfInkStats(filePath: string): Promise<IPdfInkStats> {
    const doc = await PDFDocument.load(readFileSync(filePath));
    let annotationCount = 0;
    let strokeCount = 0;
    const strokePointCounts: number[] = [];
    let totalPoints = 0;

    for (const page of doc.getPages()) {
        const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
        if (!annots) {continue;}
        for (let index = 0; index < annots.size(); index += 1) {
            const annot = annots.lookupMaybe(index, PDFDict);
            if (!annot) {continue;}
            if (annot.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Ink') {continue;}
            annotationCount += 1;
            const inkList = annot.lookupMaybe(PDFName.of('InkList'), PDFArray);
            if (!inkList) {continue;}
            for (let strokeIndex = 0; strokeIndex < inkList.size(); strokeIndex += 1) {
                const stroke = inkList.lookupMaybe(strokeIndex, PDFArray);
                if (!stroke) {continue;}
                const pointsInStroke = Math.floor(stroke.size() / 2);
                strokeCount += 1;
                strokePointCounts.push(pointsInStroke);
                totalPoints += pointsInStroke;
            }
        }
    }

    return {
        annotationCount,
        strokeCount,
        strokePointCounts,
        totalPoints,
    };
}

async function waitForShapeCount(page: Page, expectedCount: number, timeout = 60_000) {
    await waitForFunctionInPage(page, (count: number) => {
        const shapes = document.querySelectorAll('.editor-pane.is-active .pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id]');
        return shapes.length === count;
    }, { timeout }, expectedCount);
}

async function drawFreehandStroke(
    page: Page,
    points: ReadonlyArray<{
        x: number;
        y: number;
    }>,
) {
    await clickAnnotationTool(page, 'Draw', 30_000);
    await waitForViewerInteractive(page, 30_000);
    await waitForFunctionInPage(page, () => Boolean(
        document.querySelector('.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer'),
    ), { timeout: 30_000 });

    const clientPoints = await evaluateInPage(page, async ({ratios}: {
        ratios: Array<{
            x: number;
            y: number;
        }>;
    }) => {
        const overlay = document.querySelector<SVGElement>('.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer');
        const pageContainer = overlay?.closest<HTMLElement>('.page_container');
        if (!overlay || !pageContainer || ratios.length < 2) {return null;}
        pageContainer.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {return null;}
        return ratios.map(point => ({
            clientX: rect.left + rect.width * point.x,
            clientY: rect.top + rect.height * point.y,
        }));
    }, { ratios: points.map(point => ({...point})) });

    if (!clientPoints || clientPoints.length < 2) {
        throw new Error('Unable to resolve client points for heavy-ink freehand stroke');
    }

    const start = clientPoints[0]!;
    await page.mouse.move(start.clientX, start.clientY);
    await page.mouse.down();
    for (const point of clientPoints.slice(1)) {
        await page.mouse.move(point.clientX, point.clientY, { steps: 8 });
    }
    const end = clientPoints[clientPoints.length - 1]!;
    await page.mouse.move(end.clientX, end.clientY);
    await page.mouse.up();
}

it('saves and reopens heavy freehand ink drawings past the 100,000-point mutation ceiling', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'evb-heavy-ink-save-'));
    const sourcePath = await createBlankFixturePdf(`heavy-ink-save-${Date.now()}.pdf`, 1);

    let session = await startElectronE2ESession(`e2e-heavy-ink-save-${Date.now()}`, {
        clean: true,
        initialOpenPaths: [sourcePath],
    });
    try {
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);

        // Draw one real stroke to seed the canonical Ink shape template.
        await drawFreehandStroke(session.page, [
            {
                x: 0.2,
                y: 0.58,
            },
            {
                x: 0.5,
                y: 0.62,
            },
            {
                x: 0.8,
                y: 0.58,
            },
        ]);
        await waitForShapeCount(session.page, 1, 30_000);

        // Seed 26 unsaved Ink shapes of 4,000 points each (104,000 /InkList points total)
        // in bounded recovery replays so the pending Save payload exceeds 100,000 points.
        const seededCount = await session.page.evaluate(async ({
            shapeCount,
            pointsPerShape,
        }: {
            shapeCount: number;
            pointsPerShape: number;
        }) => {
            const handle = (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle();
            const plan = handle?.captureCanonicalAnnotationRecovery?.();
            const template = plan?.entities.find(entity => entity.kind === 'shape');
            if (!handle?.restoreCanonicalAnnotationRecovery || !plan || !template) {return null;}
            const {
                metadata: _metadata,
                ...annotations
            } = plan;
            const changed = plan.changedFields?.[template.identity.id] ?? [];
            const batchSize = 4;

            for (let first = 0; first < shapeCount; first += batchSize) {
                const count = Math.min(batchSize, shapeCount - first);
                const entities = Array.from({length: count}, (_, offset) => {
                    const shapeIndex = first + offset;
                    const bandTop = 0.06 + shapeIndex * 0.017;
                    const strokePoints = Array.from({length: pointsPerShape}, (_, pointIndex) => {
                        const t = pointIndex / (pointsPerShape - 1);
                        return {
                            x: Number((0.06 + t * 0.88).toFixed(5)),
                            y: Number((bandTop + Math.sin(t * Math.PI * 16) * 0.004).toFixed(5)),
                        };
                    });
                    return {
                        ...template,
                        identity: {id: `heavy-ink-seeded-${String(shapeIndex)}`},
                        rect: {
                            left: 0.06,
                            top: Number((bandTop - 0.004).toFixed(5)),
                            width: 0.88,
                            height: 0.008,
                        },
                        points: strokePoints,
                        strokes: [strokePoints],
                    };
                });
                await handle.restoreCanonicalAnnotationRecovery({
                    ...annotations,
                    drafts: [],
                    heldFields: {},
                    entities,
                    changedFields: Object.fromEntries(entities.map(entity => [
                        entity.identity.id,
                        changed,
                    ])),
                });
            }
            return shapeCount;
        }, {
            shapeCount: SEEDED_HEAVY_INK_SHAPES,
            pointsPerShape: POINTS_PER_SEEDED_SHAPE,
        });
        expect(seededCount).toBe(SEEDED_HEAVY_INK_SHAPES);
        await waitForShapeCount(session.page, SEEDED_HEAVY_INK_SHAPES + 1, 60_000);

        // Draw one more real freehand stroke through trusted mouse input before saving.
        await drawFreehandStroke(session.page, [
            {
                x: 0.2,
                y: 0.72,
            },
            {
                x: 0.5,
                y: 0.78,
            },
            {
                x: 0.8,
                y: 0.72,
            },
        ]);
        await waitForShapeCount(session.page, EXPECTED_SAVED_SHAPES, 30_000);
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {hasPendingUnsavedChanges?: boolean}}>(session.page, ['dirtyState'])
        ).dirtyState?.hasPendingUnsavedChanges, { timeout: 30_000 }).toBe(true);

        const readFailures = () => session.page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.app-toast-failure'))
            .map(toast => toast.innerText.trim()));

        await clickAsUser(session.page, 'button.save-split-primary');
        await expect.poll(async () => {
            const failures = await readFailures();
            if (failures.length > 0) {return 'failed';}
            const state = await readWorkspaceStateValues<{dirtyState?: {
                fileDirty?: boolean;
                hasPendingUnsavedChanges?: boolean;
            }}>(session.page, ['dirtyState']);
            return state.dirtyState?.fileDirty === false && state.dirtyState?.hasPendingUnsavedChanges === false
                ? 'saved'
                : 'pending';
        }, {
            timeout: 120_000,
            interval: 500,
        }).not.toBe('pending');
        await waitForWorkspaceToolbarIdle(session.page, { timeoutMs: 120_000 });

        const failures = await readFailures();
        const savedStats = await readPdfInkStats(sourcePath);
        console.info('HEAVY_INK_SAVE', JSON.stringify({
            expectedShapes: EXPECTED_SAVED_SHAPES,
            seededPoints: SEEDED_INK_POINTS,
            savedStats,
            failures,
        }));
        expect(failures).toEqual([]);
        expect(savedStats.annotationCount).toBe(EXPECTED_SAVED_SHAPES);
        expect(savedStats.strokeCount).toBe(EXPECTED_SAVED_SHAPES);
        expect(savedStats.strokePointCounts.filter(count => count === POINTS_PER_SEEDED_SHAPE))
            .toHaveLength(SEEDED_HEAVY_INK_SHAPES);
        expect(savedStats.strokePointCounts.filter(count => count !== POINTS_PER_SEEDED_SHAPE))
            .toHaveLength(EXPECTED_SAVED_SHAPES - SEEDED_HEAVY_INK_SHAPES);
        expect(savedStats.strokePointCounts.every(count => count >= 2)).toBe(true);
        expect(savedStats.totalPoints).toBeGreaterThan(SEEDED_INK_POINTS);

        const dirtyAfterSave = (
            await readWorkspaceStateValues<{dirtyState?: {
                fileDirty?: boolean;
                hasPendingUnsavedChanges?: boolean;
            }}>(session.page, ['dirtyState'])
        ).dirtyState;
        expect(dirtyAfterSave?.fileDirty).toBe(false);
        expect(dirtyAfterSave?.hasPendingUnsavedChanges).toBe(false);

        await session.stop();

        session = await startElectronE2ESession(`e2e-heavy-ink-reopen-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [sourcePath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await waitForShapeCount(session.page, EXPECTED_SAVED_SHAPES, 60_000);

        const reopenedSummary = await readPdfAnnotationSummary(sourcePath);
        expect(reopenedSummary.bySubtype.Ink).toBe(EXPECTED_SAVED_SHAPES);
    } finally {
        await session.stop();
        rmSync(sourcePath, { force: true });
        rmSync(outputDirectory, {
            recursive: true,
            force: true,
        });
    }
}, 240_000);
