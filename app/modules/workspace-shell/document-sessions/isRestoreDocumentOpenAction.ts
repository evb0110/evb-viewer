/** Restore actions reopen a document the tab already owned, such as a session or recovery restore. */
export function isRestoreDocumentOpenAction(action: string) {
    return action.toLowerCase().includes('restore');
}
