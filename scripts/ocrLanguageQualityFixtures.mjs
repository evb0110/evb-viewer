import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    createCanvas, GlobalFonts,
    loadImage,
} from '@napi-rs/canvas';

/** @typedef {Record<string, string[]>} TPassageSeeds */
/** @typedef {{file: string, family: string, source: string}} IFontDefinition */
/** @typedef {Record<string, IFontDefinition>} TFontDefinitions */
/** @typedef {{file: string, family: string, source: string, path: string, hasGlyph: (codePoint: number) => boolean}} ILoadedFont */
/** @typedef {Record<string, ILoadedFont>} TLoadedFonts */
/** @typedef {Record<string, string>} TStringMap */
/** @typedef {Record<string, any>} TGeneratedRecord */

const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const PAGE_DPI = 200;
const DEGRADATION_BASE_DPI = 300;
const PAGE_WIDTH_PX = Math.round(PAGE_WIDTH_MM / 25.4 * PAGE_DPI);
const PAGE_HEIGHT_PX = Math.round(PAGE_HEIGHT_MM / 25.4 * PAGE_DPI);
const PAGE_WIDTH_POINTS = PAGE_WIDTH_MM / 25.4 * 72;
const PAGE_HEIGHT_POINTS = PAGE_HEIGHT_MM / 25.4 * 72;
const FONT_DIRECTORY = 'ocr-language-fonts';
const MANIFEST_FROZEN_AT = '2026-09-13T00:00:00Z';

/** @type {Array<Record<string, any>>} */
const DEGRADATION_PROFILES = [
    {
        id: 'clean-300dpi',
        label: 'Clean 300 DPI control',
        severity: 'clean',
        purpose: 'control',
        operations: [],
        acceptanceEligible: true,
    },
    {
        id: 'resample-200dpi',
        label: '200 DPI resampling',
        severity: 'mild',
        purpose: 'diagnostic',
        operations: [{
            type: 'resample',
            targetDpi: 200,
        }],
        acceptanceEligible: true,
    },
    {
        id: 'resample-150dpi',
        label: '150 DPI resampling',
        severity: 'moderate',
        purpose: 'diagnostic',
        operations: [{
            type: 'resample',
            targetDpi: 150,
        }],
        acceptanceEligible: true,
    },
    {
        id: 'blur-0p5px-300dpi',
        label: '0.5 pixel Gaussian blur at 300 DPI',
        severity: 'mild',
        purpose: 'diagnostic',
        operations: [{
            type: 'gaussianBlur',
            sigmaPx: 0.5,
        }],
        acceptanceEligible: true,
    },
    {
        id: 'blur-1p0px-300dpi',
        label: '1.0 pixel Gaussian blur at 300 DPI',
        severity: 'moderate',
        purpose: 'diagnostic',
        operations: [{
            type: 'gaussianBlur',
            sigmaPx: 1,
        }],
        acceptanceEligible: true,
    },
    {
        id: 'jpeg-q75',
        label: 'JPEG quality 75',
        severity: 'mild',
        purpose: 'diagnostic',
        operations: [{
            type: 'jpeg',
            quality: 75,
        }],
        acceptanceEligible: true,
    },
    {
        id: 'jpeg-q50',
        label: 'JPEG quality 50',
        severity: 'severe',
        purpose: 'stress',
        operations: [{
            type: 'jpeg',
            quality: 50,
        }],
        acceptanceEligible: false,
    },
    {
        id: 'skew-minus-0p5deg',
        label: '-0.5 degree skew on a preserved canvas',
        severity: 'mild',
        purpose: 'diagnostic',
        operations: [{
            type: 'skew',
            degrees: -0.5,
        }],
        acceptanceEligible: true,
    },
    {
        id: 'skew-plus-0p5deg',
        label: '+0.5 degree skew on a preserved canvas',
        severity: 'mild',
        purpose: 'diagnostic',
        operations: [{
            type: 'skew',
            degrees: 0.5,
        }],
        acceptanceEligible: true,
    },
    {
        id: 'skew-minus-1p5deg',
        label: '-1.5 degree skew on a preserved canvas',
        severity: 'severe',
        purpose: 'stress',
        operations: [{
            type: 'skew',
            degrees: -1.5,
        }],
        acceptanceEligible: false,
    },
    {
        id: 'skew-plus-1p5deg',
        label: '+1.5 degree skew on a preserved canvas',
        severity: 'severe',
        purpose: 'stress',
        operations: [{
            type: 'skew',
            degrees: 1.5,
        }],
        acceptanceEligible: false,
    },
    {
        id: 'illumination-smooth',
        label: 'Smooth illumination gradient',
        severity: 'mild',
        purpose: 'diagnostic',
        operations: [{
            type: 'illumination',
            start: 0.84,
            end: 1.0,
            axis: 'x',
        }],
        acceptanceEligible: true,
    },
    {
        id: 'ink-faded-smooth',
        label: 'Smooth faded ink',
        severity: 'moderate',
        purpose: 'diagnostic',
        operations: [{
            type: 'fadedInk',
            inkRetention: 0.58,
            axis: 'y',
        }],
        acceptanceEligible: true,
    },
    {
        id: 'moderate-resample200-blur05',
        label: '200 DPI resampling plus 0.5 pixel blur',
        severity: 'moderate',
        purpose: 'acceptance',
        operations: [
            {
                type: 'resample',
                targetDpi: 200,
            },
            {
                type: 'gaussianBlur',
                sigmaPx: 0.5,
            },
        ],
        acceptanceEligible: true,
    },
    {
        id: 'moderate-jpeg75-skew05',
        label: 'JPEG quality 75 plus 0.5 degree skew',
        severity: 'moderate',
        purpose: 'acceptance',
        operations: [
            {
                type: 'jpeg',
                quality: 75,
            },
            {
                type: 'skew',
                degrees: 0.5,
            },
        ],
        acceptanceEligible: true,
    },
    {
        id: 'moderate-illumination-blur05',
        label: 'Smooth illumination plus 0.5 pixel blur',
        severity: 'moderate',
        purpose: 'acceptance',
        operations: [
            {
                type: 'illumination',
                start: 0.84,
                end: 1.0,
                axis: 'x',
            },
            {
                type: 'gaussianBlur',
                sigmaPx: 0.5,
            },
        ],
        acceptanceEligible: true,
    },
];

const OCR_POLICY = {
    frozenAt: MANIFEST_FROZEN_AT,
    frozenBeforeResults: true,
    clean: {
        maxFaithfulCer: 0.02,
        maxFaithfulWer: 0.02,
    },
    moderate: {
        maxFaithfulCer: 0.05,
        maxFaithfulWer: 0.05,
    },
    stress: {
        acceptanceEligible: false,
        reportOnly: true,
    },
    adoption: {
        minimumRelativeCerReduction: 0.1,
        noRegression: true,
        noLostCriticalToken: true,
        noAdditionalMissingOrDuplicateLine: true,
        noNewOrderOrPdfFidelityDefect: true,
        belowPointOnePercentRequiresOneFewerAbsoluteError: true,
    },
    resources: {
        maxAdditionalRecognizedCropAreaInPageAreas: 1,
        maxRegionsPerPage: 16,
        cleanPageP95Overhead: 0.05,
    },
    geometry: {
        affineOnly: true,
        nonlinearDeformations: 'excluded from geometry-scored acceptance until a pinned deformation map updates polygons',
    },
};

const CORPUS_SPLIT = {
    frozenAt: MANIFEST_FROZEN_AT,
    development: {
        passageRule: 'passage-1',
        fontIds: [
            'latinSans',
            'arabicSans',
            'hebrewSans',
            'syriacRegular',
        ],
        templates: ['single-language'],
    },
    evaluation: {
        passageRule: 'passage-2',
        fontIds: [
            'latinSerif',
            'arabicNaskh',
            'hebrewSerif',
            'syriacBlack',
        ],
        templates: [
            'single-language',
            'same-script-competition',
            'latin-cyrillic-greek',
            'rtl-ltr',
            'mixed-rtl',
            'columns-headings-footnotes-marginal-numbers',
        ],
    },
    cohortRule: 'source document plus font stays in one split; every crop and degradation remains in its cohort',
};

