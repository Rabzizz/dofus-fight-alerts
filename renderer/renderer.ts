/** The window. Talks to the main process over the preload bridge and to
 *  nothing else - it has no network of its own, deliberately.
 *
 *  No imports: this is loaded as a classic script, so everything it needs is
 *  declared here. That keeps the build to one plain `tsc` with no bundler.
 */

type EffectKind = "state" | "effect";
type Side = "ally" | "enemy" | "unknown";

interface RuleWhat { kind: "any" | EffectKind; id?: number; name?: string; exact?: boolean }
interface RuleWho { kind: "any" | "enemies" | "allies" | "self" | "target" | "monster" | "fighter"; monsterId?: number; fighterId?: number }
interface Condition { present: boolean; who: RuleWho; what: RuleWhat }
interface Rule {
  id: string; enabled: boolean; label: string;
  trigger: "gained" | "lost";
  what: RuleWhat; who: RuleWho;
  sound: string | null; toast: boolean; overlay: boolean; cooldownMs: number;
  conditions?: Condition[][];
  confirmMs?: number;
}
interface LiveEffect { uid: number; kind: EffectKind; id: number | null; name: string | null }
interface FighterView {
  id: number; side: Side; facing: number | null; cell: number | null; position: number | null;
  monsterId: number | null; monsterName: string | null; level: number | null;
  playerName: string | null; own: boolean; summon: boolean; effects: LiveEffect[];
}
interface FightView {
  inFight: boolean; fightId: number | null; round: number; unpairedRemovals: number;
  connected: boolean; lastError: string | null; fighters: FighterView[];
}
interface NamedGroup { name: string; ids: number[]; variants: string[]; seen: boolean }

