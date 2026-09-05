import {
    readFileSync,
    realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const root = realpathSync(process.cwd());
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8');

describe('document viewer architecture boundaries', () => {
    it('mounts exactly one source-neutral viewport outside feature packs', () => {
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');
        expect(chassis.match(/<DocumentViewportHost/gu)).toHaveLength(1);

        for (const path of [
            'app/modules/pdf-viewer/components/PdfViewerViewport.vue',
            'app/modules/native-pdf-viewer/components/NativePdfViewer.vue',
            'app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue',
        ]) {
            expect(read(path), path).not.toContain('<DocumentViewportHost');
        }
    });

    it('keeps renderer pixel mutations behind the chassis write port', () => {
        for (const path of [
            'app/modules/native-pdf-viewer/components/NativePdfViewer.vue',
            'app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime.ts',
            'app/modules/pdf-viewer/runtime/composables/pdf/usePdfDrag.ts',
        ]) {
            const source = read(path);
            expect(source, path).not.toMatch(/\.scroll(?:Top|Left)\s*[-+]?=/u);
            expect(source, path).not.toMatch(/\.scrollTo\s*\(/u);
            expect(source, path).toContain('viewportWritePort');
        }
    });

    it('projects every renderer into the same viewport chrome', () => {
        const pdfViewport = read('app/modules/pdf-viewer/components/PdfViewerViewport.vue');
        const sourceFeature = read('app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime.ts');
        const sharedStyles = read('app/assets/css/main.css');

        expect(pdfViewport).toContain('document-viewer-viewport pdfViewer app-scrollbar');
        expect(sourceFeature).toContain('document-viewer-viewport document-source-viewer app-scrollbar');
        expect(sharedStyles).toMatch(
            /\.document-viewer-viewport\s*\{[^}]*background: var\(--app-document-viewer-bg\);/su,
        );
        expect(read('app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue')).not.toMatch(/--app-pdf-(?:viewer|page)/u);
        expect(read('app/modules/workspace-shell/components/DocumentViewerChassis.vue'))
            .not.toMatch(/--app-pdf-(?:viewer|page)/u);
    });

    it('owns pending page presentation in the shared document layer', () => {
        const sharedSkeletonPath = 'app/components/document-viewer/DocumentPageSkeleton.vue';
        const sharedSkeleton = read(sharedSkeletonPath);
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');
        const nativeViewer = read('app/modules/native-pdf-viewer/components/NativePdfViewer.vue');
        const nativeViewerStyles = read('app/modules/native-pdf-viewer/components/NativePdfViewer.css');

        expect(sharedSkeleton).toContain('class="document-page-skeleton"');
        expect(sharedSkeleton).toContain('<USkeleton');
        expect(sharedSkeleton).toContain('var(--app-z-document-page-skeleton)');
        expect(sharedSkeleton).not.toContain('document-page-skeleton__progress');
        expect(sharedSkeleton).not.toContain('document-page-skeleton__sheen');
        expect(sharedSkeleton).not.toMatch(/var\(--app-(?:z-)?pdf/u);

        for (const path of [
            'app/modules/pdf-viewer/components/PdfViewerPage.vue',
            'app/modules/pdf-viewer/components/PdfInitialSurfacePlaceholder.vue',
            'app/modules/native-pdf-viewer/components/NativePdfPageContent.vue',
            'app/modules/workspace-shell/components/DocumentViewerChassis.vue',
            'app/modules/workspace-shell/components/DocumentPageSourcePageVisual.vue',
        ]) {
            expect(read(path), path).toContain(
                '@app/components/document-viewer/DocumentPageSkeleton.vue',
            );
        }

        const sharedStyles = read('app/assets/css/main.css');
        expect(sharedStyles).not.toContain('@keyframes document-page-visual-commit');
        expect(chassis).toContain(
            '.document-viewer-chassis[data-open-surface-presentation=\'page-shell\'] :deep(.page_canvas)',
        );
        expect(chassis).toContain(
            '.document-viewer-chassis[data-open-surface-presentation=\'page-shell\'] :deep(.native-pdf-page-shell)',
        );
        expect(chassis).toContain(
            '.document-viewer-chassis[data-open-surface-presentation=\'page-shell\'] :deep(.document-source-viewer__page)',
        );
        expect(chassis).not.toContain('<Transition name="document-opening-page">');
        expect(nativeViewer).toContain('class="native-pdf-viewer relative h-full w-full"');
        expect(nativeViewerStyles).toMatch(
            /\.native-pdf-viewer-container--initial-visual-pending\s*>\s*\.native-pdf-viewer\s*\{/u,
        );
        expect(nativeViewerStyles).not.toMatch(
            /\.native-pdf-viewer-container--initial-visual-pending\s*>\s*(?:div|\*)\s*\{/u,
        );
        for (const path of [
            'app/modules/pdf-viewer/components/PdfViewerPage.vue',
            'app/modules/native-pdf-viewer/components/NativePdfPageContent.vue',
            'app/modules/workspace-shell/components/DocumentPageSourcePageVisual.vue',
        ]) {
            expect(read(path), path).toContain('document-page-visual--committed');
        }
    });

    it('keeps document status above the shared opening transition layer', () => {
        const sharedStyles = read('app/assets/css/main.css');
        const banner = read('app/modules/djvu-viewer/components/DjvuBanner.vue');
        const alerts = read('app/modules/workspace-shell/components/WorkspaceDocumentAlerts.vue');

        expect(sharedStyles).toContain('--app-z-document-status: 65');
        expect(sharedStyles).toContain('--app-workspace-transition-overlay-z-index: var(--app-z-modal)');
        expect(sharedStyles).toContain('.document-status-enter-active');
        expect(sharedStyles).toContain('@media (prefers-reduced-motion: reduce)');
        expect(banner).toContain('z-index: var(--app-z-document-status)');
        expect(banner).not.toContain('z-index: var(--app-z-banner)');
        expect(banner).not.toMatch(/Opening DjVu|isOpening|aria-busy|AppSpinner/u);
        expect(alerts).toContain('<Transition name="document-status">');
    });

    it('treats tab transitions as semantic viewer layout resizes and gates hidden sidebar work', () => {
        const workspace = read('app/modules/workspace-shell/components/DocumentWorkspace.vue');

        expect(workspace).toMatch(
            /isActiveViewerLayoutResizing\s*=\s*computed\(\(\)\s*=>\s*\([\s\S]*?isTabTransitionBusy[\s\S]*?\)\);/u,
        );
        expect(workspace).toMatch(
            /const\s+isDocumentSidebarActive\s*=\s*computed\(\(\)\s*=>\s*\(\s*surfaceMode\.value\s*===\s*'reader'\s*&&\s*\(\s*isActive\s*\|\|\s*isRenderActive\s*\|\|\s*isActiveViewerLayoutResizing\.value\s*\)\s*\)\s*\);/u,
        );
        expect(workspace).toContain(':is-active="isDocumentSidebarActive"');
        expect(workspace).toMatch(
            /:is-resizing="\s*isActiveViewerLayoutResizing\s*\|\|\s*\(\s*isRenderActive\s*&&\s*!isActive\s*\)\s*"/u,
        );
    });

    it('sequences every renderer activation through the shared visible-layout barrier', () => {
        for (const path of [
            'app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore.ts',
            'app/modules/workspace-shell/viewers/documentPageSourcePresentation.ts',
        ]) {
            const source = read(path);
            expect(source, path).toContain('runDocumentViewerActivationPresentation');
            expect(source, path).toContain('waitForDocumentViewerVisibleLayout');
        }
        expect(read('app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime.ts'))
            .toContain('presentation.restore(transition');
    });

    it('owns resize anchoring in the shared chassis with neutral page markers', () => {
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');
        const pdfPage = read('app/modules/pdf-viewer/components/PdfViewerPage.vue');
        const sourceFeature = read('app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue');

        expect(chassis).toContain('captureDocumentViewportResizeAnchor');
        expect(chassis).toContain('chassisAuthority.viewportWritePort.apply');
        expect(pdfPage).toContain(':data-document-page-number="page"');
        expect(sourceFeature).toContain(':data-document-page-number="pageNumber"');
    });

    it('owns PDF-unit paint scaling in one live shared contract', () => {
        const scaleContract = read(
            'app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale.ts',
        );
        const annotationEditorLayer = read('app/modules/pdf-viewer/components/PdfAnnotationEditorLayer.vue');
        const page = read('app/modules/pdf-viewer/components/PdfViewerPage.vue');

        expect(scaleContract).toContain('buildPdfPageScaleStyle');
        expect(scaleContract).toContain('toPdfScaledCssLength');
        expect(page).toContain('pageScaleStyle');
        expect(annotationEditorLayer).toContain('PdfShapeAnnotation');
        expect(annotationEditorLayer).not.toContain('getComputedStyle');
        expect(annotationEditorLayer).not.toContain('pdfToCssScale');

        for (const path of [
            'app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization.ts',
            'app/modules/pdf-viewer/engine/pdf-page-buffer-manager/setupPagePlaceholderSizes.ts',
        ]) {
            expect(read(path), path).toContain('buildPdfPageScaleStyle');
            expect(read(path), path).not.toContain('\'--total-scale-factor\'');
        }

    });

    it('exposes one sidebar host contract for every document renderer', () => {
        const pdfSidebar = read('app/modules/pdf-viewer/components/PdfSidebar.vue');
        const sourceSidebar = read('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');

        expect(pdfSidebar).toContain('data-testid="document-sidebar"');
        expect(sourceSidebar).toContain('data-testid="document-sidebar"');
    });

    it('advertises source search independently from page-text extraction', () => {
        const sourceFeature = read('app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState.ts');

        expect(sourceFeature).toContain(
            'search: Boolean(nextSource.searchProvider ?? nextSource.textProvider)',
        );
        expect(sourceFeature).toContain('text: Boolean(nextSource.textProvider)');
    });
});