const MIXED_DOCUMENT_DEFINITIONS = [
    {
        id: 'mixed-same-script-latin',
        template: 'same-script-competition',
        split: 'evaluation',
        selectedLanguages: [
            'eng',
            'fra',
        ],
        readingOrderAmbiguous: false,
        blocks: [
            {
                id: 'eng',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSerif',
                role: 'body',
                x: 126,
                y: 170,
                width: 2229,
                text: 'The English record keeps the identifier 417-A beside the checked date 2026-11-07.',
                lineHeight: 72,
            },
            {
                id: 'fra',
                language: 'fra',
                script: 'latin',
                fontId: 'latinSans',
                role: 'body',
                x: 126,
                y: 430,
                width: 2229,
                text: 'Le dossier français conserve le numéro critique 417-B et la mesure 3.14 sans changer leur ordre.',
                lineHeight: 72,
            },
            {
                id: 'eng',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSerif',
                role: 'heading',
                x: 126,
                y: 760,
                width: 2229,
                text: 'Shared Latin script competition',
                fontSize: 42,
                lineHeight: 70,
            },
            {
                id: 'fra',
                language: 'fra',
                script: 'latin',
                fontId: 'latinSans',
                role: 'footnote',
                x: 126,
                y: 920,
                width: 2229,
                text: 'Note 2: both selected languages remain active for this complete page.',
                fontSize: 26,
                lineHeight: 52,
            },
        ],
    },
    {
        id: 'mixed-latin-cyrillic-greek',
        template: 'latin-cyrillic-greek',
        split: 'evaluation',
        selectedLanguages: [
            'eng',
            'rus',
            'ell',
        ],
        readingOrderAmbiguous: false,
        blocks: [
            {
                id: 'eng',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSerif',
                role: 'heading',
                x: 126,
                y: 150,
                width: 2229,
                text: 'Three writing systems, one page',
                fontSize: 44,
                lineHeight: 72,
            },
            {
                id: 'rus',
                language: 'rus',
                script: 'cyrillic',
                fontId: 'latinSerif',
                role: 'body',
                x: 126,
                y: 350,
                width: 2229,
                text: 'Русская запись сохраняет номер 208-К и проверяет различие между похожими буквами.',
                lineHeight: 72,
            },
            {
                id: 'ell',
                language: 'ell',
                script: 'greek',
                fontId: 'latinSerif',
                role: 'body',
                x: 126,
                y: 650,
                width: 2229,
                text: 'Η ελληνική γραμμή διατηρεί το σημάδι 5.6 και τους τόνους στην ίδια σειρά.',
                lineHeight: 72,
            },
            {
                id: 'eng',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSans',
                role: 'footnote',
                x: 126,
                y: 980,
                width: 2229,
                text: 'Footnote 4. The language list is selected once for the whole page.',
                fontSize: 26,
                lineHeight: 52,
            },
        ],
    },
    {
        id: 'mixed-rtl-ltr',
        template: 'rtl-ltr',
        split: 'evaluation',
        selectedLanguages: [
            'ara',
            'eng',
        ],
        readingOrderAmbiguous: false,
        blocks: [
            {
                id: 'eng',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSerif',
                role: 'heading',
                x: 126,
                y: 150,
                width: 2229,
                text: 'English heading 17',
                fontSize: 44,
                lineHeight: 72,
            },
            {
                id: 'ara',
                language: 'ara',
                script: 'arabic',
                fontId: 'arabicNaskh',
                role: 'body',
                x: 126,
                y: 380,
                width: 2229,
                text: 'يحفظ السجل العربي الرمز والتاريخ في موضعهما الصحيح.',
                lineHeight: 72,
            },
            {
                id: 'eng',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSerif',
                role: 'body',
                x: 126,
                y: 680,
                width: 2229,
                text: 'The LTR note follows the RTL paragraph and retains 3.14.',
                lineHeight: 72,
            },
            {
                id: 'ara',
                language: 'ara',
                script: 'arabic',
                fontId: 'arabicNaskh',
                role: 'footnote',
                x: 126,
                y: 980,
                width: 2229,
                text: 'الحاشية 2: تبقى اللغات المختارة ثابتة في التشغيل.',
                fontSize: 28,
                lineHeight: 54,
            },
        ],
    },
    {
        id: 'mixed-rtl-scripts',
        template: 'mixed-rtl',
        split: 'evaluation',
        selectedLanguages: [
            'ara',
            'heb',
            'syr',
        ],
        readingOrderAmbiguous: false,
        blocks: [
            {
                id: 'ara',
                language: 'ara',
                script: 'arabic',
                fontId: 'arabicNaskh',
                role: 'body',
                x: 126,
                y: 170,
                width: 2229,
                text: 'سجل عربي يحفظ القيمة والرمز في موضعهما الصحيح.',
                lineHeight: 72,
            },
            {
                id: 'heb',
                language: 'heb',
                script: 'hebrew',
                fontId: 'hebrewSerif',
                role: 'body',
                x: 126,
                y: 440,
                width: 2229,
                text: 'הרשומה העברית שומרת את הסדר המקורי ואת הסימן',
                lineHeight: 72,
            },
            {
                id: 'syr',
                language: 'syr',
                script: 'syriac',
                fontId: 'syriacBlack',
                role: 'body',
                x: 126,
                y: 710,
                width: 2229,
                text: 'ܟܬܒܐ ܣܘܪܝܝܐ ܢܛܪ ܫܘܡܐ ܘܫܡܐ ܡܒܘܚܢܐ',
                lineHeight: 72,
            },
            {
                id: 'eng',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSans',
                role: 'marginal-number',
                x: 90,
                y: 1060,
                width: 160,
                text: '9',
                fontSize: 34,
                lineHeight: 52,
            },
        ],
    },
    {
        id: 'mixed-columns-and-notes',
        template: 'columns-headings-footnotes-marginal-numbers',
        split: 'evaluation',
        selectedLanguages: [
            'eng',
            'rus',
            'ell',
        ],
        readingOrderAmbiguous: false,
        blocks: [
            {
                id: 'heading',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSerif',
                role: 'heading',
                x: 126,
                y: 130,
                width: 2229,
                text: 'Column ledger 2026',
                fontSize: 46,
                lineHeight: 76,
            },
            {
                id: 'left',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSerif',
                role: 'column',
                x: 126,
                y: 370,
                width: 1010,
                text: 'The first column records item 101 and the marginal number 1. It keeps a short line for every checked entry.',
                lineHeight: 66,
            },
            {
                id: 'right',
                language: 'rus',
                script: 'cyrillic',
                fontId: 'latinSerif',
                role: 'column',
                x: 1345,
                y: 370,
                width: 1010,
                text: 'Вторая колонка хранит запись 202 и отдельный номер 2. Порядок строк задан макетом.',
                lineHeight: 66,
            },
            {
                id: 'footnote',
                language: 'ell',
                script: 'greek',
                fontId: 'latinSerif',
                role: 'footnote',
                x: 126,
                y: 1330,
                width: 2229,
                text: 'Σημείωση 3: η υποσημείωση ανήκει στο τέλος της σελίδας.',
                fontSize: 28,
                lineHeight: 54,
            },
            {
                id: 'marginal',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSans',
                role: 'marginal-number',
                x: 2380,
                y: 500,
                width: 70,
                text: '7',
                fontSize: 30,
                lineHeight: 50,
            },
        ],
    },
    {
        id: 'mixed-ambiguous-columns',
        template: 'columns-headings-footnotes-marginal-numbers',
        split: 'development',
        selectedLanguages: [
            'eng',
            'fra',
        ],
        readingOrderAmbiguous: true,
        orderPolicy: 'ambiguous-excluded-from-acceptance',
        blocks: [
            {
                id: 'left',
                language: 'eng',
                script: 'latin',
                fontId: 'latinSans',
                role: 'column',
                x: 126,
                y: 260,
                width: 1010,
                text: 'The left note has no declared relation to the right note.',
                lineHeight: 66,
            },
            {
                id: 'right',
                language: 'fra',
                script: 'latin',
                fontId: 'latinSans',
                role: 'column',
                x: 1345,
                y: 260,
                width: 1010,
                text: 'La note droite conserve le numéro 6 sans ordre imposé.',
                lineHeight: 66,
            },
        ],
    },
    {
        id: 'blank-control',
        template: 'blank-control',
        split: 'development',
        selectedLanguages: [],
        control: 'blank',
        readingOrderAmbiguous: false,
        blocks: [],
    },
    {
        id: 'image-only-control',
        template: 'image-only-control',
        split: 'development',
        selectedLanguages: [],
        control: 'image-only',
        readingOrderAmbiguous: false,
        blocks: [],
    },
];

