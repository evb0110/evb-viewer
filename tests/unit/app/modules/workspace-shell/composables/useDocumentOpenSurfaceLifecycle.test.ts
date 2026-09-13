import {
    effectScope,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useDocumentOpenSurfaceLifecycle } from '@app/modules/workspace-shell/composables/useDocumentOpenSurfaceLifecycle';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/chassis/documentOpenSurfaceSession';

describe('useDocumentOpenSurfaceLifecycle', () => {
    it('does not create a second generation when the host already owns the open intent', () => {
        const surface = createDocumentOpenSurfaceSession();
        const hostGeneration = surface.begin({
            documentId: '/documents/scan.pdf',
            documentRevision: 'open-intent:host-1',
        });
        const pending = ref(false);
        const scope = effectScope();

        scope.run(() => useDocumentOpenSurfaceLifecycle({
            openSurface: surface,
            onInitialVisualPending: vi.fn(),
            onInitialVisualReady: vi.fn(),
            pendingDocumentOpen: pending,
            pendingDocumentIdentity: ref('/documents/scan.pdf'),
        }));
        pending.value = true;

        expect(surface.snapshot.value).toMatchObject({
            generation: hostGeneration,
            identity: {
                documentId: '/documents/scan.pdf',
                documentRevision: 'open-intent:host-1',
            },
            phase: 'pending',
        });
        scope.stop();
    });

    it('forwards generic viewer readiness without releasing an unpainted surface', () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: '/documents/scan.pdf',
            documentRevision: 'open-intent:host-1',
        });
        const onInitialVisualReady = vi.fn();
        const scope = effectScope();
        const lifecycle = scope.run(() => useDocumentOpenSurfaceLifecycle({
            openSurface: surface,
            onInitialVisualPending: vi.fn(),
            onInitialVisualReady,
            pendingDocumentOpen: ref(true),
            pendingDocumentIdentity: ref('/documents/scan.pdf'),
        }))!;

        lifecycle.handleDocumentInitialVisualReady();

        expect(onInitialVisualReady).toHaveBeenCalledOnce();
        expect(surface.snapshot.value).toMatchObject({
            generation,
            phase: 'pending',
            presentation: 'idle',
            committedRender: null,
            committedViewport: null,
        });
        scope.stop();
    });
});
