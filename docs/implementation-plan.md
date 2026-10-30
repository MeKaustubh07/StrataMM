# StrataMM — Implementation Plan (rev. 2)

> **Status (2026-10-30, build day):** library, tests (T1–T10, 100% coverage, 23/23 mutants), tooling and the research
> harness are built on `main`; a pre-launch review gate (28 confirmed findings) is fixed and recorded as
> protocol amendment 2026-10-30c. The timing campaign runs **tonight, unattended** ([runbook](./campaign-runbook.md));
> analysis and report tomorrow. Rev. 2 incorporates all 45 findings of an internal adversarial review.
> Experiment spec: [`research-protocol.md`](./research-protocol.md).

## 0. Summary

1.  **`dgemmsw`** — a drop-in, stdlib-convention Strassen–Winograd companion to `@stdlib/blas/base/dgemm` (same 14/19
    argument signatures, messages and quick returns), upstreamable unchanged as `@stdlib/blas/ext/base/dgemmsw`.
2.  **An evidence study** — correctness, same-backend speedup, crossover, attribution (layout vs leading-dimension
    locality vs arithmetic), memory and floating-point error under a pre-registered protocol with raw data.

OpenAI's ω ≤ 9/4 (`openai/math` #107) is **motivation only**: its paper "does not specify a competitive finite matrix
size". Strassen (log₂7) remains the only exponent-lowering algorithm with demonstrated FP64 crossovers; nobody has
published Strassen measurements for JS/V8, and stdlib's own `dgemm` benchmarks stop at N = 316.

## 1. Evidence so far (POC; indicative, single machine, labelled per the protocol's metrics)

| Question | Answer | Evidence |
|---|---|---|
| Is the 22-step, 2-temporary schedule (Boyer et al. Table 1) correct? | **Yes** — value-exact vs `dgemm` (`Object.is` when β = 0) | POC 4,000 trials; library smoke test 3,000 trials (1,939 recursive) |
| Do tests catch bugs? | 9/9 POC mutants killed; library 23/23 mutants killed (T8) | `poc/`, `etc/mutation/` |
| Special values / overflow | Inf, NaN and near-overflow inputs delegate to `dgemm` → bitwise identical | library smoke test |
| Speed (row-major NN, β = 0, LD = n, cutoff 64) | n = 512: **1.395×** [1.391, 1.397] (6 blocks); n = 1024: **≈ 1.68×** at steady state | `poc/benchmark/results/isolated-*.jsonl` |
| Does recursion alone help? | 8-product control ≈ 1.00× (n = 512), ≈ 0.99× (n = 1024) | same |
| How much is the multiplication saving? | **Unresolved**: SW/control = 91–103% of (8/7)^L; at n = 1024 a ≈7% power-of-two-LD penalty hits A0 and the control but not SW's compact temporaries → decided by E3's padded-LD arm | internal review |
| Accuracy, U[−1,1] (n = 512) | η_M 2.7u (L = 1) → 239u (L = 6); η_N 3.6e4u at L = 6, far below f_W | `accuracy-*.jsonl` |
| Accuracy, U[0,1] | SW beats `dgemm` **only** for n ≥ 256 with leaves ≥ 64; worse at n ≤ 128 for every L | same (one seed; H7 tests it) |
| Accuracy, outside-scaled (2^±16, n = 512) | entries with **no correct digit**: 0.09% / 1.5% / 6.7% at L = 1 / 3 / 6 (`dgemm`: 0); per-entry relative error up to 5.1e6 | internal review (BigInt-confirmed) |
| Accuracy, inside-scaled | η_R 4.6e7–9.5e10 u (7–11 digits lost relative to the largest entry) while η_N ≤ 755u ≪ f_W | internal review |

## 2. Decisions (final)

