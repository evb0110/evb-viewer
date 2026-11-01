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
