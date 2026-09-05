import {
    describe,
    expect,
    it,
} from 'vitest';
import {getAnnotationAuthor} from '@app/services/pdf/getAnnotationAuthor';

describe('getAnnotationAuthor', () => {
    it('prefers a trimmed PDF.js title object', () => {
        expect(getAnnotationAuthor({
            titleObj: {str: '  Alice  '},
            title: 'Fallback',
        })).toBe('Alice');
    });

    it('falls back to a trimmed direct title', () => {
        expect(getAnnotationAuthor({
            titleObj: {str: '  '},
            title: '  Bob ',
        })).toBe('Bob');
    });

    it('returns null when neither title contains an author', () => {
        expect(getAnnotationAuthor({
            titleObj: {str: null},
            title: '  ',
        })).toBeNull();
        expect(getAnnotationAuthor({})).toBeNull();
    });
});
