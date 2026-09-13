/**
 * The generic thumbnail rail's component contract, kept next to the shared
 * controller so every format that mounts the rail agrees on it.
 *
 * `go-to-page` carries the pointer event that activated the row, unchanged.
 * Selection intent lives entirely in that event's modifier keys, so a consumer
 * that wants ctrl/shift multi-select reads them off the user's own click
 * instead of rebuilding a synthetic event from data it never received. A
 * consumer that only navigates ignores the second argument, which is why
 * adding it changes nothing for single-select callers. A sidebar that mixes
 * thumbnail rows with rows that carry no selection meaning, such as bookmark
 * entries, republishes the event as optional.
 */
export interface IDocumentThumbnailListEmits {'go-to-page': [pageNumber: number, event: MouseEvent];}