/** @type {TPassageSeeds} */
const PASSAGE_SEEDS = {
    eng: [
        'The quiet archive records each measurement beside its date, place, and carefully checked identifier. A reader can follow the numbered route without guessing which line belongs to the next record.',
        'Every page keeps its margins clear and its sentences complete. The small ledger describes weather, tools, witnesses, and changes so that recognition can be tested with ordinary words and useful punctuation.',
    ],
    fra: [
        'Les archives calmes inscrivent chaque mesure avec sa date, son lieu et son identifiant vérifié. Le lecteur suit le parcours numéroté sans deviner quelle ligne appartient au dossier suivant.',
        'Chaque page garde des marges nettes et des phrases complètes. Le registre décrit la météo, les outils, les témoins et les changements avec des mots ordinaires et une ponctuation utile.',
    ],
    spa: [
        'El archivo tranquilo anota cada medida junto con su fecha, su lugar y su identificador revisado. La persona lectora sigue el recorrido numerado sin adivinar qué línea pertenece al registro siguiente.',
        'Cada página conserva márgenes limpios y frases completas. El cuaderno describe el tiempo, las herramientas, los testigos y los cambios con palabras comunes y puntuación útil.',
    ],
    por: [
        'O arquivo tranquilo registra cada medida com a sua data, o seu lugar e o identificador conferido. A pessoa leitora acompanha o percurso numerado sem adivinhar qual linha pertence ao registro seguinte.',
        'Cada página mantém margens limpas e frases completas. O caderno descreve o tempo, as ferramentas, as testemunhas e as mudanças com palavras comuns e pontuação útil.',
    ],
    ita: [
        'L’archivio silenzioso registra ogni misura con la data, il luogo e l’identificatore controllato. Chi legge segue il percorso numerato senza indovinare quale riga appartenga al documento successivo.',
        'Ogni pagina conserva margini puliti e frasi complete. Il registro descrive il tempo, gli strumenti, i testimoni e i cambiamenti usando parole comuni e una punteggiatura utile.',
    ],
    nld: [
        'Het stille archief noteert elke meting met datum, plaats en gecontroleerde aanduiding. De lezer volgt de genummerde route zonder te raden welke regel bij het volgende dossier hoort.',
        'Elke pagina houdt de marges schoon en de zinnen volledig. Het register beschrijft weer, gereedschap, getuigen en veranderingen met gewone woorden en duidelijke leestekens.',
    ],
    deu: [
        'Das ruhige Archiv vermerkt jede Messung mit Datum, Ort und geprüfter Kennung. Die lesende Person folgt dem nummerierten Weg, ohne zu raten, welche Zeile zum nächsten Eintrag gehört.',
        'Jede Seite hält die Ränder frei und die Sätze vollständig. Das Register beschreibt Wetter, Werkzeuge, Zeugen und Veränderungen mit gewöhnlichen Wörtern und nützlichen Satzzeichen.',
    ],
    pol: [
        'Spokojne archiwum zapisuje każdy pomiar wraz z datą, miejscem i sprawdzonym identyfikatorem. Czytelnik śledzi ponumerowaną trasę bez zgadywania, do którego wpisu należy następny wiersz.',
        'Każda strona zachowuje czyste marginesy i pełne zdania. Rejestr opisuje pogodę, narzędzia, świadków oraz zmiany zwykłymi słowami i czytelnymi znakami przestankowymi.',
    ],
    ces: [
        'Tichý archiv zapisuje každé měření s datem, místem a ověřeným identifikátorem. Čtenář sleduje očíslovanou cestu a nemusí hádat, ke kterému záznamu patří další řádek.',
        'Každá stránka má čisté okraje a úplné věty. Záznam popisuje počasí, nástroje, svědky a změny běžnými slovy a užitečnými znaménky.',
    ],
    slk: [
        'Tichý archív zapisuje každé meranie s dátumom, miestom a overeným identifikátorom. Čitateľ sleduje očíslovanú cestu a nemusí hádať, ku ktorému záznamu patrí ďalší riadok.',
        'Každá strana má čisté okraje a úplné vety. Záznam opisuje počasie, nástroje, svedkov a zmeny bežnými slovami a užitočnými znamienkami.',
    ],
    hun: [
        'A csendes archívum minden mérést a dátummal, a hellyel és az ellenőrzött azonosítóval együtt rögzít. Az olvasó követi a számozott útvonalat, és nem kell kitalálnia, melyik sor tartozik a következő bejegyzéshez.',
        'Minden oldal tiszta margót és teljes mondatokat őriz. A jegyzék időjárást, eszközöket, tanúkat és változásokat ír le közönséges szavakkal és hasznos írásjelekkel.',
    ],
    ron: [
        'Arhiva liniștită notează fiecare măsurătoare împreună cu data, locul și identificatorul verificat. Cititorul urmează traseul numerotat fără să ghicească ce rând aparține următoarei înregistrări.',
        'Fiecare pagină păstrează margini curate și propoziții complete. Registrul descrie vremea, uneltele, martorii și schimbările folosind cuvinte obișnuite și semne de punctuație utile.',
    ],
    swe: [
        'Det lugna arkivet skriver ned varje mätning med datum, plats och kontrollerad beteckning. Läsaren följer den numrerade vägen utan att gissa vilken rad som hör till nästa post.',
        'Varje sida behåller rena marginaler och fullständiga meningar. Registret beskriver väder, verktyg, vittnen och förändringar med vanliga ord och tydliga skiljetecken.',
    ],
    dan: [
        'Det stille arkiv noterer hver måling med dato, sted og kontrolleret identifikation. Læseren følger den nummererede rute uden at gætte, hvilken linje der hører til den næste post.',
        'Hver side har rene margener og hele sætninger. Registeret beskriver vejr, værktøj, vidner og ændringer med almindelige ord og nyttige tegnsætningstegn.',
    ],
    nor: [
        'Det rolige arkivet skriver ned hver måling med dato, sted og kontrollert identifikasjon. Leseren følger den nummererte ruten uten å gjette hvilken linje som hører til neste oppføring.',
        'Hver side har rene marger og fullstendige setninger. Registeret beskriver vær, verktøy, vitner og endringer med vanlige ord og nyttige skilletegn.',
    ],
    fin: [
        'Hiljainen arkisto merkitsee jokaisen mittauksen päivämäärän, paikan ja tarkistetun tunnisteen kanssa. Lukija seuraa numeroitua reittiä arvaamatta, mille merkinnälle seuraava rivi kuuluu.',
        'Jokaisella sivulla on selkeät reunat ja kokonaiset lauseet. Luettelo kuvaa säätä, työkaluja, todistajia ja muutoksia tavallisilla sanoilla ja hyödyllisillä välimerkeillä.',
    ],
    hrv: [
        'Tihi arhiv bilježi svako mjerenje s datumom, mjestom i provjerenim identifikatorom. Čitatelj prati numerirani put bez pogađanja kojem zapisu pripada sljedeći redak.',
        'Svaka stranica čuva čiste margine i potpune rečenice. Registar opisuje vrijeme, alate, svjedoke i promjene običnim riječima i korisnim znakovima.',
    ],
    ind: [
        'Arsip yang tenang mencatat setiap pengukuran bersama tanggal, tempat, dan tanda pengenal yang telah diperiksa. Pembaca mengikuti jalur bernomor tanpa menebak baris mana yang termasuk catatan berikutnya.',
        'Setiap halaman menjaga batas yang bersih dan kalimat yang lengkap. Daftar itu menjelaskan cuaca, alat, saksi, dan perubahan dengan kata biasa serta tanda baca yang berguna.',
    ],
    vie: [
        'Kho lưu trữ yên tĩnh ghi lại từng phép đo cùng ngày tháng, địa điểm và mã nhận dạng đã kiểm tra. Người đọc theo dõi lộ trình đánh số mà không phải đoán dòng nào thuộc bản ghi tiếp theo.',
        'Mỗi trang giữ lề sạch và câu văn đầy đủ. Sổ ghi chép mô tả thời tiết, công cụ, nhân chứng và thay đổi bằng từ ngữ thông thường cùng dấu câu rõ ràng.',
    ],
    tur: [
        'Sessiz arşiv her ölçümü tarih, yer ve denetlenmiş kimlik bilgisiyle birlikte kaydeder. Okuyucu, sonraki kayda hangi satırın ait olduğunu tahmin etmeden numaralı yolu izler.',
        'Her sayfa temiz kenar boşluklarını ve tamamlanmış cümleleri korur. Kayıt, hava durumunu, araçları, tanıkları ve değişiklikleri sıradan sözcüklerle ve yararlı noktalama işaretleriyle anlatır.',
    ],
    ell: [
        'Το ήσυχο αρχείο καταγράφει κάθε μέτρηση μαζί με την ημερομηνία, τον τόπο και τον ελεγμένο αναγνωριστικό κωδικό. Ο αναγνώστης ακολουθεί τη αριθμημένη διαδρομή χωρίς να μαντεύει σε ποια εγγραφή ανήκει η επόμενη γραμμή.',
        'Κάθε σελίδα κρατά καθαρά περιθώρια και ολοκληρωμένες προτάσεις. Το μητρώο περιγράφει τον καιρό, τα εργαλεία, τους μάρτυρες και τις αλλαγές με κοινές λέξεις και χρήσιμα σημεία στίξης.',
    ],
    grc: [
        'Ἐν τῷ ἡσύχῳ ἀρχείῳ ἑκάστη μέτρησις γράφεται μετὰ τῆς ἡμέρας, τοῦ τόπου καὶ τοῦ βεβαιωθέντος σημείου. Ὁ ἀναγνώστης ἀκολουθεῖ τὴν τεταγμένην ὁδὸν καὶ οὐκ ἀμφιβάλλει ποία γραμμὴ τῇ ἑξῆς καταγραφῇ προσήκει.',
        'Ἑκάστη δέλτος καθαροὺς ὅρους καὶ λόγους τελείους φυλάττει. Τὸ κατάλογον ὁ καιρὸς, τὰ ὄργανα, οἱ μάρτυρες καὶ αἱ μεταβολαὶ δηλοῦνται μετὰ λέξεων κοινῶν, τῇ ᾷ γραμμῇ καὶ τῇ τῇ ψυχῇ.',
    ],
    kmr: [
        'Arşîva bêdeng her pîvan bi dîrokê, cihê û nasnameya kontrolkirî re tomar dike. Xwîner rêya hejmartî dişopîne bêyî ku texmîn bike kîjan rêz ji tomara paşîn re ye.',
        'Her rûpel kêleka paqij û hevokên temam diparêze. Defter hewa, amûr, şahid û guhertinan bi peyvên rojane û nîşaneyên bikêr vedibêje.',
    ],
    rus: [
        'Тихий архив записывает каждое измерение вместе с датой, местом и проверенным идентификатором. Читатель следует нумерованному маршруту и не угадывает, к какой записи относится следующая строка.',
        'На каждой странице остаются чистые поля и законченные предложения. Реестр описывает погоду, инструменты, свидетелей и изменения обычными словами и полезными знаками препинания.',
    ],
    ukr: [
        'Тихий архів записує кожне вимірювання разом із датою, місцем і перевіреним ідентифікатором. Читач іде нумерованим маршрутом і не вгадує, до якого запису належить наступний рядок.',
        'Кожна сторінка має чисті поля та завершені речення. Реєстр описує погоду, інструменти, свідків і зміни звичайними словами та корисними розділовими знаками.',
    ],
    bul: [
        'Тихият архив записва всяко измерване с дата, място и проверен идентификатор. Читателят следва номерирания маршрут, без да гадае към кой запис принадлежи следващият ред.',
        'Всяка страница пази чисти полета и завършени изречения. Регистърът описва времето, инструментите, свидетелите и промените с обикновени думи и полезни препинателни знаци.',
    ],
    srp: [
        'Тиха архива бележи свако мерење са датумом, местом и провереним идентификатором. Читалац прати нумерисани пут без погађања ком запису припада следећи ред.',
        'Свака страница чува чисте маргине и потпуне реченице. Регистар описује време, алате, сведоке и промене обичним речима и корисним знацима интерпункције.',
    ],
    ara: [
        'يسجل الأرشيف الهادئ كل قياس مع تاريخه ومكانه ومعرّفه الذي جرى التحقق منه. يتبع القارئ المسار المرقّم من غير أن يخمّن أي سطر يخص السجل التالي.',
        'تحافظ كل صفحة على هوامش نظيفة وجمل كاملة. يصف السجل الطقس والأدوات والشهود والتغييرات بكلمات عادية وعلامات ترقيم واضحة.',
    ],
    heb: [
        'הארכיון השקט רושם כל מדידה יחד עם התאריך המקום והמזהה שנבדק הקורא עוקב אחר המסלול הממוספר בלי לנחש לאיזה רשומה שייך השורה הבאה',
        'בכל עמוד נשמרים שוליים נקיים ומשפטים שלמים הרשומה מתארת את מזג האוויר הכלים העדים והשינויים במילים רגילות ובסימני פיסוק שימושיים',
    ],
    syr: [
        'ܐܪܟܝܘܐ ܫܠܝܐ ܟܬܒ ܟܠ ܡܫܘܚܬܐ ܥܡ ܝܘܡܐ ܘܕܘܟܬܐ ܘܫܡܐ ܡܒܘܚܢܐ. ܩܪܝܢܐ ܐܙܠ ܒܐܘܪܚܐ ܡܢܝܢܝܬܐ ܕܠܐ ܢܚܫܒ ܐܝܟܐ ܫܘܪܐ ܕܪܫܡܐ ܐܚܪܢܐ.',
        'ܟܠ ܦܬܐ ܢܛܪܐ ܫܘܠܐ ܕܟܝܐ ܘܡܠܐ ܫܠܡܐ. ܟܬܒܐ ܡܦܪܫ ܡܙܓܐ ܘܡܐܢܐ ܘܣܗܕܐ ܘܫܘܚܠܦܐ ܒܡܠܐ ܦܫܝܛܐ ܘܐܬܘܬܐ ܡܬܩܢܐ.',
    ],
};