declare const api: {
  getState(): Promise<{ settings: { rules: Rule[]; volume: number; apiUrl: string }, storage: { file: string; problem: string | null }, catalog: { gameVersion: string | null; builtAt: string }, fight: FightView, sounds: string[] }>;
  saveSettings(patch: Record<string, unknown>): Promise<{ rules: Rule[]; volume: number }>;
  searchNames(kind: EffectKind, query: string): Promise<NamedGroup[]>;
  nameOf(kind: EffectKind, id: number): Promise<string | null>;
  checkHealth(): Promise<{ ok: boolean; contract?: number; catalogCurrent?: boolean; currentGameVersion?: string | null; error?: string }>;
  listSounds(): Promise<string[]>;
  addSound(): Promise<string | null>;
  soundData(file: string): Promise<ArrayBuffer>;
  testRule(id: string): Promise<boolean>;
  setOwn(name: string, own: boolean): Promise<string[]>;
  mergeRules(into: Rule, sources: Rule[], mode: "and" | "or"): Promise<Rule>;
  onFightUpdate(h: (v: FightView) => void): () => void;
  onFightEvent(h: (v: { label: string; round: number }) => void): () => void;
  onAlertSound(h: (v: { file: string; volume: number }) => void): () => void;
  onAlertLog(h: (v: { at: number; label: string; title: string }) => void): () => void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** The volume slider as it is right now. Everything that plays a sound in the
 *  renderer goes through this, so a preview matches the real alert. */
const currentVolume = () => Number(($("volume") as HTMLInputElement).value);
const el = (tag: string, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let rules: Rule[] = [];
let sounds: string[] = [];
let fight: FightView = { inFight: false, fightId: null, round: 0, unpairedRemovals: 0, connected: false, lastError: null, fighters: [] };
let editing: Rule | null = null;
/** Only set when the settings file existed but could not be read properly. */
let storageProblem: string | null = null;
/** Rules ticked for merging, in the order they were ticked: the first stays
 *  the trigger. */
let selected: string[] = [];
/** Selection mode. Off by default, so a rule row shows exactly ONE checkbox -
 *  the on/off one - instead of two bare ones nobody can tell apart. */
let merging = false;

// ---------------------------------------------------------------- sound

/** Bytes come over IPC once per file, then stay as a blob url. */
const soundCache = new Map<string, string>();
async function play(file: string, volume: number): Promise<void> {
  let url = soundCache.get(file);
  if (!url) {
    const buf = await api.soundData(file);
    url = URL.createObjectURL(new Blob([buf]));
    soundCache.set(file, url);
  }
  const audio = new Audio(url);
  audio.volume = Math.max(0, Math.min(1, volume));
  await audio.play().catch(() => { /* a missing output device is not fatal */ });
}

// ---------------------------------------------------------------- fight pane

function fighterName(f: FighterView): string {
  if (f.playerName) return f.playerName;
  if (f.monsterName) return f.monsterName;
  if (f.monsterId !== null) return `Monstre ${f.monsterId}`;
  if (f.summon) return `Invocation ${f.id}`;
  return `Combattant ${f.id}`;
}

function fighterCard(f: FighterView): HTMLElement {
  const card = el("div", `card ${f.side}`);
  const head = el("div", "row");
  head.appendChild(el("span", "name", fighterName(f)));
  const bits: string[] = [];
  if (f.level !== null) bits.push(`niv. ${f.level}`);
  // Where it is now, falling back to the start cell before anyone has moved.
  const at = f.position ?? f.cell;
  if (at !== null) bits.push(`case ${at}`);
  head.appendChild(el("span", "muted", bits.join(" · ")));

  // Nothing in the protocol says which character is logged in here, so you say
  // so once per character and the app remembers it.
  if (f.playerName) {
    head.appendChild(el("span", "grow"));
    const mine = el("button", "ghost" + (f.own ? " on" : ""), f.own ? "moi ✓" : "moi ?");
    mine.title = f.own
      ? `${f.playerName} est un de tes personnages — clique pour retirer`
      : `marquer ${f.playerName} comme un de tes personnages`;
    mine.addEventListener("click", () => void api.setOwn(f.playerName!, !f.own));
    head.appendChild(mine);
  }
  card.appendChild(head);

  if (f.effects.length) {
    const chips = el("div", "chips");
    for (const e of f.effects) {
      const chip = el("span", "chip", e.name ?? `${e.kind} ${e.id ?? "?"}`);
      chip.title = "Créer une règle sur cet effet";
      chip.addEventListener("click", () => {
        if (e.id === null) return;
        openEditor(draftFrom(f, e));
        selectTab("rules");
      });
      chips.appendChild(chip);
    }
    card.appendChild(chips);
  }
  return card;
}

function draftFrom(f: FighterView, e: LiveEffect): Rule {
  return {
    id: "", enabled: true, label: "",
    trigger: "lost",
    // Prefer the name: several ids share it and the next cast may use another.
    what: e.name ? { kind: e.kind, name: e.name } : { kind: e.kind, id: e.id ?? undefined },
    who: f.monsterId !== null ? { kind: "monster", monsterId: f.monsterId } : { kind: "any" },
    sound: sounds[0] ?? null, toast: true, overlay: true, cooldownMs: 1500,
  };
}

function renderFight(): void {
  $("dot").className = "dot" + (fight.connected ? " on" : "");
  $("status").textContent = fight.connected
    ? (fight.inFight ? "en combat" : "connecté, hors combat")
    : `sniffer injoignable${fight.lastError ? ` (${fight.lastError})` : ""}`;
  $("fightinfo").textContent = fight.inFight ? `combat ${fight.fightId} · tour ${fight.round}` : "";

  for (const [side, node] of [["ally", $("allies")], ["enemy", $("enemies")], ["unknown", $("unknowns")]] as const) {
    node.replaceChildren();
    const list = fight.fighters.filter((f) => f.side === side);
    if (!list.length && side !== "unknown") node.appendChild(el("p", "empty", "—"));
    for (const f of list) node.appendChild(fighterCard(f));
  }
  $("unknownwrap").hidden = !fight.fighters.some((f) => f.side === "unknown");

  const note: string[] = [];
  if (!fight.connected) note.push("Démarre le sniffer : docker compose up -d, puis python sniffer/sniff.py");
  if (fight.unpairedRemovals) {
    note.push(`${fight.unpairedRemovals} effet(s) retiré(s) dont le début n'a pas été vu — l'app a rejoint le combat en cours, leur nom est inconnu.`);
  }
  $("fightnote").textContent = note.join(" ");
}

// ---------------------------------------------------------------- rules pane

/** id -> label, filled in as rules are rendered: a rule reading "état #56" is
 *  no use to anybody. */
const nameCache = new Map<string, string>();
async function warmNames(rs: readonly Rule[]): Promise<void> {
  await Promise.all(rs.map(async (r) => {
    if (r.what.kind === "any" || r.what.id === undefined || r.what.name !== undefined) return;
    const key = `${r.what.kind}:${r.what.id}`;
    if (nameCache.has(key)) return;
    nameCache.set(key, (await api.nameOf(r.what.kind, r.what.id)) ?? `#${r.what.id}`);
  }));
}

function whoText(who: RuleWho): string {
  return who.kind === "any" ? "n'importe qui"
    : who.kind === "target" ? "la cible"
    : who.kind === "self" ? "moi"
    : who.kind === "allies" ? "un allié"
    : who.kind === "enemies" ? "un ennemi"
    : who.kind === "monster" ? `le monstre ${fight.fighters.find((f) => f.monsterId === who.monsterId)?.monsterName ?? who.monsterId}`
    : `le combattant ${who.fighterId}`;
}

function whatText(what: RuleWhat): string {
  const label = what.kind === "any" ? null
    : what.name ?? (what.id === undefined ? null : nameCache.get(`${what.kind}:${what.id}`) ?? `#${what.id}`);
  if (label === null) return "n'importe quel effet";
  return `« ${label} »${what.exact ? " (exactement)" : ""}`;
}

/** The conditions, as editable rows: each one can be flipped between "a" and
 *  "n'a pas", or dropped. */
function conditionRows(r: Rule): HTMLElement[] {
  const groups = (r.conditions ?? []).filter((g) => g.length);
  const out: HTMLElement[] = [];
  groups.forEach((g, gi) => {
    g.forEach((c, ci) => {
      const row = el("div", "sum cond");
      row.appendChild(el("span", undefined,
        (gi === 0 && ci === 0 ? "seulement si " : ci === 0 ? "ou si " : "et ") + whoText(c.who) + " "));
      const flip = el("button", "ghost", c.present ? "a" : "n'a pas");
      flip.title = "inverser la condition";
      flip.addEventListener("click", () => {
        c.present = !c.present;
        void persist();
      });
      row.appendChild(flip);
      row.appendChild(el("span", undefined, " " + whatText(c.what) + " "));
      const drop = el("button", "ghost danger", "×");
      drop.title = "retirer cette condition";
      drop.addEventListener("click", () => {
        g.splice(ci, 1);
        r.conditions = (r.conditions ?? []).filter((x) => x.length);
        void persist();
      });
      row.appendChild(drop);
      out.push(row);
    });
  });
  return out;
}

function summarise(r: Rule): string {
  const label = r.what.kind === "any" ? null
    : r.what.name ?? (r.what.id === undefined ? null : nameCache.get(`${r.what.kind}:${r.what.id}`) ?? `#${r.what.id}`);
  // An id rule predates the name picker and covers exactly one id, which is
  // almost never what someone wants. Say so instead of letting it look normal.
  const only = r.what.name === undefined && r.what.id !== undefined ? " (cet identifiant seul)" : "";
  const what = label === null
    ? "n'importe quel effet"
    : `${r.what.kind === "state" ? "l'état" : "l'effet"} « ${label} »${only}`;
  const who = whoText(r.who);
  const how = [r.sound ? `son ${r.sound}` : null, r.toast ? "toast" : null, r.overlay ? "bandeau" : null]
    .filter(Boolean).join(" + ") || "aucune alerte";
  const confirm = r.confirmMs ? `, confirmé après ${r.confirmMs} ms` : "";
  return `quand ${who} ${r.trigger === "gained" ? "gagne" : "perd"} ${what}${confirm} → ${how}`;
}

/** Callers warm the name cache first; this stays synchronous. */
function renderRules(): void {
  ($("mergemode") as HTMLButtonElement).hidden = rules.length < 2;
  $("mergemode").textContent = merging ? "Annuler la fusion" : "Fusionner des règles…";
  const list = $("rulelist");
  list.replaceChildren();
  if (storageProblem) {
    const warn = el("div", "card", storageProblem);
    warn.style.borderLeftColor = "#e3b341";
    list.appendChild(warn);
  }
  if (!rules.length) {
    list.appendChild(el("p", "empty", "Aucune règle. Clique « Nouvelle règle », ou un effet dans l'onglet Combat."));
    return;
  }
  // The merge bar, only while merging.
  if (merging) {
    const bar = el("div", "card rule");
    const first = rules.find((r) => r.id === selected[0]);
    bar.appendChild(el("div", "grow", selected.length < 2
      ? "Coche au moins deux règles. La première cochée reste le déclencheur, les autres deviennent ses conditions."
      : `${selected.length} règles · « ${first?.label || "(sans nom)"} » reste le déclencheur, les autres deviennent ses conditions`));
    for (const [mode, text] of [["and", "Fusionner ET"], ["or", "Fusionner OU"]] as const) {
      const b = el("button", mode === "and" ? "primary" : "ghost", text);
      if (selected.length < 2) (b as HTMLButtonElement).disabled = true;
      b.addEventListener("click", () => void mergeSelected(mode));
      bar.appendChild(b);
    }
    const cancel = el("button", "ghost", "Annuler");
    cancel.addEventListener("click", () => { merging = false; selected = []; renderRules(); });
    bar.appendChild(cancel);
    list.appendChild(bar);
  }

  for (const r of rules) {
    const card = el("div", "card rule");
    // Exactly one checkbox per row: while merging it selects, otherwise it is
    // the on/off switch.
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    if (merging) {
      box.checked = selected.includes(r.id);
      box.title = "sélectionner pour fusionner";
      box.addEventListener("change", () => {
        selected = box.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id);
        renderRules();
      });
    } else {
      box.checked = r.enabled;
      box.title = "activer / désactiver";
      box.addEventListener("change", () => { r.enabled = box.checked; void persist(); });
    }
    card.appendChild(box);

    const mid = el("div", "grow");
    mid.appendChild(el("div", "name", r.label || "(sans nom)"));
    mid.appendChild(el("div", "sum", summarise(r)));
    for (const row of conditionRows(r)) mid.appendChild(row);
    card.appendChild(mid);

    const test = el("button", "ghost", "Tester");
    test.addEventListener("click", () => void api.testRule(r.id));
    const edit = el("button", "ghost", "Modifier");
    edit.addEventListener("click", () => openEditor({ ...r }));
    const del = el("button", "ghost danger", "Supprimer");
    del.addEventListener("click", () => { rules = rules.filter((x) => x.id !== r.id); void persist(); });
    card.append(test, edit, del);
    list.appendChild(card);
  }
}

/** Fold the ticked rules into the first one. The others are removed: that is
 *  what merging means, and the result spells out what it now checks. */
async function mergeSelected(mode: "and" | "or"): Promise<void> {
  const picked = selected.map((id) => rules.find((r) => r.id === id)).filter((r): r is Rule => !!r);
  if (picked.length < 2) return;
  const [trigger, ...sources] = picked;
  const merged = await api.mergeRules(trigger!, sources, mode);
  rules = rules.filter((r) => !sources.some((s) => s.id === r.id)).map((r) => (r.id === merged.id ? merged : r));
  selected = [];
  merging = false;
  await warmNames(rules);
  await persist();
}

async function persist(): Promise<void> {
  const saved = await api.saveSettings({ rules });
  rules = saved.rules;
  await warmNames(rules);
  renderRules();
}

function openEditor(draft: Rule): void {
  editing = draft;
  const box = $("editor");
  box.hidden = false;
  box.className = "card";
  box.replaceChildren();

  const form = el("div", "form");
  const field = (label: string, control: HTMLElement, wide = false) => {
    const l = el("label", wide ? "wide" : undefined);
    l.appendChild(el("span", undefined, label));
    l.appendChild(control);
    form.appendChild(l);
    return control;
  };

  const label = el("input") as HTMLInputElement;
  label.value = draft.label;
  label.placeholder = "ex. Boss devient invulnérable";
  label.style.width = "100%";
  field("Nom de la règle", label, true);

  const trigger = el("select") as HTMLSelectElement;
  for (const [v, t] of [["gained", "gagne l'effet"], ["lost", "perd l'effet"]] as const) {
    const o = el("option", undefined, t) as HTMLOptionElement;
    o.value = v;
    trigger.appendChild(o);
  }
  trigger.value = draft.trigger;
  field("Déclencheur", trigger);

  const whoKind = el("select") as HTMLSelectElement;
  for (const [v, t] of [["any", "n'importe qui"], ["self", "moi"], ["enemies", "un ennemi"],
                        ["allies", "un allié"], ["monster", "un monstre précis"],
                        ["fighter", "un combattant précis (ce combat)"]] as const) {
    const o = el("option", undefined, t) as HTMLOptionElement;
    o.value = v;
    whoKind.appendChild(o);
  }
  whoKind.value = draft.who.kind;
  field("Sur qui", whoKind);

  const whoTarget = el("select") as HTMLSelectElement;
  const whoWrap = field("Lequel", whoTarget) as HTMLSelectElement;
  const fillTargets = () => {
    whoTarget.replaceChildren();
    const monsters = whoKind.value === "monster";
    const seen = new Set<number>();
    for (const f of fight.fighters) {
      const value = monsters ? f.monsterId : f.id;
      if (value === null || seen.has(value)) continue;
      seen.add(value);
      if (monsters && f.monsterId === null) continue;
      const o = el("option", undefined, `${fighterName(f)} (${value})`) as HTMLOptionElement;
      o.value = String(value);
      whoTarget.appendChild(o);
    }
    if (!whoTarget.children.length) {
      const o = el("option", undefined, "— entre un combat pour choisir —") as HTMLOptionElement;
      o.value = "";
      whoTarget.appendChild(o);
    }
    const current = draft.who.monsterId ?? draft.who.fighterId;
    if (current !== undefined) whoTarget.value = String(current);
    whoWrap.parentElement!.hidden = whoKind.value !== "monster" && whoKind.value !== "fighter";
  };
  whoKind.addEventListener("change", fillTargets);

  const whatKind = el("select") as HTMLSelectElement;
  for (const [v, t] of [["any", "n'importe lequel"], ["state", "un état"], ["effect", "un effet"]] as const) {
    const o = el("option", undefined, t) as HTMLOptionElement;
    o.value = v;
    whatKind.appendChild(o);
  }
  whatKind.value = draft.what.kind;
  field("Quoi", whatKind);

  const search = el("input") as HTMLInputElement;
  search.placeholder = "tape un nom : pesanteur, invulnérable…";
  search.style.width = "100%";
  const searchWrap = field("Effet ou état", search, true);
  const results = el("div", "results");
  results.hidden = true;
  searchWrap.parentElement!.appendChild(results);

  let chosen: { kind: EffectKind; name?: string; id?: number; exact?: boolean } | null =
    draft.what.kind === "any" ? null
      : draft.what.name !== undefined ? { kind: draft.what.kind, name: draft.what.name, exact: draft.what.exact }
      : draft.what.id !== undefined ? { kind: draft.what.kind, id: draft.what.id }
      : null;
  const showChosen = async () => {
    if (!chosen) { search.value = ""; return; }
    search.value = chosen.name
      ?? (await api.nameOf(chosen.kind, chosen.id!)) ?? `#${chosen.id}`;
  };
  void showChosen();

  let timer = 0;
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (whatKind.value === "any" || !search.value.trim()) { results.hidden = true; return; }
      const found = await api.searchNames(whatKind.value as EffectKind, search.value);
      results.replaceChildren();
      for (const g of found) {
        // One row per family. Six ids are called "Invulnérable" and the ranks of
        // one spell (Toxines I..V) are one thing, so the rule covers them all.
        const row = el("div");
        const bits = [g.name];
        if (g.ids.length > 1) bits.push(`${g.ids.length} variantes`);
        if (g.seen) bits.push("✓ vu en combat");
        row.appendChild(el("div", undefined, bits.join("  ·  ")));
        // Say plainly what is folded in, so a merge is never a surprise.
        if (g.variants.length > 1) {
          const shown = g.variants.slice(0, 6).join(", ");
          row.appendChild(el("div", "sum", shown + (g.variants.length > 6 ? ", …" : "")));
        }
        row.addEventListener("click", () => {
          chosen = { kind: whatKind.value as EffectKind, name: g.name };
          search.value = g.name;
          results.hidden = true;
        });
        results.appendChild(row);

        // One row per rank as well, for a condition that needs the exact step
        // ("only while it is not yet at Toxines V"). Folded away otherwise.
        if (g.variants.length > 1) {
          for (const v of g.variants) {
            if (v === g.name) continue;
            const exact = el("div", "variant", `   ↳ ${v}  ·  exactement celui-ci`);
            exact.addEventListener("click", (e) => {
              e.stopPropagation();
              chosen = { kind: whatKind.value as EffectKind, name: v, exact: true };
              search.value = v;
              results.hidden = true;
            });
            results.appendChild(exact);
          }
        }
      }
      results.hidden = !found.length;
    }, 120);
  });
  whatKind.addEventListener("change", () => {
    chosen = null;
    search.value = "";
    results.hidden = true;
    searchWrap.parentElement!.hidden = whatKind.value === "any";
  });
  searchWrap.parentElement!.hidden = whatKind.value === "any";

  const sound = el("select") as HTMLSelectElement;
  const fillSounds = () => {
    sound.replaceChildren();
    const none = el("option", undefined, "— aucun —") as HTMLOptionElement;
    none.value = "";
    sound.appendChild(none);
    for (const s of sounds) {
      const o = el("option", undefined, s) as HTMLOptionElement;
      o.value = s;
      sound.appendChild(o);
    }
    sound.value = draft.sound ?? "";
  };
  fillSounds();

  const soundRow = el("div", "row");
  soundRow.appendChild(sound);
  const add = el("button", "ghost", "Ajouter un fichier…");
  add.addEventListener("click", async () => {
    const added = await api.addSound();
    if (!added) return;
    sounds = await api.listSounds();
    draft.sound = added;
    fillSounds();
  });
  const preview = el("button", "ghost", "Écouter");
  // Read the slider at click time, not at build time: previewing at full volume
  // told you nothing about how loud the alert would actually be (issue #4).
  preview.addEventListener("click", () => { if (sound.value) void play(sound.value, currentVolume()); });
  soundRow.append(add, preview);
  field("Son", soundRow, true);

  const toast = el("input") as HTMLInputElement;
  toast.type = "checkbox";
  toast.checked = draft.toast;
  field("Notification Windows", toast);

  const overlay = el("input") as HTMLInputElement;
  overlay.type = "checkbox";
  overlay.checked = draft.overlay;
  field("Bandeau par-dessus le jeu", overlay);

  const confirm = el("input") as HTMLInputElement;
  confirm.type = "number";
  confirm.min = "0";
  confirm.step = "100";
  confirm.value = String(draft.confirmMs ?? 0);
  confirm.title = "0 = alerter tout de suite";
  field("Confirmer après (ms)", confirm);
  const hint = el("div", "sum",
    "Attend puis revérifie, et ne sonne que si c'est toujours vrai. Indispensable pour « perd » : " +
    "quand un sort monte de rang, l'état revient en 0-1 ms et ce n'est pas une vraie perte. 1500 va bien.");
  hint.style.gridColumn = "1 / -1";
  form.appendChild(hint);

  const cooldown = el("input") as HTMLInputElement;
  cooldown.type = "number";
  cooldown.min = "0";
  cooldown.step = "100";
  cooldown.value = String(draft.cooldownMs);
  field("Anti-répétition (ms)", cooldown);

  box.appendChild(form);

  const actions = el("div", "row");
  actions.style.marginTop = "14px";
  const save = el("button", "primary", "Enregistrer");
  save.addEventListener("click", () => {
    const who: RuleWho =
      whoKind.value === "monster" ? { kind: "monster", monsterId: Number(whoTarget.value) }
      : whoKind.value === "fighter" ? { kind: "fighter", fighterId: Number(whoTarget.value) }
      : { kind: whoKind.value as "any" | "allies" | "enemies" };
    const what: RuleWhat = whatKind.value === "any" || !chosen
      ? { kind: "any" }
      : chosen.name !== undefined
        ? { kind: chosen.kind, name: chosen.name, ...(chosen.exact ? { exact: true } : {}) }
        : { kind: chosen.kind, id: chosen.id };

    const saved: Rule = {
      id: draft.id || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      enabled: draft.enabled,
      label: label.value.trim(),
      trigger: trigger.value as "gained" | "lost",
      what, who,
      sound: sound.value || null,
      toast: toast.checked,
      overlay: overlay.checked,
      cooldownMs: Math.max(0, Number(cooldown.value) || 0),
      confirmMs: Math.max(0, Number(confirm.value) || 0),
    };
    const at = rules.findIndex((r) => r.id === saved.id);
    if (at === -1) rules.push(saved); else rules[at] = saved;
    closeEditor();
    void persist();
  });
  const cancel = el("button", "ghost", "Annuler");
  cancel.addEventListener("click", closeEditor);
  actions.append(save, cancel);
  box.appendChild(actions);

  fillTargets();
}

