import {
    readdirSync,
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

describe('document search architecture boundaries', () => {
    it('keeps the source sidebar controlled by the workspace search session', () => {
        const sidebar = read('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');

        expect(sidebar).toContain('defineModel<TDocumentSidebarTab>(\'activeTab\'');
        expect(sidebar).toContain('searchSession: IDocumentSearchSession');
        expect(sidebar).toContain('<DocumentSearchPanel');
        expect(sidebar).not.toContain('const searchQuery = ref(\'\')');
        expect(sidebar).not.toContain('searchDocumentTextProvider');
        expect(sidebar).not.toContain('useDocumentSearchSession');

        const workspace = read('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const sourceSidebarSession = read('app/modules/workspace-shell/composables/useDocumentSourceSidebarSession.ts');
        expect(workspace).toContain('useDocumentSourceSidebarSession');
        expect(sourceSidebarSession).toContain('useDocumentSearchSession');
        expect(sourceSidebarSession).toContain('onNavigate: match => options.onNavigate(match.pageIndex)');
    });

    it('keeps search execution outside shared presentation', () => {
        const panel = read('app/components/document-viewer/DocumentSearchPanel.vue');
        const pdfSidebar = read('app/modules/pdf-viewer/components/PdfSidebar.vue');
        const sourceSidebar = read('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');

        expect(panel).toContain('IDocumentSearchSession');
        expect(panel).not.toContain('IDocumentTextProvider');
        expect(panel).not.toContain('searchDocumentTextProvider');
        expect(panel).not.toContain('usePdfSearch');
        expect(pdfSidebar).toContain('<DocumentSearchPanel');
        expect(sourceSidebar).toContain('<DocumentSearchPanel');
        expect(pdfSidebar).toContain('createPdfDocumentSearchSession');
    });

    it('routes sidebar search cancellation into the PDF search lifecycle', () => {
        const pdfSidebar = read('app/modules/pdf-viewer/components/PdfSidebar.vue');
        const workspace = read('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const searchSidebar = read('app/modules/workspace-shell/composables/useWorkspaceSearchSidebar.ts');
        const pdfSearch = read('app/modules/pdf-viewer/runtime/composables/usePdfSearch.ts');

        expect(pdfSidebar).toContain('cancel: () => emit(\'cancel-search\')');
        expect(pdfSidebar).not.toContain('cancel: () => undefined');
        expect(pdfSidebar).toContain('searchSession.cancel()');
        expect(workspace).toContain('@cancel-search="cancelSearch"');
        expect(searchSidebar).toContain('cancelSearch');
        expect(pdfSearch).toContain('function cancelSearch()');
    });

    it('keeps page-source rendering free of sidebar UI ownership', () => {
        const featurePack = read('app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue');

        expect(featurePack).not.toContain('DocumentSourceSidebar');
        expect(read('app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime.ts')).toContain('\'update:pageSource\'');
    });

    it('projects workspace-owned source search geometry into inert page overlays', () => {
        const featurePack = read('app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue');
        const pageVisual = read('app/modules/workspace-shell/components/DocumentPageSourcePageVisual.vue');
        const searchLayer = read('app/modules/workspace-shell/components/DocumentPageSourceSearchLayer.vue');
        const binding = read('app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts');

        expect(binding).toContain('searchResults: options.documentSourceSearchResults.value');
        expect(binding).toContain('currentSearchResultIndex: options.documentSourceCurrentResultIndex.value');
        expect(featurePack).toContain('<DocumentPageSourcePageVisual');
        expect(pageVisual).toContain('<DocumentPageSourceSearchLayer');
        expect(searchLayer).toContain('resolveDocumentPageSourceSearchHighlights');
        expect(searchLayer).toContain('data-testid="document-page-source-search-highlight"');
        expect(searchLayer).toContain('aria-hidden="true"');
        expect(searchLayer).toMatch(/\.document-source-viewer__search-layer\s*\{[^}]*pointer-events: none;/su);
        expect(searchLayer).toMatch(/\.document-search-highlight\s*\{[^}]*var\(--app-search-highlight-bg\)/su);
        expect(searchLayer).toMatch(/\.document-search-highlight--current\s*\{[^}]*var\(--app-search-highlight-current-bg\)/su);
    });

    it('keeps common document-viewer components free of PDF-specific naming', () => {
        const componentDirectory = join(root, 'app/components/document-viewer');
        const componentNames = readdirSync(componentDirectory)
            .filter(name => name.endsWith('.vue'));

        for (const componentName of componentNames) {
            const source = read(`app/components/document-viewer/${componentName}`);

            expect(source, componentName).not.toMatch(/\bpdf(?:[-_]|[A-Z])/iu);
        }

        // The adapter is intentionally allowed to import the portable PDF-core
        // domain owner. Check the adapter's own implementation and comments,
        // not that approved module specifier.
        const pageLabels = read('app/utils/document-viewer/pageLabels.ts')
            .replaceAll('@pdf-core/pdfPageLabels', '');
        expect(pageLabels).not.toMatch(/\bpdf(?:[-_]|[A-Z])/iu);
    });
});
