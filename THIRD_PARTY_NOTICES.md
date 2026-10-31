# Third-Party Notices

TWICE's own code is licensed under the [MIT License](LICENSE). That grant does not replace any third-party license below. Copyright and license texts are distributed with the extension in `licenses/` and `vendor/tesseract/`; the repository paths below start with `public/`. Open `licenses.html` in the installed extension, or Settings → Open-source licenses, to read them offline.

This software is based in part on the work of the Independent JPEG Group.

## Components shipped in the extension

Versions were reviewed on 2026-11-01. Native library revisions come from the exact tesseract.js-core 7.0.0 source tree. JavaScript submodules were identified from the official Tesseract.js 7.0.0 source maps; where the bundle omits a submodule version, it is labelled as embedded rather than assigning an unverified exact version.

| Component | Version / revision | License | Original texts |
|---|---|---|---|
| [wxt](https://github.com/wxt-dev/wxt/blob/main/LICENSE) | `0.21.5` | MIT | [LICENSE](public/licenses/wxt/LICENSE) |
| [@wxt-dev/browser](https://github.com/wxt-dev/wxt/blob/main/LICENSE) | `0.3.7` | MIT | [LICENSE](public/licenses/wxt/LICENSE) |
| [@wxt-dev/storage](https://github.com/wxt-dev/wxt/blob/main/LICENSE) | `1.3.0` | MIT | [LICENSE](public/licenses/wxt/LICENSE) |
| [superlock](https://www.npmjs.com/package/superlock/v/1.4.13) | `1.4.13` | MIT | [LICENSE.md](public/licenses/superlock/LICENSE.md) |
| [vite](https://www.npmjs.com/package/vite/v/8.3.5) | `8.3.5` | MIT | [LICENSE.md](public/licenses/vite/LICENSE.md) |
| [rolldown](https://www.npmjs.com/package/rolldown/v/1.2.16) | `1.2.16` | MIT | [LICENSE](public/licenses/rolldown/LICENSE) |
| [dequal (embedded in @wxt-dev/storage)](https://github.com/lukeed/dequal/tree/2.0.3) | `2.0.3` | MIT | [LICENSE](public/licenses/dequal/LICENSE) |
| [Tesseract.js](https://github.com/naptha/tesseract.js/tree/42eae669e4b3a66429d8516f078912cc747a89df) | `7.0.0` | Apache-2.0 | [LICENSE-tesseract.js.md](public/vendor/tesseract/LICENSE-tesseract.js.md), [tesseract.min.js.LICENSE.txt](public/vendor/tesseract/tesseract.min.js.LICENSE.txt), [worker.min.js.LICENSE.txt](public/vendor/tesseract/worker.min.js.LICENSE.txt) |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core/tree/acffef2b66eb44a31df297e11d905f4b39001068) | `7.0.0` | Apache-2.0 | [LICENSE](public/vendor/tesseract/core/LICENSE) |
| [regenerator-runtime](https://github.com/facebook/regenerator.git#main) | `embedded in Tesseract.js 7.0.0` | MIT | [regenerator-runtime.txt](public/licenses/tesseract-js/regenerator-runtime.txt) |
| [zlibjs](https://github.com/imaya/zlib.js.git) | `embedded in Tesseract.js 7.0.0` | MIT | [zlibjs.txt](public/licenses/tesseract-js/zlibjs.txt) |
| [wasm-feature-detect](https://github.com/GoogleChromeLabs/wasm-feature-detect.git) | `embedded in Tesseract.js 7.0.0` | Apache-2.0 | [wasm-feature-detect.txt](public/licenses/tesseract-js/wasm-feature-detect.txt) |
| [bmp-js](https://github.com/shaozilee/bmp-js.git) | `embedded in Tesseract.js 7.0.0` | MIT | [bmp-js.txt](public/licenses/tesseract-js/bmp-js.txt) |
| [is-url](https://github.com/segmentio/is-url.git) | `embedded in Tesseract.js 7.0.0` | MIT | [is-url.txt](public/licenses/tesseract-js/is-url.txt) |
| [buffer](https://github.com/feross/buffer.git) | `embedded in Tesseract.js 7.0.0` | MIT | [buffer.txt](public/licenses/tesseract-js/buffer.txt) |
| [base64-js](https://github.com/beatgammit/base64-js.git) | `embedded in Tesseract.js 7.0.0` | MIT | [base64-js.txt](public/licenses/tesseract-js/base64-js.txt) |
| [ieee754](https://github.com/feross/ieee754.git) | `embedded in Tesseract.js 7.0.0` | BSD-3-Clause | [ieee754.txt](public/licenses/tesseract-js/ieee754.txt) |
| [idb-keyval](https://github.com/jakearchibald/idb-keyval) | `embedded in Tesseract.js 7.0.0` | Apache-2.0 | [idb-keyval.txt](public/licenses/tesseract-js/idb-keyval.txt), [Apache-2.0](public/vendor/tesseract/LICENSE-tesseract.js.md) |
| [tesseract](https://raw.githubusercontent.com/Balearica/tesseract/2a9c1c49c360462733c386d2a44fcd22c4e21411/LICENSE) | `2a9c1c49c360` | Apache-2.0 | [tesseract-native.txt](public/licenses/tesseract-core/tesseract-native.txt) |
| [leptonica](https://raw.githubusercontent.com/DanBloomberg/leptonica/4af068b56a9674da915debea4ed7e1b9885b17e8/leptonica-license.txt) | `4af068b56a96` | BSD-2-Clause | [leptonica.txt](public/licenses/tesseract-core/leptonica.txt) |
| [giflib](https://raw.githubusercontent.com/mirrorer/giflib/fa37672085ce4b3d62c51627ab3c8cf2dda8009a/COPYING) | `fa37672085ce` | MIT | [giflib.txt](public/licenses/tesseract-core/giflib.txt) |
| [libjpeg](https://raw.githubusercontent.com/LuaDist/libjpeg/6c0fcb8ddee365e7abc4d332662b06900612e923/README) | `6c0fcb8ddee3` | IJG | [libjpeg.txt](public/licenses/tesseract-core/libjpeg.txt) |
| [libpng](https://raw.githubusercontent.com/glennrp/libpng/a37d4836519517bdce6cb9d956092321eca3e73b/LICENSE) | `a37d48365195` | libpng-2.0 | [libpng.txt](public/licenses/tesseract-core/libpng.txt) |
| [libtiff](https://raw.githubusercontent.com/libsdl-org/libtiff/b51bb157123264e26d34c09cc673d213aea61fc7/COPYRIGHT) | `b51bb1571232` | libtiff | [libtiff.txt](public/licenses/tesseract-core/libtiff.txt) |
| [libwebp](https://raw.githubusercontent.com/webmproject/libwebp/20ef03ee351d4ff03fc5ff3ec4804a879d1b9d5c/COPYING) | `20ef03ee351d` | BSD-3-Clause | [libwebp.txt](public/licenses/tesseract-core/libwebp.txt), [libwebp-PATENTS.txt](public/licenses/tesseract-core/libwebp-PATENTS.txt) |
| [openlibm](https://raw.githubusercontent.com/JuliaMath/openlibm/ae2d91698508701c83cab83714d42a1146dccf85/LICENSE.md) | `ae2d91698508` | MIT/BSD/ISC/SunPro (see full text) | [openlibm.txt](public/licenses/tesseract-core/openlibm.txt) |
| [zlib](https://raw.githubusercontent.com/madler/zlib/21767c654d31d2dccdde4330529775c6c5fd5389/README) | `21767c654d31` | Zlib | [zlib.txt](public/licenses/tesseract-core/zlib.txt) |
| [Emscripten runtime](https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.15/LICENSE) | `Emscripten 4.0.15` | MIT OR NCSA | [emscripten.txt](public/licenses/tesseract-core/emscripten.txt) |
| [musl libc](https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.15/system/lib/libc/musl/COPYRIGHT) | `Emscripten 4.0.15` | MIT/BSD (see full text) | [musl.txt](public/licenses/tesseract-core/musl.txt) |
| [LLVM libc++](https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.15/system/lib/libcxx/LICENSE.TXT) | `Emscripten 4.0.15` | Apache-2.0 WITH LLVM-exception | [libcxx.txt](public/licenses/tesseract-core/libcxx.txt) |
| [LLVM libc++abi](https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.15/system/lib/libcxxabi/LICENSE.TXT) | `Emscripten 4.0.15` | Apache-2.0 WITH LLVM-exception | [libcxxabi.txt](public/licenses/tesseract-core/libcxxabi.txt) |
| [LLVM compiler-rt](https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.15/system/lib/compiler-rt/LICENSE.TXT) | `Emscripten 4.0.15` | Apache-2.0 WITH LLVM-exception | [compiler-rt.txt](public/licenses/tesseract-core/compiler-rt.txt) |
| [English trained data](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata) | `tessdata_fast` | Apache-2.0 | [LICENSE](public/vendor/tesseract/lang/LICENSE) |
| [Korean trained data](https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_best_int/kor.traineddata.gz) | `4.0.0_best_int` | Apache-2.0 | [LICENSE](public/vendor/tesseract/lang/LICENSE) |

## Redistribution and provenance

- The bundled OCR JavaScript and WASM wrappers match the official npm 7.0.0 distributions byte for byte. The original Apache texts and minified-bundle license sidecars are retained. Additional dependency notices are provided under `public/licenses/`.
- The core build links its native image codecs, Leptonica, OpenLibm and C/C++ runtime. The original notices, including libwebp patent terms, are included. OpenLibm's license document also describes LGPL test programs; those tests are not included by the upstream `install-static` build used here. This does not license the shipped math library under LGPL.
- The English model is the pinned tessdata_fast revision above, compressed locally with unchanged uncompressed model bytes. The Korean model was matched by uncompressed SHA-256 to `4.0.0_best_int/kor.traineddata.gz`. Exact bundled asset and license-text hashes are in [licensing/third-party.json](licensing/third-party.json); the packaged copy is `licenses/components.json`.
- WXT and its storage/browser modules, superlock, embedded dequal, and Vite/Rolldown runtime helpers are part of the shipped code even though the top-level packages are installed as development dependencies.
- No third-party audio recordings or web fonts are shipped. Sounds are synthesized; the icon assets are generated by `scripts/generate-icons.py`.

## Build/test tools and external services

The installed build/test package inventory is recorded in [licensing/development-dependencies.json](licensing/development-dependencies.json). It includes MIT, ISC, Apache-2.0, BSD and MPL-2.0 packages. Lightning CSS's MPL-2.0 applies to the build tool; the audited production bundle contains its generated CSS, not the tool's source/binary. The inventory is platform-specific and is not a claim that every development package is redistributed.

Chrome, Gemini Nano model files and any user-selected external AI service are not included in TWICE's distribution or covered by TWICE's MIT grant. Access to those products remains subject to their own terms. TWICE's external API adapter uses HTTP and does not bundle an OpenAI or other model SDK.

Run `pnpm licenses:check` after vendor changes and `pnpm licenses:inventory` after dependency updates. The build checks runtime package versions and unknown bundled modules, preserves the notices, and generates the offline license page. Re-review the registry whenever dependencies or OCR assets change.
