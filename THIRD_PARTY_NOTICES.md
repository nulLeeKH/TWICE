# Third-Party Notices

TWICE bundles the following local OCR components under `public/vendor/tesseract`. No remote CDN is used at runtime.

| Component | Version / Data | Upstream | License |
|---|---|---|---|
| Tesseract.js | 7 | https://github.com/naptha/tesseract.js | Apache-2.0 (`public/vendor/tesseract/LICENSE-tesseract.js.md`) |
| tesseract.js-core | 7 | https://github.com/naptha/tesseract.js-core | Apache-2.0 (`public/vendor/tesseract/core/LICENSE`) |
| English trained data | `eng.traineddata.gz` | https://github.com/tesseract-ocr/tessdata_fast | Apache-2.0 (`public/vendor/tesseract/lang/LICENSE`) |
| Korean trained data | `kor.traineddata.gz` | https://github.com/naptha/tessdata | Apache-2.0 (`public/vendor/tesseract/lang/LICENSE`) |

Development dependencies (`wxt`, `typescript`, `vitest`) are listed in `package.json` and `pnpm-lock.yaml` under their respective open-source licenses.
