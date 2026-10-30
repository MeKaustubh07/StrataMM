# StrataMM — Research Protocol (pre-registration, rev. 2)

> **Revision 2 (2026-10-30)** supersedes the 2026-10-29 draft after an internal adversarial review (45 confirmed
> findings). The campaign runs **unattended overnight**; every decision that depends on data (cutoff selection, warmup
> confirmation) is made by a rule written here, executed by the orchestrator, and recorded in
> `research/data/<campaign>/frozen.json`. Changes after launch are dated amendments (§12).
> Step-by-step launch instructions are in [`campaign-runbook.md`](./campaign-runbook.md).

## 0. Requirements → mechanisms

| Requirement | Mechanism |
|---|---|
| Correctness before complexity | Package tests T1–T10 green (incl. mutation and coverage gates) before launch; Freivalds gate on the first and last timed call of every process |
| Fair, same-backend comparisons | Same Node binary, flags, inputs, α/β, layout and leading dimension (LD); SW leaves call the public `dgemm.ndarray`; leaf-path parity is a test (T10) |
| Real crossover | One-level arm A1 (break-even) and deployed arm A2; one threshold θ per definition (§7) |
| Numerical stability | Dot2 double-double reference; 11 families; normwise, componentwise and **per-entry relative** metrics |
| Memory | analytic vs ΔarrayBuffers (read on return; §12, 2026-10-30b) vs ΔmaxRSS in dedicated fresh processes |
| Edge cases | odd/prime/rectangular shapes, all transpose/layout combos, LD padding, α/β variants |
| No misleading results | fresh process per config, randomized blocks, sentinels, verified warmup, raw JSONL, provenance, CIs, losses reported |
| No scope creep | WASM/native/AlphaTensor schemes excluded; Strassen-18 and diagonal scaling only as accuracy arms |
| Research as differentiator | attribution (layout vs LD/locality vs arithmetic) + speed–accuracy Pareto + memory accounting |

## 1. Hypotheses (stated before data; each names its metric)

| ID | Hypothesis | Prior evidence (POC, steady-state) |
|---|---|---|
| H1 | A2 beats A0 for n above a crossover n* (row-major NN, β=0), with break-even (A1) at n ≤ 256 | one-level break-even ≈ 64–128 vs the control |
| H2 | 8-product recursion alone gives S ≈ 1.00 at LD = n+8; at power-of-two LD, SW additionally avoids a ≈7% LD penalty | control 1.000× (n=512) / ≈0.99× (n=1024); SW/C2 at 93.6% of (8/7)³ (n=512) but ≈99% of (8/7)⁴ (n=1024) |
| H3 | Packing B to column-major (C1) gives ≈2× over A0 at n ≤ 1024, more than A2 | 1.90–2.08× incl. copy (n = 128–512) |
| H4a | Zero-mean (F2/F3): per-level growth g (on η_F, median over seeds) ∈ [1.7, 3]; η_N ≤ f_W always | g ≈ 2.0–2.7 |
| H4b | Outside-scaled (F4): η_C ≥ 1e10·u and a nonzero fraction of entries with E ≥ \|C\| for L ≥ 1 (n ≥ 128), while R_N = η_N(SW)/η_N(A0) ≤ 1e2 | 0.09% / 1.5% / 6.7% entries with no correct digit at L = 1/3/6, n = 512 |
| H4c | Inside-scaled (F5): η_R ≥ 1e6·u and R_N ≥ 1e6 for every L ≥ 1, while η_N ≤ f_W | R from 1.3e7 to 1.8e10 |
| H4d | Diagonal scaling (V2) brings η_C (F4) and η_R (F5) within 10× of A0 | Ballard et al. 2016 |
| H5 | Peak extra memory = 8·E1 bytes exactly (β = 0) and 8·(MN + E1) (β ≠ 0) | single allocation per call |
| H6 | Peeling overhead is visible as a sawtooth in SW time per flop on O-family sizes | 5.45% at 1023³ |
| H7 | U[0,1] (F1): SW is more accurate than A0 iff the leaf size k₀ = n/2^L ≥ 64 and n ≥ 256 | holds in 11 seeds |

## 2. Environment and pre-flight (orchestrator-enforced)