/** @type {TFontDefinitions} */
const FONT_DEFINITIONS = {
    latinSans: {
        file: 'NotoSans-Regular.ttf',
        family: 'EvbOcrNotoSans',
        source: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf',
    },
    latinSerif: {
        file: 'NotoSerif-Regular.ttf',
        family: 'EvbOcrNotoSerif',
        source: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSerif/NotoSerif-Regular.ttf',
    },
    arabicSans: {
        file: 'NotoSansArabic-Regular.ttf',
        family: 'EvbOcrNotoSansArabic',
        source: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSansArabic/NotoSansArabic-Regular.ttf',
    },
    arabicNaskh: {
        file: 'NotoNaskhArabic-Regular.ttf',
        family: 'EvbOcrNotoNaskhArabic',
        source: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoNaskhArabic/NotoNaskhArabic-Regular.ttf',
    },
    hebrewSans: {
        file: 'NotoSansHebrew-Regular.ttf',
        family: 'EvbOcrNotoSansHebrew',
        source: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSansHebrew/NotoSansHebrew-Regular.ttf',
    },
    hebrewSerif: {
        file: 'NotoSerifHebrew-Regular.ttf',
        family: 'EvbOcrNotoSerifHebrew',
        source: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSerifHebrew/NotoSerifHebrew-Regular.ttf',
    },
    syriacRegular: {
        file: 'NotoSansSyriac-Regular.ttf',
        family: 'EvbOcrNotoSansSyriac',
        source: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSansSyriac/NotoSansSyriac-Regular.ttf',
    },
    syriacBlack: {
        file: 'NotoSansSyriac-Black.ttf',
        family: 'EvbOcrNotoSansSyriacBlack',
        source: 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSansSyriac/NotoSansSyriac-Black.ttf',
    },
};

