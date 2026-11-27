import type {TMenuEventUnsubscribe} from '@contracts/electronApiCommon';

function noopUnsubscribe(): TMenuEventUnsubscribe {
    return () => {};
}

export {noopUnsubscribe};