-   Machine: MacBook Air M2 (Mac14,2, fanless), 4P+4E, 8 GB; macOS 26.4.1; Node **v22.14.0** pinned (V8 12.4.254.21;
    Maglev disabled ⇒ Ignition → Sparkplug → TurboFan).
-   Checked at start and before every block (fail ⇒ pause 60 s, re-check up to 10 min, then stop): AC power, Low Power
    Mode off, thermalState = 0 (JXA `NSProcessInfo`), no foreign process > 20% CPU, no process matching the optional
    blocked-process pattern (`STRATAMM_BLOCKED_PROCESSES`), swap not growing, `kern.memorystatus_vm_pressure_level` = 1.
    A power-source change stops the campaign.
-   Launched from Terminal under `caffeinate -i`, with all other applications quit (runbook).

## 3. Algorithms and controls

| ID | Definition | Role |
|---|---|---|
| A0 | stdlib `dgemm` (public API) | baseline |
| A1 | SW one level: `base.js(…, cutoff=1, levels=1)` | break-even (one-level crossover) |
| A2 | SW deployed: `base.js(…, τ*, L_max=4)`, τ* from §5.1 | deployed configuration |
| C1 | packed `dgemm`: B copied to column-major **inside** the timed call (buffer allocated per call), then `dgemm` | layout control |
| C2 | 8-product recursion with SW's split, cutoff, level cap, peeling and leaves | recursion control |
| V1 | classic Strassen (18 additions) | accuracy only |
| V2 | SW with outside + inside diagonal scaling by powers of two (Ballard et al. 2016, Alg. 1) | accuracy and its time cost |

Every timed algorithm runs at **LD = n** and, in E3, at **LD = n + 8** (padded arm). The research harness loads the
package by relative path (`lib/node_modules/@stdlib/blas/ext/base/dgemmsw/lib/base.js`) and records path + SHA-256.
Leaf-path parity (T10) is a launch gate; a diagnostic run records per-leaf operand strides and leaf time.

## 4. Timing protocol

-   **Replication unit:** one fresh Node process per (algorithm, shape, LD, replicate), `--expose-gc` only, minimal env,
    `BENCH_PAD` U{0..4095} bytes, 0.5 s pause (2 s after n ≥ 1024).
-   **Blocks:** randomized complete blocks; algorithm order within a block uniformly random (seeded; `pos_in_block`
    recorded and tested for an effect); sentinel (A0, n = 256, LD = 256, 5 warmup + 15 samples) before each block; drift
    > 3% vs the median of the first 5 sentinels ⇒ pause/re-check.
-   **Child procedure (all algorithms, all tiers; warmup as amended in §12, 2026-10-30c):** seeded inputs; C filled with NaN when
    β = 0, or with seeded C₀ restored untimed before each call when β ≠ 0; **gate call** (timed as `first_call`,
    Freivalds-checked: ‖Cx − (αA(Bx) + βC₀x)‖∞ / (|α||A||B||x| + |β||C₀||x|)∞ < 1e−8) → `gc()` → **3 untimed
    full-size calls** → `gc()` → k timed samples (batch b(n) so each sample ≥ 20 ms) → final Freivalds check.
    Rationale: an explicit `gc()` discards V8's on-stack-replacement code for `dgemm`'s single long loop; only the third
    call after it runs fully optimized code. SW/C2 warm `dgemm` through their leaf calls, so without this rule only A0
    is measured cold (POC: +5.7% at n = 1024).
