export interface IPointerDownTargetFixture {closest: (selector: string) => unknown;}

export function createPointerDownEvent(target: EventTarget | IPointerDownTargetFixture): PointerEvent {
    const event = new Event('pointerdown');
    Object.defineProperty(event, 'target', {
        configurable: true,
        value: target,
    });

    // happy-dom does not provide the PointerEvent shape used by this listener.
    return event as PointerEvent;
}
