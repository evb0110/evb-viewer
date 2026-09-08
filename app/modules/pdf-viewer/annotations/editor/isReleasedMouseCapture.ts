export function isReleasedMouseCapture(event: Pick<PointerEvent, 'type' | 'pointerType' | 'buttons'>) {
    // Chromium can drop capture on a final mousemove with released buttons,
    // before it delivers pointerup. That sequence completes the gesture.
    return event.type === 'lostpointercapture'
        && event.pointerType === 'mouse'
        && event.buttons === 0;
}
