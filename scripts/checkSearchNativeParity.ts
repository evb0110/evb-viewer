import {execFileSync} from 'node:child_process';
import {strict as assert} from 'node:assert';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {SEARCH_NATIVE_PROTOCOL_VERSION} from '@contracts/nativeToolProtocols';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    buildPdfSearchExcerpt,
    findPdfSearchMatches,
    type ISearchMatchOptions,
} from '@pdf-core/pdfSearchCore';
import {getCompactSearchIndexPath} from '@contracts/searchIndexSidecar';
import {createCompactSearchIndexEncoding} from '@node-runtime/searchIndexSidecar';

interface ISearchCorpusCase {
    id: string;
    text: string;
    query: string;
    options?: ISearchMatchOptions;
    contextChars: number;
    nativeSupported: boolean;
}

interface ISearchCorpus {cases: ISearchCorpusCase[];}

const root = resolve(import.meta.dirname, '..');
const binaryPath = join(
    root,
    'native',
    'target',
    'debug',
    process.platform === 'win32' ? 'evb-pdf-search.exe' : 'evb-pdf-search',
);
const revision = requireDocumentRevisionToken('search-native-parity-v1');

function runBinary(args: string[]) {
    return execFileSync(binaryPath, args, {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
    });
}

async function main() {
    assert.equal(runBinary(['--protocol-version']).trim(), String(SEARCH_NATIVE_PROTOCOL_VERSION));
    const corpus = JSON.parse(await readFile(
        join(root, 'packages/contracts/searchConformanceCorpus.json'),
        'utf8',
    )) as ISearchCorpus;
    const directory = await mkdtemp(join(tmpdir(), 'evb-search-native-parity-'));

    try {
        for (const fixture of corpus.cases.filter(testCase => testCase.nativeSupported)) {
            assert.equal(fixture.options?.wholeWord, undefined, `${fixture.id}: native whole-word unsupported`);
            assert.equal(fixture.options?.useRegex, undefined, `${fixture.id}: native regex unsupported`);
            const pdfPath = join(directory, `${fixture.id}.pdf`);
            const encoding = createCompactSearchIndexEncoding({
                documentRevision: revision,
                pageCount: 1,
                pages: [{
                    pageNumber: requirePageNumber(1),
                    text: fixture.text,
                }],
            });
            await writeFile(
                getCompactSearchIndexPath(pdfPath),
                Buffer.concat([
                    encoding.headerAndTable,
                    ...encoding.pages.map(page => Buffer.from(page.text, 'utf8')),
                ]),
            );

            const args = [
                'search',
                '--index',
                getCompactSearchIndexPath(pdfPath),
                '--query',
                fixture.query,
                '--document-revision',
                revision,
                '--limit',
                '500',
                '--context',
                String(fixture.contextChars),
            ];
            if (fixture.options?.matchCase) {
                args.push('--match-case');
            }
            const nativeResponse = JSON.parse(runBinary(args)) as {results: unknown[]};
            const expected = findPdfSearchMatches(fixture.text, fixture.query, fixture.options)
                .map((range, matchIndex) => ({
                    pageNumber: 1,
                    pageMatchIndex: matchIndex,
                    matchIndex,
                    ...range,
                    excerpt: buildPdfSearchExcerpt(
                        fixture.text,
                        range.startOffset,
                        range.endOffset,
                        fixture.contextChars,
                    ),
                }));
            assert.deepEqual(nativeResponse.results, expected, `${fixture.id}: native/pdf-core drift`);
        }
    } finally {
        await rm(directory, {
            force: true,
            recursive: true,
        });
    }

    process.stdout.write(`Native search parity verified for ${corpus.cases.filter(testCase => testCase.nativeSupported).length} cases.\n`);
}

await main();