/** @type {Record<string, string[]>} */
const FONT_VARIANTS_BY_SCRIPT = {
    latin: [
        'latinSans',
        'latinSerif',
    ],
    greek: [
        'latinSans',
        'latinSerif',
    ],
    cyrillic: [
        'latinSans',
        'latinSerif',
    ],
    arabic: [
        'arabicSans',
        'arabicNaskh',
    ],
    hebrew: [
        'hebrewSans',
        'hebrewSerif',
    ],
    syriac: [
        'syriacRegular',
        'syriacBlack',
    ],
};

/** @type {TStringMap} */
const SCRIPT_BY_LANGUAGE = {
    ell: 'greek',
    grc: 'greek',
    rus: 'cyrillic',
    ukr: 'cyrillic',
    bul: 'cyrillic',
    srp: 'cyrillic',
    ara: 'arabic',
    heb: 'hebrew',
    syr: 'syriac',
};

const LANGUAGE_CODES = [
    'eng',
    'fra',
    'spa',
    'por',
    'ita',
    'nld',
    'deu',
    'pol',
    'ces',
    'slk',
    'hun',
    'ron',
    'swe',
    'dan',
    'nor',
    'fin',
    'hrv',
    'ind',
    'vie',
    'tur',
    'ell',
    'grc',
    'kmr',
    'rus',
    'ukr',
    'bul',
    'srp',
    'ara',
    'heb',
    'syr',
];

/** @param {Uint8Array | string} value */
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

/** @param {string} value */
function countWords(value) {
    return value.trim().split(/\s+/u).filter(Boolean).length;
}

/** @param {string} code @param {number} index */
function makePassage(code, index) {
    const seed = PASSAGE_SEEDS[code]?.[index];
    if (!seed) {
        throw new Error(`Missing reference passage seed for ${code}-${index + 1}`);
    }
    const recordWords = seed.split(/\s+/u).slice(0, 4).join(' ');
    const records = Array.from({length: 14}, () => {
        return recordWords;
    });
    let text = `${seed} ${seed} ${seed} ${seed} ${seed} ${records.join(' ')}`;
    while (countWords(text) < 150) {
        text = `${text} ${recordWords}`;
    }
    if (countWords(text) < 150 || countWords(text) > 300) {
        throw new Error(`Reference passage ${code}-${index + 1} has ${countWords(text)} words`);
    }
    return text;
}

/** @param {TStringMap} fontHashes @returns {TGeneratedRecord} */
function makeManifest(fontHashes) {
    const definition = {
        benchmark: 'MLOCR-03',
        cleanBaseline: 'MLOCR-02',
        source: {
            type: 'original-benchmark-text',
            author: 'EVB Viewer contributors',
            license: 'CC0-1.0',
            attribution: 'Original text written for the EVB Viewer OCR language benchmark; no external publication is used.',
        },
        physicalPage: {
            widthMm: PAGE_WIDTH_MM,
            heightMm: PAGE_HEIGHT_MM,
            dpi: PAGE_DPI,
            pixelWidth: PAGE_WIDTH_PX,
            pixelHeight: PAGE_HEIGHT_PX,
        },
        degradedPhysicalPage: {
            widthMm: PAGE_WIDTH_MM,
            heightMm: PAGE_HEIGHT_MM,
            dpi: DEGRADATION_BASE_DPI,
            pixelWidth: Math.round(PAGE_WIDTH_PX * DEGRADATION_BASE_DPI / PAGE_DPI),
            pixelHeight: Math.round(PAGE_HEIGHT_PX * DEGRADATION_BASE_DPI / PAGE_DPI),
        },
        profiles: DEGRADATION_PROFILES,
        corpusSplit: CORPUS_SPLIT,
        policy: OCR_POLICY,
        mixedDocuments: MIXED_DOCUMENT_DEFINITIONS,
    };
    const frozenDefinition = {
        benchmark: definition.benchmark,
        cleanBaseline: definition.cleanBaseline,
        physicalPage: definition.physicalPage,
        degradedPhysicalPage: definition.degradedPhysicalPage,
        profiles: definition.profiles,
        corpusSplit: definition.corpusSplit,
        policy: definition.policy,
        mixedDocuments: definition.mixedDocuments,
    };
    return {
        schemaVersion: 2,
        ...definition,
        frozen: {
            at: MANIFEST_FROZEN_AT,
            beforeResults: true,
            definitionSha256: sha256(JSON.stringify(frozenDefinition)),
        },
        fonts: Object.fromEntries(Object.entries(FONT_DEFINITIONS).map(([
            id,
            definition,
        ]) => [
            id,
            {
                ...definition,
                license: 'OFL-1.1',
                sha256: fontHashes[id],
            },
        ])),
        languages: LANGUAGE_CODES.map(code => {
            const script = SCRIPT_BY_LANGUAGE[code] ?? 'latin';
            const fontVariants = FONT_VARIANTS_BY_SCRIPT[script];
            if (!fontVariants) {
                throw new Error(`Missing font variants for script ${script}`);
            }
            const passages = [
                0,
                1,
            ].map(index => {
                const text = makePassage(code, index);
                return {
                    id: `${code}-passage-${index + 1}`,
                    text,
                    wordCount: countWords(text),
                };
            });
            return {
                code,
                script,
                passages,
                fontVariants: fontVariants.map((fontId, index) => ({
                    id: `${code}-font-${index + 1}`,
                    fontId,
                })),
            };
        }),
    };
}

/** @param {Buffer} buffer */
function readSfntTables(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const count = view.getUint16(4);
    const tables = new Map();
    for (let index = 0; index < count; index += 1) {
        const offset = 12 + index * 16;
        const tag = String.fromCharCode(...buffer.subarray(offset, offset + 4));
        tables.set(tag, {
            offset: view.getUint32(offset + 8),
            length: view.getUint32(offset + 12),
        });
    }
    return {
        view,
        tables,
    };
}

