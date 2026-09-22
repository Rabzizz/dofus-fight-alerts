# dofus-fight-alerts

Tells you, by sound, a Windows toast and a banner over the game, the moment a chosen fighter
**gains or loses** a chosen effect or state in a Dofus 3 fight.

It reads its events from a **sniffer running on `http://127.0.0.1:8765`** — a separate, non-public
project that decodes Dofus 3 network messages and serves them over a local HTTP API. This app is a
consumer only: it never touches the game, sends nothing to Ankama, and changes nothing in the
sniffer. Without that API it does nothing at all.

The contract it expects is small: `GET /api/health` returning `{"ok":true,"contract":1}`,
`GET /api/stream` as Server-Sent Events of decoded messages read **by name**, and
`GET /api/lookup?kind=monster&id=…`.

## Running it

The sniffer has to be up first and listening on `127.0.0.1:8765` — the app is useless without it.
Then:

```bash
npm install
npm start
```

Closing the window hides it to the tray; quit from the tray menu. The window may stay hidden the
whole time you play: the stream and the rule engine run in the main process, so nothing is
throttled when the window is not visible.

## Writing a rule

Rules are written against the **name family**, not against an id. That matters: the game data contains
**six different states called "Invulnérable"** and several called "Pesanteur", and nothing tells you
which one a given spell will produce. The picker shows one row per name — `Invulnérable · 5
variantes` — and the rule fires for any of them. Genuinely different names (`Invulnérable en Mêlée`)
stay separate.

**Ranks are one thing.** A spell that climbs `Toxines I` → `II` → … → `V` is a single entry,
`Toxines · 9 variantes`, and the row lists exactly what is folded in so a merge is never a
surprise. `Toxines réappliquées` is not a rank and stays separate. Across the whole catalogue this
merges 292 of 4564 state families and **no** effects.

Anything an id of yours has actually produced in a fight is marked `✓ vu en combat` and sorted
first. The quickest way to write a rule is still the **Combat** tab: during a fight every effect on
a fighter is a chip, and clicking one opens a rule already pointed at it.

A rule is *who* + *what* + *gained/lost*, then how you want to be told:

| field | notes |
|---|---|
| Sur qui | anyone, **moi**, an ally, an enemy, **a monster** (`monster_id`, so it keeps working next fight) or one fighter (this fight only — fighter ids are handed out per fight) |
| Quoi | any effect, or one named state/effect (every id sharing that name) |
| Son | one of the eight bundled ones, or your own — see below |
| Bandeau | an always-on-top banner. The surface that actually survives a borderless-fullscreen game, unlike the toast, which Windows suppresses under Focus Assist |
| Anti-répétition | one cast often applies the same state several times in a row (a real capture applied one three times in five seconds). 1500 ms by default |

## Who is "moi"

**Nothing in the protocol says which character is logged in here.** The c2s placement request looked
like it did, until a real capture showed our own client sending it for monsters (`-1`, `-4`, `-5`)
and for other players. So the app seeds a guess from that message when it names a *player*, and you
correct it: each player in the **Combat** tab has a `moi ?` / `moi ✓` button. The moment you touch
it the app stops guessing and just remembers what you said.

Matched by **name**, not by id, and it is a set — multi-accounting works, all your characters count
as `moi`. Verified over 25 recent fights: both of the tester's own characters were recognised, and
the two other players in those fights were not.

## Where your rules live

Rules and settings are saved the moment you change them, in

```
%APPDATA%\dofus-fight-alerts\settings.json
```

and reloaded at startup, so everything survives closing the app. If anything went wrong reading
them, the Règles tab says so at the top rather than looking empty.

Two deliberate precautions, because "the app forgot my rules" is the worst thing this could do:

- **Saving is atomic.** The file is written next to the real one and then renamed over it, so a
  crash or a power cut in the middle of a write cannot leave a half-written `settings.json`.
- **A file that will not parse is never discarded.** It is copied to `settings.json.corrupt-<time>`
  and the app says so in the Règles tab, rather than quietly starting with an empty list. Rules that
  are individually malformed (a hand-edit gone wrong) are skipped one by one, and the rest survive.

