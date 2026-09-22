# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Electron desktop app (TypeScript, French UI) that raises sound/toast/overlay alarms when a chosen
fighter gains or loses a chosen effect in a Dofus 3 fight. It is a **read-only consumer** of a
separate, non-public sniffer serving `http://127.0.0.1:8765` (contract 1: `/api/health`,
`/api/stream` SSE, `/api/lookup`). Without that API running, the app does nothing.

## Commands

```bash
npm start                                   # tsc + electron .
npm test                                    # tsc, then node --test on dist/test/**
npm run build                               # tsc only
node --test dist/test/fight.test.js         # one file (build first)
node --test --test-name-pattern "summon"    # one test by name
npm run dist                                # electron-builder; needs Windows Developer Mode
npm run catalog                             # rebuild data/catalog.json after a game update
npm run sounds / npm run icon               # regenerate the bundled assets
node tools/changelog.mjs v0.2.0             # preview release notes
```

There is no linter. `tsc` is strict with `noUncheckedIndexedAccess`; treat it as the gate.

A smoke run drives the real UI end to end (screenshots, saves a rule, decodes a sound, merges two
rules) — no npm script, run it directly:
`FIGHT_ALERTS_SMOKE=/path/shot.png electron .` after a build. It redirects `userData` to temp so it
cannot touch your real rules.

Releasing: `npm version minor && git push --follow-tags`. The tag drives
`.github/workflows/release.yml` (windows-latest, runs `npm test`, rewrites package.json from the
tag, publishes setup + portable exe + latest.yml).

## Architecture

The main process owns *everything* that matters; the renderer is a view.

```
sniffer SSE ─► stream.ts ─► fight.ts (FightTracker) ─► rules.ts (firing/stillTrue)
                            │                          │
                            └─ names.ts (catalog +     └─ main.ts fire(): toast, overlay
                               /api/lookup)               window, IPC to renderer for sound
                                                        config.ts (Store) ⇄ settings.json
```

- **`src/main.ts`** — the only place with network. All fetching lives here because the sniffer's
  CORS gate rejects a `file://` renderer, and because Chromium throttles a hidden renderer while the
  alert path must not be. Also owns the tray, the always-on-top overlay window (`screen-saver`
  level, the only surface that survives borderless fullscreen), and every `ipcMain.handle`.
- **`src/stream.ts`** — SSE reader with `after_id` resume. Deliberately not `EventSource` and not
  the sniffer's own client (which `JSON.parse`s).
- **`src/json.ts`** — **never `JSON.parse` a sniffer message.** Monster fighter ids are negative and
  sent unsigned, so `-1` arrives as `18446744073709551615`; `JSON.parse` rounds every mob onto the
  same double. `parseKeepingBigInts` keeps 16+ digit integers as strings, `signedId` converts.
- **`src/fight.ts`** — rebuilds the fight from named messages (`fight_started`, `fighter_info`,
  `fight_placement_cells`, `fight_effect_applied/removed`, …). Effect ids 950/951/952 mean
  state gained / removed / *disabled* (disabled ≠ removed). `sawStart` records whether we watched
  from the start; conditions refuse to evaluate when we did not.
- **`src/rules.ts`** — pure matching, no I/O; name resolution is injected as `NameOf`. `family()`
  strips rank suffixes so `Toxines I…V` is one rule. Conditions are OR-of-ANDs, built by `merge()`.
  `Cooldowns` takes `now` as an argument so it is testable.
- **`src/config.ts`** — atomic save (temp + rename); an unparseable settings file is copied to
  `.corrupt-<time>` and surfaced in the UI, never discarded; individually malformed rules are
  skipped one by one.
- **`renderer/renderer.ts`** — one classic script, no imports and no bundler (plain `tsc`), loaded
  by `index.html` from `dist/renderer/renderer.js`. Talks only through `src/preload.cjs`
  (CommonJS on purpose: a sandboxed preload cannot be ESM, and it is not compiled by tsc).

## Invariants worth not relearning

- Read messages by `name`, never by the three-letter `key` — Ankama rotates keys every build.
- Team numbers are not constants (7/3 in one capture, 1/5 in another). Sides are derived from
  `fight_placement_cells`; the sniffer's `team` field on `fight_placement_positions` is the facing.
- Nothing in the protocol says which character is logged in. "moi" is a set of **names**, seeded
  from the placement request only when it names a player, and locked once the user edits it.
- A summon's side stays `unknown` — never guessed from the sign of its id (your own are negative too).
- Rules target a **name family**, not an id: six distinct states are called "Invulnérable".
  `exact: true` keeps the rank, which conditions usually want and triggers usually do not.
- `confirmMs` re-checks after a delay to tell a real loss from a rank stepping up (rank steps come
  back in 0–1 ms). That is a different thing from `cooldownMs`, which de-duplicates one cast.
- `data/catalog.json` is committed (180 KB) so the editor works offline. Built from DofusDB, whose
  LPNC-IA licence restricts AI use — a deliberate call for a private tool, see `tools/build-catalog.mjs`.
- **English everywhere except the app's own interface.** Commit messages, release notes, code
  comments, identifiers and docs are English. Only the strings the user reads in the window
  (`renderer/index.html`, the labels built in `renderer/renderer.ts`, the toast titles in
  `src/main.ts`) are French — it is a French Dofus tool. The one French commit in the history
  and the French headings `tools/changelog.mjs` used to print are not the convention.
