import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    checkLocaleParity,
    checkNoEnglishSchemaFallbackImport,
} from '@scripts/checkLocales';
import { plural } from '@i18n-core';

const schema = {
    actions: {
        cancel: 'Cancel',
        save: 'Save {name}',
    },
    title: 'Example',
};

describe('locale parity checker', () => {
    it('reports every missing key with its locale', () => {
        expect(checkLocaleParity('desktop', schema, {de: {actions: {cancel: 'Abbrechen'}}})).toEqual([
            'desktop locale "de" missing key "actions.save"',
            'desktop locale "de" missing key "title"',
        ]);
    });

    it('reports every extra key with its locale', () => {
        expect(checkLocaleParity('desktop', schema, {fr: {
            actions: {
                cancel: 'Annuler',
                save: 'Enregistrer {name}',
            },
            obsolete: 'Obsolète',
            title: 'Exemple',
        }})).toEqual(['desktop locale "fr" extra key "obsolete"']);
    });

    it('accepts a complete locale with matching placeholders', () => {
        expect(checkLocaleParity('desktop', schema, {es: {
            actions: {
                cancel: 'Cancelar',
                save: 'Guardar {name}',
            },
            title: 'Ejemplo',
        }})).toEqual([]);
    });

    it('reports message kind mismatches', () => {
        const pluralSchema = {actions: {selected: plural({
            one: '{count} page',
            other: '{count} pages',
        })}};

        expect(checkLocaleParity('desktop', pluralSchema, {ru: {actions: {selected: 'Выбрано: {count} стр.'}}})).toEqual(['desktop locale "ru" message kind mismatch at "actions.selected": expected=plural; actual=string']);
    });

    it('rejects English fallback aliases for the landing target', () => {
        expect(checkNoEnglishSchemaFallbackImport(
            'landing',
            'de.ts',
            'import en from \'./en\';\nexport default {section: en.section};',
        )).toEqual(['landing locale file "de.ts" imports the English schema as a fallback; define its keys explicitly']);
    });
});