| # | Decision | Value |
|---|---|---|
| D1 | Package name | `@stdlib/blas/ext/base/dgemmsw` (BLAS name + algorithm suffix, like `dasumpw`, `dsumkbn`) |
| D2 ✔ | Layout | mirrored at `lib/node_modules/@stdlib/blas/ext/base/dgemmsw/`; harness in `research/`; docs in `docs/` |
| D3 ✔ | Public API | drop-in `dgemm` signatures; workspace allocated per call (≈ (2/3)n², + n² when β ≠ 0), measured (E7) and documented; a `W`-argument variant only if maintainers ask |
| D4 | Dependencies | exact pins: `@stdlib/{blas,ndarray,string,utils,math,assert,strided,constants}@0.4.1`, `@stdlib/array@0.5.1`; dev `@stdlib/{bench@0.5.1,random@0.4.1,number@0.4.1}`, `tape@4.5.1`, `proxyquire@2.1.3`, `c8@7.14.0`; `--ignore-scripts`; npm `dgemm` kernel byte-identical to the local checkout; `ddot` pure JS |
| D5 | β ≠ 0 | product into an M×N temporary (C's layout), then `C = P + βC` (5/3·n²); Boyer Table 2 (< n²) only if E7 justifies |
| D6 | Delegation to `dgemm` | depth 0, α = 0, K = 0, non-finite α/β/A/B, and the overflow guard (D7) |
| D7 | Overflow guard | delegate if `4^L·max(‖A‖_M,‖B‖_M) > 2^1021` (sums) or `‖A‖_M‖B‖_M·K·4.5^L·max(1,|α|) + |β|·‖C‖_M ≥ 2^1023` (products, U-chain, β term; NaN ⇒ delegate) |
| D8 | Validation | `dgemm`'s messages and order; order resolved with `layout-resolve-str`; LDA/LDB checks from the **resolved** transposes (fixes `dgemm`'s enum/`'conjugate-transpose'` bug) |
| D9 ✔ | Headers | `Copyright (c) 2026 The Stdlib Authors.` |
| D10 | npm | not published in v1 |
| D11 | Level cap | `LEVELS = 4` (ESSL `DGEMMS` precedent) |
| D12 | Cutoff | provisional 64; final τ* chosen by the pre-registered pilot rule tonight and written to `lib/defaults.js` |
| D13 | Git | work on `main`; commit after `npm run build` passes; push before the campaign (provenance) |

## 3. Architecture

```text
 dgemmsw( order, transA, transB, M, N, K, α, A, LDA, B, LDB, β, C, LDC )        lib/dgemmsw.js ┐ only these two read
 dgemmsw.ndarray( transA, transB, M, N, K, α, A, sa1, sa2, oa, B, …, C, …, oc )  lib/ndarray.js ┘ lib/defaults.js
        │ validation (dgemm's messages; resolved strings)
        ▼
 lib/base.js( …19 args…, cutoff, levels )
   1 quick return (identical to dgemm)
   2 L = depth(M,N,K,cutoff,levels); delegate if L = 0 ∨ α = 0 ∨ K = 0 ∨ α/β non-finite
   3 swap strides for transposes
   4 maxAbs(op(A)), maxAbs(op(B)) [+ maxAbs(C) if β ≠ 0] → delegate on NaN/Inf or guard (D7)
   5 one Float64Array workspace (workspace_length.js) [+ M·N if β ≠ 0]
   6 β = 0 → winograd(…, α, C)        β ≠ 0 → winograd(…, α, P); C = P + β·C (axpby.js)
        ▼
 lib/winograd.js — 22 steps, 7 recursive products, α folded into leaves, level countdown, layout-mirrored X/Y
   ├─ leaves + peeling fix-ups: @stdlib/blas/base/dgemm.ndarray (public API)
   └─ lib/add.js, lib/sub.js (loop order from the output's layout; alias-safe)
```

## 4. Low-level design notes

-   **Schedule** (into): 1 S3→X, 2 T3→Y, 3 P7→C21, 4 S1→X, 5 T1→Y, 6 P5→C22, 7 S2→X, 8 T2→Y, 9 P6→C12, 10 S4→X,
    11 P3→C11, 12 P1→X, 13 C12+=X, 14 C21+=C12, 15 C12+=C22, 16 C22+=C21, 17 C12+=C11, 18 T4→Y, 19 P4→C11, 20 C21−=C11,
    21 P2→C11, 22 C11+=X. Never mix Huss-Lederman's numbering.