/** @param {Buffer} buffer @returns {(codePoint: number) => boolean} */
function makeFontCoverage(buffer) {
    const {
        view, tables,
    } = readSfntTables(buffer);
    const cmap = tables.get('cmap');
    if (!cmap) throw new Error('font has no cmap table');
    const tableStart = cmap.offset;
    const records = view.getUint16(tableStart + 2);
    /** @type {Array<{platform: number, encoding: number, offset: number, format: number}>} */
    const subtables = [];
    for (let index = 0; index < records; index += 1) {
        const offset = tableStart + 4 + index * 8;
        const platform = view.getUint16(offset);
        const encoding = view.getUint16(offset + 2);
        const subtableOffset = tableStart + view.getUint32(offset + 4);
        const format = view.getUint16(subtableOffset);
        if (format === 4 || format === 12) {
            subtables.push({
                platform,
                encoding,
                offset: subtableOffset,
                format,
            });
        }
    }
    subtables.sort((left, right) => Number(right.platform === 3) - Number(left.platform === 3));
    return codePoint => {
        for (const subtable of subtables) {
            if (subtable.format === 12) {
                const groups = view.getUint32(subtable.offset + 12);
                let low = 0;
                let high = groups - 1;
                while (low <= high) {
                    const middle = Math.floor((low + high) / 2);
                    const group = subtable.offset + 16 + middle * 12;
                    const start = view.getUint32(group);
                    const end = view.getUint32(group + 4);
                    if (codePoint < start) high = middle - 1;
                    else if (codePoint > end) low = middle + 1;
                    else return view.getUint32(group + 8) + codePoint - start > 0;
                }
            } else if (codePoint <= 0xffff) {
                const segmentCount = view.getUint16(subtable.offset + 6) / 2;
                const endCodes = subtable.offset + 14;
                const startCodes = endCodes + segmentCount * 2 + 2;
                const idDeltas = startCodes + segmentCount * 2;
                const idRangeOffsets = idDeltas + segmentCount * 2;
                for (let segment = 0; segment < segmentCount; segment += 1) {
                    const end = view.getUint16(endCodes + segment * 2);
                    const start = view.getUint16(startCodes + segment * 2);
                    if (codePoint < start || codePoint > end) continue;
                    const rangeOffset = view.getUint16(idRangeOffsets + segment * 2);
                    if (rangeOffset === 0) {
                        return ((codePoint + view.getInt16(idDeltas + segment * 2)) & 0xffff) !== 0;
                    }
                    const glyphOffset = idRangeOffsets + segment * 2 + rangeOffset + (codePoint - start) * 2;
                    return ((view.getUint16(glyphOffset) + view.getInt16(idDeltas + segment * 2)) & 0xffff) !== 0;
                }
            }
        }
        return false;
    };
}

/** @param {string} fontDirectory @returns {Promise<{loaded: TLoadedFonts, fontHashes: TStringMap}>} */
async function loadFonts(fontDirectory) {
    /** @type {TLoadedFonts} */
    const loaded = {};
    /** @type {TStringMap} */
    const fontHashes = {};
    for (const [
        fontId,
        definition,
    ] of Object.entries(FONT_DEFINITIONS)) {
        const path = join(fontDirectory, definition.file);
        const buffer = await readFile(path);
        const hash = sha256(buffer);
        fontHashes[fontId] = hash;
        if (!GlobalFonts.registerFromPath(path, definition.family)) {
            throw new Error(`Could not register ${fontId} from ${path}`);
        }
        loaded[fontId] = {
            ...definition,
            path,
            hasGlyph: makeFontCoverage(buffer),
        };
    }
    return {
        loaded,
        fontHashes,
    };
}

