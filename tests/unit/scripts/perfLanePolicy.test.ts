import {readFile} from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('large-document performance lane policy', () => {
    it('keeps the exact fixtures, runner, native environment, and evidence contract', async () => {
        const workflow = await readFile('.github/workflows/perf-lane.yml', 'utf8');

        expect(workflow).toContain('cron: \'17 2 * * *\'');
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow.match(/runs-on: ubuntu-22\.04/gu)).toHaveLength(4);
        expect(workflow).toContain('FIXTURE_REPOSITORY: evb0110/evb-viewer-fixtures');
        expect(workflow).toContain('FIXTURE_RELEASE_TAG: fixtures-2026-08-31');
        expect(workflow).toContain('1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6');
        expect(workflow).toContain('5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea');
        expect(workflow.match(/EVB_PDF_PAGE_OPS_ENABLE: '1'/gu)).toHaveLength(2);
        expect(workflow.match(/\[a\]utomation-electron-app-entry/gu)).toHaveLength(2);
        expect(workflow).toContain('xlarge-document-acceptance.json');
        expect(workflow).toContain('GITHUB_STEP_SUMMARY');
        expect(workflow).toContain('gh issue create');
        expect(workflow).not.toContain('vps-420c0bae.vps.ovh.net');
        expect(workflow).not.toContain('continue-on-error: true');
    });
});
