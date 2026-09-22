/** What is happening in the current fight, rebuilt from the message stream.
 *
 *  Everything here is driven by messages the sniffer already names with
 *  confidence `sure`; nothing is inferred from a raw key or a field path.
 */

import { entries, int, list, signedId } from "./json.js";
import type { SnifferMessage } from "./stream.js";

export type Side = "ally" | "enemy" | "unknown";
export type EffectKind = "state" | "effect";

/** Why an effect stopped applying. "disabled" is not "removed": effect 952
 *  suppresses a state, it does not take it away. */
export type Reason = "applied" | "removed_by_spell" | "disabled" | "expired";

export interface Fighter {
  id: number;                    // signed: mobs are negative
  side: Side;
  /** NOT the team, despite what the sniffer calls this field. Proven on a real
   *  capture: it only ever holds 1, 3, 5 or 7, one message carried four
   *  distinct values, and two allied players got 7 and 1 while the monster
   *  between them got 3. Those are the four diagonal facings. Sides come from
   *  fight_placement_cells instead. */
  facing: number | null;
  /** The START cell. Sides are derived from it, so it is never overwritten
   *  when the fighter walks - `position` is where it is now. */
  cell: number | null;
  /** Where it stands right now, from actor_movement. null until it moves. */
  position: number | null;
  monsterId: number | null;
  level: number | null;
  grade: number | null;
  playerName: string | null;
  /** One of your characters. Matched by NAME, because no message in the
   *  protocol says which character is logged in here: the c2s placement request
   *  looked like it did, but a real capture has our client sending it for
   *  monsters (-1, -4, -5) and for other players too. So the set is seeded from
   *  that message when it names a player, and you correct it in the UI. */
  own: boolean;
  /** Never announced in fighter_info - first seen in the effect stream.
   *  Which summon it is cannot be resolved; do not pretend otherwise. */
  summon: boolean;
}

export interface FightEvent {
  trigger: "gained" | "lost";
  reason: Reason;
  kind: EffectKind;
  /** state id or effect id. null when a removal could not be paired back. */
  id: number | null;
  target: number;
  spellId: number | null;
  turns: number | null;
  round: number;
  ageMs: number;
}

interface LiveEffect {
  kind: EffectKind;
  id: number | null;
  target: number;
  /** Effect 952 suppressed it. Still there, but not applying, so a condition
   *  asking whether the target "has" it must answer no. */
  disabled: boolean;
}

/** What liveEffects() hands out. */
export interface LiveEffectView extends LiveEffect {
  uid: number;
}

/** Effect ids that mean "this is about a state", with the state in state_id. */
const STATE_GAINED = 950;
const STATE_REMOVED = 951;
const STATE_DISABLED = 952;

function blank(id: number, summon = false): Fighter {
  return { id, side: "unknown", facing: null, cell: null, position: null, monsterId: null,
           level: null, grade: null, playerName: null, own: false, summon };
}

/** The cell a movement path ends on.
 *
 *  The API projects the packed path either as a list of cells or, when every
 *  byte of it happens to be printable (a path that stays under cell 128), as
 *  the string of those bytes. Both mean the same thing. Dofus 3 sends plain
 *  cells here - no direction packed into the high bits, unlike Dofus 2. */
function destination(path: unknown): number | null {
  if (typeof path === "string") return path.length ? path.charCodeAt(path.length - 1) : null;
  const cells = list(path);
  return int(cells[cells.length - 1]);
}