-   **Per-sample records:** `hrtime.bigint`, `cpuUsage`, `resourceUsage`, `v8.GCProfiler` events, anti-DCE sink.
-   **Flags (never deleted):** `gc`, `preempt` (cpu/wall < 0.90), `slow_mode` (> 1.5× process median), `tukey3`,
    `warmup_suspect` (min/median of the process's samples < 0.98). Whole-process exclusion only for gate failure,
    swapouts, pressure ≥ 2, thermalState ≥ 2, power change, or > 20% flagged samples (kept with `excluded: true`).
-   **Diagnostics (separate processes, not timed):** `--trace-opt --trace-deopt` for A0 and A2 at n ∈ {512, 2048}: zero
    compile/OSR/deopt events for `blocked`, `naive`, `ddot` and the SW kernels after the second `gc()`.

| Tier | Sizes | k | r (blocks) |
|---|---|---|---|
| S | n ≤ 128 | 30 | 10 |
| M | n ≤ 384 | 20 | 10 |
| L | n ≤ 1025 | 10 | 6 |
| XL | 1536, 2048 | 3 | 4 (labelled low replication) |

Replication is **fixed** (no adaptive extensions): inconclusive cells are reported as inconclusive.

## 5. Campaign stages (in order; resumable from the append-only JSONL)

### 5.1 Pilot and automatic freeze (≈ 15 min)

Pilot (r = 2, excluded from inference): A0 and A2 at n ∈ {512, 1024} for τ ∈ {16, 32, 64, 128, 256} (L_max = 4);
A0 and A2(τ = 64) at n = 2048 (XL warmup check); A0 at n ∈ {32…192} to fix b(n).
**Selection rule:** for each n ∈ {512, 1024} let t_best(n) = min over τ of the median per-call time; τ* = the **largest**
τ whose median is ≤ 1.02 · t_best(n) at **both** sizes (fewest levels within the ±2% band). Ties impossible by
construction. The orchestrator writes τ*, L_max, b(n) and the protocol hash to `frozen.json`; the library default in
`lib/defaults.js` is set to τ* afterwards (identical code path, so no re-run is needed). The pilot τ cells are never
quoted as speedups.

### 5.2 Timing experiments (priority order; on overrun, cut from the bottom)

| ID | Question | Design | Est. |
|---|---|---|---|
| E2 | **Crossover and speedup (primary)** | row-major NN, α=1, β=0, LD=n; A0, A1, A2; families P = {32, 64, 128, 256, 512, 1024, 2048}, O = {255, 257, 511, 513, 1023, 1025}, R = {48, 96, 160, 192, 320, 384, 768, 1536} | ≈ 50 min |
| E3 | **Attribution ladder** | n ∈ {512, 1008, 1024} × LD ∈ {n, n+8}: A0, C2, A2; plus C1 at LD = n; r = 10 (512) / 6 | ≈ 25 min |
| E5 | Shapes, layouts, α/β | n = 512: 4 transpose combos and column-major (A0, A2); β = 1 and (α=0.5, β=2) at n ∈ {512, 1024}; rectangular (1024,1024,256), (256,1024,1024), (2048,512,512), (160,1957,957); r = 6 | ≈ 20 min |
| E4 | Depth sweep (exploratory) | n ∈ {512, 1024, 2048}: leaf size ∈ {32, 64, 128, 256} (levels uncapped) | ≈ 20 min |
| E0 | Baseline characterization (unreplicated) | A0, 8 (order, trans) combos × n ∈ {64, 256, 1024}; LD ∈ {n, n+8, 1024} at n = 256 | ≈ 8 min |

n = 1008 = 63·2⁴ is even down to the leaves at τ = 64 (no peeling) and has a non-power-of-two LD.

### 5.3 Memory (E7, ≈ 5 min) — §9. 5.4 Accuracy (E6, ≈ 40 min, after all timing) — §8.

E1 (100k exact differential trials) and E8 (ml-matrix check, manual) run outside the exclusive window. The orchestrator
prints its own budget computed from this design before starting (`--dry-run`); expected total ≈ 3–3.5 h.

## 6. Statistics

-   Per process: median per-call time. Per cell: median of the r process medians; IQR of pooled samples; min–max of
    process medians.
-   Speedup S = cell(A0) / cell(alg), paired within blocks. 95% CI by block bootstrap (B = 10,000, percentile, seed
    recorded); r ≤ 4 ⇒ per-block ratios + t-interval on log ratios (df = r − 1), labelled "low replication".
-   Verdicts per cell: **faster** (CI lower > 1 and S ≥ 1.02), **faster (< 2% margin)** (CI lower > 1, S < 1.02),
    **equivalent** (CI ⊂ [0.98, 1.02]), **slower** (CI upper < 1 and S ≤ 0.98), otherwise **inconclusive**.
-   C2 and the ladder terms are reported as **estimates with CIs**, not forced verdicts. Ladder terms are ratios of cell
    medians with block-bootstrap CIs; sanity rule: if A2/C2 ≥ (8/7)^L the cell is flagged "confounded".

## 7. Crossover definitions

-   Families as in §5.2; **P is primary**. Per family, two thresholds, never mixed:
    -   **Break-even (θ = 1):** conservative n*₁ = smallest n such that every larger n in the family has CI lower > 1,
        found by a **fixed-sequence test** from n_max downward at the per-cell 95% level, stopping at the first failure
        (controls family-wise error; no Bonferroni needed). Point estimate: crossing of log S = 0 interpolated between
        the bracketing sizes inside each bootstrap replicate (last upward crossing; censored at < n_min / > n_max).
        Computed on **A1** (A2 equals A0 exactly for n ≤ τ*, so A2 is interpolated only over n > τ*).
    -   **Practical (θ = 1.02):** same procedure with "faster" verdicts and log S = log 1.02.
-   Every crossover is stated as specific to cutoff × layout × LD × machine × Node version.

## 8. Accuracy methodology (E6)

-   **Reference:** Dot2 on pre-split operands, unevaluated double-double (hi, lo); E_ij = |(Ĉ_ij − hi) − lo|.
    Validated against BigInt (≤ 0.6% of the a-priori bound). Computed once per (family, seed, n) in a 4-worker pass,
    cached as `.f64` + SHA-256; certified per run with DotK(3) on 1,000 random + the 20 worst entries and BigInt on 32.
    Preconditions instead of a fixed window: |a|, |b| < 2^996, nonzero |a·b| ≥ 2^−969, |A||B| finite.
-   **Families (seeds: 10 for n ≤ 512, 5 at 1024, 3 at 2048):** F1 U[0,1]; F2 U[−1,1]; F3 N(0,1); F4 outside-scaled
    (s ∈ {10, 20, 40}); F5 inside-scaled; F6 Ballard et al. §6.5; F7 Pascal × U[0,1] (n ≤ 128); F8 I·B, |b| ∈ 2^[−30,30];
    F9a GenDot rows/columns (κ = 1e4…1e16); F9b B = fl(A⁻¹); F10 Kronecker signs; F11 integers/dyadics.
    n ∈ {64, 128, 256, 512, 1024}; n = 2048 only for F1, F2, F4, F5.
-   **Arms:** A0; SW at L = 1…6 (levels = L, cutoff 1); V1 at L = 1…6; V2 at L = 1…6 on F4–F7.
-   **Metrics:** η_N = max E/(u‖A‖_M‖B‖_M) and ρ_N = η_N/f_W; η_C = max E_ij/(u(|A||B|)_ij) (max, p99.9, median);
    η_R = max E/(u‖C‖_M); η_F = ‖E‖_F/(u‖|A||B|‖_F); η_M = max E/(u·max(|A||B|)) (the POC metric, never compared with
    f_W); **per-entry relative:** fraction of entries with E_ij ≥ |C_ij| and ≥ 1e−8·|C_ij|, max and p99.9 of
    E_ij/|C_ij|, histogram of log₂(E_ij/|C_ij|); κ-binned relative error for F9.
-   **Bounds:** classic ‖ΔC‖_M ≤ K²u‖A‖‖B‖, |ΔC| ≤ γ_K|A||B|; Strassen [12^L(k₀² + 5k₀) − 5K]u‖A‖‖B‖; Winograd variant
    f_W = 18^L(k₀² + 5.5625k₀) − 5.5625K (re-derived for this schedule; ≤ Higham's [18^L(k₀² + 6k₀) − 6K]).
-   **Hard gates (violation = bug, stop):** classic η_N ≥ K² or η_C > K; SW or V1 with ρ_N ≥ 1; any F11 inexactness.
    **Warnings (investigate, not bugs):** g outside [1.7, 3] (g = median over seeds of (η_F(L)/η_F(0))^{1/L}, F2/F3
    only); F1 with k₀ ≥ 32 and L ≤ 4 more than 2× worse than A0. ρ_N is reported, never range-checked.
-   **Parallelism:** reference pass 4 `worker_threads`; evaluations as 4 single-threaded processes over (family, seed, n);
    run only after all timing.

## 9. Memory methodology (E7)

Fresh process per (algorithm, n ∈ {256, 512, 1024, 2048}, β ∈ {0, 1}), 3 replicates: allocate and touch A, B, C;
`gc()`; snapshot `memoryUsage()` and `resourceUsage().maxRSS`; one call under `GCProfiler`; snapshot; `gc()`; snapshot.
ΔarrayBuffers is read immediately on return (valid for single-allocation arms; GC events recorded; §12, 2026-10-30b item 2); ΔmaxRSS only in a fresh process. Report next to 8·E1 (+8MN), as multiples of 8MN.

## 10. Raw data and provenance (`research/data/<campaign>/*.jsonl`, schema `sw-bench/2`)

Records: `campaign`, `env_check`, `frozen`, `proc` (incl. LD, warmup trace, gate, flags, steady class), `sample`, `mem`,
`accuracy` (incl. per-entry relative metrics and histograms). Provenance per campaign: project commit + dirty flag
(`research/data/` excluded from the dirty check), package and stdlib versions, `require.resolve` paths (asserted under
the repo), SHA-256 of every loaded `@stdlib` file and of the package sources, Node/V8, `process.config` V8 options,
timer tick/overhead, pure-JS `ddot` assertion.

## 11. Reporting rules (README, REPORT.md, X thread)

1.  Every number cites raw records (file + ids) and the commit. 2. Speedups with 95% CIs and absolute baseline times;
    losses and inconclusive cells shown. 3. Every speed claim names layout, **LD**, cutoff, levels, n, machine, Node.
4.  Every speed claim is paired with the accuracy cost at the same (n, L), including the per-entry "no correct digit"
    fraction on scaled families. 5. OpenAI's ω ≤ 9/4 is motivation only, with its own "no competitive finite size"
    caveat. 6. The layout result (H3) is reported even if it overshadows Strassen. 7. Limitations: single fanless laptop;
    no core pinning or frequency locking on macOS; ±2% band near the noise floor; XL low replication; RSS resolution;
    Node 22.14 / V8 12.4 without Maglev only.

## 12. Amendments

-   **2026-10-30 (rev. 2, before any campaign data):** incorporated the 45 review findings — verified warmup procedure;
    padded-LD arm and n = 1008; cutoff selection rule and automatic freeze; level cap L_max = 4; one-threshold crossover
    with fixed-sequence test and defined families; fixed replication; per-entry relative-error metrics; recalibrated
    sanity rules (hard gates vs warnings); E6 parallelism and ordering; β ≠ 0 child procedure; C1 allocation accounting.
-   **2026-10-30b (after building the harness, before any campaign data):**
    1.  End-gate integrity: with β = 0, C is refilled with NaN (untimed) before the last sample, so a stale C fails.
    2.  E7: every call (including `dgemm`) triggers 1–5 GCs, so "0 GCs" is never met. ΔarrayBuffers is valid for
        algorithms that make a single allocation per call when read immediately on return (validated: equals the
        analytic bytes exactly at n = 256/512); GC events are still recorded and ΔmaxRSS is reported alongside.
    3.  τ fallback: if no τ is within 1.02× of the best at both sizes, choose the τ with the smallest worst-case
        slowdown (larger τ on ties) and flag it in `frozen.json`.
    4.  E4 runs the SW arms only; its speedups use E2's A0 cells and are labelled "unpaired".
    5.  `preempt` is weak on Node 22.14 (`process.cpuUsage` includes V8 background threads); it is reported, and
        exclusions effectively rest on `slow_mode` and the hard conditions.
    6.  Resuming on a different night starts a new campaign (`--new`): sentinel baselines are per campaign.
    7.  E6 parameters fixed: F5 s = 20; F6 Ballard et al. §6.5 distributions 2 and 3; F8 identity only; F9a every
        row/column pair ill-conditioned with κ log-spread over 1e4–1e16; F10 magnitudes 1 + U[0, 0.5); F11 integers
        and dyadics; V1 held to f_W (its own Strassen bound is a warning); added hard gate: any non-finite output; new
        record type `accuracy_warning`; cached references carry a `.meta.json`.
    8.  Tooling: every tape invocation takes one quoted glob (tape 4.5.1 silently drops files given as separate args).
-   **2026-10-30c (pre-launch review gate: 28 confirmed findings; before any campaign data):**
    1.  **Warmup** (§4, all arms, tiers and the sentinel): after the gate and `gc()`, untimed full-size calls continue
        until ≥ 3 calls AND ≥ 0.25 s have elapsed AND (the arm has made ≥ 4,000 `dgemm` invocations — estimated as 1
        per call for A0/C1/SENTINEL, 7^L for SW, 8^L for C2 — OR 2 s have elapsed); then `gc()` and the samples start
        immediately. Rationale: V8 compiles the shared `dgemm` entry (with `blocked`/`ddot` inlined) after ≈ 3,000
        invocations; SW reaches that state in its first calls, A0 at small n only mid-sample (A0, n = 48: process median
        +2.4%; A2, n = 512: a ≈ 1% step in sample 4). Verified: zero JIT events after `MEASURE_START` at n = 48 and 512,
        and process median / second-half median within 0.15% for A0, A1, A2 at n = 48. Recorded per process:
        `warmup_calls_effective`, `warmup_elapsed_ns`, `warmup_invocations_est`, `warmup_target_met`. New process flag
        `early_slow` (first sample / median of the second half > 1.05; never excludes). Budget: total ≈ 3 h 41 min.
    2.  **JIT diagnostics:** `--trace-opt --trace-deopt --trace-osr --trace-turbo-inlining` for A0 and A2 (τ = 64) at
        n ∈ {512, 2048}. FAIL only on events for element-loop kernels (blocked, naive, ddot, zeros, scal, add, sub, maxAbs,
        axpby, packed) after `MEASURE_START`; call-only drivers and wrappers (winograd, the `dgemm` entry, resolve, …)
        are reported with their first sample index (at depth 4 `winograd` tiers up in sample 1; ≈ 0.12 ms per call,
        ≤ 0.013% at n = 1024). Each run writes `summary.json`.
    3.  **Operations:** single-instance lock (`research/data/.orchestrator.lock`; a second live instance is refused) and a
        preflight check for any foreign harness process; SIGINT/SIGTERM terminate immediately (resumable), SIGHUP is
        ignored, `research/data/<id>/STOP` stops cleanly between processes; E6 exit 2 ends the campaign "stopped —
        investigate" and blocks resuming until `--override-e6-stop`; other E6/E1 failures are resumable; an E7 abort
        still runs E6 and ends "incomplete"; each session waits up to 15 min for the display to sleep before its first
        block; processes matching the optional operator-supplied pattern (`STRATAMM_BLOCKED_PROCESSES`) fail the
        check (matching idle ShipIt updaters, ≤ 5% CPU, are only recorded; the harness's own `caffeinate` wrapper is
        exempt); a resume re-runs only unsettled configurations and is refused for a different `protocol.json`,
        another mode, or an automatically selected campaign last written more than 12 h ago; sentinel failures stop
        the campaign only after ≥ 3 consecutive failures spanning ≥ 10 min.
    4.  **E6/E1 integrity:** hard gates are sticky (existing records are re-checked on start/resume and before
        `E6 COMPLETE`; a gated metric stored as null fails); E6 refuses to resume across a package change; torn JSONL
        tails are newline-terminated and skipped; exit codes 0 complete, 2 gate/certification/precondition, 1 other.
    5.  **Analysis:** n*₁ is the size where the fixed-sequence test stopped (first failing size; the smallest passing
        size is also reported; missing sizes are censored, not failures); "confounded" means cell(C2)/cell(A2) ≥ (8/7)^L;
        speedups are paired within the cell's own experiment only (E4 vs E2's A0 is the one labelled exception); the
        analysis re-derives τ* (incl. the fallback) and the hard gates exactly as the harness does; F9 κ-binned errors
        are aggregated; every run of a resumed campaign is listed; the report embeds only generated figures.
    6.  **Package:** tests, README example and benchmarks no longer assume τ = 64 (verified green for every
        τ ∈ {16, 32, 64, 128, 256}), so the τ* write-back edits only `lib/defaults.js` and the README value.

## 13. References

See `implementation-plan.md` §12. Key: Strassen 1969
(10.1007/BF02165411); Winograd 1971 (10.1016/0024-3795(71)90009-7); Douglas et al. 1994 (10.1006/jcph.1994.1001);
Huss-Lederman et al. 1996 (10.1145/369028.369096); Boyer et al. 2009 (10.1145/1576702.1576713); Higham 1990
(10.1145/98267.98290) and 2002 (10.1137/1.9780898718027); Ballard et al. 2016 (10.1137/15M1032168); Ogita–Rump–Oishi
2005 (10.1137/030601818); Hoefler & Belli 2015 (10.1145/2807591.2807644); Georges et al. 2007
(10.1145/1297027.1297033); Kalibera & Jones 2013 (10.1145/2464157.2464160); Barrett et al. 2017 (10.1145/3133876).
