/** The Electron main process: the only place that talks to the sniffer.
 *
 *  All of the network lives here rather than in the renderer, for two reasons
 *  that are both load-bearing:
 *    - CORS. api/gate.py hands CORS headers only to a loopback *page* origin; a
 *      renderer loaded from file:// gets none and every request is hidden from
 *      it. Node's fetch sends no Origin at all, so the gate lets it straight
 *      through.
 *    - Throttling. A hidden or minimised window has its renderer throttled by
 *      Chromium. The alert path must not be.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, screen, Tray } from "electron";
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Store } from "./config.js";
import { FightTracker, type Fighter, type FightEvent } from "./fight.js";
import { Names } from "./names.js";
import { Cooldowns, firing, merge, stillTrue, type Rule } from "./rules.js";
import { follow, get } from "./stream.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

// Windows shows nothing at all for a toast unless the app has an explicit
// model id. This is not optional and it fails silently without it.
app.setAppUserModelId("ch.abyss-inn.dofus-fight-alerts");

// The smoke run drives the real UI, including saving a rule. Give it its own
// profile so it can never write into the rules you actually use. Must happen
// before the app is ready, and before the Store is constructed below.
if (process.env.FIGHT_ALERTS_SMOKE) {
  app.setPath("userData", path.join(app.getPath("temp"), "dofus-fight-alerts-smoke"));
}

const store = new Store(app.getPath("userData"));
const names = new Names();
const tracker = new FightTracker();
const cooldowns = new Cooldowns();

let win: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let stopStream: (() => void) | null = null;
let connected = false;
let lastError: string | null = null;
let quitting = false;
/** Every effect/state id seen in a fight, so the rule editor can float them to
 *  the top. Flushed to disk when a fight ends rather than on every event. */
let seen = new Set<string>();
let seenDirty = false;

/** A dot, drawn rather than shipped as a file. */
const ICON = nativeImage.createFromDataURL(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXklEQVQ4y2NgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBQMBQAABbUAAeCJ8k8AAAAASUVORK5CYII=",
);

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function rosterPayload() {
  const live = tracker.liveEffects();
  return {
    inFight: tracker.inFight,
    fightId: tracker.fightId,
    round: tracker.round,
    unpairedRemovals: tracker.unpairedRemovals,
    connected,
    lastError,
    fighters: [...tracker.fighters.values()].map((f: Fighter) => ({
      ...f,
      monsterName: f.monsterId === null ? null : names.monsterName(f.monsterId),
      effects: live
        .filter((e) => e.target === f.id)
        .map((e) => ({ ...e, name: names.of(e.kind, e.id) })),
    })),
  };
}

function describe(ev: FightEvent): { title: string; body: string } {
  const f = tracker.fighters.get(ev.target);
  const who = f?.playerName
    ?? (f?.monsterId !== null && f?.monsterId !== undefined
      ? names.monsterName(f.monsterId) ?? `monstre ${f.monsterId}`
      : f?.summon
        ? `invocation ${ev.target}`
        : `combattant ${ev.target}`);
  const what = names.of(ev.kind, ev.id) ?? (ev.id === null ? "un effet inconnu" : `${ev.kind} ${ev.id}`);
  const verb = ev.trigger === "gained"
    ? "gagne"
    : ev.reason === "disabled"
      ? "voit désactivé"
      : ev.reason === "removed_by_spell"
        ? "perd (dissipé)"
        : "perd";
  return { title: `${who} ${verb} ${what}`, body: `tour ${ev.round}` };
}

function showOverlay(text: string, ms: number): void {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.webContents.send("overlay:show", { text, ms });
  overlay.showInactive(); // never steals focus from the game
  setTimeout(() => {
    if (overlay && !overlay.isDestroyed()) overlay.hide();
  }, ms);
}

function fire(rule: Rule, ev: FightEvent): void {
  const { title, body } = describe(ev);
  if (rule.toast) new Notification({ title, body, silent: true }).show();
  if (rule.overlay) showOverlay(title, store.settings.overlayMs);
  if (rule.sound) send("alert:sound", { file: rule.sound, volume: store.settings.volume });
  send("alert:log", { at: Date.now(), rule: rule.id, label: rule.label || title, title, body });
}

