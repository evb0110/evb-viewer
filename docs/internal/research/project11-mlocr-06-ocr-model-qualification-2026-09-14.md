# MLOCR-06 OCR model qualification

Date: 2026-09-14 UTC
Repository: `evb0110/evb-viewer`
Issue: [#810, MLOCR-06](https://github.com/evb0110/evb-viewer/issues/810)
Parent: [#811, MLOCR](https://github.com/evb0110/evb-viewer/issues/811)

## Decision

Reject both bounded candidate families. Keep the current pinned Tesseract
backend unchanged.

This is a qualification result, not a recognition improvement. Neither
candidate reached a valid candidate OCR run. PP-OCRv5 fails the target
alphabet and mixed-page coverage gate. The historical Kraken files have useful
script coverage, but the exact Greek weight files say `license: None`, the
legacy repository is out of date, and this host has no usable Kraken inference
runtime. A candidate CER or WER would therefore be made up, so this report does
not publish one.

| Candidate family | Declared target | Disposition | Blocking evidence |
| --- | --- | --- | --- |
| PaddleOCR PP-OCRv5 multilingual mobile recognizers | Clean mixed `eng+rus+ell`, with Tesseract retained for unsupported languages | Reject before model execution | The Greek decoder has no Greek Extended or combining marks. The family also has no single decoder covering English, Russian and Greek together, and has no Hebrew or Syriac model. |
| Kraken historical specialist recognizers | Ancient Greek, Hebrew and Syriac | Reject for delivery, no qualified score | The legacy Greek artifacts declare `license: None`, the legacy repository says it is out of date, and the host lacks PyTorch and a complete Kraken runtime. No weight was executed. |

No production files were changed. The required single-language fallback remains
owned by MLOCR-07 if no alternate model qualifies.

## Frozen measurement

The evaluation identity was frozen before candidate review:

- Repository `HEAD`: `72a87d298a948e05b17dd6288f4db8900e0b4676`.
- Fixture definition: `scripts/fixtures/ocr-language-quality-manifest.json`,
  SHA-256 `ac15011508808c601323598f367c913dbe29b9aa958b887ef90ec458e9a5f2b7`.
- Clean source raster PDF: SHA-256
  `809b39f2a0580362dacf907aa491ad62dd9d6931cfe603276d7b3513c7ec6298`.
- Clean MLOCR-02 output PDF from the completed 30-language run: SHA-256
  `daf887475aaa054160395fc78853f7c96d9d45cb816e561e2193e35cc89f45e3`.
- Clean corpus: 30 languages, 120 valid pages, four samples per language.
- Degraded corpus: 37 selected pages, 16 profiles, 592 page/profile cases.
- Frozen split: passage 1 and sans fonts for development; passage 2 and serif
  fonts for evaluation. Mixed and degraded derivatives stay with their source
  cohort.
- Frozen adoption rule: at least 10% relative faithful-CER reduction on the
  declared error-bearing target cohort, no affected-cohort CER or WER increase,
  no lost critical token, no additional missing or duplicate line, and no new
  order or PDF-fidelity defect. Below 0.1% baseline CER, use absolute error
  counts and require at least one fewer error.

The baseline command was:

```bash
pnpm run build:scan-cleanup
EVB_OCR_QUALITY_REQUIRED=1 EVB_OCR_QUALITY_DEGRADED=1 \
  EVB_SCAN_CLEANUP_PATH=$PWD/native/target/release/evb-scan-cleanup \
  node scripts/test-ocr-quality-corpus.mjs
```

The native cleanup build reused binary fingerprint `aa213b576daf`. The
benchmark output and exit status are recorded in the final receipt below.

## Current baseline by language

The values below are the clean MLOCR-02 raw OCR scores from the same pinned
Tesseract run. CER is faithful NFC CER over Unicode scalar values. WER uses the
benchmark's combining-mark-preserving tokenizer. Denominators are included so
small percentage changes are not overstated. The searchable-PDF and consumer
text paths remain separate in the benchmark because a correct raw transcript
does not prove usable saved text.

| Language | Script | Samples | Faithful CER (errors / chars) | Faithful WER |
| --- | --- | ---: | ---: | ---: |
| `eng` | Latin | 4 | 0.000187 (1 / 5342) | 0.001199 |
| `fra` | Latin | 4 | 0.000000 (0 / 5230) | 0.000000 |
| `spa` | Latin | 4 | 0.000000 (0 / 5342) | 0.000000 |
| `por` | Latin | 4 | 0.001531 (8 / 5224) | 0.011194 |
| `ita` | Latin | 4 | 0.007019 (39 / 5556) | 0.004926 |
| `nld` | Latin | 4 | 0.001230 (6 / 4880) | 0.001344 |
| `deu` | Latin | 4 | 0.000000 (0 / 4932) | 0.000000 |
| `pol` | Latin | 4 | 0.000000 (0 / 5280) | 0.000000 |
| `ces` | Latin | 4 | 0.000000 (0 / 4384) | 0.000000 |
| `slk` | Latin | 4 | 0.000000 (0 / 4456) | 0.000000 |
| `hun` | Latin | 4 | 0.000000 (0 / 5220) | 0.000000 |
| `ron` | Latin | 4 | 0.001249 (7 / 5604) | 0.010086 |
| `swe` | Latin | 4 | 0.000206 (1 / 4844) | 0.000000 |
| `dan` | Latin | 4 | 0.000220 (1 / 4538) | 0.000000 |
| `nor` | Latin | 4 | 0.000000 (0 / 4594) | 0.000000 |
| `fin` | Latin | 4 | 0.000000 (0 / 5452) | 0.000000 |
| `hrv` | Latin | 4 | 0.000000 (0 / 4534) | 0.000000 |
| `ind` | Latin | 4 | 0.000188 (1 / 5324) | 0.000000 |
| `vie` | Latin | 4 | 0.003747 (16 / 4270) | 0.014374 |
| `tur` | Latin | 4 | 0.000406 (2 / 4924) | 0.002882 |
| `ell` | Greek | 4 | 0.003302 (18 / 5452) | 0.020631 |
| `grc` | Greek | 4 | 0.003288 (17 / 5170) | 0.015588 |
| `kmr` | Latin | 4 | 0.000000 (0 / 4252) | 0.000000 |
| `rus` | Cyrillic | 4 | 0.000000 (0 / 5320) | 0.000000 |
| `ukr` | Cyrillic | 4 | 0.000000 (0 / 4774) | 0.000000 |
| `bul` | Cyrillic | 4 | 0.000411 (2 / 4870) | 0.001462 |
| `srp` | Cyrillic | 4 | 0.000000 (0 / 4494) | 0.000000 |
| `ara` | RTL, Arabic | 4 | 0.002125 (8 / 3764) | 0.011869 |
| `heb` | RTL, Hebrew | 4 | 0.004488 (17 / 3788) | 0.025994 |
| `syr` | RTL, Syriac | 4 | 0.027336 (86 / 3146) | 0.124595 |

The already measured target gaps that motivated the two candidates are:

| Cohort | Baseline faithful CER | Meaning |
| --- | ---: | --- |
| `eng+rus+ell`, clean | 0.2137 | Mixed Latin, Cyrillic and Greek competition fails on a clean page. |
| `eng+rus+ell`, `blur-1p0px-300dpi` | 0.2557 | The hardest single-factor blur profile makes the same failure worse. |
| `ara+heb+syr`, clean | 0.1111 | The three RTL scripts fail before degradation. |
| `ara+heb+syr`, `moderate-illumination-blur05` | 0.2778 | Mixed RTL recognition degrades further under a qualified moderate profile. |
| `ara+eng`, `resample-150dpi` | 0.0508 | Arabic and Latin competition also breaches the moderate ceiling. |

Most clean single-language controls are below the 2% project ceiling in the
same run. The exceptions are `syr` at 0.027336 faithful CER and the saved-PDF
consumer path for several otherwise low-error languages. `ita` is 0.007019 and
`ell` is 0.003302 on the raw path. These are small-error cohorts except for
Syriac, so a candidate must report error counts rather than claim a large
relative improvement.

## Candidate 1: PaddleOCR PP-OCRv5

### Preflight result

The selected family was the official PP-OCRv5 multilingual mobile recognition
family, using its documented `latin`, `eslav`, `cyrillic`, `el` and `arabic`
variants. The official documentation lists the model-to-language mapping in
[PP-OCRv5 multi-language documentation](https://github.com/PaddlePaddle/PaddleOCR/blob/2661c7c0ef5c613e8f93c6e93b2e052399f0f854/docs/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.en.md).

The exact Greek decoder was checked before any conversion or inference:

- PaddleOCR source revision: `2661c7c0ef5c613e8f93c6e93b2e052399f0f854`.
- Config:
  [`el_PP-OCRv5_mobile_rec.yaml`](https://github.com/PaddlePaddle/PaddleOCR/blob/2661c7c0ef5c613e8f93c6e93b2e052399f0f854/configs/rec/PP-OCRv5/multi_language/el_PP-OCRv5_mobile_rec.yaml), SHA-256
  `c51bebbb6e9afe037e7be73f117cf9ad592e9b8941a0668bdb8f60e58194c9e8`.
- Decoder dictionary:
  [`ppocrv5_el_dict.txt`](https://github.com/PaddlePaddle/PaddleOCR/blob/2661c7c0ef5c613e8f93c6e93b2e052399f0f854/ppocr/utils/dict/ppocrv5_el_dict.txt), SHA-256
  `31defc62c0c3ad3674a82da6192226a2ba98ef4ff014a7045cb88d59f9c3de31`.
- The dictionary has 354 unique entries. It has 110 Greek and Coptic block
  entries, zero Greek Extended entries in U+1F00 through U+1FFF, and zero
  Unicode combining-mark entries. The model config adds a space at runtime and
  the CTC decoder adds its blank token.
- The `grc` fixture contains 24 distinct Greek Extended characters, including
  polytonic precomposed forms. PP-OCRv5 cannot emit any of them. The `ara`
  fixture also contains U+0651 SHADDA, while the PP-OCRv5 family selected here
  has no model for Hebrew or Syriac.

This is a hard alphabet failure, not a quality estimate. The family also does
not provide one decoder for `eng+rus+ell`: English is available in separate
English, East Slavic and Greek models, but a page-level result would need
unmeasured region routing and merging. That would be a new policy rather than a
comparison of the stated ordinary-print model family. Since the family cannot
preserve every selected language on the target cohorts, no Paddle weights were
downloaded, converted or scored.

### Disposition

Reject. PP-OCRv5 is not an eligible candidate for this product's mixed-language
cohorts. Tesseract remains the recognizer for all 30 registry entries.

## Candidate 2: Kraken historical specialist family

### Artifact and license check

The selected specialist family was the historical Kraken model set because the
observed gaps include Syriac, Hebrew and ancient Greek. The checked source was
the pinned `mittagessen/kraken-models` repository at commit
`febac55b3f6037a643243fe27d3fbaace669fc3d`. Its README says the repository is
out of date and that model distribution moved to Zenodo.

The exact local artifacts checked were:

| Target | Artifact | Size | Model metadata license | SHA-256 |
| --- | --- | ---: | --- | --- |
| Classical Syriac | `clstm/syriac-monotype/syriac.clstm` | 650,820 bytes | `Apache` | `2e418b5306c80abac5e35195dc7facbb2993127e3d6d326891dc15b2d1305182` |
| Polytonic Greek | `pyrnn/porson/porson-2013-10-23-16-14-00100000.pyrnn.pronn` | 699,193 bytes | `None` | `c8a60f6dd3b4978fd9f17b6a842a1ac483e248db238979d1fd070d3669076dd8` |
| Polytonic Greek | `pyrnn/migne/migne-2014-06-30-15-16-00100000.pyrnn.pronn` | 709,695 bytes | `None` | `ba0278b4da6219b73625ec221bf2b67f228f6c324512d9d832809aebc6e9f188` |

The repository has a top-level Apache-2.0 file, but the per-model Greek
metadata says `None`. The Syriac metadata says only `Apache`, without a
version. Those are not artifact-level redistribution grants that can be
carried into an installed application. The legacy repository also has no
dedicated Hebrew model. The checked Greek metadata does confirm polytonic
coverage, which makes the legal ambiguity especially important. It is not a
reason to pretend the candidate was measured.

The historical model documentation and files are in the
[Kraken model repository](https://github.com/mittagessen/kraken-models/tree/febac55b3f6037a643243fe27d3fbaace669fc3d).
The Kraken runtime source was checked at commit
`a314f84f42da49a34079a4166305a7f378bb9c71`. The current runtime is Apache-2.0,
but that code license does not repair the weight license ambiguity.

### Offline runtime result

The Linux host had Python 3.12.3 and Pillow, but no `torch`, `kraken`,
`paddle`, `paddleocr` or `onnxruntime`. Installing the Kraken source package
without dependencies into `.devkit/kraken-python2` succeeded with package
wheel SHA-256 `82faba07d9fa4746cb822c669e822570f8a8c42a9ac1570ad187326cedbd48e4`,
but importing `kraken.lib.models` failed with:

```text
ModuleNotFoundError: No module named 'torch'
```

The current Kraken package requires PyTorch and related inference dependencies.
The available system Python cannot create a virtual environment because
`ensurepip` and `python3-venv` are not installed. No system package or GPU stack
was added for this research ticket. This blocked offline execution of the
historical weights. It did not block source, alphabet or license inspection.

### Disposition

Reject for delivery, with candidate recognition unmeasured. The exact Greek
weights cannot be redistributed on the evidence checked, and the host could not
execute Kraken offline without provisioning a new Python/PyTorch runtime. The
candidate therefore fails before the frozen CER/WER adoption rule can be
applied. No specialist weight is integrated or presented as an improvement.

Newer Kraken Zenodo records may be worth a separate, explicitly pinned study.
They are not a result of this ticket. A future study must select one exact
artifact per scope, download it, hash the bytes, verify the model-card license,
run the oracle-line comparison, and then measure automatic detection, order,
geometry, saved-PDF extraction and search/copy behavior.

## Coverage and retention matrix

The existing Tesseract registry remains the coverage owner. The hashes in the
Tesseract column are the pinned `tessdata_best` model hashes in
`packages/contracts/ocrLanguages.ts`. `Paddle v5` means that the official
family documents a model for the individual language. It does not mean that a
single PP-OCRv5 decoder can recognize the mixed page. `Kraken historical` marks
only the exact legacy files checked above, not newer Zenodo records.

| Language | Tesseract model SHA-256 | Paddle v5 | Kraken historical |
| --- | --- | --- | --- |
| `eng` | `8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba` | yes, separate English/variant models | no selected artifact |
| `fra` | `907743d98915c91a3906dfbf6e48b97598346698fe53aaa797e1a064ffcac913` | yes, latin | no selected artifact |
| `spa` | `e2c1ffdad8b30f26c45d4017a9183d3a7f9aa69e59918be4f88b126fac99ab2c` | yes, latin | no selected artifact |
| `por` | `711de9dbb8052067bd42f16b9119967f30bada80d57e2ef24f65d09f531adb04` | yes, latin | no selected artifact |
| `ita` | `8df9c89176fb93f56bf4b2d4ede04c01c1f31d4b7697fbd76cc336df700f3f38` | yes, latin | no selected artifact |
| `nld` | `92e7a1ad4bf8082e268de57c7823316ec024935702c6ed2a1e473b3a071aa733` | yes, latin | no selected artifact |
| `deu` | `8407331d6aa0229dc927685c01a7938fc5a641d1a9524f74838cdac599f0d06e` | yes, latin | no selected artifact |
| `pol` | `e80cc4cefbdface06e9223f43f089556b9dcf104020fbc0a200f6863c57d4405` | yes, latin | no selected artifact |
| `ces` | `d821773116d3c4e0360ea750066436c60ae45af02c39da3a840a543d761b3f41` | yes, latin | no selected artifact |
| `slk` | `3553e335f64408412c8741fec19e443b5fda81d88abe59aa1401cba4e8825bed` | yes, latin | no selected artifact |
| `hun` | `08786ad5fe25d502d1cfcdf606ba215f320409a1630109582fa1a38d93b3e32d` | yes, latin | no selected artifact |
| `ron` | `93588d7e59a28fad7920db07767345438ee5eeefa3c5f20541dfb9ad083a6d2e` | yes, latin | no selected artifact |
| `swe` | `360303308aa5d4a912ac3b3637691152b7532d9bd6e960639db1affb83db7ea9` | yes, latin | no selected artifact |
| `dan` | `28901bf4b58a657b511fddafce4ce245a1f21c5ee075734b479d01ab8d4cb6a5` | yes, latin | no selected artifact |
| `nor` | `451d52ba1559aa1aecf163ccbfdeced2b9605fbd49480f5e8a53ace29b9eb0e7` | yes, latin | no selected artifact |
| `fin` | `96745dd0900fe997541516863d859616df6120430db546424feae72923828423` | yes, latin | no selected artifact |
| `hrv` | `a46566f0a1442502028bc0c35f043bc1780cc80e8567ec1b1df13d685c47215e` | yes, latin | no selected artifact |
| `ind` | `1f6596041ffb4cd5094e5f98764db43cfde04edb8f02b988f90ebc1353ac73b8` | yes, latin | no selected artifact |
| `vie` | `b6b49293d95d0b6dbd8780174627e82c75be957b6f4ed9862155540d6b00bb45` | yes, latin | no selected artifact |
| `tur` | `e0c3338dc17503dc7d335a507c9ae01b2b46cfd07561171e1e1ac55d85e8e438` | yes, latin | no selected artifact |
| `ell` | `288b4ea00bab450cf39893d22f04a2835a8469b673b5b20dcb39b159d1bbc9b8` | yes, Greek basic and modern precomposed accents only | no selected artifact |
| `grc` | `dfc9bda286cd9d8755b1832e5731a5425d1cf0803393a5fa6dee078466178cf1` | no, Greek Extended absent | yes, legacy Greek files, license unclear |
| `kmr` | `6017f6284e6771419f85a72218a2e84c5c6c19a4ed0ef27286cd637981293b76` | yes, latin family | no selected artifact |
| `rus` | `b617eb6830ffabaaa795dd87ea7fd251adfe9cf0efe05eb9a2e8128b7728d6b6` | yes, eslav/cyrillic | no selected artifact |
| `ukr` | `1277f6e3b6f707063a92d40e7678e7f57154e8414e328e340be9ee9275eea9c8` | yes, eslav/cyrillic | no selected artifact |
| `bul` | `87322f07ae023d0f61d3c12507f6f1ed22411c00f1b2e722d2e13b723584fad1` | yes, cyrillic | no selected artifact |
| `srp` | `b090f9bb22366d9b4b0cb6baa2136c4f75e992ddba01ecb78240896e359e4072` | yes, cyrillic | no selected artifact |
| `ara` | `ab9d157d8e38ca00e7e39c7d5363a5239e053f5b0dbdb3167dde9d8124335896` | yes, Arabic variant | no selected artifact |
| `heb` | `dbaa827aea6bc21215638447f17783a1004987c2d0bf5573d111fee397abdae5` | no | no legacy Hebrew artifact |
| `syr` | `7642168b7731866d0ec4c74c67780913db4a04583874fcff0078daa8430bd887` | no | yes, Syriac file, license version unclear |

For languages marked unsupported, Tesseract coverage is retained. No language
is silently routed to a candidate with an incomplete alphabet.

## Automatic page, order and geometry qualification

No candidate reached this stage. The benchmark separates these concerns, and
the report does not infer them from model documentation:

1. Oracle-line recognition would be run first with fixed raster and PSM.
2. Automatic page detection would then be measured separately.
3. Reading order and geometry would be scored without sorting predicted lines
   into the reference order.
4. Saved-PDF extraction, search and copying would be checked separately from
   raw OCR.

The PP-OCRv5 alphabet and coverage failure makes an oracle-line result unable to
qualify the target page. Kraken could not produce an oracle-line result because
the runtime was unavailable, and its selected historical artifacts failed the
redistribution check. There are consequently no candidate values for line
completeness, duplicate lines, critical tokens, order, geometry, memory,
package size or runtime. This is an explicit incomplete measurement, not a
pass.

## Remaining quality gaps

- Clean single-language text is mostly below the project ceilings, but Syriac,
  Italian and Greek still have measurable errors. At the low end, absolute
  error counts matter more than percentage claims.
- Mixed-language competition remains the main failure. The clean
  `eng+rus+ell` and `ara+heb+syr` cohorts fail before degradation. The
  `ara+eng` resampling cohort also fails its moderate ceiling.
- `resample-150dpi` and `blur-1p0px` remain the hardest single-factor profiles.
- PP-OCRv5 cannot represent the polytonic Greek code points in the `grc`
  fixture, and its documented model family does not cover Hebrew or Syriac.
- The historical Kraken candidate has useful alphabets but no clear
  artifact-level redistribution terms for the exact Greek weights. The host
  also lacks the runtime needed to measure it.
- No alternate engine has demonstrated complete image-to-text-and-geometry
  behavior, saved-PDF fidelity, search/copy behavior or acceptable runtime on
  this corpus.
- MLOCR-07 must implement the required product outcome. If no new bounded
  candidate is qualified, that outcome is the single-language recognition
  restriction, while all individual languages and existing multilingual PDFs
  remain supported.

## Final receipt

The report is complete only as a reject qualification. It does not claim a
delivered OCR improvement and does not authorize an engine integration.

- Candidate dispositions: PP-OCRv5 reject; Kraken historical reject for
  delivery, unmeasured recognition.
- Required full benchmark: build reused binary fingerprint `aa213b576daf`;
  MLOCR-02 clean report completed for 30 languages and its output PDF hash was
  `daf887475aaa054160395fc78853f7c96d9d45cb816e561e2193e35cc89f45e3`.
  MLOCR-03 completed for 592 page/profile cases. The command exited
  successfully.
- Verification after this report: `pnpm lint && pnpm typecheck`.
- No new test file, CI job, npm check script, lint rule or validation stage was
  added.
