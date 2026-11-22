// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- SPEC.md section 5: matching lines at three tiers ----

type Marker = 'ctx' | 'old' | 'new' | 'bs';
interface BLine {
  m: Marker;
  text: string;
  raw: string;
}
interface Hunk {
  A: number;
  body: BLine[];
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const atTier = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s));
const tierList = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

function occAt(file: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const k = old.length;
  if (k === 0) return out;
  outer: for (let i = from; i + k <= file.length; i += 1) {
    for (let j = 0; j < k; j += 1) if (atTier(file[i + j]!, tier) !== atTier(old[j]!, tier)) continue outer;
    out.push(i);
  }
  return out;
}

function firstTier(file: string[], old: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  for (const tier of tierList(strict)) {
    const ps = occAt(file, old, tier, from);
    if (ps.length > 0) return { tier, positions: ps };
  }
  return null;
}

function firstTierEof(file: string[], old: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  for (const tier of tierList(strict)) {
    const ps = occAt(file, old, tier, from).filter((p) => p + old.length === file.length);
    if (ps.length > 0) return { tier, positions: ps };
  }
  return null;
}

function firstAnchor(file: string[], anchor: string, from: number, strict: boolean): number | null {
  for (const tier of tierList(strict)) {
    for (let i = from; i < file.length; i += 1) if (atTier(file[i]!, tier) === atTier(anchor, tier)) return i;
  }
  return null;
}

interface NLine {
  ctx: boolean;
  text: string;
  oIdx: number;
}
interface ON {
  O: string[];
  N: NLine[];
  oLead: string;
  lastNNoNl: boolean;
}

/** O (context and old lines) and N (context and new lines) of a hunk or chunk body, in body order. */
function computeON(body: BLine[]): ON {
  const O: string[] = [];
  const N: NLine[] = [];
  let lastN = -1;
  for (let i = 0; i < body.length; i += 1) {
    const e = body[i]!;
    if (e.m === 'ctx') {
      O.push(e.text);
      N.push({ ctx: true, text: e.text, oIdx: O.length - 1 });
      lastN = i;
    } else if (e.m === 'old') {
      O.push(e.text);
    } else if (e.m === 'new') {
      N.push({ ctx: false, text: e.text, oIdx: -1 });
      lastN = i;
    }
  }
  const lastNNoNl = lastN >= 0 && lastN + 1 < body.length && body[lastN + 1]!.m === 'bs';
  return { O, N, oLead: O.length > 0 ? lead(O[0]!) : '', lastNNoNl };
}

/** Build the result lines for N, using the file's own matched lines for context lines. */
function buildResult(on: ON, tier: number, strict: boolean, fileLines: string[], pos: number): string[] {
  const F = pos < fileLines.length ? lead(fileLines[pos]!) : '';
  const out: string[] = [];
  for (const e of on.N) {
    if (e.ctx) {
      out.push(fileLines[pos + e.oIdx]!);
      continue;
    }
    let text = e.text;
    if (tier === 2 && !strict && text !== '' && text.trim() !== '' && text.startsWith(on.oLead)) text = F + text.slice(on.oLead.length);
    out.push(text);
  }
  return out;
}

// ---- file states: lines, the break between them, and the final break ----