Back it up by copying that one file; drop it back to restore. `npm test` covers the round trip and
both failure modes.

## ET / OU conditions

Build each piece as its own rule, tick two or more in the **Règles** tab, then **Fusionner ET** or
**Fusionner OU**. The first one ticked stays the trigger and keeps its sound; the others become
checks on what a fighter carries at that instant, and disappear from the list.

```
seulement si  la cible  [a]  « Toxines réappliquées »  ×
ou si         la cible  [n'a pas]  « Toxines V » (exactement)  ×
```

Each condition line can be flipped between `a` and `n'a pas`, or dropped, straight from the list.
`ET` extends the current branch, `OU` opens a new one, and the rule fires when any branch is fully
satisfied.

Two things that are easy to get wrong:

- **Two triggers can never both fire at once**, so a merge is always *one* trigger plus state
  checks — never "A and B happened together".
- **A condition on a rank needs `exactement celui-ci`.** Because ranks are merged, `n'a pas
  Toxines V` otherwise means `n'a pas Toxines` — and the mob always carries *some* rank, so the
  rule would be dead. The picker lists each rank under the family for exactly this.

**A conditioned rule stays silent if the app was started mid-fight.** It never saw the earlier
applies, so it does not know what anyone carries, and a rule saying "only if the mob does *not*
have X" would fire on a mob that does. Refusing is the honest answer; rules without conditions are
unaffected.

## "Confirmer après" — telling a real loss from a rank going up

A rule that says *"the mob loses Toxines"* fires on **every step of the ladder**, because the mob
loses `Toxines I` before it gains `Toxines II`. Checking a condition at that instant cannot help:
at that moment the state really is gone.

Measured on a real fight (Capitaine Meno, 10 893 messages):

| what happened | how long until it came back |
|---|---|
| rank step I → II, II → III, … | **0–1 ms** |
| the Sram actually misplayed (no trap) | **45.1 s**, never that turn |

So the rule waits and looks again. **Confirmer après (ms)** re-checks before making any noise: with
conditions it re-evaluates those, and without, it re-checks the trigger itself — a *loses X* rule
confirms X is still gone, a *gains X* rule that X is still there. On that same fight:

```
sans confirmation           : 11 alarmes
avec confirmation (1500 ms) :  1 alarme, au tour 5   <- the misplay
```

`1500` is a good default. This is not the same thing as **Anti-répétition**, which stops one cast
alerting several times; this one decides whether to alert at all.

## Sounds

Eight are bundled and copied into your own sounds folder the first time the app starts. After
that the folder is yours: **Ajouter un fichier…** in the rule editor copies in any
`.wav/.mp3/.ogg/.flac/.m4a`, and anything you delete from the folder stays deleted.

| file | shape |
|---|---|
| `gain-montant.wav` | two notes rising — something appeared |
| `perte-descendante.wav` | two notes falling — something went away |
| `chute.wav` | a downward sweep — unmistakably bad |
| `alerte-grave.wav` | low, doubled, slightly detuned so it beats — urgent |
| `cloche.wav` | a bell with inharmonic partials — for the rule that really matters |
| `carillon.wav` | three rising notes — the thing you were waiting for |
| `sonar.wav` | a long-tailed ping — carries over game noise without being harsh |
| `clic.wav` | short and dry — for a rule that fires often |

They are told apart by *shape* (rising, falling, doubled, bell, sweep), not by pitch alone, because
pitch is the first thing you stop noticing with a game running over it.

```bash
npm run sounds      # regenerate them
```

**They are synthesised, not taken from the game.** Dofus 3 packs its audio into 7092 FMOD `.bank`
files (FSB5, Vorbis). FMOD strips the Vorbis headers and rebuilds them at runtime from a codebook
table, so pulling one out needs a dedicated FSB5 tool plus a third-party codebook blob — and the
result would be Ankama's audio sitting in a repository. If you want a real game sound, rip it
yourself and add it with **Ajouter un fichier…**; it never leaves your machine.

## Game data

