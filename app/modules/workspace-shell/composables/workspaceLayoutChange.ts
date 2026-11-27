import type { Ref } from 'vue';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

/**
 * Runs `change`, which calls `fence` before it changes the panes' layout, and
 * settles once the views that layout change moved show their reading points
 * again. A change that never calls `fence` changes no layout and waits for none.
 */
export type TChangeWorkspaceLayout = (change: (fence: () => Promise<void>) => unknown) => Promise<void>;

/**
 * A split, or the collapse when a split pane's last tab closes, changes the
 * grid's slots: Teleport moves a pane into its new slot, which resets the
 * pane's scroll offset, and the views it shows change size. Through the
 * workspace's resize fence each view keeps the point it showed before the
 * move. Once the change has run, including the tab transition it queued, the
 * views place that point in their new boxes; once the fence is released,
 * again.
 *
 * Changes can overlap, as a split queued behind a collapse does: the fence
 * holds until the last of them ends, which places the views once more after
 * it falls. An earlier one ends without waiting for a later one, which may be
 * queued behind it.
 */
export function createWorkspaceLayoutChange(options: {
    setWorkspaceLayoutResizing: (value: boolean) => void;
    documentSessionsByTabId: Readonly<Ref<Record<string, IWorkspaceDocumentController>>>;
}): TChangeWorkspaceLayout {
    let fences = 0;

    // Each view settles at once unless its box changed or it is opening.
    async function whenViewsPlaced() {
        const controllers = new Set(Object.values(options.documentSessionsByTabId.value));
        await Promise.all([...controllers].flatMap(controller => [...controller.views.value.values()])
            .map(view => view.mountedWorkspace.value?.whenLayoutPlaced?.()));
    }

    return async (change) => {
        let fenced = false;
        const fence = async () => {
            if (fenced) {return;}
            fenced = true;
            fences += 1;
            options.setWorkspaceLayoutResizing(true);
            // The views read the fence as a prop, which reaches them in Vue's
            // next render; they take their point from the DOM then. Rendered
            // with the change, the grid's Teleport would move the pane first,
            // and they would read its reset offset.
            await nextTick();
        };
        try {
            await change(fence);
            if (fenced) {
                // The new slots are laid out and a new pane's view is mounted.
                await nextTick();
                await whenViewsPlaced();
            }
        } finally {
            if (fenced) {
                fences -= 1;
                if (fences === 0) {
                    options.setWorkspaceLayoutResizing(false);
                    // Releasing the fence places each view's point once more after the prop reaches it.
                    await nextTick();
                    await whenViewsPlaced();
                }
            }
        }
    };
}
