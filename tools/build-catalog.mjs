/** Rebuild data/catalog.json: every state and effect id with its French name.
 *
 *     npm run catalog        # after a game update
 *
 * Source is DofusDB (api.dofusdb.fr), which is the only public API that serves
 * state names inline. dofusdude has no states endpoint at all - its data is only
 * in release files, where the names are ids you must join against a 30 MB
 * fr.json. Note DofusDB's LPNC-IA licence: this is a private, personal tool.
 *
 * The output is ~180 KB and committed, so the app resolves names offline and
 * never calls out at runtime.
 */

import { writeFile } from "node:fs/promises";

const API = "https://api.dofusdb.fr";
const PAGE = 50;                       // hard cap: $limit=500 still returns 50
const CONCURRENCY = 6;

/** Game text without its markup and placeholders, the same way the sniffer does
 *  it (tools/import_refdata.py:text). The '{{spell,123,1::Porteur}}' form is a
 *  LINK whose label after '::' is content - dropping the whole thing empties
 *  ~194 state names. */
const text = (s) =>
  String(s ?? "")
    .replace(/\{\{[^{}]*?::(.*?)\}\}/g, "$1")
    .replace(/<[^>]*>|\{\{.*?\}\}|#\d|\[.*?\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url} -> ${err.message}`);
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

/** Every page of a collection, CONCURRENCY at a time. */
async function all(collection) {
  const first = await getJson(`${API}/${collection}?$limit=${PAGE}`);
  const skips = [];
  for (let s = PAGE; s < first.total; s += PAGE) skips.push(s);

  const pages = [first.data];
  for (let i = 0; i < skips.length; i += CONCURRENCY) {
    const batch = skips.slice(i, i + CONCURRENCY);
    const got = await Promise.all(
      batch.map((s) => getJson(`${API}/${collection}?$limit=${PAGE}&$skip=${s}`)),
    );
    for (const g of got) pages.push(g.data);
    process.stdout.write(`\r  ${collection}: ${pages.length * PAGE}/${first.total}`);
  }
  process.stdout.write("\n");
  return pages.flat();
}

/** [id, name] pairs, sorted by id, skipping anything that resolves to nothing. */
function rows(records, nameOf) {
  const out = new Map();
  for (const r of records) {
    if (!Number.isInteger(r?.id) || r.id <= 0) continue;
    const name = text(nameOf(r)).slice(0, 200);
    if (name) out.set(r.id, name);
  }
  return [...out].sort((a, b) => a[0] - b[0]);
}

const states = rows(await all("spell-states"), (r) => r.name?.fr);
const effects = rows(await all("effects"), (r) => r.description?.fr);

// Only used to tell you the catalog is out of date; licence-clean and one call.
const gameVersion = await getJson("https://api.dofusdu.de/dofus3/v1/meta/version")
  .then((v) => v.version)
  .catch(() => null);

const catalog = { gameVersion, builtAt: new Date().toISOString().slice(0, 10), state: states, effect: effects };
await writeFile(new URL("../data/catalog.json", import.meta.url), JSON.stringify(catalog));

const find = (rs, id) => rs.find((r) => r[0] === id)?.[1];
console.log(`\n${states.length} states, ${effects.length} effects, game ${gameVersion}`);
console.log(`  state 7 = ${find(states, 7)}   state 6975 = ${find(states, 6975)}`);
console.log(`  effect 950 = ${find(effects, 950)}   effect 951 = ${find(effects, 951)}`);