interface FState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function breakOf(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

function splitFile(text: string): FState {
  const br = breakOf(text);
  if (text === '') return { lines: [], br, finalBreak: false };
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(st: FState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
}

const mustExist = (tree: Tree, p: string): string => {
  if (!safe(p)) throw new Fail('unsafe', p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
};
const mustAbsent = (tree: Tree, p: string): void => {
  if (!safe(p)) throw new Fail('unsafe', p);
  if (tree.get(p) !== null) throw new Fail('exists', p);
};

// ---- SPEC.md section 6: unified diffs ----

function uPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  oldNull: boolean;
  newNull: boolean;
  hasPaths: boolean;
  renameOld: string | null;
  renameNew: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

const newUSection = (): USection => ({
  gitOld: null,
  gitNew: null,
  oldPath: null,
  newPath: null,
  oldNull: false,
  newNull: false,
  hasPaths: false,
  renameOld: null,
  renameNew: null,
  createFlag: false,
  deleteFlag: false,
  hunks: [],
});

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const st = splitFile(text);
  let d = 0;
  for (const hunk of hunks) {
    const on = computeON(hunk.body);
    let pos: number;
    let tier = 0;
    if (on.O.length === 0) {
      pos = Math.max(0, Math.min(hunk.A + d, st.lines.length));
    } else {
      const found = firstTier(st.lines, on.O, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.A - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      pos = best;
      tier = found.tier;
    }
    const reachesEnd = pos + on.O.length === st.lines.length;
    if (reachesEnd) st.finalBreak = !on.lastNNoNl;
    const result = buildResult(on, tier, strict, st.lines, pos);
    st.lines.splice(pos, on.O.length, ...result);
    d += on.N.length - on.O.length;
  }
  return joinFile(st);
}

function createdFromHunks(hunks: Hunk[]): string {
  const flat: BLine[] = [];
  for (const h of hunks) for (const e of h.body) flat.push(e);
  const plus: string[] = [];
  let lastNew = -1;
  for (let i = 0; i < flat.length; i += 1) {
    if (flat[i]!.m === 'new') {
      plus.push(flat[i]!.text);
      lastNew = i;
    }
  }
  const noNl = lastNew >= 0 && lastNew + 1 < flat.length && flat[lastNew + 1]!.m === 'bs';
  if (plus.length === 0) return '';
  return plus.join('\n') + (noNl ? '' : '\n');
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const secs: USection[] = [];
  let cur: USection | null = null;
  let headerDone = false;
  let i = 0;
  const pushNew = (): USection => {
    const s = newUSection();
    secs.push(s);
    cur = s;
    headerDone = false;
    return s;
  };
  while (i < n) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = pushNew();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      let s: USection;
      if (cur === null || headerDone || cur.hasPaths) s = pushNew();
      else s = cur;
      s.oldPath = uPath(line);
      s.newPath = uPath(next);
      if (s.oldPath === null) s.oldNull = true;
      if (s.newPath === null) s.newNull = true;
      s.hasPaths = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BLine[] = [];
      i += 1;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '') body.push({ m: 'ctx', text: '', raw: '' });
        else if (b.startsWith(' ')) body.push({ m: 'ctx', text: b.slice(1), raw: b });
        else if (b.startsWith('-')) body.push({ m: 'old', text: b.slice(1), raw: b });
        else if (b.startsWith('+')) body.push({ m: 'new', text: b.slice(1), raw: b });
        else if (b.startsWith('\\')) body.push({ m: 'bs', text: b.slice(1), raw: b });
        else break;
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.m === 'ctx' && body[body.length - 1]!.raw === '') body.pop();
      cur.hunks.push({ A: parseInt(hm[1]!, 10), body });
      headerDone = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !headerDone) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.createFlag = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deleteFlag = true;
      }
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of secs) {
    let oldP: string | null;
    let newP: string | null;
    if (s.hasPaths) {
      oldP = s.oldPath;
      newP = s.newPath;
    } else {
      oldP = s.renameOld ?? s.gitOld;
      newP = s.renameNew ?? s.gitNew;
    }
    const isCreate = s.oldNull || s.createFlag;
    const isDelete = s.newNull || s.deleteFlag;
    if (isCreate) {
      const p = newP;
      if (p === null) continue;
      const hunks = s.hunks;
      edits.push((tree) => {
        mustAbsent(tree, p);
        tree.now.set(p, createdFromHunks(hunks));
      });
    } else if (isDelete) {
      const p = oldP;
      if (p === null) continue;
      edits.push((tree) => {
        mustExist(tree, p);
        tree.now.set(p, null);
      });
    } else if (oldP !== null && newP !== null && oldP !== newP) {
      const o = oldP;
      const w = newP;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(o)) throw new Fail('unsafe', o);
        if (!safe(w)) throw new Fail('unsafe', w);
        const text = mustExist(tree, o);
        mustAbsent(tree, w);
        const out = applyHunks(text, hunks, strict, o);
        tree.now.set(o, null);
        tree.now.set(w, out);
        tree.moves.push({ old: o, new: w });
      });
    } else {
      const p = newP ?? oldP;
      if (p === null) continue;
      const hunks = s.hunks;
      edits.push((tree) => {
        const text = mustExist(tree, p);
        tree.now.set(p, applyHunks(text, hunks, strict, p));
      });
    }
  }
  return edits;
}

