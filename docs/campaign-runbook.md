# StrataMM — Campaign Runbook (overnight, unattended)

> The campaign measures timing, so the Mac must be quiet: **no other workload may run while it executes** — other
> applications and background tools consume CPU and memory and would be measured as noise. Everything below is
> copy-paste. Design and rules: [`research-protocol.md`](./research-protocol.md). Expected duration: **≈ 3 h 45 min**
> (computed by `--dry-run`: pilot 11 min, E2 74, E3 34, E5 23, E4 25, E0 5, memory 9, accuracy ≈ 40). Start by ~22:00
> to finish by ~02:00. Disk: the accuracy reference cache needs ≈ 3.1 GB.

## 1. Pre-launch gate

-   `npm run build` (lint + tests), `npm run test:cov` (100% + canary) and `npm run test:mutation` (all killed) pass.
-   All research suites pass; `node research/correctness/e1.js` (100k trials) reports 0 mismatches.
-   `node research/harness/orchestrator.js --dry-run` prints the budget; `--tiny --skip-preflight` completes end-to-end;
    `--diagnostics` (n = 512 and 2048) passes for the element-loop kernels.
-   Commit pushed; working tree clean (provenance records the commit and a dirty flag).

## 2. Prepare the machine (≈ 15 min)

0.  **Reboot first (recommended)** to clear swap and memory pressure. After logging in, quit anything that auto-starts.
1.  **Power:** plug in AC. System Settings → Battery → Low Power Mode **off** (also "on power adapter").
2.  **Wallpaper:** System Settings → Wallpaper → choose a **static** picture (the aerial wallpaper costs ~25% of a core).
3.  **Screen saver:** System Settings → Lock Screen → "Start Screen Saver when inactive" → **Never** (or in Terminal:
    `defaults -currentHost write com.apple.screensaver idleTime 0`). The display itself will be put to sleep at launch.
4.  **Automatic updates off for tonight:** System Settings → General → Software Update → (i) Automatic updates → turn
    off "Download new updates", "Install macOS updates", "Install Security Responses and system files". Install any
    pending update **before** the campaign, not during it.
5.  **Quit apps:** browsers, chat and messaging apps, editors and every other desktop application (quit, don't just
    close windows).
6.  **Background services:** `brew services stop mongodb-community` (or whichever service `brew services list` shows as
    started). **Time Machine:** System Settings → General → Time Machine → Options → Back up frequency: **Manually**;
    check `tmutil status` → `Running = 0`.
7.  **Optional (needs your password):** pause Spotlight indexing for the night: `sudo mdutil -a -i off`.
8.  **Lid:** keep it **open** on a hard surface (a closed lid sleeps even under `caffeinate`).
9.  Wait ~5 minutes for the machine to settle.

## 3. Launch (Terminal.app)

```bash
cd ~/workspace2/StrataMM
node research/harness/orchestrator.js --preflight-only --new
```

It must print `LAUNCH: start a new campaign` and `PREFLIGHT PASS`. If it fails, it names the reason (power, Low Power
Mode, thermal state, a busy process, swap growth, a blocked process, another harness process). Fix it and re-run. (If it
names a busy app updater such as ShipIt, wait for it to finish.) Optionally, export `STRATAMM_BLOCKED_PROCESSES` before
both commands: a case-insensitive regular expression matched against each process's full command line, e.g.
`'Slack|Discord'` for apps you tend to forget to quit (it is recorded in the campaign record). Only the harness and
its `caffeinate` wrapper are exempt, so the pattern must not match Terminal or the shell. Then launch **and put the
display to sleep** (the orchestrator waits up to 15 min for the display to sleep before the pilot, so the whole night
runs under one condition):

```bash
nohup caffeinate -i node research/harness/orchestrator.js --campaign --new >> research/data/campaign.nohup.log 2>&1 &! sleep 3; pmset displaysleepnow
```

(`&!` detaches the job in zsh, so closing Terminal later cannot kill it.) **Then do not touch the Mac.** Waking the
display changes conditions; every check can wait until morning.

## 4. If something interrupts it

-   **To stop it deliberately:** `touch research/data/<campaign-id>/STOP` (clean stop after the current child); or, to
    stop everything immediately: `pkill -TERM -f 'research/(harness|accuracy|correctness)/'`. Before relaunching,
    `pgrep -fl 'research/(harness|accuracy|correctness)/'` must print nothing.
-   **Same night (power loss, reboot, stop):** re-run the launch command **without** `--new`. It refuses while another
    instance runs (exit 75), removes a stale lock, and resumes the latest unfinished campaign: completed stages and
    configurations are skipped and only the interrupted block runs again. It refuses (exit 64, nothing written) a
    campaign started under a different `protocol.json` or last written more than 12 h ago (use `--new`).
-   **A different night:** use `--new` (sentinel baselines are per campaign). The nights are analysed separately.
-   **It pauses itself** (sentinel drift > 3%, Low Power Mode, thermal state ≥ 1, a busy process, swap growth, memory
    pressure, a blocked process, another harness process): it re-checks every 60 s for up to 10 min, then stops with
    the reason.
-   **`CAMPAIGN STOPPED: E6 failed (exit 2) - INVESTIGATE`** (exit code 4): an accuracy hard gate, certification or
    input precondition failed — a bug signal. Do not resume; investigate `research/data/<campaign-id>/E6.stderr.log`
    first. Other `CAMPAIGN STOPPED: …` lines (exit 2) are resumable. `CAMPAIGN INCOMPLETE: E7 aborted …` (exit 3):
    re-running the launch command retries the missing memory configurations.
-   **Charger unplugged:** the campaign stops by design (results would not be comparable).
-   Exit codes: 0 complete · 2 stopped (resumable) · 3 incomplete · 4 investigate (E6 hard gate) · 64 refused or usage
    error · 75 another instance running.

## 5. Morning

1.  Check the last line of `research/data/<campaign-id>/campaign.log` (and the `warnings:` line before it):
    `CAMPAIGN COMPLETE`, or the stop reason. E6 errors are in `research/data/<campaign-id>/E6.stderr.log`.
2.  Run the analysis in this order: `node research/analysis/summarize.js <id>`, `node research/analysis/plots.js <id>`,
    `node research/analysis/report.js <id>`; then complete the interpretation in `research/REPORT.md`, the README
    headline and the claims checklist. If the campaign was resumed, read the report's "Runs" section first.
3.  τ* write-back: `CUTOFF` in `lib/node_modules/@stdlib/blas/ext/base/dgemmsw/lib/defaults.js` and the "(currently …)"
    value in the package README are set to τ* from `frozen.json`; then `npm run build && npm run test:cov &&
    npm run test:mutation` must pass before committing.
4.  Restore: wallpaper, screen saver, automatic updates, Time Machine schedule, `brew services start mongodb-community`,
    and Spotlight (`sudo mdutil -a -i on`) if you paused it.

## 6. What not to do during the run

-   Do not wake the Mac, open apps, start builds, play video, or run other benchmarks.
-   Do not unplug the charger, change Low Power Mode, or close the lid.
