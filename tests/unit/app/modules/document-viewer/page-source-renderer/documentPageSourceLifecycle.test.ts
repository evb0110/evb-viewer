import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    createDocumentPageSourceLifecycle,
    type IDocumentPageSourceTransition,
} from '@app/modules/document-viewer/page-source-renderer/documentPageSourceFeaturePackState';

const documentRef = '/documents/scan.djvu' as TDocumentRef;
const revision = (value: string) => value as TDocumentRevisionToken;

function createHarness() {
    const src = ref<TDocumentRef | null>(documentRef);
    const documentRevision = ref<TDocumentRevisionToken | null>(revision('revision-a'));
    const isActive = ref(true);
    const policyRevision = ref(0);
    const scope = effectScope();
    const lifecycle = scope.run(() => createDocumentPageSourceLifecycle({
        chassisAuthority: null,
        readIsActive: () => isActive.value,
        readRevisionToken: () => documentRevision.value,
        readSrc: () => {
            void policyRevision.value;
            return src.value;
        },
    }))!;
    return {
        documentRevision,
        isActive,
        lifecycle,
        policyRevision,
        scope,
        src,
    };
}

describe('document page-source lifecycle', () => {
    it('reloads a same-src revision with a new immutable four-coordinate fence', async () => {
        const harness = createHarness();
        const transitions: IDocumentPageSourceTransition[] = [];
        harness.lifecycle.channel.subscribe((transition) => {
            transitions.push(transition);
        });
        harness.lifecycle.start();
        await vi.waitFor(() => expect(transitions).toHaveLength(1));

        const first = transitions[0]!;
        harness.policyRevision.value += 1;
        await nextTick();
        expect(transitions).toHaveLength(1);

        harness.documentRevision.value = revision('revision-b');
        await nextTick();
        await vi.waitFor(() => expect(transitions).toHaveLength(2));

        const second = transitions[1]!;
        expect(transitions.map(transition => transition.kind)).toEqual([
            'open',
            'open',
        ]);
        expect(second.fence).toEqual({
            documentRevision: 'revision-b',
            loadGeneration: first.fence.loadGeneration + 1,
            openSurfaceGeneration: null,
            src: documentRef,
        });
        expect(Object.isFrozen(first.fence)).toBe(true);
        expect(Object.isFrozen(second.fence)).toBe(true);
        expect(first.isCurrent()).toBe(false);
        expect(second.isCurrent()).toBe(true);
        harness.scope.stop();
    });

    it('lets B commit while deferred A observes cancellation after supersession', async () => {
        const harness = createHarness();
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const completed: string[] = [];
        const seen: IDocumentPageSourceTransition[] = [];
        harness.lifecycle.channel.subscribe(async (transition) => {
            seen.push(transition);
            if (transition.fence.documentRevision === 'revision-a') {
                await firstGate;
            }
            if (transition.isCurrent()) {
                completed.push(transition.fence.documentRevision!);
            }
        });
        harness.lifecycle.start();
        await vi.waitFor(() => expect(seen).toHaveLength(1));

        harness.documentRevision.value = revision('revision-b');
        await nextTick();
        await vi.waitFor(() => expect(completed).toEqual(['revision-b']));
        expect(seen[0]!.isCurrent()).toBe(false);

        releaseFirst();
        await nextTick();
        expect(completed).toEqual(['revision-b']);
        harness.scope.stop();
    });

    it('publishes open, invalidate, and restore in lifecycle order', async () => {
        const harness = createHarness();
        const kinds: Array<IDocumentPageSourceTransition['kind']> = [];
        harness.lifecycle.channel.subscribe((transition) => {
            kinds.push(transition.kind);
        });
        harness.lifecycle.start();
        await vi.waitFor(() => expect(kinds).toEqual(['open']));

        harness.isActive.value = false;
        await nextTick();
        await vi.waitFor(() => expect(kinds).toEqual([
            'open',
            'invalidate',
        ]));
        harness.isActive.value = true;
        await nextTick();
        await vi.waitFor(() => expect(kinds).toEqual([
            'open',
            'invalidate',
            'restore',
        ]));
        harness.scope.stop();
    });
});
