import {
    describe,
    expect,
    it,
} from 'vitest';
import { redactLogText } from '@contracts/redactLogText';

describe('redactLogText', () => {
    it('redacts URL credentials, every query value, and fragments without hiding routing diagnostics', () => {
        const input = 'GET https://alice:secret@updates.example.test:8443/releases/v1/latest.yml?channel=stable&token=s3cr3t&channel=beta&flag#private-section failed';

        expect(redactLogText(input)).toBe(
            'GET https://[redacted]@updates.example.test:8443/releases/v1/latest.yml?channel=[redacted]&token=[redacted]&channel=[redacted]&flag=[redacted]#[redacted] failed',
        );
    });

    it('keeps URL redaction idempotent', () => {
        const input = 'https://user:pass@[::1]:3235/path?access_token=secret&empty=#fragment';
        const redacted = redactLogText(input);

        expect(redactLogText(redacted)).toBe(redacted);
        expect(redacted).toBe(
            'https://[redacted]@[::1]:3235/path?access_token=[redacted]&empty=[redacted]#[redacted]',
        );
    });

    it('keeps generated fragment placeholders idempotent beside unmatched path brackets', () => {
        const redacted = redactLogText('https://host.test/]#');

        expect(redacted).toBe('https://host.test/]#[redacted]');
        expect(redactLogText(redacted)).toBe(redacted);
    });

    it('redacts valid apostrophes and balanced parentheses inside URL secrets', () => {
        const input = 'Request (https://us\'er:pa)ss@host.test/a(b)?token=a\'b)c) failed';

        expect(redactLogText(input)).toBe(
            'Request (https://[redacted]@host.test/a(b)?token=[redacted]) failed',
        );
    });

    it('redacts percent-encoded userinfo and query values', () => {
        expect(redactLogText(
            'https://user%40example.test:pa%3Ass@host.test/path?redirect=https%3A%2F%2Fprivate.test%2F',
        )).toBe(
            'https://[redacted]@host.test/path?redirect=[redacted]',
        );
    });

    it('redacts query text containing URL-canonicalized delimiter characters', () => {
        expect(redactLogText(
            'https://user:pass@host.test/path?token=sec"ret&next=a<b>c',
        )).toBe(
            'https://[redacted]@host.test/path?token=[redacted]&next=[redacted]',
        );
    });

    it('retains home-path masking inside HTTP URL paths', () => {
        expect(redactLogText(
            'https://host.test/Users/alice/private/report.pdf?download=yes https://host.test/C:/Users/Alice/private/report.pdf',
        )).toBe(
            'https://host.test/Users/[redacted]?download=[redacted] https://host.test/C:/Users/[redacted]',
        );
    });

    it('redacts composite JSON secret values without damaging sibling diagnostics', () => {
        expect(redactLogText(
            'event={"authorization":{"scheme":"Basic","credentials":"abc def"},"next":"useful"}',
        )).toBe(
            'event={"authorization":"[redacted-secret]","next":"useful"}',
        );
    });

    it('redacts common prefixed secret headers without matching longer words', () => {
        expect(redactLogText(
            'X-Api-Key: api-secret x-auth-token="auth secret" X-Refresh-Token=refresh-secret mytoken=visible',
        )).toBe(
            'X-Api-Key: "[redacted-secret]" x-auth-token="[redacted-secret]" X-Refresh-Token="[redacted-secret]" mytoken=visible',
        );
    });

    it('redacts password and key field names without matching longer words', () => {
        const redacted = redactLogText(
            'password=one passwd=two pwd=three secret=four client_secret=five private-key=six passwordless=visible secretary=visible',
        );

        expect(redacted.match(/\[redacted-secret\]/gu)).toHaveLength(6);
        expect(redacted).toContain('passwordless=visible');
        expect(redacted).toContain('secretary=visible');
        for (const value of [
            'one',
            'two',
            'three',
            'four',
            'five',
            'six',
        ]) {
            expect(redacted).not.toContain(`=${value}`);
        }
    });

    it('preserves repeated bare query keys while redacting their empty values', () => {
        expect(redactLogText('https://host.test/path?flag&flag&named=value')).toBe(
            'https://host.test/path?flag=[redacted]&flag=[redacted]&named=[redacted]',
        );
    });

    it('redacts apostrophes inside data URI payloads', () => {
        expect(redactLogText('payload=data:text/plain,secret\'payload')).toBe(
            'payload=data:[redacted]',
        );
    });

    it.each([
        {
            input: 'Request (\'https://host.test/path?token=secret\'), failed',
            output: 'Request (\'https://host.test/path?token=[redacted]\'), failed',
        },
        {
            input: 'Request \'https://host.test/path?token=secret\', failed',
            output: 'Request \'https://host.test/path?token=[redacted]\', failed',
        },
        {
            input: 'Request [https://host.test/path?token=secret], failed',
            output: 'Request [https://host.test/path?token=[redacted]], failed',
        },
        {
            input: 'Request `https://host.test/path?token=secret`, failed',
            output: 'Request `https://host.test/path?token=[redacted]`, failed',
        },
    ])('preserves punctuation around wrapped URL diagnostics', ({
        input,
        output,
    }) => {
        expect(redactLogText(input)).toBe(output);
    });

    it('keeps sentence punctuation outside an unwrapped URL at end of input', () => {
        expect(redactLogText('Failed at https://host.test/path?token=secret.')).toBe(
            'Failed at https://host.test/path?token=[redacted].',
        );
    });

    it('preserves the existing header, bearer, data, file, and home-path redaction', () => {
        const input = [
            'authorization: super-secret',
            'authorization: "Basic abc def"',
            'Bearer abc.def.ghi',
            'data:image/png;base64,AAAA',
            'file:///Users/alice/private.pdf',
            '/Users/alice/private/report.pdf',
            'C:\\Users\\Alice\\private\\report.pdf',
        ].join(' | ');
        const redacted = redactLogText(input);

        expect(redacted).toContain('[redacted-secret]');
        expect(redacted).toContain('Bearer [redacted]');
        expect(redacted).toContain('data:[redacted]');
        expect(redacted).toContain('file://[redacted]');
        expect(redacted).toContain('/Users/[redacted]');
        expect(redacted).toContain('C:\\Users\\[redacted]');
        expect(redacted).not.toContain('super-secret');
        expect(redacted).not.toContain('abc def');
        expect(redacted).not.toContain('abc.def.ghi');
        expect(redacted).not.toContain('AAAA');
        expect(redacted).not.toContain('Alice');
    });

    it('hides browser workspace document names and keeps their ids', () => {
        const redacted = redactLogText('resultPath=browser://documents/1d8256f2-7de0-497f-a7d9-caea46d190f8/private-report.pdf, page=2');

        expect(redacted).toBe('resultPath=browser://documents/1d8256f2-7de0-497f-a7d9-caea46d190f8/[redacted], page=2');
        expect(redactLogText(redacted)).toBe(redacted);
    });
});
