import {
    readdirSync,
    readFileSync,
    statSync,
} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const root = process.cwd();
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8');

function collectStyleSources(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) {
            return collectStyleSources(path);
        }
        return /\.(?:css|scss|ts|vue)$/u.test(name) ? [path] : [];
    });
}

describe('balanced scrollbar-gutter architecture', () => {
    it('defines one shared balanced policy without one-sided CSS overrides', () => {
        const sharedStyles = read('app/assets/css/main.css');
        expect(sharedStyles).toMatch(
            /\.app-scrollbar\s*\{[^}]*scrollbar-color:/su,
        );
        expect(sharedStyles).toMatch(
            /\.app-scroll-region--balanced\s*\{[^}]*scrollbar-gutter: stable both-edges;/su,
        );
        expect(sharedStyles).toMatch(
            /\.app-panel-scroll\s*\{[^}]*scrollbar-gutter: stable both-edges;/su,
        );

        const oneSidedDeclarations = collectStyleSources(join(root, 'app'))
            .flatMap((path) => {
                const source = readFileSync(path, 'utf8');
                return /scrollbar-gutter:\s*stable\s*;/u.test(source) ? [path] : [];
            });
        expect(oneSidedDeclarations).toEqual([]);
    });

    it('keeps every explicit application scroll source in a reviewed inventory', () => {
        const scrollDeclaration = /overflow(?:-[xy])?\s*:\s*(?:auto|scroll)|\boverflow-(?:[xy]-)?(?:auto|scroll)\b/u;
        const locallyBalanced = [
            'app/app.vue',
            'app/assets/css/main.css',
            'app/components/AppFailureAlert.vue',
            'app/components/AppFatalRuntimeDialog.vue',
            'app/components/AppToolPageShell.vue',
            'app/components/combine/CombinePdfPage.vue',
            'app/components/document-viewer/DocumentBookmarkTree.vue',
            'app/components/document-viewer/DocumentSearchResults.vue',
            'app/components/document-viewer/DocumentThumbnailRail.vue',
            'app/modules/agent-panel/components/AssistantTurnStatus.vue',
            'app/modules/ocr-panel/components/OcrPopup.vue',
            'app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue',
            'app/modules/pdf-viewer/components/PdfEmptyState.vue',
            'app/modules/pdf-viewer/components/PdfOutline.vue',
            'app/modules/scan-cleanup/components/ScanCleanupWorkspace.vue',
        ];
        const balancedByOwningComponent = [
            'app/assets/css/pdf-viewer.scss',
            'app/modules/agent-panel/components/AgentAssistantPanel.shell.css',
        ];
        const horizontalOrHidden = [
            'app/components/settings/SettingsAgentPanel.vue',
            'app/modules/agent-panel/components/AgentAssistantPanel.composer.css',
            'app/modules/pdf-viewer/components/PdfToolbar.vue',
            'app/modules/workspace-shell/components/layout/TabBar.vue',
        ];
        const dormantVendorScrollers = ['app/assets/css/vendor/pdfjs-viewer-sanitized.css'];
        const actual = collectStyleSources(join(root, 'app'))
            .filter(path => scrollDeclaration.test(readFileSync(path, 'utf8')))
            .map(path => path.slice(root.length + 1))
            .sort();

        expect(actual).toEqual([
            ...locallyBalanced,
            ...balancedByOwningComponent,
            ...horizontalOrHidden,
            ...dormantVendorScrollers,
        ].sort());
        for (const path of locallyBalanced) {
            expect(read(path), path).toMatch(
                /app-scroll-region--balanced|app-panel-scroll|scrollbar-gutter:\s*stable both-edges/u,
            );
        }

        // The companion templates own the shared class for split Vue/CSS files.
        expect(read('app/modules/pdf-viewer/components/PdfViewerViewport.vue'))
            .toContain('app-scroll-region--balanced');
        expect(read('app/modules/agent-panel/components/AgentAssistantPanel.vue'))
            .toContain('app-scroll-region--balanced');
        expect(read('app/modules/scan-cleanup/components/settings/ScanCleanupSettingsPanel.vue'))
            .toContain('app-scroll-region--balanced');
        expect(read('app/modules/pdf-viewer/components/PdfThumbnails.vue'))
            .toContain('DocumentThumbnailRail');
        expect(read('app/components/document-viewer/DocumentThumbnailList.vue'))
            .toContain('DocumentThumbnailRail');
    });

    it('covers framework-created vertical scroll regions through shared UI slots', () => {
        const appConfig = read('app/app.config.ts');

        for (const component of [
            'dropdownMenu',
            'select',
            'selectMenu',
        ]) {
            expect(appConfig).toMatch(
                new RegExp(`${component}:[\\s\\S]*?viewport: 'app-scrollbar app-scroll-region--balanced'`, 'u'),
            );
        }
        expect(appConfig).toMatch(
            /modal:[\s\S]*?body: 'app-scrollbar'/u,
        );
        expect(appConfig).toMatch(
            /false:[\s\S]*?body: 'app-scroll-region--balanced'/u,
        );
        expect(appConfig).toMatch(
            /footer: 'overflow-hidden app-scroll-region--balanced'/u,
        );
        expect(appConfig).toMatch(
            /header: 'overflow-hidden app-scroll-region--balanced'/u,
        );
        expect(appConfig).toMatch(
            /true:[\s\S]*?overlay: 'app-scrollbar app-scroll-region--balanced'/u,
        );
    });

    it('caps only potentially tall floating surfaces with one balanced owner', () => {
        const floatingOwnerClass = 'app-floating-scroll-region app-scrollbar app-scroll-region--balanced';
        for (const path of [
            'app/modules/agent-panel/components/AssistantEffortSwitcher.vue',
            'app/modules/agent-panel/components/AssistantModelSwitcher.vue',
            'app/modules/pdf-viewer/components/PdfContextMenuBase.vue',
            'app/modules/pdf-viewer/components/PdfZoomDropdown.vue',
        ]) {
            expect(read(path), path).toContain(floatingOwnerClass);
        }
        expect(read('app/modules/agent-panel/components/AssistantSpeedSwitcher.vue'))
            .not.toContain('app-floating-scroll-region');
        expect(read('app/modules/pdf-viewer/components/PdfAnnotationsPanel.vue'))
            .not.toContain('app-floating-scroll-region');
    });

    it('keeps document scroll roots dynamic and sidebars on one vertical scroll owner', () => {
        const openSurface = read(
            'app/utils/document-viewer/chassis/documentOpenSurfaceSession.ts',
        );
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');
        const sidebarShell = read('app/components/sidebar/AppSidebarShell.vue');
        const pdfSidebar = read('app/modules/pdf-viewer/components/PdfSidebar.vue');

        expect(openSurface).toContain('scrollbarGutter: \'stable\'');
        expect(chassis).toContain('scrollbarGutter: policy.scrollbarGutter');
        expect(chassis).not.toMatch(/scrollbar-gutter:\s*(?:auto|stable)/u);
        expect(chassis).not.toContain('app-scroll-region--balanced');
        expect(sidebarShell).toContain('outerScroll = false');
        expect(pdfSidebar).toContain(':outer-scroll="false"');
        expect(pdfSidebar).not.toMatch(/:outer-scroll="[^"]*activeTab/u);
    });
});