// ---- SPEC.md section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const text = mustExist(tree, path);
    const st = splitFile(text);
    const found = firstTier(st.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const tier = found.tier;
    const F = lead(st.lines[pos]!);
    const P = lead(oldLines[0]!);
    const on: ON = { O: oldLines, N: newLines.map((t) => ({ ctx: false, text: t, oIdx: -1 })), oLead: P, lastNNoNl: false };
    on.N = newLines.map((t) => {
      let tx = t;
      if (tier === 2 && !strict && tx !== '' && tx.trim() !== '' && tx.startsWith(P)) tx = F + tx.slice(P.length);
      return { ctx: false, text: tx, oIdx: -1 };
    });
    st.lines.splice(pos, oldLines.length, ...on.N.map((e) => e.text));
    tree.now.set(path, joinFile(st));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const isSearch = (s: string): boolean => stripTrail(s) === '<<<<<<< SEARCH';
  const isSep = (s: string): boolean => stripTrail(s) === '=======';
  const isRep = (s: string): boolean => stripTrail(s) === '>>>>>>> REPLACE';
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (!isSearch(lines[i]!)) {
      i += 1;
      continue;
    }
    const si = i;
    let path: string | null = null;
    for (let j = si - 1; j >= prevEnd; j -= 1) {
      const s = lines[j]!;
      if (blank(s)) continue;
      const t = s.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${si + 1}`);
    let eq = -1;
    for (let j = si + 1; j < n; j += 1) if (isSep(lines[j]!)) { eq = j; break; }
    if (eq < 0) throw new Exit2(`error: parse ${si + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) if (isRep(lines[j]!)) { rep = j; break; }
    if (rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    edits.push(srEdit(path, lines.slice(si + 1, eq), lines.slice(eq + 1, rep), strict));
    prevEnd = rep + 1;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

// ---- SPEC.md section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i += 1) if (!blank(lines[i]!)) { first = i; break; }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) if (!blank(lines[i]!)) { last = i; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const content: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('+')) content.push(b.slice(1));
        else if (b === '') content.push('');
        else break;
        i += 1;
      }
      while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
      edits.push((tree) => {
        mustAbsent(tree, path);
        tree.now.set(path, content.length === 0 ? '' : `${content.join('\n')}\n`);
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      edits.push((tree) => {
        mustExist(tree, path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let closed = false;
      while (i < last) {
        const b = lines[i]!;
        if (b.trim() === '*** End of File') {
          if (chunks.length > 0) chunks[chunks.length - 1]!.eof = true;
          closed = true;
          i += 1;
          continue;
        }
        if (b.startsWith('*** ')) break;
        if (b.startsWith('@@')) {
          const anchor = b.slice(2).trim();
          chunks.push({ anchor: anchor === '' ? null : anchor, eof: false, body: [] });
          closed = false;
          i += 1;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (chunks.length === 0 || closed) {
            chunks.push({ anchor: null, eof: false, body: [] });
            closed = false;
          }
          const c = chunks[chunks.length - 1]!;
          if (b === '') c.body.push({ m: 'ctx', text: '', raw: '' });
          else if (b.startsWith(' ')) c.body.push({ m: 'ctx', text: b.slice(1), raw: b });
          else if (b.startsWith('-')) c.body.push({ m: 'old', text: b.slice(1), raw: b });
          else c.body.push({ m: 'new', text: b.slice(1), raw: b });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lastBody = chunks[chunks.length - 1]!.body;
        while (lastBody.length > 0 && blank(lastBody[lastBody.length - 1]!.raw)) lastBody.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const movePath = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (movePath !== null && !safe(movePath)) throw new Fail('unsafe', movePath);
        const text = tree.get(path);
        if (text === null) throw new Fail('missing', path);
        if (movePath !== null && tree.get(movePath) !== null) throw new Fail('exists', movePath);
        const st = splitFile(text);
        let cursor = 0;
        for (const c of chunks) {
          if (c.anchor !== null) {
            const ai = firstAnchor(st.lines, c.anchor, cursor, strict);
            if (ai === null) throw new Fail('no-match', path);
            cursor = ai + 1;
          }
          const on = computeON(c.body);
          let pos: number;
          let tier = 0;
          if (on.O.length === 0) {
            pos = c.eof ? st.lines.length : cursor;
          } else {
            const found = c.eof ? firstTierEof(st.lines, on.O, cursor, strict) : firstTier(st.lines, on.O, cursor, strict);
            if (found === null) throw new Fail('no-match', path);
            pos = found.positions[0]!;
            tier = found.tier;
          }
          const result = buildResult(on, tier, strict, st.lines, pos);
          st.lines.splice(pos, on.O.length, ...result);
          cursor = pos + result.length;
        }
        const out = joinFile(st);
        if (movePath !== null) {
          tree.now.set(path, null);
          tree.now.set(movePath, out);
          tree.moves.push({ old: path, new: movePath });
        } else {
          tree.now.set(path, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveOf = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      moveOf.set(m.new, m.old);
    }
  }
  const cmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  type Row = { sort: string; line: string };
  const rows: Row[] = [];
  const movedOut = new Set(moveOf.values());
  for (const p of tree.now.keys()) {
    if (movedOut.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const src = moveOf.get(p);
    if (src !== undefined) rows.push({ sort: p, line: `R ${src} -> ${p}` });
    else rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => cmp(a.sort, b.sort));
  if (!check) {
    for (const r of rows) {
      const p = r.sort;
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    for (const p of movedOut) rmSync(p, { force: true });
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
