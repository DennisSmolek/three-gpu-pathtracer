# Windows WebGPU compilation

Measured on 2026-10-07 against upstream `5f0ad5154a44224ae4b6c801b65778471dabf367`. The fork's old main is preserved in `codex/archive-main-2026-10-07`; the original `pr/42` work is preserved in `codex/archive-pr42-2026-10-07`.

## Implemented

- Upgrade three.js to r186.1 and matching types; update `Source` to `TextureSource` and require r186+ peers.
- Give kernel storage buffers and material/IES atlas uniform arrays stable names. Equivalent instances now generate identical compute WGSL instead of embedding different global node IDs.
- Preserve wavefront kernel identities when pixel queues and ray-slot buffers resize. Their WGSL arrays are runtime-sized, and r186 refreshes storage bindings when the node's value changes. Shader-generating changes still rebuild kernels.
- Add `WebGPUPathTracer.createAsync`, `setSceneAsync` and `compileAsync`, using three's public `compileComputeAsync`. Setup commands retain uniform snapshots, dispatch sizes, texture-copy order, and resource disposal order.
- Compile independent nodes in a sliding window of four. A shared mutable uniform waits for the compiler using it. Free slots refill without waiting for the slowest shader in a batch. Failure cleanup waits for all in-flight compilers.
- Prepare the default low-resolution preview, full-resolution buffers, pool-copy/reset kernels, sample counters, scene fallback and display material before starting the loop. The primitives demo uses this path by default.

```js
await renderer.init();
renderer.setSize(width, height);

const tracer = await WebGPUPathTracer.createAsync(renderer);
await tracer.setSceneAsync(scene, camera);
renderer.setAnimationLoop(() => tracer.renderSample());
```

For the megakernel, pass `{ useMegakernel: true }` to `createAsync`. `compileAsync({ concurrency: 1 })` provides a serial comparison; supported concurrency is 1–8. Preparation resets accumulation and submits setup GPU work. Suspend rendering and configuration changes on the renderer until the promise resolves. Optional denoisers and upscalers retain their own readiness lifecycle. Geometry/BVH construction and texture-atlas raster blits retain their CPU/synchronous setup behavior.

## Measurements

Hardware: NVIDIA GeForce RTX 3060 Laptop GPU, adapter vendor `nvidia`, architecture `ampere`, driver `32.0.15.9200`; Chrome `154.0.8037.98`, Windows. Each leg starts a new owned browser profile. NVIDIA's driver cache is retained. Jobs run sequentially, source remains fixed, order alternates between runs, and there is no screencast. This measures browser-profile-cold startup on one adapter; it does not establish FXC, Intel, AMD, or runtime-FPS results.

Three paired runs of the real `primitives.html` demo, 640×480, including transitions through 480×320/1,000 slots, 800×600/5,000 slots and 640×480/250,000 slots:

| Metric (median of three) | Synchronous setup on r186.1 | Async setup on r186.1 |
| --- | ---: | ---: |
| Largest animation-frame gap | 4054.6 ms | 272.7 ms |
| Synchronous compute-pipeline calls, including transitions | 15 | 0 |
| First fully faded full-resolution image | 5937.9 ms | 5857.6 ms |

The frame-gap reduction is about 93%. Full-resolution readiness is similar within the spread of these runs; this is primarily a responsiveness and cache-reuse improvement. The synchronous `ready` mark precedes lazy compilation, while the async mark follows preparation, so comparing those two marks alone would be misleading.

The textured/IES-lit 64×64 fixture uses one converged sample and three paired runs. It retains two tracers on one renderer, replaces one scene, and checks that the other tracer's image remains unchanged:

| Equivalent second-instance setup + 25 frames | Unnamed buffers | Stable buffer names |
| --- | ---: | ---: |
| Median | 2092.9 ms | 341.9 ms |

This is about 84% less elapsed setup work. All compared table readbacks (253,952 bytes), image readbacks (65,536 bytes), and equivalent-instance images match bit for bit. Changed-scene output differs while the original instance remains unchanged. Both wavefront and megakernel fixtures pass, with zero synchronous compute creation on their async paths and no WebGPU validation errors. The megakernel result is a one-pair smoke check, not a three-run speed claim.

An isolated experiment compiled the same captured r185 compute set on fresh devices: a serial median of 4092.0 ms versus 3000.8 ms with a four-slot sliding window, about 27% less preparation time. These use automatic layouts and include module creation and pipeline readiness; they are diagnostic timings rather than a whole-demo speed claim. The largest material kernel is approximately 79 KB and remains the dominant cold pipeline, roughly 2.8 seconds in the isolated capture.

The exposure-style uniform outer-loop experiment was rejected: Turquin's table remained byte-identical, but pipeline preparation stayed approximately 59–60 ms. Narrowing the Sobol bit loop also showed no useful compile improvement in the quick isolated test. Neither shader-math experiment is shipped. The TSL `select()` isolation/pinning blowup found in Homefig was not observed in these function-based WGSL compute kernels.

Compact evidence is in [windows-compile-results.json](./windows-compile-results.json). Raw WGSL, samples and screenshots are regenerated under ignored `bench/results/`.

## Reproduce

Use Node 22.12+ or Node 24 and an installed Chrome or Edge with hardware WebGPU. `--browser` and `CHROME_PATH` select an explicit executable; otherwise installed Chrome/Edge or Puppeteer's browser is discovered. The browser is isolated from personal profiles.

```powershell
npm ci
npm run test:compute-preparation
npm run lint
npm run build
npm run build-examples

# Real demo: sync/async startup, full-resolution capture, resize and slot-budget transitions
npm run bench:compile:example -- --runs 3 --expected-vendor nvidia

# Stable names A/B, exact textured/IES readbacks, independent instance resources
npm run bench:compile -- --async --resources --runs 3 --expected-vendor nvidia
npm run bench:compile -- --async --resources --backend mega --runs 1 --expected-vendor nvidia

# Compare serial/sliding preparation of the exact captured compute shader set
npm run bench:compile:raw -- --source bench/results/compile/wavefront-0-stable-buffers-shaders.json --runs 3 --expected-vendor nvidia
```

The fixture supports `--variant baseline|stable-buffers`, `--concurrency 1..8`, `--power-preference high-performance|low-power`, `--browser`, and `--output`. Its baseline removes only the stable buffer names; both legs use the same three.js version, async scheduler, fixture and pool-binding behavior. The example compares legacy synchronous setup against the async APIs with the final pool-binding fix present in both legs. Append `?compile=sync` to `primitives.html` for the synchronous demo.

## Sources and remaining scope

The implementation applies findings from Homefig `origin/next` at `d4740c230`: `CLAUDE.md` (WebGPU Shader Compile Rules), `wiki/development/windows-shader-perf/RESULTS.md`, and `init-and-compile-system.md`; and upscaler main `5821d91` (v0.5.0), including the Windows audit/follow-up notes and example command preparation.

Further reduction of the dominant cold material pipeline needs generated-HLSL/compiler analysis and shader factoring experiments. Add a Dawn trace when attributing time specifically to DXC or proving zero driver compiles on warm reloads: module hashes and API counters alone do not establish that. Raster atlas blits, optional post passes, different camera/material/random strategies, forced FXC, longer lifecycle tests and other adapters need separate coverage.
