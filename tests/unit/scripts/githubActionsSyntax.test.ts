import {
    describe,
    expect,
    it,
} from 'vitest';
import {readFile} from 'node:fs/promises';
import {
    assertGithubActionsYamlSyntax,
    checkGithubActionsSyntax,
} from '@scripts/checkGithubActionsSyntax';

const PINNED_ACTION_PATTERN = /uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})\b/gu;

describe('GitHub Actions YAML syntax', () => {
    it('parses every checked-in workflow and composite action', async () => {
        const files = await checkGithubActionsSyntax();

        expect(files).toContain('.github/workflows/ci.yml');
        expect(files).toContain('.github/workflows/release.yml');
        expect(files).toContain('.github/actions/upload-electron-e2e-artifacts/action.yml');
    });

    it('reports the source location for an unquoted colon scalar regression', () => {
        expect(() => assertGithubActionsYamlSyntax([
            'name: Broken',
            'jobs:',
            '  check:',
            '    steps:',
            '      - run: command --only-binary=:all: -r requirements.txt',
        ].join('\n'), '.github/workflows/broken.yml')).toThrow(
            /\.github\/workflows\/broken\.yml:5:\d+:/u,
        );
    });

    it('pins each action to one commit SHA across workflows and composite actions', async () => {
        const files = await checkGithubActionsSyntax();
        const pinsByAction = new Map<string, Map<string, string[]>>();
        for (const file of files) {
            const content = await readFile(file, 'utf8');
            for (const match of content.matchAll(PINNED_ACTION_PATTERN)) {
                const [
                    , action,
                    sha,
                ] = match;
                if (action === undefined || sha === undefined) {
                    continue;
                }
                const shas = pinsByAction.get(action) ?? new Map<string, string[]>();
                shas.set(sha, [
                    ...(shas.get(sha) ?? []),
                    file,
                ]);
                pinsByAction.set(action, shas);
            }
        }

        expect(pinsByAction.get('actions/checkout')?.size).toBe(1);
        const divergent = [...pinsByAction]
            .filter(([
                , shas,
            ]) => shas.size > 1)
            .map(([
                action,
                shas,
            ]) => `${action}: ${[...shas].map(([
                sha,
                where,
            ]) => `${sha} (${where.join(', ')})`).join(' vs ')}`);
        expect(divergent).toEqual([]);
    });
});
