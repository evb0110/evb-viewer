import {
    existsSync,
    readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const SESSION_ORDER = [
    'pdfDocumentSession',
    'createPdfViewportSession',
    'createPdfRenderingSession',
    'createPdfAnnotationSession',
] as const;

const SESSION_DIRECTORY = 'app/modules/pdf-viewer/runtime/sessions';

function readSession(name: string) {
    return readFileSync(resolve(process.cwd(), `${SESSION_DIRECTORY}/${name}.ts`), 'utf8');
}

function importedSessions(source: string) {
    return SESSION_ORDER.filter(name => source.includes(`${SESSION_DIRECTORY.replace('app/', '@app/')}/${name}`));
}

describe('PDF viewer session topology', () => {
    it('permits only document → viewport → rendering → annotation imports', () => {
        for (const [
            index,
            name,
        ] of SESSION_ORDER.entries()) {
            const imported = importedSessions(readSession(name));
            for (const dependency of imported) {
                expect(
                    SESSION_ORDER.indexOf(dependency),
                    `${name} must not import ${dependency}`,
                ).toBeLessThan(index);
            }
        }
    });

    it('keeps the loading path free of injected settle callbacks', () => {
        for (const name of SESSION_ORDER) {
            const source = readSession(name);
            expect(source, `${name} must not take an onSettled-style callback`)
                .not.toMatch(/on(Document)?(Load|Settle)[A-Za-z]*\??:\s*\(/);
        }
    });

    it('routes every session through the document owner for disposal', () => {
        for (const name of SESSION_ORDER.slice(1)) {
            expect(readSession(name), `${name} must register reverse disposal`)
                .toContain('registerDisposable');
        }
        expect(readSession('pdfDocumentSession')).toContain('[...disposables].reverse()');
    });

    it('keeps both navigation epochs and the layout window on the viewport session', () => {
        const viewport = readSession('createPdfViewportSession');

        // Both epochs come from one owner, so scroll can be attributed to the
        // viewer or the user rather than being collapsed into a single counter.
        // That the rerender coordinator is actually handed the physical epoch
        // and the layout window is proven at runtime by
        // `pdfRenderingSessionBehavior.test.ts`, not by matching this source.
        expect(viewport).toContain('createPdfViewportUserNavigationEpochs');
        expect(viewport).toContain('userPhysicalNavigationEpoch');
        expect(viewport).toContain('beginLayoutGeometryReplacement');
    });

    it('keeps viewport demand and document transitions one-way', () => {
        const viewport = readSession('createPdfViewportSession');
        const rendering = readSession('createPdfRenderingSession');
        const renderer = readFileSync(resolve(
            process.cwd(),
            'app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer.ts',
        ), 'utf8');

        expect(viewport).toContain('documentSession.subscribe');
        expect(viewport).not.toContain('attachRasterPort');
        expect(viewport).not.toContain('IPdfViewportRasterPort');
        expect(rendering).toContain('watch(viewport.demand');
        expect(rendering).not.toContain('viewport.notifyRenderStateChanged');
        expect(viewport).not.toContain('notifyRenderStateChanged');
        expect(rendering).toContain('const viewportRasterTarget');
        expect(rendering).toContain('clearAuthoritativePage');
        expect(rendering).toContain('start: prepared => prepared.render.startRender(),');
        expect(renderer).not.toContain('rasterScheduler');
        expect(renderer).not.toContain('getPdfPageRasterScheduler');
        expect(renderer).not.toContain('pageCanvases');
        expect(renderer).not.toContain('requestRaster:');
        const thumbnails = readFileSync(resolve(
            process.cwd(),
            'app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime.ts',
        ), 'utf8');
        expect(thumbnails).toContain('source.rasterScheduler');
        expect(thumbnails).not.toContain('getPdfPageRasterScheduler');
    });

    it('has no superseded raster or initial-canvas controller files', () => {
        for (const path of [
            'runtime/lifecycle/usePdfInitialCanvasCommitCoordinator.ts',
            'runtime/rendering/usePdfRendererCanvasController.ts',
            'runtime/rendering/usePdfRendererRerenderController.ts',
            'runtime/rendering/usePdfRendererSinglePageController.ts',
            'runtime/rendering/usePdfRendererVisibleRenderController.ts',
            'runtime/rendering/usePdfRendererCleanupController.ts',
            'runtime/rendering/usePdfRendererPageRegistry.ts',
        ]) {
            expect(existsSync(resolve(
                process.cwd(),
                `app/modules/pdf-viewer/${path}`,
            )), path).toBe(false);
        }
    });
});
