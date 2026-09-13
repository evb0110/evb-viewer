import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    createCanvas, GlobalFonts,
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
const PAGE_WIDTH_PX = Math.round(PAGE_WIDTH_MM / 25.4 * PAGE_DPI);
const PAGE_HEIGHT_PX = Math.round(PAGE_HEIGHT_MM / 25.4 * PAGE_DPI);
const PAGE_WIDTH_POINTS = PAGE_WIDTH_MM / 25.4 * 72;
const PAGE_HEIGHT_POINTS = PAGE_HEIGHT_MM / 25.4 * 72;
const FONT_DIRECTORY = 'ocr-language-fonts';

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
    return {
        schemaVersion: 1,
        benchmark: 'MLOCR-02',
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

/** @param {any} page @param {ILoadedFont} fontDefinition */
function renderPage(page, fontDefinition) {
    const canvas = createCanvas(PAGE_WIDTH_PX, PAGE_HEIGHT_PX);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, PAGE_WIDTH_PX, PAGE_HEIGHT_PX);
    context.font = `32px "${fontDefinition.family}"`;
    context.fillStyle = '#101010';
    context.textBaseline = 'top';
    const rtl = page.script === 'arabic' || page.script === 'hebrew' || page.script === 'syriac';
    context.direction = rtl ? 'rtl' : 'ltr';
    context.textAlign = rtl ? 'right' : 'left';
    const margin = 126;
    const maxWidth = PAGE_WIDTH_PX - margin * 2;
    const lineHeight = 56;
    const top = 132;
    const lines = wrapText(context, page.text, maxWidth);
    const lineRecords = lines.map((text, index) => {
        const width = context.measureText(text).width;
        const x = rtl ? PAGE_WIDTH_PX - margin - width : margin;
        const y = top + index * lineHeight;
        context.fillText(text, rtl ? PAGE_WIDTH_PX - margin : margin, y);
        return {
            id: `${page.id}-line-${String(index + 1).padStart(3, '0')}`,
            text,
            readingOrder: index,
            polygon: {
                x,
                y,
                width,
                height: lineHeight,
            },
        };
    });
    if (lines.length * lineHeight + top > PAGE_HEIGHT_PX - 100) {
        throw new Error(`${page.id} does not fit on the fixed page`);
    }
    page.blocks = [{
        id: `${page.id}-block-001`,
        polygon: {
            x: margin,
            y: top,
            width: maxWidth,
            height: lines.length * lineHeight,
        },
        lines: lineRecords,
    }];
    page.readingOrder = lineRecords.map(line => line.id);
    const raster = canvas.toBuffer('image/jpeg', 95);
    page.imageFormat = 'jpeg';
    page.imageSha256 = sha256(raster);
    return raster;
}

/**
 * @param {{repositoryRoot: string, outputDirectory: string, manifestPath: string}} options
 */
export async function generateOcrLanguageQualityFixture({
    repositoryRoot,
    outputDirectory,
    manifestPath,
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
                    language: language.code,
                    script: language.script,
                    passageId: passage.id,
                    fontVariantId: fontVariant.id,
                    fontId: fontVariant.fontId,
                    text: passage.text,
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
                    raster: renderPage(page, font),
                });
            }
        }
    }
    const pdf = await PDFDocument.create();
    pdf.setTitle('EVB Viewer MLOCR-02 clean raster OCR fixture');
    pdf.setAuthor('EVB Viewer contributors');
    pdf.setCreationDate(new Date(0));
    pdf.setModificationDate(new Date(0));
    for (const entry of pageImages) {
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
    await writeFile(manifestPath, `${JSON.stringify(committedManifest, null, 2)}\n`, 'utf8');
    const renderedManifest = {
        ...committedManifest,
        artifact: {
            pdfPath,
            pdfSha256: sha256(pdfBytes),
            imageDirectory,
            pageCount: pageImages.length,
            sourceTextBytes: 0,
        },
    };
    await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(renderedManifest, null, 2)}\n`, 'utf8');
    return {
        manifest: renderedManifest,
        pdfPath,
        pageImages,
    };
}

export {
    LANGUAGE_CODES, PAGE_DPI,
};