function closeEditor(): void {
  editing = null;
  $("editor").hidden = true;
  $("editor").replaceChildren();
}

// ---------------------------------------------------------------- shell

function selectTab(tab: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
    b.classList.toggle("on", b.dataset.tab === tab);
  }
  for (const id of ["fight", "rules", "log"]) $(`tab-${id}`).hidden = id !== tab;
}

document.querySelectorAll<HTMLButtonElement>("nav button").forEach((b) => {
  b.addEventListener("click", () => selectTab(b.dataset.tab!));
});

$("mergemode").addEventListener("click", () => {
  merging = !merging;
  selected = [];
  renderRules();
});

$("newrule").addEventListener("click", () =>
  openEditor({
    id: "", enabled: true, label: "", trigger: "gained",
    what: { kind: "any" }, who: { kind: "any" },
    sound: sounds[0] ?? null, toast: true, overlay: true, cooldownMs: 1500,
  }),
);

const volume = $("volume") as HTMLInputElement;
volume.addEventListener("change", () => void api.saveSettings({ volume: Number(volume.value) }));

api.onFightUpdate((v) => { fight = v; renderFight(); });
api.onAlertSound(({ file, volume: vol }) => void play(file, vol));
api.onAlertLog(({ at, title }) => {
  const log = $("log");
  const line = el("div", undefined, `${new Date(at).toLocaleTimeString()}  ${title}`);
  log.prepend(line);
  while (log.children.length > 300) log.lastChild!.remove();
});

void (async () => {
  const state = await api.getState();
  rules = state.settings.rules;
  storageProblem = state.storage.problem;
  sounds = state.sounds;
  fight = state.fight;
  volume.value = String(state.settings.volume);
  renderFight();
  await warmNames(rules);
  renderRules();

  const health = await api.checkHealth();
  const cat = $("catalog");
  if (!health.ok) cat.textContent = "sniffer hors ligne";
  else if (health.contract !== 1) {
    cat.textContent = `contrat API ${health.contract} ≠ 1 — cette app a été écrite pour la version 1`;
    cat.className = "muted warn";
  } else if (health.catalogCurrent === false) {
    cat.textContent = `données de jeu ${state.catalog.gameVersion}, actuelles ${health.currentGameVersion} — lance npm run catalog`;
    cat.className = "muted warn";
  } else {
    cat.textContent = `données de jeu ${state.catalog.gameVersion}`;
  }
  if (editing) { /* keep the open editor */ }
})();
