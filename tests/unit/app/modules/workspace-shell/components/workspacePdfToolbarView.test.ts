import { readFileSync } from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { workspacePdfToolbarCommands } from '@app/modules/workspace-shell/toolbar/workspacePdfToolbarCommands';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function readWorkspaceFile(path: string) {
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('workspace PDF toolbar wiring', () => {
    it('keeps direct PdfToolbar usage centralized in the workspace presenter', () => {
        const documentWorkspace = readWorkspaceFile('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const shellToolbar = readWorkspaceFile('app/modules/workspace-shell/components/ShellWorkspaceToolbar.vue');
        const presenter = readWorkspaceFile('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue');

        expect(documentWorkspace).toContain('<WorkspacePdfToolbarView');
        expect(shellToolbar).toContain('<WorkspacePdfToolbarView');
        expect(documentWorkspace).not.toContain('<PdfToolbar');
        expect(shellToolbar).not.toContain('<PdfToolbar');
        expect(presenter).toContain('<PdfToolbar');
    });

    it('wires every shared toolbar command in real and shell handoff modes', () => {
        const documentWorkspace = readWorkspaceFile('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const shellToolbar = readWorkspaceFile('app/modules/workspace-shell/components/ShellWorkspaceToolbar.vue');

        for (const command of workspacePdfToolbarCommands) {
            expect(documentWorkspace, `DocumentWorkspace missing @${command}`).toContain(`@${command}=`);
            expect(shellToolbar, `ShellWorkspaceToolbar missing @${command}`).toContain(`@${command}=`);
        }
    });

    it('routes pre-mount shell page commands into the host viewport session', () => {
        const appShell = readWorkspaceFile('app/modules/workspace-shell/components/AppShellRoot.vue');
        const shellToolbar = readWorkspaceFile('app/modules/workspace-shell/components/ShellWorkspaceToolbar.vue');
        const deferredHost = readWorkspaceFile('app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue');

        expect(appShell).toContain('v-on="fallbackToolbarCommandListeners"');
        expect(shellToolbar).toContain('@go-to-page="emit(\'go-to-page\', $event)"');
        expect(deferredHost).toContain('handleGoToPage: (page, options) => {');
        expect(deferredHost).toContain('if (isDocumentOpenInFlight.value || !mountedWorkspace.value)');
        expect(deferredHost).toContain('activeDocumentSession.value.requestDocumentPage(page);');
        expect(deferredHost).toContain('mountedWorkspace.value.handleGoToPage(page, options);');
    });

    it('uses the same opening-document state for live and shell toolbar snapshots', () => {
        const documentWorkspace = readWorkspaceFile('app/modules/workspace-shell/components/DocumentWorkspace.vue');

        expect(documentWorkspace).toContain('isOpeningDocument: isOpeningDocumentForToolbarDisplay.value');
        expect(documentWorkspace).not.toContain('isOpeningDocument: pendingDocumentOpen.value');
    });

    it('keeps page-step navigation command-capable while opening metadata is unknown', () => {
        const presenter = readWorkspaceFile('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue');
        const pageDropdown = readWorkspaceFile('app/modules/pdf-viewer/components/PdfPageDropdown.vue');

        expect(presenter).toContain(':disabled="pageNavigationDisabled"');
        expect(presenter).toContain('toolbarDocumentBusy.value ? false : toolbarControlsDisabled.value');
        expect(pageDropdown).toContain('totalPages > 0 && commandPage >= totalPages');
        expect(pageDropdown).toContain('totalPages <= 0 || commandPage.value < totalPages');
        expect(pageDropdown).toContain(':disabled="disabled || totalPages === 0 || commandPage >= totalPages"');
    });

    it('routes inline, app-menu, and overflow print commands through the shared busy predicate', () => {
        const presenter = readWorkspaceFile('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue');
        const toolbar = readWorkspaceFile('app/modules/pdf-viewer/components/PdfToolbar.vue');
        const appMenu = readWorkspaceFile('app/components/toolbar/ToolbarAppMenu.vue');
        const overflowMenu = readWorkspaceFile('app/components/toolbar/ToolbarOverflowMenu.vue');

        expect(presenter).toContain(':is-any-saving="snapshot.isAnySaving"');
        expect(presenter).toContain(':is-history-busy="snapshot.isHistoryBusy"');
        for (const source of [
            toolbar,
            appMenu,
            overflowMenu,
        ]) {
            expect(source).toContain('isReaderPrintCommandDisabled');
        }
        expect(overflowMenu).toContain('disabled: isPrintCommandDisabled.value');
    });

    it('has a compact, scroll-safe terminal toolbar tier', () => {
        const toolbar = readWorkspaceFile('app/modules/pdf-viewer/components/PdfToolbar.vue');

        expect(toolbar).toContain('const pageCompactLevel = computed');
        expect(toolbar).toContain('const zoomCompactLevel = computed');
        expect(toolbar).toContain('.toolbar[data-collapse-tier=\'5\'] .toolbar-section');
        expect(toolbar).toContain('overflow-x: auto');
        expect(toolbar).toContain('isCommandInline(\'settings\') && !isCollapsed(5)');
        expect(toolbar).toContain('<AssistantToolbarToggle v-if="!isCollapsed(5)"');

        const presenter = readWorkspaceFile('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue');
        const overflow = readWorkspaceFile('app/components/toolbar/ToolbarOverflowMenu.vue');
        expect(presenter).toContain(':can-use-assistant="assistantPanelEnabled"');
        expect(presenter).toContain('@toggle-assistant="toggleAssistantPanel"');
        expect(overflow).toContain('createCommandItem(\'toggle-assistant\'');
    });

    it('reserves scan cleanup and OCR as separate toolbar actions', () => {
        const presenter = readWorkspaceFile('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue');
        const toolbar = readWorkspaceFile('app/modules/pdf-viewer/components/PdfToolbar.vue');

        expect(presenter).toContain('#scan-cleanup="{ isCollapsed }"');
        expect(presenter).toContain('#ocr="{ isCollapsed }"');
        expect(toolbar).toContain('toolbar-action--scan-cleanup');
        expect(toolbar).toContain('toolbar-action--ocr');
        expect(toolbar).not.toContain('<slot name="ocr"><slot');
    });

    it('routes scan cleanup through the tab-local sibling surface instead of popup ownership', () => {
        const documentWorkspace = readWorkspaceFile('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const annotationOverlays = readWorkspaceFile(
            'app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue',
        );
        const workspaceBindings = readWorkspaceFile(
            'app/modules/workspace-shell/composables/createDocumentWorkspaceCommandBindings.ts',
        );
        const presenter = readWorkspaceFile('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue');

        expect(presenter).toContain('\'open-scan-cleanup\': []');
        expect(presenter).toContain('emit(\'open-scan-cleanup\')');
        expect(presenter).not.toContain('ScanCleanupPopup');
        expect(documentWorkspace).toContain('@open-scan-cleanup="openScanCleanup"');
        expect(documentWorkspace).toContain(':is-active="isActive && surfaceMode === \'reader\'"');
        expect(documentWorkspace).toContain('v-show="surfaceMode === \'reader\'"');
        expect(documentWorkspace).toContain('<WorkspaceAnnotationOverlays\n            :visible="surfaceMode === \'reader\'"');
        expect(documentWorkspace).not.toContain('<WorkspaceAnnotationOverlays\n            v-show=');
        expect(annotationOverlays).toContain('<div v-show="visible" class="workspace-annotation-overlays-root">');
        expect(annotationOverlays).toContain('.workspace-annotation-overlays-root {\n    display: contents;\n}');
        expect(documentWorkspace).toContain('v-if="surfaceMode === \'scan-cleanup\'"');
        expect(documentWorkspace).toContain(':toolbar-active="isActive"');
        expect(documentWorkspace).toContain(':can-teleport-toolbar="canTeleportToolbar"');
        expect(documentWorkspace).toContain('@done="closeScanCleanup"');
        expect(documentWorkspace).toContain('function discardScanCleanupState()');
        expect(documentWorkspace).toContain('useDocumentWorkspaceLifecycle({');
        expect(documentWorkspace).toContain('discardScanCleanupState,');
        expect(workspaceBindings).toContain('if (options.surfaceMode.value === \'scan-cleanup\') {');
        expect(workspaceBindings).toContain('options.discardScanCleanupState();');
    });

    it('keeps one document status teleport present in reader and scan-cleanup modes', () => {
        const documentWorkspace = readWorkspaceFile('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const scanCleanupWorkspace = readWorkspaceFile('app/modules/scan-cleanup/components/ScanCleanupWorkspace.vue');
        const surfaceOwners = `${documentWorkspace}\n${scanCleanupWorkspace}`;
        const statusTeleport = documentWorkspace.match(
            /<Teleport\s+[^>]*to="#editor-global-status-host"[^>]*>/u,
        )?.[0];

        expect(surfaceOwners.match(/to="#editor-global-status-host"/gu)).toHaveLength(1);
        expect(statusTeleport).toContain('v-if="isActive && canTeleportStatus"');
        expect(documentWorkspace).toContain('<PdfStatusBar');
        for (const surfaceMode of [
            'reader',
            'scan-cleanup',
        ]) {
            expect(
                statusTeleport?.includes('surfaceMode'),
                `status content must remain present in ${surfaceMode} mode`,
            ).toBe(false);
        }
    });
});
