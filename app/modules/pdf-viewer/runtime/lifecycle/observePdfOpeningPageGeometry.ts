/**
 * Commits the opening page's geometry once its container has a size. A
 * zero-sized container has no geometry yet; its own resize is the
 * notification that it has some. Observing ends once the geometry commits,
 * once the opening no longer needs it from this page (another page or
 * generation, or a geometry committed elsewhere), and through the returned
 * stop on unmount.
 */
export function observePdfOpeningPageGeometry(options: {
    pageContainer: HTMLElement;
    /** Reactive: whether this page of this generation still owes the opening geometry. */
    isCurrent: () => boolean;
    /** Commits the geometry; false while it cannot commit yet. */
    commit: () => boolean;
}) {
    const observer = new ResizeObserver(() => {
        if (!options.isCurrent() || !options.pageContainer.isConnected) {
            stop();
            return;
        }
        const rect = options.pageContainer.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && options.commit()) {
            stop();
        }
    });
    const stopCurrencyWatch = watch(options.isCurrent, (current) => {
        if (!current) stop();
    }, {flush: 'sync'});
    function stop() {
        observer.disconnect();
        stopCurrencyWatch();
    }
    // The first observation reports the size at once, so a container that
    // gained its size before this call commits in the same frame.
    observer.observe(options.pageContainer);
    return stop;
}
