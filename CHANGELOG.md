# Changelog

## [1.1.0](https://github.com/anchildress1/soundboard/compare/v1.0.0...v1.1.0) (2026-10-27)


### Features

* add YouTube audit privacy and research retention ([#20](https://github.com/anchildress1/soundboard/issues/20)) ([cef38f2](https://github.com/anchildress1/soundboard/commit/cef38f297dffa8fcac4b9d4153baafb0bc3c4277))
* **artist:** give each user their own artist profile ([#29](https://github.com/anchildress1/soundboard/issues/29)) ([5d8d09d](https://github.com/anchildress1/soundboard/commit/5d8d09d767266ae2ab0b9b5f9d0cd28c33ca592d))
* **brand:** give every artist an approved voice and brand guide ([#31](https://github.com/anchildress1/soundboard/issues/31)) ([0898c72](https://github.com/anchildress1/soundboard/commit/0898c72fc20e627f0ee9211bc57b01fb33814bb3))
* google sign-in, per-user jobs, and youtube connections ([#18](https://github.com/anchildress1/soundboard/issues/18)) ([ba88563](https://github.com/anchildress1/soundboard/commit/ba885638145d1c04dfc32e3316fc9f20fad89db2))
* guide each release step by step on a single token palette ([#25](https://github.com/anchildress1/soundboard/issues/25)) ([6f7c3e9](https://github.com/anchildress1/soundboard/commit/6f7c3e97343a5cc45cf4b97e24c0657e3ccb95b2))
* **legal:** add public Terms of Service page ([#23](https://github.com/anchildress1/soundboard/issues/23)) ([41c257c](https://github.com/anchildress1/soundboard/commit/41c257c5ffa3066a05aececf0cf2fd9436dcfd11))
* **research:** learn what grows the fanbase from peers and results ([#32](https://github.com/anchildress1/soundboard/issues/32)) ([2d8ee88](https://github.com/anchildress1/soundboard/commit/2d8ee889abbd974eda2f42e53162b3954570aa2d))
* swap self-hosted Gemma for the Gemini API ([#26](https://github.com/anchildress1/soundboard/issues/26)) ([fcee227](https://github.com/anchildress1/soundboard/commit/fcee22719a8af46cc3435d53e862857ec8d8ded4))
* **upload:** resume video uploads after dropped connections ([#28](https://github.com/anchildress1/soundboard/issues/28)) ([737ce2b](https://github.com/anchildress1/soundboard/commit/737ce2b156dd11a50949586cc27efadf9253ab28))


### Bug Fixes

* clear dependency advisories, Semgrep findings, and the dev SSR crash ([#27](https://github.com/anchildress1/soundboard/issues/27)) ([ac38a71](https://github.com/anchildress1/soundboard/commit/ac38a71fedccabf61d3f096bc32d450de969f3c5))
* enforce Neon row-level isolation ([#24](https://github.com/anchildress1/soundboard/issues/24)) ([1d71e55](https://github.com/anchildress1/soundboard/commit/1d71e55305aaecd501782d66b827785e3fa33c10))
* handle revoked tokens and model scale-down, and back off retries with p-retry ([#15](https://github.com/anchildress1/soundboard/issues/15)) ([f713688](https://github.com/anchildress1/soundboard/commit/f713688fca9846fc1dedc87a88044fa29da8883c))

## 1.0.0 (2026-10-05)


### Features

* add the Gemma 4 model sidecar, uploads bucket, and docs-only CI skip ([#2](https://github.com/anchildress1/soundboard/issues/2)) ([d8cc9c8](https://github.com/anchildress1/soundboard/commit/d8cc9c87f8d06defec0cf9d22170514e4d36b492))
* build the Soundboard P0 pipeline, UI, and deploy wiring ([#4](https://github.com/anchildress1/soundboard/issues/4)) ([cc592a3](https://github.com/anchildress1/soundboard/commit/cc592a36bc30c089c942862490d3325ad6c56e20))
* cut a vertical YouTube Short from the video's hook ([#9](https://github.com/anchildress1/soundboard/issues/9)) ([b6fb55f](https://github.com/anchildress1/soundboard/commit/b6fb55ffa9b3e7c9bdec8e2ad190db76c63edf38))
* draft Bandcamp copy and split the review into YouTube and Bandcamp tabs ([#7](https://github.com/anchildress1/soundboard/issues/7)) ([c66b614](https://github.com/anchildress1/soundboard/commit/c66b614ea4149d3bb21793fd894e49f6383ef681))
* ground picks in the genre search and Nathan's own voice ([#5](https://github.com/anchildress1/soundboard/issues/5)) ([30eb48d](https://github.com/anchildress1/soundboard/commit/30eb48daa0b12cb7a253297a019d1a2251ba5f0d))
* Sentry tracing, a demo account, and page polish ([#6](https://github.com/anchildress1/soundboard/issues/6)) ([541bb31](https://github.com/anchildress1/soundboard/commit/541bb31dceb2cb63007bd2ee99aca7493d3e8455))


### Bug Fixes

* clarify Short copy and isolate browser model tests ([#10](https://github.com/anchildress1/soundboard/issues/10)) ([c9193ba](https://github.com/anchildress1/soundboard/commit/c9193bacb7369a97dd8a5f9777c3ac434f71ee2c))
* fit the brand guide in context, serve the custom domain, and fix the model image ([#12](https://github.com/anchildress1/soundboard/issues/12)) ([c83ac96](https://github.com/anchildress1/soundboard/commit/c83ac96d6b7a5644f2e5cbb094c5858f1e87d7af))
* make deploys safe to rerun and allow every app URL in CORS ([#14](https://github.com/anchildress1/soundboard/issues/14)) ([35025c2](https://github.com/anchildress1/soundboard/commit/35025c220f7bba4e8f8fccc88d8138f289869e6e))
* record agent input and output on invoke_agent spans ([#8](https://github.com/anchildress1/soundboard/issues/8)) ([2e8397e](https://github.com/anchildress1/soundboard/commit/2e8397e29da6bf5d78fc30fa70dd582d121767a5))
* wait on Vertex operations instead of polling for the resource ([#11](https://github.com/anchildress1/soundboard/issues/11)) ([5cce32b](https://github.com/anchildress1/soundboard/commit/5cce32b39d6e99f4b48ea32b3c6802b785e70813))