`data/catalog.json` holds every state and effect id with its French name — 6374 states and 639
effects, 180 KB — so the rule editor works offline and needs nothing from the sniffer.

```bash
npm run catalog     # after a Dofus update
```

It is built from [DofusDB](https://api.dofusdb.fr), the only public API that serves state names
inline. The app tells you when it is out of date by comparing its stamped version against
dofusdude's `meta/version`. Monster names are not in the catalog: the sniffer already holds all
5135 of them and `/api/lookup` is exactly what it is for.

> DofusDB's LPNC-IA 1.0 licence restricts use by AI systems. This is a private, personal tool and
> that was a deliberate call — see the note in `tools/build-catalog.mjs`.

## What it cannot do, honestly

- **Sides come from the start cells** (`fight_placement_cells`), not from the field the sniffer calls
  `team` on `fight_placement_positions` — that field is the facing, and using it put enemies in the
  ally column. Monsters that are genuinely on your side, like the Bonta militia, show as allies
  because they are.
- **Summons have no identity.** `fighter_info` only fires at the start of a fight, so a summon is an
  id nobody announced. It shows as `Invocation -21` and its side is left **unknown**, never guessed
  from the sign of its id — your own summons are negative too. So an "enemy" rule will not fire on a
  summon, in either direction.
- **233 of the 872 effects have no name at all.** Their description in the game files is a bare
  `#1` placeholder, so there is genuinely nothing to show. They appear as `effect 792`.
- **Joining a fight already in progress** means the app never saw those effects applied, so when one
  is removed it cannot say what it was. Those removals are counted and reported in the Combat tab
  rather than guessed at.
- **Latency is about half a second**: the sniffer's API polls its database rather than holding a
  listener. Fine for a turn-based game, not a reflex tool.
- Written against **API contract 1**. The header warns you if the sniffer reports a different one.

## Publishing a version

Tag a commit and GitHub builds and publishes it:

```bash
npm version minor        # or patch / major: bumps package.json AND makes the tag
git push --follow-tags
```

`.github/workflows/release.yml` then, on `windows-latest`: installs, **runs the tests**, takes the
version from the tag so package.json and the artifact names cannot drift, builds with
electron-builder, generates the notes and publishes the release with

- `dofus-fight-alerts-X.Y.Z-setup.exe` — the installer (choosable install directory, no admin)
- `dofus-fight-alerts-X.Y.Z-portable.exe` — runs without installing
- `latest.yml` — the manifest electron-updater would need, if auto-update is ever wanted

The notes come from `tools/changelog.mjs`, which groups the commits since the previous tag by
conventional-commit prefix (`feat:`, `fix:`, …) and puts anything unprefixed under *Autres*, so no
commit is ever silently dropped. GitHub's own `--generate-notes` groups by pull request, which is
useless here because the work lands as direct commits.

```bash
node tools/changelog.mjs v0.2.0     # preview the notes before tagging
```

**The binaries are not signed**, so Windows SmartScreen shows a warning on first run — *Informations
complémentaires* then *Exécuter quand même*. Signing needs a paid certificate; the release notes say
this so your friends are not surprised.

Building locally (`npm run dist`) needs Windows **Developer Mode** enabled, or it fails extracting
electron-builder's signing cache, which contains macOS symlinks. The CI runner is elevated and does
not care.

## Notes for whoever works on this next

- **Never `JSON.parse` a message from the API.** Monsters have negative fighter ids, sent unsigned,
  so `-1` arrives as `18446744073709551615`. That is past `Number.MAX_SAFE_INTEGER`, and `JSON.parse`
  rounds it — `-1`, `-2` and `-21` all collapse onto the same double, and the conversion the sniffer
  documents then returns `0` for every one of them. `src/json.ts` exists for this and has the test
  that proves it.
- Read messages by `name`, never by the three-letter `key`: Ankama rotates those every build.
- Team numbers are **not** constants. Captures show 7/3 in one fight and 1/5 in another, so sides
  are derived (who this client controls, else which team holds the negative ids) and never hardcoded.

```bash
npm test      # the parser, the fight tracker and the rule engine
npm run build
```