export class FightTracker {
  fightId: number | null = null;
  round = 0;
  /** We watched this fight from its start, so the set of effects we think each
   *  fighter carries is complete. False when the app was launched mid-fight,
   *  and conditions refuse to guess in that case. */
  sawStart = false;
  readonly fighters = new Map<number, Fighter>();
  /** effect_uid -> what it was. fight_effect_removed carries nothing else. */
  private readonly live = new Map<number, LiveEffect>();
  /** Fighters we control, learnt from this client's own c2s messages. */
  private readonly ours = new Set<number>();
  /** Your character NAMES, kept across fights and restarts. Owned by the
   *  settings, seeded here, and editable from the Combat tab. */
  readonly ownNames = new Set<string>();
  /** Set when resolveSides() added a name, so it can be persisted. */
  ownNamesChanged = false;
  /** True once you have said who you are. The seeding guess then stops for
   *  good, otherwise un-ticking a name would be undone on the next message. */
  ownLocked = false;
  /** The two placement groups, from fight_placement_cells. This is what the
   *  game actually uses to say who is on which side. */
  private attackerCells = new Set<number>();
  private defenderCells = new Set<number>();
  /** Removals for effects applied before we connected. Surfaced, not hidden. */
  unpairedRemovals = 0;
  /** Set when someone changed cell, so the window can be refreshed: a move
   *  produces no FightEvent and would otherwise not reach the UI. */
  moved = false;

  get inFight(): boolean {
    return this.fightId !== null;
  }

  /** Declare a character name yours, or not, and re-flag the roster. */
  setOwn(name: string, own: boolean): void {
    if (own) this.ownNames.add(name);
    else this.ownNames.delete(name);
    this.ownLocked = true;
    this.ownNamesChanged = true;
    this.resolveSides();
  }

  /** What is currently applied, as far as we have seen. Only effects whose
   *  apply we witnessed are in here - see unpairedRemovals for the rest. */
  liveEffects(): LiveEffectView[] {
    return [...this.live].map(([uid, e]) => ({ uid, ...e }));
  }

  private reset(fightId: number | null): void {
    this.fightId = fightId;
    this.sawStart = false;
    this.round = 0;
    this.fighters.clear();
    this.live.clear();
    this.ours.clear();
    this.attackerCells.clear();
    this.defenderCells.clear();
    this.unpairedRemovals = 0;
  }

  private fighter(id: number, summon = false): Fighter {
    let f = this.fighters.get(id);
    if (!f) {
      f = blank(id, summon);
      this.fighters.set(id, f);
    }
    return f;
  }

  private groupOfCell(cell: number | null): "attacker" | "defender" | null {
    if (cell === null) return null;
    if (this.attackerCells.has(cell)) return "attacker";
    if (this.defenderCells.has(cell)) return "defender";
    return null;
  }

  /** Ally or enemy, from the cell each fighter was placed on.
   *
   *  fight_placement_cells gives the two start-cell groups, which is the game's
   *  own statement of who is on which side. The field the sniffer calls `team`
   *  is NOT usable for this - see Fighter.facing. */
  private resolveSides(): void {
    // Which group is ours: the one holding a fighter this client placed.
    // Seed our names from the fighters this client asked to place, but only
    // when they are players: the same message is also sent for monsters. Once
    // you have corrected it by hand, we stop guessing.
    if (!this.ownLocked) for (const id of this.ours) {
      const f = this.fighters.get(id);
      if (f?.playerName && !this.ownNames.has(f.playerName)) {
        this.ownNames.add(f.playerName);
        this.ownNamesChanged = true;
      }
    }

    let ourGroup: "attacker" | "defender" | null = null;
    for (const f of this.fighters.values()) {
      if (!f.playerName || !this.ownNames.has(f.playerName)) continue;
      ourGroup = this.groupOfCell(f.cell);
      if (ourGroup) break;
    }
    if (!ourGroup) {
      // Joined too late to see our own placement. The group holding the named
      // players is ours - but only when they are all in ONE group, because a
      // PvP fight has players on both sides and guessing there would be wrong.
      const groups = new Set<string>();
      for (const f of this.fighters.values()) {
        if (f.playerName === null) continue;
        const g = this.groupOfCell(f.cell);
        if (g) groups.add(g);
      }
      if (groups.size === 1) ourGroup = [...groups][0] as "attacker" | "defender";
    }

    for (const f of this.fighters.values()) {
      f.own = f.playerName !== null && this.ownNames.has(f.playerName);
      const group = this.groupOfCell(f.cell);
      if (group && ourGroup) f.side = group === ourGroup ? "ally" : "enemy";
      // No placement cell: a summon, or we connected mid-fight. A monster_id
      // still means a mob and a name still means a player; anything else stays
      // unknown rather than being guessed from the sign of its id.
      else if (f.monsterId !== null) f.side = "enemy";
      else if (f.playerName !== null) f.side = "ally";
      else f.side = "unknown";
    }
  }

