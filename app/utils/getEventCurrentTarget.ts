interface IElementConstructor<TElement extends Element> {
    new (...args: never[]): TElement;
}

export function getEventCurrentTarget<TElement extends Element>(event: Event, constructor: IElementConstructor<TElement>) {
    return event.currentTarget instanceof constructor ? event.currentTarget : null;
}
