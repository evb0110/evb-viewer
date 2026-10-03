import type { Page } from 'puppeteer-core';
import type {
    TApplicationMenuItemActivation,
    TApplicationMenuItemQuery,
} from '@electron/menu';

// A CDP key event reaches only the renderer, and on macOS the application
// menu's key equivalents need a native event, so `page.keyboard` never presses
// a menu accelerator there. The main process runs the item instead: the same
// item, its enabled and visible state, and the window an accelerator targets.
// OS key routing itself stays outside this; only a visible window covers it.

interface IMenuAutomationWindow {__activateMenuItemForAutomation?: (query: TApplicationMenuItemQuery) => Promise<TApplicationMenuItemActivation>;}

/** Runs the application-menu item with this id or accelerator, as pressing its accelerator would. */
export function activateElectronMenuItem(page: Page, query: TApplicationMenuItemQuery) {
    return page.evaluate(async (menuQuery: TApplicationMenuItemQuery) => {
        const activate = (window as IMenuAutomationWindow).__activateMenuItemForAutomation;
        if (typeof activate !== 'function') {
            throw new Error('This session does not expose menu automation');
        }
        return activate(menuQuery);
    }, query);
}
