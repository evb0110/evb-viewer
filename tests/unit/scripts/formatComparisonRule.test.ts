import {
    describe,
    expect,
    it,
} from 'vitest';
import {findFormatComparisonViolations} from '@scripts/architecture/formatComparisonRule.mjs';

describe('findFormatComparisonViolations', () => {
    it('reports binary comparisons in both operand orders', () => {
        const violations = findFormatComparisonViolations(
            'app/modules/workspace-shell/composables/useWorkspaceShell.ts',
            [
                'const first = workspace.driverId === \'pdfjs\';',
                'const second = \'djvu\' !== document.viewerType;',
            ].join('\n'),
        );

        expect(violations).toMatchObject([
            {
                comparisonKind: '===',
                discriminant: 'workspace.driverId',
                formatLiteral: 'pdfjs',
                line: 1,
            },
            {
                comparisonKind: '!==',
                discriminant: 'document.viewerType',
                formatLiteral: 'djvu',
                line: 2,
            },
        ]);
    });

    it('reports optional and computed property-access discriminants', () => {
        const violations = findFormatComparisonViolations(
            'app/modules/workspace-shell/composables/useWorkspaceShell.ts',
            [
                'if (activeDocumentDriver?.id == \'native-pdf\') {}',
                'if (workspace[\'viewerType\'] != \'image\') {}',
            ].join('\n'),
        );

        expect(violations).toHaveLength(2);
        expect(violations[0]).toMatchObject({
            comparisonKind: '==',
            discriminant: 'activeDocumentDriver?.id',
            formatLiteral: 'native-pdf',
        });
        expect(violations[1]).toMatchObject({
            comparisonKind: '!=',
            discriminant: 'workspace[\'viewerType\']',
            formatLiteral: 'image',
        });
    });

    it('reports switch cases for live discriminants', () => {
        const violations = findFormatComparisonViolations(
            'app/modules/workspace-shell/composables/useWorkspaceShell.ts',
            [
                'switch (viewer.driverId) {',
                '    case \'pdf\': return;',
                '    case \'pdfjs\': return;',
                '}',
            ].join('\n'),
        );

        expect(violations).toMatchObject([
            {
                comparisonKind: 'switch-case',
                discriminant: 'viewer.driverId',
                formatLiteral: 'pdf',
                line: 2,
            },
            {
                comparisonKind: 'switch-case',
                discriminant: 'viewer.driverId',
                formatLiteral: 'pdfjs',
                line: 3,
            },
        ]);
    });

    it('parses TypeScript inside a Vue script block and reports its source location', () => {
        const violations = findFormatComparisonViolations(
            'app/modules/workspace-shell/components/WorkspaceShell.vue',
            [
                '<template><div /></template>',
                '<script setup lang="ts" data-note=">">',
                'const show = document.format === \'pdf\';',
                '</script>',
            ].join('\n'),
        );

        expect(violations).toMatchObject([{
            comparisonKind: '===',
            formatLiteral: 'pdf',
            line: 3,
        }]);
    });

    it('ignores comments, prose strings, type unions, and unrelated comparisons', () => {
        const violations = findFormatComparisonViolations(
            'app/modules/workspace-shell/composables/useWorkspaceShell.ts',
            [
                '// workspace.driverId === \'pdf\'',
                'const prose = "document.viewerType === \'djvu\'";',
                'type Format = \'pdf\' | \'djvu\';',
                'const unrelated = file.name === \'pdf\';',
            ].join('\n'),
        );

        expect(violations).toEqual([]);
    });

    it('allows only the exact driver and adapter implementation paths', () => {
        const source = 'if (driver.id === \'djvu\') {}';

        expect(findFormatComparisonViolations(
            'app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts',
            source,
        )).toEqual([]);
        expect(findFormatComparisonViolations(
            'app/modules/workspace-shell/viewers/workspaceViewerAdapters.ts',
            source,
        )).toEqual([]);
        expect(findFormatComparisonViolations(
            'app/modules/workspace-shell/viewers/workspaceDocumentDriverCopy.ts',
            source,
        )).toHaveLength(1);
    });

    it('accepts an explicit additional exact allowed path without filename matching', () => {
        const source = 'if (driver.id === \'image\') {}';

        expect(findFormatComparisonViolations(
            'app\\modules\\workspace-shell\\composables\\useWorkspaceShell.ts',
            source,
            {allowedPaths: ['app\\modules\\workspace-shell\\composables\\useWorkspaceShell.ts']},
        )).toEqual([]);
        expect(findFormatComparisonViolations(
            'app/modules/workspace-shell/composables/useWorkspaceShellCopy.ts',
            source,
            {allowedPaths: ['app/modules/workspace-shell/composables/useWorkspaceShell.ts']},
        )).toHaveLength(1);
    });

    it('normalizes Windows separators in an ordinary violation path', () => {
        const violations = findFormatComparisonViolations(
            'app\\modules\\workspace-shell\\composables\\useWorkspaceShell.ts',
            'if (driver.id === \'pdf\') {}',
        );

        expect(violations).toMatchObject([{
            sourcePath: 'app/modules/workspace-shell/composables/useWorkspaceShell.ts',
            formatLiteral: 'pdf',
        }]);
    });

    it('returns a parse diagnostic instead of silently passing malformed TypeScript', () => {
        const violations = findFormatComparisonViolations(
            'app\\modules\\workspace-shell\\composables\\useWorkspaceShell.ts',
            'if (workspace.driverId === \'pdf\' {',
        );

        expect(violations).toMatchObject([{
            comparisonKind: 'parse-error',
            formatLiteral: null,
            sourcePath: 'app/modules/workspace-shell/composables/useWorkspaceShell.ts',
            line: 1,
        }]);
        expect(violations[0]?.message).toContain(
            'Unable to parse app/modules/workspace-shell/composables/useWorkspaceShell.ts:',
        );
    });
});
