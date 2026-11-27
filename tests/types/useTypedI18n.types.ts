import {useTypedI18n} from '@app/composables/useTypedI18n';

const {t} = useTypedI18n();

t('export.scopeAll', {count: 2});
t('searchResults.resultCount', 3);
t('pageNumbering.pageWord', 3);
t('print.summary', {
    count: 3,
    layout: 'single',
    orientation: 'portrait',
});
t('searchResults.pageWithCount', {
    page: 1,
    count: 2,
});
t('toolbar.openPdf');

// @ts-expect-error placeholder params are required for pluralized renderer messages
t('export.scopeAll');

// @ts-expect-error count is required even when the pluralized leaf has no {count} placeholder
t('pageNumbering.pageWord');

// @ts-expect-error count shorthand cannot drop required non-count placeholders
t('print.summary', 3);

// @ts-expect-error count shorthand cannot drop required non-count placeholders
t('searchResults.pageWithCount', 2);

// @ts-expect-error params are not allowed for plain renderer messages
t('toolbar.openPdf', {count: 1});

// @ts-expect-error count shorthand is only valid for messages that accept count
t('toolbar.openPdf', 1);

const mixedKey: 'toolbar.openPdf' | 'searchResults.resultCount' = Math.random() > 0.5 ? 'toolbar.openPdf' : 'searchResults.resultCount';

t(mixedKey, {count: 2});

// @ts-expect-error count shorthand must be rejected when a union key includes a plain message
t(mixedKey, 2);

// @ts-expect-error undefined params must be rejected when a union key includes a plural message
t(mixedKey, undefined);

const pluralUnionKey: 'searchResults.resultCount' | 'searchResults.pageWithCount' =
    Math.random() > 0.5 ? 'searchResults.resultCount' : 'searchResults.pageWithCount';

t(pluralUnionKey, {
    count: 2,
    page: 1,
});

// @ts-expect-error union of plural keys must still require placeholders from every branch
t(pluralUnionKey, {count: 2});

// @ts-expect-error count shorthand must be rejected when any union branch requires extra placeholders
t(pluralUnionKey, 2);