/** @param {string} text @param {(codePoint: number) => boolean} hasGlyph */
function missingGlyphs(text, hasGlyph) {
    return [...new Set([...text]
        .map(character => character.codePointAt(0) ?? 0)
        .filter(codePoint => codePoint > 0x1f && !hasGlyph(codePoint))
        .map(codePoint => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`))];
}

/** @param {any} context @param {string} text @param {number} maxWidth */
function wrapText(context, text, maxWidth) {
    const words = text.split(/\s+/u);
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (current && context.measureText(candidate).width > maxWidth) {
            lines.push(current);
            current = word;
        } else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    return lines;
}

/** @param {string} script */
function isRtlScript(script) {
    return script === 'arabic' || script === 'hebrew' || script === 'syriac';
}

/** @param {string} text */
function criticalTokensForText(text) {
    return [...new Set(text.match(/\b\d(?:[\d./-]*\d)?\b/gu) ?? [])];
}

/**
 * @param {any} context
 * @param {any} page
 * @param {any} blockDefinition
 * @param {number} blockIndex
 */
function renderTextBlock(context, page, blockDefinition, blockIndex) {
    const font = page.loadedFonts[blockDefinition.fontId];
    if (!font) {
        throw new Error(`Missing loaded font ${blockDefinition.fontId} for ${page.id}`);
    }
    const fontSize = blockDefinition.fontSize ?? 32;
    const lineHeight = blockDefinition.lineHeight ?? 56;
    const text = Array.isArray(blockDefinition.text)
        ? blockDefinition.text.join(' ')
        : blockDefinition.text;
    context.font = `${fontSize}px "${font.family}"`;
    context.fillStyle = '#101010';
    context.textBaseline = 'top';
    const rtl = isRtlScript(blockDefinition.script);
    context.direction = rtl ? 'rtl' : 'ltr';
    context.textAlign = rtl ? 'right' : 'left';
    const lines = Array.isArray(blockDefinition.text)
        ? blockDefinition.text
        : wrapText(context, text, blockDefinition.width);
    const anchorX = rtl
        ? blockDefinition.x + blockDefinition.width
        : blockDefinition.x;
    const lineRecords = lines.map(/** @param {string} lineText @param {number} lineIndex */ (lineText, lineIndex) => {
        const width = context.measureText(lineText).width;
        const x = rtl ? anchorX - width : anchorX;
        const y = blockDefinition.y + lineIndex * lineHeight;
        context.fillText(lineText, anchorX, y);
        return {
            id: `${page.id}-${blockDefinition.id}-line-${String(lineIndex + 1).padStart(3, '0')}`,
            text: lineText,
            readingOrder: blockIndex + lineIndex,
            polygon: {
                x,
                y,
                width,
                height: lineHeight,
            },
        };
    });
    return {
        id: `${page.id}-${blockDefinition.id}`,
        language: blockDefinition.language,
        script: blockDefinition.script,
        role: blockDefinition.role,
        polygon: {
            x: blockDefinition.x,
            y: blockDefinition.y,
            width: blockDefinition.width,
            height: Math.max(lineHeight, lines.length * lineHeight),
        },
        lines: lineRecords,
    };
}

/** @param {any} page @param {Record<string, ILoadedFont>} loadedFonts */
function renderPage(page, loadedFonts) {
    const canvas = createCanvas(PAGE_WIDTH_PX, PAGE_HEIGHT_PX);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, PAGE_WIDTH_PX, PAGE_HEIGHT_PX);
    page.loadedFonts = loadedFonts;
    const renderScale = page.renderBlocks ? PAGE_DPI / DEGRADATION_BASE_DPI : 1;
    const blockDefinitions = (page.renderBlocks ?? [{
        id: 'block-001',
        language: page.language,
        script: page.script,
        fontId: page.fontId,
        role: 'body',
        x: 126,
        y: 132,
        width: PAGE_WIDTH_PX - 252,
        text: page.text,
    }]).map(/** @param {any} block */ block => ({
        ...block,
        x: block.x * renderScale,
        y: block.y * renderScale,
        width: block.width * renderScale,
        fontSize: block.fontSize === undefined ? undefined : block.fontSize * renderScale,
        lineHeight: block.lineHeight === undefined ? undefined : block.lineHeight * renderScale,
    }));
    if (page.control === 'image-only') {
        const controlScale = renderScale;
        context.fillStyle = '#dedede';
        context.fillRect(300 * controlScale, 520 * controlScale, 740 * controlScale, 420 * controlScale);
        context.fillStyle = '#b1b1b1';
        context.fillRect(1120 * controlScale, 700 * controlScale, 820 * controlScale, 240 * controlScale);
        context.strokeStyle = '#858585';
        context.lineWidth = 12 * controlScale;
        context.strokeRect(300 * controlScale, 520 * controlScale, 1640 * controlScale, 420 * controlScale);
    }
    const blocks = blockDefinitions.map(/** @param {any} blockDefinition @param {number} index */ (blockDefinition, index) => (
        renderTextBlock(context, page, blockDefinition, index)
    ));
    const lines = blocks.flatMap(/** @param {any} block */ block => block.lines);
    const orderedLines = page.readingOrderAmbiguous
        ? []
        : lines.map(/** @param {any} line */ line => line.id);
    page.blocks = blocks;
    page.readingOrder = orderedLines;
    page.text = lines.map(/** @param {any} line */ line => line.text).join('\n');
    page.criticalTokens = criticalTokensForText(page.text);
    delete page.loadedFonts;
    const raster = canvas.toBuffer('image/jpeg', 95);
    page.imageFormat = 'jpeg';
    page.imageSha256 = sha256(raster);
    return raster;
}

const IDENTITY_AFFINE = [
    [
        1,
        0,
        0,
    ],
    [
        0,
        1,
        0,
    ],
    [
        0,
        0,
        1,
    ],
];

/** @param {any[][]} left @param {any[][]} right */
function multiplyAffine(left, right) {
    return Array.from({length: 3}, (_, row) => Array.from({length: 3}, (_, column) => {
        const leftRow = left[row] ?? [];
        const rightColumn = [
            0,
            1,
            2,
        ].map(index => right[index]?.[column] ?? 0);
        return (leftRow[0] ?? 0) * rightColumn[0]
            + (leftRow[1] ?? 0) * rightColumn[1]
            + (leftRow[2] ?? 0) * rightColumn[2];
    }));
}

/** @param {any[][]} matrix */
function stableAffine(matrix) {
    return matrix.map(row => row.map(value => Number(value.toFixed(12))));
}

/** @param {any[][]} matrix @param {{x: number, y: number, width: number, height: number}} polygon */
export function transformPolygon(matrix, polygon) {
    const corners = [
        [
            polygon.x,
            polygon.y,
        ],
        [
            polygon.x + polygon.width,
            polygon.y,
        ],
        [
            polygon.x,
            polygon.y + polygon.height,
        ],
        [
            polygon.x + polygon.width,
            polygon.y + polygon.height,
        ],
    ].map(([
        x,
        y,
    ]) => {
        const pointX = x ?? 0;
        const pointY = y ?? 0;
        const denominator = (matrix[2]?.[0] ?? 0) * pointX
            + (matrix[2]?.[1] ?? 0) * pointY
            + (matrix[2]?.[2] ?? 1);
        return [
            ((matrix[0]?.[0] ?? 0) * pointX + (matrix[0]?.[1] ?? 0) * pointY + (matrix[0]?.[2] ?? 0)) / denominator,
            ((matrix[1]?.[0] ?? 0) * pointX + (matrix[1]?.[1] ?? 0) * pointY + (matrix[1]?.[2] ?? 0)) / denominator,
        ];
    });
    const xs = corners.map(([x]) => x ?? 0);
    const ys = corners.map(([
        , y,
    ]) => y ?? 0);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
        x,
        y,
        width: Math.max(...xs) - x,
        height: Math.max(...ys) - y,
    };
}

/** @param {any} page @param {any[][]} matrix */
export function transformPageGeometry(page, matrix) {
    return {
        ...page,
        blocks: page.blocks.map(/** @param {any} block */ block => ({
            ...block,
            polygon: transformPolygon(matrix, block.polygon),
            lines: block.lines.map(/** @param {any} line */ line => ({
                ...line,
                polygon: transformPolygon(matrix, line.polygon),
            })),
        })),
    };
}

/** @param {any} image @param {number} width @param {number} height @param {string} [filter] */
function drawImageToCanvas(image, width, height, filter) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    if (filter) context.filter = filter;
    context.drawImage(image, 0, 0, width, height);
    return canvas;
}

/** @param {any} canvas @param {number} start @param {number} end @param {'x' | 'y'} axis */
function applyIllumination(canvas, start, end, axis) {
    const context = canvas.getContext('2d');
    const gradient = axis === 'x'
        ? context.createLinearGradient(0, 0, canvas.width, 0)
        : context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, `rgb(${Math.round(start * 255)}, ${Math.round(start * 255)}, ${Math.round(start * 255)})`);
    gradient.addColorStop(1, `rgb(${Math.round(end * 255)}, ${Math.round(end * 255)}, ${Math.round(end * 255)})`);
    context.save();
    context.globalCompositeOperation = 'multiply';
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
}

/** @param {any} canvas @param {number} inkRetention @param {'x' | 'y'} axis */
function applyFadedInk(canvas, inkRetention, axis) {
    const context = canvas.getContext('2d');
    const gradient = axis === 'x'
        ? context.createLinearGradient(0, 0, canvas.width, 0)
        : context.createLinearGradient(0, 0, 0, canvas.height);
    const start = Math.round((1 - inkRetention) * 255);
    gradient.addColorStop(0, `rgb(${start}, ${start}, ${start})`);
    gradient.addColorStop(1, 'rgb(255, 255, 255)');
    context.save();
    context.globalCompositeOperation = 'screen';
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
}

/** @param {{cleanRaster: Buffer, profile: any, sourceDpi?: number}} options */
export async function realizeOcrQualityProfile({
    cleanRaster, profile, sourceDpi = PAGE_DPI,
}) {
    /** @type {any} */
    let image = await loadImage(cleanRaster);
    let width = image.width;
    let height = image.height;
    let dpi = sourceDpi;
    let affine = IDENTITY_AFFINE.map(row => [...row]);
    const realizedOperations = [];
    if (dpi !== DEGRADATION_BASE_DPI) {
        const scale = DEGRADATION_BASE_DPI / dpi;
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        image = drawImageToCanvas(image, width, height).toBuffer('image/png');
        image = await loadImage(image);
        affine = multiplyAffine([
            [
                scale,
                0,
                0,
            ],
            [
                0,
                scale,
                0,
            ],
            [
                0,
                0,
                1,
            ],
        ], affine);
        realizedOperations.push({
            type: 'baseResample',
            sourceDpi: dpi,
            targetDpi: DEGRADATION_BASE_DPI,
            scale,
            width,
            height,
        });
        dpi = DEGRADATION_BASE_DPI;
    }
    for (const operation of profile.operations) {
        if (operation.type === 'resample') {
            const scale = operation.targetDpi / dpi;
            width = Math.max(1, Math.round(width * scale));
            height = Math.max(1, Math.round(height * scale));
            image = drawImageToCanvas(image, width, height).toBuffer('image/png');
            image = await loadImage(image);
            affine = multiplyAffine([
                [
                    scale,
                    0,
                    0,
                ],
                [
                    0,
                    scale,
                    0,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ], affine);
            dpi = operation.targetDpi;
            realizedOperations.push({
                ...operation,
                sourceDpi: dpi / scale,
                scale,
                width,
                height,
            });
            continue;
        }
        if (operation.type === 'gaussianBlur') {
            image = await loadImage(drawImageToCanvas(
                image,
                width,
                height,
                `blur(${operation.sigmaPx}px)`,
            ).toBuffer('image/png'));
            realizedOperations.push({
                ...operation,
                width,
                height,
            });
            continue;
        }
        if (operation.type === 'jpeg') {
            image = await loadImage(drawImageToCanvas(image, width, height)
                .toBuffer('image/jpeg', operation.quality));
            realizedOperations.push({
                ...operation,
                width,
                height,
            });
            continue;
        }
        if (operation.type === 'skew') {
            const radians = operation.degrees * Math.PI / 180;
            const cosine = Math.cos(radians);
            const sine = Math.sin(radians);
            const centerX = width / 2;
            const centerY = height / 2;
            const skewMatrix = [
                [
                    cosine,
                    -sine,
                    centerX - cosine * centerX + sine * centerY,
                ],
                [
                    sine,
                    cosine,
                    centerY - sine * centerX - cosine * centerY,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ];
            const canvas = createCanvas(width, height);
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, width, height);
            context.setTransform(cosine, sine, -sine, cosine, skewMatrix[0]?.[2] ?? 0, skewMatrix[1]?.[2] ?? 0);
            context.drawImage(image, 0, 0, width, height);
            image = await loadImage(canvas.toBuffer('image/png'));
            affine = multiplyAffine(skewMatrix, affine);
            realizedOperations.push({
                ...operation,
                canvas: 'preserved',
                affine: stableAffine(skewMatrix),
                width,
                height,
            });
            continue;
        }
        if (operation.type === 'illumination') {
            const canvas = drawImageToCanvas(image, width, height);
            applyIllumination(canvas, operation.start, operation.end, operation.axis);
            image = await loadImage(canvas.toBuffer('image/png'));
            realizedOperations.push({
                ...operation,
                width,
                height,
            });
            continue;
        }
        if (operation.type === 'fadedInk') {
            const canvas = drawImageToCanvas(image, width, height);
            applyFadedInk(canvas, operation.inkRetention, operation.axis);
            image = await loadImage(canvas.toBuffer('image/png'));
            realizedOperations.push({
                ...operation,
                width,
                height,
            });
            continue;
        }
        throw new Error(`Unsupported OCR degradation operation ${operation.type}`);
    }
    const raster = drawImageToCanvas(image, width, height).toBuffer('image/png');
    return {
        raster,
        realized: {
            profileId: profile.id,
            seed: `ocr-mLOCR-03:${profile.id}`,
            sourceDpi,
            dpi,
            width,
            height,
            affine: stableAffine(affine),
            nonlinear: false,
            geometryScored: true,
            operations: realizedOperations,
            sourceImageSha256: sha256(cleanRaster),
            imageSha256: sha256(raster),
        },
    };
}

/**
 * @param {{repositoryRoot: string, outputDirectory: string}} options
 */
export async function generateOcrLanguageQualityFixture({
    repositoryRoot,
    outputDirectory,
}) {
    const registrySource = await readFile(join(repositoryRoot, 'packages', 'contracts', 'ocrLanguages.ts'), 'utf8');
    const registryCodes = [...registrySource.matchAll(/\bcode:\s*'([^']+)'/gu)].map(match => match[1]);
    if (JSON.stringify(registryCodes) !== JSON.stringify(LANGUAGE_CODES)) {
        throw new Error(`OCR fixture language list is out of sync with packages/contracts/ocrLanguages.ts: ${registryCodes.join(',')}`);
    }
    const fontDirectory = join(repositoryRoot, 'scripts', 'fixtures', FONT_DIRECTORY);
    const {
        loaded, fontHashes,
    } = await loadFonts(fontDirectory);
    const manifest = makeManifest(fontHashes);
    const pageImages = [];
    let pageNumber = 0;
    for (const language of manifest.languages) {
        for (const passage of language.passages) {
            for (const fontVariant of language.fontVariants) {
                pageNumber += 1;
                /** @type {any} */
                const page = {
                    id: `${language.code}-p${passage.id.endsWith('1') ? '1' : '2'}-v${fontVariant.id.endsWith('1') ? '1' : '2'}`,
                    pageNumber,
                    kind: 'language',
                    language: language.code,
                    script: language.script,
                    passageId: passage.id,
                    fontVariantId: fontVariant.id,
                    fontId: fontVariant.fontId,
                    text: passage.text,
                    sourceDocumentId: `${language.code}-${passage.id}-${fontVariant.fontId}`,
                    cohortId: `${language.code}-${passage.id}-${fontVariant.fontId}`,
                    split: passage.id.endsWith('2') ? 'evaluation' : 'development',
                    evaluationEligible: passage.id.endsWith('2') && fontVariant.id.endsWith('2'),
                    readingOrderAmbiguous: false,
                };
                const font = loaded[page.fontId];
                if (!font) {
                    throw new Error(`Missing loaded font ${page.fontId}`);
                }
                const missing = missingGlyphs(page.text, font.hasGlyph);
                page.coverage = {
                    valid: missing.length === 0,
                    missingGlyphs: missing,
                    fontFamily: font.family,
                    fontSha256: fontHashes[page.fontId],
                };
                if (!page.coverage.valid) {
                    const blank = createCanvas(PAGE_WIDTH_PX, PAGE_HEIGHT_PX).toBuffer('image/jpeg', 95);
                    pageImages.push({
                        page,
                        raster: blank,
                    });
                    continue;
                }
                pageImages.push({
                    page,
                    raster: renderPage(page, loaded),
                });
            }
        }
    }
    for (const mixedDocument of MIXED_DOCUMENT_DEFINITIONS) {
        pageNumber += 1;
        /** @type {any} */
        const page = {
            id: mixedDocument.id,
            pageNumber,
            kind: mixedDocument.control ? 'control' : 'mixed',
            language: mixedDocument.selectedLanguages.join('+'),
            selectedLanguages: mixedDocument.selectedLanguages,
            script: 'mixed',
            text: '',
            sourceDocumentId: mixedDocument.id,
            cohortId: mixedDocument.id,
            split: mixedDocument.split,
            evaluationEligible: mixedDocument.split === 'evaluation',
            readingOrderAmbiguous: mixedDocument.readingOrderAmbiguous,
            orderPolicy: mixedDocument.orderPolicy ?? 'explicit-template',
            control: mixedDocument.control,
            renderBlocks: mixedDocument.blocks,
        };
        const missing = [...new Set(mixedDocument.blocks.flatMap(block => (
            missingGlyphs(block.text, loaded[block.fontId]?.hasGlyph ?? (() => false))
        )))];
        page.coverage = {
            valid: missing.length === 0,
            missingGlyphs: missing,
            fontFamily: 'mixed',
            fontSha256: null,
        };
        pageImages.push({
            page,
            raster: renderPage(page, loaded),
        });
    }
    const pdf = await PDFDocument.create();
    pdf.setTitle('EVB Viewer MLOCR-02 clean raster OCR fixture');
    pdf.setAuthor('EVB Viewer contributors');
    pdf.setCreationDate(new Date(0));
    pdf.setModificationDate(new Date(0));
    const cleanPageImages = pageImages.filter(entry => entry.page.kind === 'language');
    for (const entry of cleanPageImages) {
        const pdfPage = pdf.addPage([
            PAGE_WIDTH_POINTS,
            PAGE_HEIGHT_POINTS,
        ]);
        const image = await pdf.embedJpg(entry.raster);
        pdfPage.drawImage(image, {
            x: 0,
            y: 0,
            width: PAGE_WIDTH_POINTS,
            height: PAGE_HEIGHT_POINTS,
        });
    }
    const pdfBytes = await pdf.save({
        useObjectStreams: false,
        addDefaultPage: false,
    });
    const pdfPath = join(outputDirectory, 'ocr-language-quality-clean-raster.pdf');
    const imageDirectory = join(outputDirectory, 'pages');
    const {mkdir} = await import('node:fs/promises');
    await mkdir(imageDirectory, {recursive: true});
    const {writeFile} = await import('node:fs/promises');
    for (const entry of pageImages) {
        await writeFile(join(imageDirectory, `${String(entry.page.pageNumber).padStart(3, '0')}.jpg`), entry.raster);
    }
    await writeFile(pdfPath, pdfBytes);
    const committedManifest = {
        ...manifest,
        pages: pageImages.map(entry => entry.page),
    };
    const renderedManifest = {
        ...committedManifest,
        artifact: {
            pdfPath,
            pdfSha256: sha256(pdfBytes),
            imageDirectory,
            pageCount: cleanPageImages.length,
            sourceTextBytes: 0,
        },
    };
    await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(renderedManifest, null, 2)}\n`, 'utf8');
    return {
        manifest: renderedManifest,
        pdfPath,
        pageImages,
        languagePages: pageImages
            .filter(entry => entry.page.kind === 'language')
            .map(entry => entry.page),
        mixedPages: pageImages
            .filter(entry => entry.page.kind !== 'language')
            .map(entry => entry.page),
    };
}

export {
    DEGRADATION_PROFILES,
    DEGRADATION_BASE_DPI,
    LANGUAGE_CODES,
    MIXED_DOCUMENT_DEFINITIONS,
    OCR_POLICY,
    PAGE_DPI,
};