function onMessage(m: Parameters<Parameters<typeof follow>[1]["onMessage"]>[0]): void {
  const before = tracker.fighters.size;
  const events = tracker.handle(m);

  if (tracker.ownNamesChanged) {
    tracker.ownNamesChanged = false;
    void store.save({ ownCharacters: [...tracker.ownNames] });
    send("fight:update", rosterPayload());
  }

  if (tracker.fighters.size !== before || m.name === "fight_end" || m.name === "fight_started") {
    const wanted = [...tracker.fighters.values()].map((f) => f.monsterId).filter((id): id is number => id !== null);
    void names.fetchMonsters(store.settings.apiUrl, wanted).then(() => send("fight:update", rosterPayload()));
    if (!tracker.inFight) {
      cooldowns.clear();
      if (seenDirty) {
        seenDirty = false;
        void store.save({ seen: [...seen] });
      }
    }
  }

  if (tracker.moved) {
    tracker.moved = false;
    send("fight:update", rosterPayload());
  }

  for (const ev of events) {
    if (ev.id !== null && !seen.has(`${ev.kind}:${ev.id}`)) {
      seen.add(`${ev.kind}:${ev.id}`);
      seenDirty = true;
    }
    // Replayed backlog still updates the roster above, but must not shout.
    if (ev.ageMs > store.settings.maxEventAgeMs) continue;
    const nameOf = (k: "state" | "effect", id: number) => names.of(k, id);
    for (const rule of firing(store.settings.rules, ev, tracker, cooldowns, Date.now(), nameOf)) {
      if (!rule.confirmMs) {
        fire(rule, ev);
        continue;
      }
      // Wait and look again: a state that comes straight back was a rank going
      // up, not the thing you wanted to hear about.
      const fightAtMatch = tracker.fightId;
      setTimeout(() => {
        if (tracker.fightId !== fightAtMatch) return;   // the fight moved on
        if (stillTrue(rule, ev, tracker, nameOf)) fire(rule, ev);
      }, rule.confirmMs);
    }
    send("fight:event", { ...ev, label: describe(ev).title });
  }
  if (events.length) send("fight:update", rosterPayload());
}

function startStream(): void {
  stopStream?.();
  stopStream = follow(store.settings.apiUrl, {
    onMessage,
    onStatus: (ok, detail) => {
      connected = ok;
      lastError = ok ? null : detail ?? null;
      send("fight:update", rosterPayload());
    },
  });
}