  /** Feed one message in; get back whatever alertable events it produced. */
  handle(m: SnifferMessage): FightEvent[] {
    const f = m.fields ?? {};
    switch (m.name) {
      case "fight_started":
        this.reset(int(f.fight_id));
        this.sawStart = true;
        return [];

      case "fight_end":
        this.reset(null);
        return [];

      case "fighter_info": {
        const id = signedId(f.fighter_id);
        if (id === null) return [];
        const fighter = this.fighter(id);
        fighter.cell = int(f.cell);
        fighter.monsterId = int(f.monster_id);
        fighter.level = int(f.monster_level);
        fighter.grade = int(f.monster_grade);
        fighter.playerName = typeof f.player_name === "string" ? f.player_name : null;
        fighter.summon = false;
        this.resolveSides();
        return [];
      }

      case "fight_placement_cells": {
        // The game's own split of the start cells. This is the side source.
        const fill = (set: Set<number>, raw: unknown) => {
          set.clear();
          for (const c of list(raw)) {
            const cell = int(c);
            if (cell !== null) set.add(cell);
          }
        };
        fill(this.attackerCells, f.attacker_cells);
        fill(this.defenderCells, f.defender_cells);
        this.resolveSides();
        return [];
      }

      case "actor_removed": {
        // When someone joins a fight that has not started, the server discards
        // the monsters and re-announces the SAME ones with new ids. Without
        // this the old ids linger and every monster appears twice (issue #1).
        // Out of combat this message is about actors leaving the map, and then
        // the id is simply not in our roster, so this is a no-op.
        const id = signedId(f.actor_id);
        if (id !== null && this.fighters.delete(id)) {
          for (const [uid, e] of this.live) if (e.target === id) this.live.delete(uid);
          this.resolveSides();
        }
        return [];
      }

      case "fight_placement_positions": {
        // One entry per fighter. Read entry by entry, NOT by zipping the three
        // parallel arrays the API projects: protobuf omits zero values, so a
        // fighter with team 0 or cell 0 shortens one array and every later
        // pairing shifts - which hands a monster the player's team and shows it
        // as an ally (issue #3).
        // "team" is what the sniffer calls the field; it is really the facing.
        const grouped = entries(m.decoded, m.field_paths, ["fighter_id", "team", "cell"])
          ?.map((r) => ({ fighter_id: r.fighter_id, facing: r.team, cell: r.cell }));
        const rows = grouped ?? this.zipped(f);
        for (const row of rows) {
          const id = signedId(row.fighter_id);
          if (id === null) continue;
          const fighter = this.fighter(id);
          // Inside a real entry, an absent scalar means ZERO - protobuf does not
          // put zeros on the wire. Team 0 is a team. With the flattened fallback
          // we cannot tell absent from zero, so there we keep what we had.
          // Merged rather than replaced either way: these snapshots are partial,
          // they grow as people take their places.
          fighter.facing = int(row.facing) ?? (grouped ? 0 : fighter.facing);
          fighter.cell = int(row.cell) ?? (grouped ? 0 : fighter.cell);
        }
        this.resolveSides();
        return [];
      }

      case "fight_placement_position_request": {
        // c2s: this client asking for a cell, so that fighter is ours.
        const id = signedId(f.fighter_id);
        // Negative ids are monsters, and our client really does send this for
        // them; they are never us and must never decide which side is ours.
        if (id !== null && id > 0 && m.dir === "c2s") {
          this.ours.add(id);
          this.resolveSides();
        }
        return [];
      }

      case "actor_movement": {
        // Only ever for a fighter we already know: out of combat this message
        // fires constantly for everyone on the map, and the roster is the
        // fight, not the map.
        // ponytail: walking only. A push or a teleport arrives inside
        // game_action_fight_event, which the sniffer does not decode, so a
        // pushed fighter keeps its old cell until it next walks. Read that
        // message if the position has to be exact.
        const id = signedId(f.actor_id);
        const fighter = id === null ? undefined : this.fighters.get(id);
        const to = destination(f.path);
        if (fighter && to !== null && fighter.position !== to) {
          fighter.position = to;
          this.moved = true;
        }
        return [];
      }

      case "fight_turn_start":
      case "fight_round_number": {
        this.round = int(f.round) ?? this.round;
        return [];
      }

      case "fight_effect_applied":
        return this.applied(m, f);

      case "fight_effect_removed":
        return this.removed(m, f);

      default:
        return [];
    }
  }

