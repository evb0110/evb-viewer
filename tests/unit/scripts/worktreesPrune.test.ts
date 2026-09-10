import {
    describe,
    expect,
    it,
} from 'vitest';

import {
    classifyWorktree,
    parseArgs,
    parseWorktreeList,
} from '@scripts/worktrees-prune.mjs';

describe('worktrees prune', () => {
    it('parses porcelain worktree listings including detached and bare entries', () => {
        expect(parseWorktreeList([
            'worktree /repo',
            'HEAD 1111111111111111111111111111111111111111',
            'branch refs/heads/main',
            '',
            'worktree /tmp/ticket-1',
            'HEAD 2222222222222222222222222222222222222222',
            'branch refs/heads/ticket/1',
            '',
            'worktree /tmp/detached',
            'HEAD 3333333333333333333333333333333333333333',
            'detached',
            '',
            'worktree /repo/.bare',
            'bare',
            '',
        ].join('\n'))).toEqual([
            {
                path: '/repo',
                head: '1111111111111111111111111111111111111111',
                branch: 'main',
                detached: false,
                bare: false,
            },
            {
                path: '/tmp/ticket-1',
                head: '2222222222222222222222222222222222222222',
                branch: 'ticket/1',
                detached: false,
                bare: false,
            },
            {
                path: '/tmp/detached',
                head: '3333333333333333333333333333333333333333',
                branch: null,
                detached: true,
                bare: false,
            },
            {
                path: '/repo/.bare',
                head: null,
                branch: null,
                detached: false,
                bare: true,
            },
        ]);
    });

    it('keeps stale registrations without explicit completion evidence and unreadable trees', () => {
        expect(classifyWorktree({
            isPrimary: false,
            containsCwd: false,
            missing: true,
            dirtyEntries: 0,
            mergedInto: [],
        })).toEqual({
            action: 'keep',
            reason: 'stale registration cleanup requires a safe metadata-only operation',
        });
        expect(classifyWorktree({
            isPrimary: false,
            containsCwd: false,
            missing: false,
            dirtyEntries: null,
            mergedInto: ['origin/main'],
        })).toEqual({
            action: 'keep',
            reason: 'git status unavailable',
        });
    });

    it('removes only clean worktrees that are merged into a base ref', () => {
        const base = {
            isPrimary: false,
            containsCwd: false,
            dirtyEntries: 0,
            mergedInto: ['origin/main'],
            selectedTarget: true,
            completedTask: true,
            ownerStatus: 'absent',
        };
        expect(classifyWorktree(base)).toEqual({
            action: 'remove',
            reason: 'completed target merged into origin/main',
        });
        expect(classifyWorktree({
            ...base,
            isPrimary: true,
        }).action).toBe('keep');
        expect(classifyWorktree({
            ...base,
            containsCwd: true,
        }).action).toBe('keep');
        expect(classifyWorktree({
            ...base,
            dirtyEntries: 2,
        })).toEqual({
            action: 'keep',
            reason: '2 uncommitted change(s)',
        });
        expect(classifyWorktree({
            ...base,
            mergedInto: [],
        })).toEqual({
            action: 'keep',
            reason: 'HEAD not merged into any base ref',
        });
        expect(classifyWorktree({
            ...base,
            selectedTarget: false,
            completedTask: true,
            ownerStatus: 'absent',
        })).toEqual({
            action: 'keep',
            reason: 'not the selected cleanup target',
        });
        expect(classifyWorktree({
            ...base,
            selectedTarget: true,
            completedTask: false,
            ownerStatus: 'absent',
        })).toEqual({
            action: 'keep',
            reason: 'completed-task evidence required',
        });
        expect(classifyWorktree({
            ...base,
            selectedTarget: true,
            completedTask: true,
            ownerStatus: 'active',
            ownerReason: 'live',
        })).toEqual({
            action: 'keep',
            reason: 'live',
        });
        expect(classifyWorktree({
            ...base,
            selectedTarget: true,
            completedTask: true,
            ownerStatus: 'absent',
        })).toEqual({
            action: 'remove',
            reason: 'completed target merged into origin/main',
        });
        expect(classifyWorktree({
            ...base,
            missing: true,
            mergedInto: [],
        })).toEqual({
            action: 'keep',
            reason: 'stale registration cleanup requires a safe metadata-only operation',
        });
    });

    it('defaults to a dry run against origin/main and accumulates --into refs', () => {
        expect(parseArgs([])).toEqual({
            apply: false,
            completed: null,
            help: false,
            into: ['origin/main'],
            target: null,
        });
        expect(parseArgs([
            '--into=origin/own-annotations,origin/main',
            '--apply',
        ])).toEqual({
            apply: true,
            completed: null,
            help: false,
            into: [
                'origin/main',
                'origin/own-annotations',
            ],
            target: null,
        });
        expect(() => parseArgs(['--force'])).toThrow('Unknown argument: --force');
    });
});
