import {refreshMenu} from '@electron/menu';
import {te} from '@electron/te';
import type {IDocumentsWindowContext} from '@electron/features/documents/documentsContexts';

const MAX_WINDOW_TITLE_LENGTH = 512;

function normalizeWindowTitle(title: unknown) {
    if (typeof title !== 'string') {
        return '';
    }

    return title.trim().slice(0, MAX_WINDOW_TITLE_LENGTH);
}

export function handleSetWindowTitle(context: IDocumentsWindowContext, title: string) {
    if (context.window) {
        const normalizedTitle = normalizeWindowTitle(title);
        context.window.setTitle(normalizedTitle || te('app.title'));
        refreshMenu();
    }
}
