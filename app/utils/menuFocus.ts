/**
 * Whether focus has moved from a closing menu to another control, such as a
 * dialog one of its commands opened. A menu then leaves focus there instead of
 * returning it to its trigger.
 */
export function hasFocusLeftMenu(event: Event) {
    const focused = document.activeElement;
    return focused !== null && focused !== document.body
        && !(event.target instanceof Node && event.target.contains(focused));
}

/** A menu's close-autofocus hook: focus returns to the trigger unless it moved on. */
export function keepMovedFocus(event: Event) {
    if (hasFocusLeftMenu(event)) {
        event.preventDefault();
    }
}

/**
 * An open menu whose focused entry becomes disabled, as when another document
 * becomes active, loses focus to the page. Focus then moves to the menu panel,
 * so arrow keys and typeahead keep working.
 */
export function keepMenuFocusWhenItemsChange(isOpen: () => boolean, items: () => unknown, panelSelector: string) {
    watch(items, async () => {
        await nextTick();
        // A submenu opens its own panel of the same kind, portalled apart from the root.
        const panels = [...document.querySelectorAll<HTMLElement>(panelSelector)];
        const focused = document.activeElement;
        // Focus is still on an entry of this menu that just became disabled, or lost already.
        const owner = focused instanceof HTMLElement && focused.matches(':disabled')
            ? panels.find(panel => panel.contains(focused))
            : undefined;
        if (isOpen() && (owner || focused === document.body)) {
            (owner ?? panels.at(-1))?.focus();
        }
    }, {flush: 'post'});
}
