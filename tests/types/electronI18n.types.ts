import {te} from '@electron/te';

te('export.scopeCurrent', {page: 1});
te('pageNumbering.pageWord', 2);
te('toolbar.openPdf');

// @ts-expect-error export.scopeCurrent requires page
te('export.scopeCurrent');

// @ts-expect-error pageNumbering.pageWord requires count
te('pageNumbering.pageWord');

// @ts-expect-error toolbar.openPdf does not accept params
te('toolbar.openPdf', {count: 1});
