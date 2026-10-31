# TWICE 라이선스 검토 기록

검토일: 2026-11-01. 브랜치: `codex/license-review`. 기준 소스: `9596dcb`와 작업 시작 시 존재하던 README·`src/audio/music.js`의 미커밋 변경. 원격 `origin/main`과 커밋 차이가 없음을 확인했습니다. 기존 미커밋 변경은 보존합니다.

## 최신 구현과 라이선스 범위

현재 제품은 Tesseract `kor+eng` OCR, 번역 없이 한국어·영어 원문을 전달하는 Gemini Nano, 선택적인 OpenAI 호환 HTTP API, 16종 분위기의 16/32마디 조합형 작곡, Web Audio 합성과 한·영 UI를 사용합니다. 모델 SDK나 녹음 음원·외부 폰트는 배포하지 않습니다. `private: true`는 npm 발행 방지 설정으로 유지하며 오픈소스 라이선스 여부와는 별개입니다.

사용자가 선택한 프로젝트 라이선스는 MIT입니다. 프로젝트가 권리를 가진 코드에 적용하며, 외부 코드·학습 데이터·서비스까지 MIT로 재허가한다는 의미는 아닙니다. [OSI MIT 원문](https://opensource.org/license/mit), [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)과 각 구성 요소의 원문 조건을 기준으로 확인했습니다.

## 확인 및 보완

| 항목 | 근거와 처리 |
|---|---|
| 프로젝트 라이선스 없음 | 루트 LICENSE, package.json SPDX `MIT`, README 범위 설명 추가 |
| Tesseract 부속 고지 누락 | 공식 npm 7.0.0 원본의 `tesseract.min.js.LICENSE.txt`, `worker.min.js.LICENSE.txt` 복원 |
| OCR 자산 버전이 `7`로만 표시 | npm 7.0.0 ESM·worker·core 3종과 SHA-256 일치 확인. 원본 파일 수정 없음 |
| OCR 내부 JS | 공식 소스맵에서 9개 모듈 식별. 전체 고지 원문 추가. 정확한 하위 버전이 없으면 상위 번들 버전으로 표시 |
| WASM 네이티브 코드 | npm gitHead `acffef2b66eb44a31df297e11d905f4b39001068`의 빌드 스크립트·서브모듈 확인. Tesseract·Leptonica·giflib·libjpeg·libpng·libtiff·libwebp·OpenLibm·zlib 원문 포함 |
| C/C++ 런타임 | `build-with-docker.sh`의 Emscripten 4.0.15 기준. Emscripten·musl·libc++·libc++abi·compiler-rt 고지 포함 |
| 특수 고지 | IJG 인정 문구, libwebp PATENTS, libpng·TIFF 등 원문 조건 유지 |
| 학습 데이터 | 영문 tessdata_fast 고정 커밋·국문 `4.0.0_best_int` 원본과 비압축 모델 해시 확인. 압축/비압축 해시 기록 |
| 실제 앱 번들 | emitted modules에서 WXT, @wxt-dev/browser/storage, superlock 확인. storage에 미리 번들된 dequal 2.0.3과 Vite/Rolldown 생성 런타임 포함 |
| 개발 도구 | 설치된 143개: MIT 112, ISC 9, Apache-2.0 4, BSD-2-Clause 13, BSD-3-Clause 3, MPL-2.0 2. 누락된 SPDX/UNLICENSED 패키지 없음 |
| 배포 고지 | LICENSE·THIRD_PARTY_NOTICES·34개 고지 원문·성분/해시 JSON·오프라인 licenses.html을 빌드/ZIP에 포함 |

Lightning CSS와 해당 macOS 네이티브 패키지의 MPL-2.0은 빌드 도구에 적용됩니다. 실제 앱 모듈 목록에는 포함되지 않습니다. OpenLibm 원문은 LGPL 테스트도 설명하지만 upstream은 `install-static`으로 라이브러리를 빌드하며 별도 `test/check` 대상은 호출하지 않습니다. 그 테스트를 재배포 라이브러리의 라이선스로 분류하지 않았습니다.

## 재현과 유지

`third-party.json`은 34개 구성 요소, 7개 OCR 자산, 고지 원문의 해시·출처를 기록합니다. 네이티브 라이브러리는 upstream 커밋을, 내부 JS는 공식 소스맵을 기준으로 식별했습니다. 상위 번들이 정확한 하위 버전 정보를 제공하지 않는 경우 임의의 번호를 붙이지 않았습니다.

- `pnpm licenses:check`: 고지 누락·변경, 미등록 벤더 자산, 검토하지 않은 개발 라이선스 검사.
- `pnpm build` / `pnpm zip`: 실제 emitted modules의 npm 패키지·버전·라이선스를 등록 목록과 대조. `licenses/bundled-packages.json`에 개인 경로 없이 기록.
- `pnpm licenses:inventory`: 현재 OS의 설치된 의존성 목록 갱신. 다른 OS의 미설치 optional 패키지까지 확인했다는 의미는 아님.
- 새 의존성·OCR 파일·버전 변경 시 고지 원문·자산 해시·이 기록을 재검토. 미리 번들된 JS와 WASM은 npm 최상위 license 필드만으로 판별하지 않음.

검토는 저장소·공식 배포본·상위 빌드 구조의 대조 기록입니다. 전체 소스의 저작권 귀속, 상표·특허 전반이나 외부 서비스 약관을 보증하는 문서는 아닙니다. Chrome/Nano/외부 API 코드·모델은 TWICE 배포본에 포함되지 않으므로 프로젝트 MIT 범위에서 분리했습니다.

## 이번 변경의 검증

- `pnpm licenses:check`: 구성 요소 34개·OCR 자산 7개·고지 원문 34개 검사 통과.
- `pnpm check`: 타입·단위 51/51·라이선스 검사를 포함한 배포 빌드 통과.
- `pnpm test:e2e`: 실제 Chrome·OCR·가짜 모델 46/46. 오프라인 라이선스 페이지와 원문 링크, 한·영 설정 링크 포함.
- 등록되지 않은 가짜 런타임 모듈과 임시 벤더 자산을 각각 넣었을 때 검사 실패를 확인한 뒤 제거.
- `pnpm zip`: 고지·프로젝트 LICENSE·각 라이선스 원문과 해시 JSON 포함 확인.

오디오 DSP는 수정하지 않았습니다. 기존 음악 파일의 미커밋 JSDoc 변경도 유지했으며 오디오 검사는 이번 라이선스 작업에서 다시 실행하지 않았습니다. 커밋·푸시·PR·릴리즈는 수행하지 않았습니다.