  /** Last resort when the message arrived without its decoded tree: the old
   *  index zip. Kept only so a missing `decoded` degrades instead of failing. */
  private zipped(f: Record<string, unknown>): Record<string, unknown>[] {
    const ids = list(f.fighter_id);
    const teams = list(f.team);
    const cells = list(f.cell);
    const aligned = ids.length === teams.length && ids.length === cells.length;
    return ids.map((fighter_id, i) => ({
      fighter_id,
      // If the arrays disagree, believe none of them rather than mispair.
      facing: aligned ? teams[i] : null,
      cell: aligned ? cells[i] : null,
    }));
  }

  private applied(m: SnifferMessage, f: Record<string, unknown>): FightEvent[] {
    const target = signedId(f.target_id);
    const effectId = int(f.effect_id);
    if (target === null || effectId === null) return [];
    if (!this.fighters.has(target)) this.fighter(target, true); // a summon
    this.resolveSides();

    const stateId = int(f.state_id);
    const uid = int(f.effect_uid);
    const base = {
      target,
      spellId: int(f.spell_id),
      // -1 means "until removed", and it only reads as -1 after the signed
      // conversion; raw it is 2^64-1.
      turns: int(f.turns),
      round: this.round,
      ageMs: m.ageMs,
    };

    let ev: FightEvent;
    if (effectId === STATE_GAINED) {
      ev = { ...base, trigger: "gained", reason: "applied", kind: "state", id: stateId };
    } else if (effectId === STATE_REMOVED) {
      ev = { ...base, trigger: "lost", reason: "removed_by_spell", kind: "state", id: stateId };
    } else if (effectId === STATE_DISABLED) {
      ev = { ...base, trigger: "lost", reason: "disabled", kind: "state", id: stateId };
    } else {
      ev = { ...base, trigger: "gained", reason: "applied", kind: "effect", id: effectId };
    }

    // Only a gain creates something that can later expire. A 951/952 carries
    // its own fresh uid and does not tell us the uid of the state it acted on,
    // so the original entry has to wait for its own fight_effect_removed.
    if (uid !== null && ev.trigger === "gained") {
      this.live.set(uid, { kind: ev.kind, id: ev.id, target, disabled: false });
    }
    // 951 and 952 carry their OWN uid, not the uid of what they acted on, so
    // the original entry has to be found by state id or it would linger and
    // make "the target still has X" wrong.
    if (effectId === STATE_REMOVED || effectId === STATE_DISABLED) {
      for (const [uid2, e] of this.live) {
        if (e.target !== target || e.kind !== "state" || e.id !== stateId) continue;
        if (effectId === STATE_REMOVED) this.live.delete(uid2);
        else e.disabled = true;
      }
    }
    return [ev];
  }

  private removed(m: SnifferMessage, f: Record<string, unknown>): FightEvent[] {
    const uid = int(f.effect_uid);
    const target = signedId(f.target_id);
    if (target === null) return [];
    const gone = uid === null ? undefined : this.live.get(uid);
    if (uid !== null) this.live.delete(uid);
    if (!gone) this.unpairedRemovals++; // it began before we connected

    return [{
      trigger: "lost",
      reason: "expired",
      kind: gone?.kind ?? "effect",
      id: gone?.id ?? null,
      target,
      spellId: null,
      turns: null,
      round: this.round,
      ageMs: m.ageMs,
    }];
  }
}