-   **Workspace:** per level X = m·max(k,n) (holds S, then P1; (M,N,K) = (32,160,96) is the regression case), Y = k·n;
    stack `[X | Y | child]`; E1 = Σ m_i·max(k_i,n_i) + k_i·n_i = (2/3)(1 − 4^−L)n² for square powers of two.
-   **Peeling:** K odd → `dgemm(2m, 2n, 1, α, …, β=1)`; N odd → `dgemm(2m, 1, K, α, …, β=0)`; M odd →
    `dgemm(1, N, K, α, …, β=0)`. Regions are disjoint; C is never read in product mode.
-   **Semantics vs `dgemm`:** values exact on integer data; `±0` identical when β = 0 (may differ when β ≠ 0); special
    values identical (delegation); rounding differs on real data (normwise bound only); C must not alias A/B.

## 5. Tooling

| Command | What it does |
|---|---|
| `npm test` | tape over `…/dgemmsw/test/test*.js` |
| `npm run lint` | `etc/lint.sh`: stdlib's ESLint configs per file group, `--report-unused-disable-directives`, resolver preload for `lib/index.js`'s canonical self-require |
| `npm run test:cov` | `etc/coverage.sh`: one c8 process with `--all --exclude-node-modules=false`, `--check-coverage --100`, plus a canary that fails on an empty file set |
| `npm run test:mutation` | `etc/mutation/run.js`: copies the package to `.mutants/<id>/`, applies each mutant from `mutants.json`, runs the suite; any survivor fails |
| `npm run build` | lint + tests (the pre-commit gate) |

## 6. Test plan (all green before the campaign)

| ID | Content |
|---|---|
| T1 | stdlib unit tests: exports, arity (14/19), one test per invalid argument, quick returns, α/β special cases, the corrected enum/LDA behaviour |
| T2 | all 58 `dgemm` fixtures, twice: real cutoff and cutoff 1 (proxyquire on `dgemmsw.js`/`ndarray.js` with a counting wrapper on `winograd.js` that must fire) |
| T3 | exact differential fuzz (M, N, K ≤ 80, cutoffs 1–16, levels 1–3/∞, all layouts, LD padding, offsets, negative strides, whole buffers, `Object.is` when β = 0) + rectangular extremes |
| T4 | Kronecker-sign adversary at the safe bound; dyadic α/β |
| T5 | non-finite α/β/A/B/C and finite near-overflow (each guard term) → `Object.is`-identical to `dgemm` |
| T6 | workspace guard sentinels; closed forms; `depth()` |
| T7 | η_N ≤ f_W on seeded real data (exact BigInt or Dot2 reference) |
| T8 | mutation runner: schedule, peeling, workspace, α, layout mirroring, each guard term, transposes, `axpby`, `depth`, validation |
| T9 | 100% coverage with the canary |
| T10 | leaf-path parity: every leaf/peel call takes the same `dgemm` path (naive vs blocked) as the top-level call, all 16 layout/transpose combinations |

## 7. Research harness (spec: protocol rev. 2)

```text
research/
├── protocol.json            frozen design; its SHA-256 is in every record
├── harness/   orchestrator.js (--dry-run | --preflight-only | --tiny | --diagnostics | --campaign; resumable)
│              preflight.js · design.js · budget.js · resume.js · diagnostics.js
│              child.js (one configuration per fresh process; verified warmup; Freivalds gates; GCProfiler)
│              algorithms.js · controls/{classic,packed}.js · env.js (provenance) · memory.js (E7)
├── accuracy/  reference.js (Dot2, 4 workers, cached) · families.js (F1–F11) · metrics.js · strassen18.js (V1)
│              scaling.js (V2) · certify.js (DotK(3) + BigInt) · run.js (E6)
├── correctness/e1.js        100k exact differential trials
├── analysis/  stats.js · crossover.js · summarize.js · plots.js (SVG) · report.js (REPORT.md draft)
└── data/<campaign>/         campaign.jsonl, accuracy.jsonl, e1.jsonl, frozen.json, campaign.log, derived/, figures/
```

## 8. Timeline

