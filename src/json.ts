/** JSON parsing that does not destroy Dofus fighter ids.
 *
 *  Monsters have NEGATIVE fighter ids, and the sniffer decodes every integer as
 *  unsigned because protobuf does not record signedness - so -1 arrives as
 *  18446744073709551615. That is larger than Number.MAX_SAFE_INTEGER, and
 *  JSON.parse rounds it to the nearest double: 2^64. So does -21, and -2, and
 *  every other mob. They all collapse onto the SAME number, and the conversion
 *  docs/API.md suggests then yields 0 for all of them.
 *
 *  Measured, not assumed:
 *    JSON.parse('{"a":18446744073709551615,"b":18446744073709551595}')
 *      -> a === b === 18446744073709552000
 *
 *  So big integers have to survive the parse. They are rewritten to strings
 *  first and converted on read, which keeps every digit.
 */

/** Digits at which a decimal integer can exceed 2^53 and stop being exact. */
const BIG = 16;

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\r" || c === "\n";

/** JSON.parse, but integer literals of 16+ digits come back as strings. */
export function parseKeepingBigInts(text: string): unknown {
  let out = "";
  let last = 0;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }

    // A number only ever starts right after one of these, which rules out the
    // digits inside a key and inside an already-quoted value.
    if (ch !== "-" && !isDigit(ch)) continue;
    let k = i - 1;
    while (k >= 0 && isSpace(text[k])) k--;
    const before = k >= 0 ? text[k] : undefined;
    if (before !== ":" && before !== "," && before !== "[") continue;

    let j = i;
    if (text[j] === "-") j++;
    const start = j;
    while (isDigit(text[j])) j++;
    const digits = j - start;
    // A fraction or an exponent is a real double; leave it alone.
    if (text[j] === "." || text[j] === "e" || text[j] === "E") { i = j; continue; }
    if (digits >= BIG) {
      out += text.slice(last, i) + '"' + text.slice(i, j) + '"';
      last = j;
    }
    i = j - 1;
  }
  return JSON.parse(out + text.slice(last));
}

/** A fighter id as a signed number. Mobs are negative, players are not.
 *  Accepts the string form parseKeepingBigInts produces, or a plain number. */
export function signedId(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) return null;
  const n = BigInt(v);
  return Number(n >= 1n << 63n ? n - (1n << 64n) : n);
}

/** A plain integer field (effect id, round, cell). Signed the same way, because
 *  `turns` arrives as 2^64-1 to mean "until removed". */
export const int = signedId;

/** Field values repeat when protobuf repeats them; normalise to an array. */
export function list(v: unknown): unknown[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

/** One decoded node: the sniffer maps each protobuf field number to an ARRAY of
 *  the values seen for it, because any field may repeat. */
type Node = Record<string, unknown[]>;

const first = (node: unknown, key: string): unknown => {
  const got = (node as Node | undefined)?.[key];
  return Array.isArray(got) ? got[0] : got;
};

/** Longest shared dotted prefix of some field paths, as path segments. */
function commonPrefix(paths: string[]): string[] {
  const split = paths.map((p) => p.split("."));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const seg = split[0]?.[i];
    if (seg === undefined || !split.every((p) => p[i] === seg)) return out;
    out.push(seg);
  }
}

/** Read a repeated group as records, one per entry, instead of as parallel arrays.
 *
 *  The API projects every field path independently over the decoded tree, so a
 *  message that repeats a group (one entry per fighter) arrives as several
 *  separate arrays. **Protobuf omits zero values**, so those arrays are not
 *  guaranteed to be the same length: a fighter whose team is 0 simply has no
 *  team entry, every later value shifts up by one, and zipping by index pairs
 *  one fighter's id with the next fighter's team.
 *
 *  Walking the decoded tree per entry cannot shift: a field missing from an
 *  entry is null for THAT entry and nothing else moves. The paths still come
 *  from field_paths, so nothing here is keyed on a build-specific number.
 *
 *  Returns null when the message does not carry what is needed, so the caller
 *  can fall back.
 */
export function entries(
  decoded: unknown,
  fieldPaths: Record<string, string> | undefined,
  names: readonly string[],
): Record<string, unknown>[] | null {
  if (!decoded || !fieldPaths) return null;
  const paths = names.map((n) => fieldPaths[n]);
  if (paths.some((p) => !p)) return null;

  const prefix = commonPrefix(paths as string[]);
  if (!prefix.length) return null;

  // Descend to the repeated node. Everything above the repeat is single.
  let node: unknown = decoded;
  for (let i = 0; i < prefix.length - 1; i++) {
    node = first(node, prefix[i]!);
    if (node === undefined || node === null) return null;
  }
  const repeated = (node as Node | undefined)?.[prefix[prefix.length - 1]!];
  if (!Array.isArray(repeated)) return null;

  const rest = (paths as string[]).map((p) => p.split(".").slice(prefix.length));
  return repeated.map((entry) => {
    const record: Record<string, unknown> = {};
    names.forEach((name, i) => {
      let value: unknown = entry;
      for (const seg of rest[i]!) {
        value = first(value, seg);
        if (value === undefined || value === null) break;
      }
      record[name] = value ?? null;
    });
    return record;
  });
}