function createWindows(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Dofus fight alerts",
    icon: ICON,
    webPreferences: {
      preload: path.join(ROOT, "src", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // The renderer plays the alert sounds, so it must keep running while the
      // window is hidden behind the game.
      backgroundThrottling: false,
    },
  });
  // Without these a renderer fault is a silent blank window, which is a
  // miserable thing to debug in a tray app you rarely look at.
  win.webContents.on("render-process-gone", (_e, d) => console.error("renderer gone:", d));
  win.webContents.on("preload-error", (_e, f, err) => console.error("preload failed:", f, err));
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    if (level >= 2) console.error(`renderer: ${message} (${source}:${line})`);
  });
  void win.loadFile(path.join(ROOT, "renderer", "index.html"));
  win.on("close", (e) => {
    if (quitting) return;
    // Quitting on close is a real quit: window-all-closed deliberately does
    // nothing, so just letting the window go would leave a headless process.
    if (!store.settings.closeToTray) {
      quitting = true;
      app.quit();
      return;
    }
    e.preventDefault(); // closing hides it; the tray brings it back
    win?.hide();
  });

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlay = new BrowserWindow({
    width: 620,
    height: 96,
    x: Math.round((width - 620) / 2),
    y: 60,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: { preload: path.join(ROOT, "src", "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  // 'screen-saver' is the level that stays above a borderless fullscreen game.
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true);
  overlay.webContents.on("render-process-gone", (_e, d) => console.error("overlay gone:", d));
  overlay.webContents.on("preload-error", (_e, f, err) => console.error("overlay preload failed:", f, err));
  void overlay.loadFile(path.join(ROOT, "renderer", "overlay.html"));

  tray = new Tray(ICON);
  tray.setToolTip("Dofus fight alerts");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Ouvrir", click: () => win?.show() },
      { type: "separator" },
      { label: "Quitter", click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on("double-click", () => win?.show());
}

ipcMain.handle("state:get", async () => ({
  settings: store.settings,
  storage: { file: store.file, problem: store.loadProblem },
  catalog: { gameVersion: names.gameVersion, builtAt: names.builtAt },
  fight: rosterPayload(),
  sounds: await listSounds(),
}));

ipcMain.handle("settings:save", async (_e, patch: Record<string, unknown>) => {
  const before = store.settings.apiUrl;
  const next = await store.save(patch);
  if (next.apiUrl !== before) startStream();
  return next;
});

ipcMain.handle("names:search", (_e, { kind, query }: { kind: "state" | "effect"; query: string }) =>
  names.search(kind, query, seen),
);

ipcMain.handle("names:of", (_e, { kind, id }: { kind: "state" | "effect"; id: number }) => names.of(kind, id));

ipcMain.handle("health:check", async () => {
  try {
    const h = (await get(store.settings.apiUrl, "/api/health")) as { ok: boolean; contract: number };
    const cat = await names.catalogIsCurrent();
    return { ...h, catalogCurrent: cat.ok, currentGameVersion: cat.current };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

async function listSounds(): Promise<string[]> {
  try {
    return (await readdir(store.soundsDir)).filter((f) => /\.(wav|mp3|ogg|flac|m4a)$/i.test(f));
  } catch {
    return [];
  }
}

ipcMain.handle("sound:list", listSounds);

ipcMain.handle("sound:add", async () => {
  const res = await dialog.showOpenDialog({
    title: "Choisir un son",
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "flac", "m4a"] }],
    properties: ["openFile"],
  });
  const picked = res.filePaths[0];
  if (!picked) return null;
  const name = path.basename(picked);
  await copyFile(picked, path.join(store.soundsDir, name));
  return name;
});

/** Sound bytes over IPC rather than a custom protocol: no scheme to register,
 *  nothing to punch through webSecurity, and the renderer caches the blob. */
ipcMain.handle("sound:data", async (_e, file: string) => {
  const safe = path.basename(file); // never leave the sounds folder
  const buf = await readFile(path.join(store.soundsDir, safe));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle("own:set", async (_e, { name, own }: { name: string; own: boolean }) => {
  tracker.setOwn(name, own);
  tracker.ownNamesChanged = false;
  await store.save({ ownCharacters: [...tracker.ownNames], ownCharactersEdited: true });
  send("fight:update", rosterPayload());
  return [...tracker.ownNames];
});

// Merging lives in rules.ts so it is covered by the same tests as matching.
ipcMain.handle("rules:merge", (_e, a: { into: Rule; sources: Rule[]; mode: "and" | "or" }) =>
  merge(a.into, a.sources, a.mode));

ipcMain.handle("rule:test", (_e, ruleId: string) => {
  const rule = store.settings.rules.find((r) => r.id === ruleId);
  if (!rule) return false;
  const { title } = { title: rule.label || "Test" };
  if (rule.toast) new Notification({ title, body: "test", silent: true }).show();
  if (rule.overlay) showOverlay(title, store.settings.overlayMs);
  if (rule.sound) send("alert:sound", { file: rule.sound, volume: store.settings.volume });
  return true;
});

void app.whenReady().then(async () => {
  await store.load();
  console.log(`${store.settings.rules.length} rule(s) loaded from ${store.file}`);
  if (store.loadProblem) console.error("settings:", store.loadProblem);
  seen = new Set(store.settings.seen);
  for (const name of store.settings.ownCharacters) tracker.ownNames.add(name);
  tracker.ownLocked = store.settings.ownCharactersEdited;
  await store.seedSounds(path.join(ROOT, "data", "sounds"));
  await names.loadCatalog(path.join(ROOT, "data", "catalog.json"));
  createWindows();
  startStream();

  // `npm run smoke` drives the UI end to end, writes screenshots and exits.
  // It is how this gets verified without a person sitting in front of it.
  if (process.env.FIGHT_ALERTS_SMOKE && win) {
    win.webContents.once("did-finish-load", () => void smoke(process.env.FIGHT_ALERTS_SMOKE!));
  }
});

async function smoke(out: string): Promise<void> {
  const shoot = async (suffix: string, target: BrowserWindow) =>
    writeFile(out.replace(/\.png$/, `${suffix}.png`), (await target.webContents.capturePage()).toPNG());
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  await wait(2000);
  await shoot("", win!);

  // Render a fight so the Combat tab can be checked without being in one.
  // renderer.js is a classic script, so its state is reachable from here.
  await win!.webContents.executeJavaScript(`
    fight = { inFight: true, fightId: 42, round: 3, unpairedRemovals: 1,
      connected: true, lastError: null, fighters: [
      { id: 1000000001, side: "ally", facing: 1, cell: 200, monsterId: null, monsterName: null,
        level: null, playerName: "Joueuse", own: true, summon: false,
        effects: [{ uid: 1, kind: "state", id: 5195, name: "Toxines II" }] },
      { id: 1000000002, side: "ally", facing: 7, cell: 201, monsterId: null, monsterName: null,
        level: null, playerName: "Coequipier", own: false, summon: false, effects: [] },
      { id: -1, side: "enemy", facing: 3, cell: 100, position: 142, monsterId: 4460, monsterName: "Capitaine Meno",
        level: 209, playerName: null, own: false, summon: false,
        effects: [{ uid: 2, kind: "state", id: 5196, name: "Toxines III" }] },
      { id: -21, side: "unknown", facing: null, cell: null, monsterId: null, monsterName: null,
        level: null, playerName: null, own: false, summon: true, effects: [] }] };
    renderFight();
  `);
  await wait(300);
  await shoot("-fight", win!);

  // Build a rule through the real editor and save it, which exercises the tab
  // switch, the form, the catalog search and the round trip through disk.
  await win!.webContents.executeJavaScript(`
    document.querySelector('nav button[data-tab=rules]').click();
    document.getElementById('newrule').click();
    document.querySelector('#editor input').value = 'Boss invulnerable';
    const kinds = document.querySelectorAll('#editor select');
    kinds[3].value = 'state'; kinds[3].dispatchEvent(new Event('change'));
    const box = document.querySelector('#editor input[placeholder^="tape"]');
    box.value = 'invuln'; box.dispatchEvent(new Event('input'));
  `);
  await wait(600);
  await shoot("-search", win!);

  await win!.webContents.executeJavaScript(`
    document.querySelector('.results div').click();
    [...document.querySelectorAll('#editor button')].find(b => b.textContent === 'Enregistrer').click();
  `);
  await wait(600);
  await shoot("-saved", win!);

  // Prove a sound actually decodes in the renderer, rather than trusting that
  // the bytes made it across IPC intact.
  const audio = await win!.webContents.executeJavaScript(`(async () => {
    const files = await api.listSounds();
    if (!files.length) return "NO SOUNDS";
    const buf = await api.soundData(files[0]);
    const decoded = await new AudioContext().decodeAudioData(buf.slice(0));
    return files.length + " sounds; " + files[0] + " decodes: " +
           decoded.duration.toFixed(2) + "s @ " + decoded.sampleRate + "Hz";
  })()`);
  console.log("smoke: audio ->", audio);

  // Build a second rule and merge the two, which exercises the merge bar, the
  // IPC round trip and the condition rows.
  await win!.webContents.executeJavaScript(`
    document.getElementById('newrule').click();
    document.querySelector('#editor input').value = 'Meno a Toxines';
    const k = document.querySelectorAll('#editor select');
    k[3].value = 'state'; k[3].dispatchEvent(new Event('change'));
    const b = document.querySelector('#editor input[placeholder^="tape"]');
    b.value = 'toxines'; b.dispatchEvent(new Event('input'));
  `);
  await wait(600);
  await shoot("-variants", win!);
  await win!.webContents.executeJavaScript(`
    document.querySelector('.results div').click();
    [...document.querySelectorAll('#editor button')].find(x => x.textContent === 'Enregistrer').click();
  `);
  await wait(500);
  // Enter selection mode first: outside it a rule row has only its on/off box.
  await win!.webContents.executeJavaScript(`document.getElementById('mergemode').click();`);
  await wait(300);
  await shoot("-selecting", win!);
  // Re-query between clicks: ticking one re-renders the list.
  for (const nth of [0, 1]) {
    await win!.webContents.executeJavaScript(`
      [...document.querySelectorAll('#rulelist .rule')]
        .map(card => card.querySelector('input[type=checkbox]'))
        .filter(box => box && !box.checked)[0].click();
    `);
    await wait(200);
    void nth;
  }
  await wait(300);
  await shoot("-mergebar", win!);
  await win!.webContents.executeJavaScript(`
    [...document.querySelectorAll('#rulelist button')].find(x => x.textContent === 'Fusionner ET').click();
  `);
  await wait(600);
  await shoot("-merged", win!);
  console.log("smoke: rules after merge ->", JSON.stringify(store.settings.rules.map(r =>
    ({ label: r.label, what: r.what, conditions: r.conditions }))));

  const rule = store.settings.rules[0];
  console.log("smoke: rule saved ->", JSON.stringify(rule));
  if (rule) {
    if (rule.overlay) showOverlay(`${rule.label} (test)`, 8000);
    await wait(800);
    await shoot("-overlay", overlay!);
  }
  console.log("smoke: done ->", out);
  quitting = true;
  app.quit();
}

app.on("window-all-closed", () => {
  // Deliberately does nothing: the app lives in the tray and keeps listening.
});

app.on("before-quit", () => {
  quitting = true;
  stopStream?.();
  if (seenDirty) void store.save({ seen: [...seen] });
});