| When | Work | Done when |
|---|---|---|
| Today, morning | scaffold, pinned deps, library core | ✔ smoke test green |
| Today, midday | package docs, tests T1–T10 and tooling (lint/coverage/mutation) ∥ research harness, accuracy pipeline and analysis ∥ protocol/plan/runbook rev. 2 | all suites pass |
| Today, afternoon | integration: `npm run build`, coverage 100%, mutation all killed; `orchestrator --dry-run`, `--tiny`, `--diagnostics`; E1 (100k trials, CPU only) | gates in runbook §1 |
| Today, late afternoon | adversarial review gate on code + harness; fixes; commit; push | review findings fixed or waived in writing |
| Tonight | machine prep + launch from Terminal (runbook §2–3); all other applications closed | `CAMPAIGN COMPLETE` |
| Tomorrow | analysis (`summarize`, `plots`, `report`), certification, README headline + claims checklist, τ* into `defaults.js`, upstream issue drafts, thread draft | every number traced to raw records |

## 9. Obstacles and resolutions

| Obstacle | Resolution |
|---|---|
| JIT warmup asymmetry: `gc()` discards `dgemm`'s OSR code; A0 measured cold (+5.7% at n = 1024) | gate → `gc()` → 3 untimed calls → `gc()` → samples; `--trace-opt` diagnostics; `warmup_suspect` flag |
| Power-of-two LD penalty (~7%) that SW's compact temporaries avoid | padded-LD arm (n + 8) and n = 1008 in E3; LD named in every claim; leaf-time diagnostics |
| 2× layout code path inside `dgemm` | layout-mirrored temporaries + T10 parity gate + C1 packed control reported honestly |
| Single-process JIT artifacts | fresh process per configuration, randomized blocks |
| Noisy fanless laptop (battery, animated wallpaper, apps, swap) | preflight gate, sentinels, paired ratios, launch from Terminal with all other applications closed, resumable orchestrator |
| Budget overrun / selection bias | computed budget, priority order with cut list, cutoff picked by a pre-registered rule on pilot data only, fixed replication |
| IEEE special values and overflow | non-finite delegation + three-term guard + T5 + mutants |
| No componentwise error bound | per-entry "no correct digit" metric, diagonal-scaling arm, level cap, honest README notes |
| stdlib tooling outside the monorepo (resolution, lint doctest, c8 skipping `lib/node_modules`, proxyquire depth, tape 4 vs 5) | npm namespace pins, lint resolver preload, c8 flags + canary, direct-requirer stubs with counters, pinned tape 4.5.1 |
| ml-matrix cross-check (E8) without adding a dependency | a separate, manual check script (`poc/side-checks/`) |

## 10. Side contributions (to be filed upstream)

1.  stdlib `dgemm` main-API LDA/LDB validation bug with integer enums and `'conjugate-transpose'` (reproduced).
2.  stdlib `dgemm` K = 0 inconsistency between paths with non-finite α (reference BLAS returns βC).
3.  stdlib `dgemm` layout gap: row-major × row-major takes the 2× slower blocked path; packing (or a larger block size,
    per the existing `TODO`) — E3/E0 quantify it.
4.  ml-matrix `mmulStrassen` quadrant swap above 512 — confirmed by reading `setSubMatrix(matrix, startRow,
    startColumn)`; run `poc/side-checks/mlmatrix-strassen-check.js` before reporting upstream.

## 11. Open items

-   Order in which to file the side contributions upstream.

## 12. References

Strassen 1969 (10.1007/BF02165411) · Winograd 1971 (10.1016/0024-3795(71)90009-7) · Douglas et al. 1994
(10.1006/jcph.1994.1001) · Huss-Lederman et al. 1996 (10.1145/369028.369096) · Boyer et al. 2009
(10.1145/1576702.1576713) · Higham 1990 (10.1145/98267.98290) · Higham 2002, ASNA ch. 23 (10.1137/1.9780898718027) ·
Ballard et al. 2016 (10.1137/15M1032168) · Huang et al. 2016 (10.1109/SC.2016.58) · Ogita–Rump–Oishi 2005
(10.1137/030601818) · Hoefler & Belli 2015 (10.1145/2807591.2807644) · Barrett et al. 2017 (10.1145/3133876) ·
OpenAI `openai/math` #107 (`lean/docs/107.md`).
