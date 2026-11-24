import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTrial } from './runner.ts';

type Format = 'auto' | 'unified' | 'search-replace' | 'v4a' | 'json';
type Options = { format: Format; check: boolean; strict: boolean; patch: string };
type FileText = { lines: string[]; eol: string; ending: boolean };
type Failure = { code: string; path: string };
type State = Map<string, string>;
class ParseFault extends Error { readonly line: number; constructor(line: number) { super(); this.line = line; } }
const formats = new Set<Format>(['auto', 'unified', 'search-replace', 'v4a', 'json']);

function options(argv: string[]): Options | null {
  let format: Format = 'auto', check = false, strict = false, ended = false;
  let seenFormat = false, seenCheck = false, seenStrict = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (!ended && arg === '--') { ended = true; continue; }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        if (seenFormat || !formats.has(arg.slice(9) as Format)) return null;
        seenFormat = true; format = arg.slice(9) as Format;
      } else if (arg === '--check') { if (seenCheck) return null; seenCheck = true; check = true; }
      else if (arg === '--strict') { if (seenStrict) return null; seenStrict = true; strict = true; }
      else return null;
    } else positional.push(arg);
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patch: positional[0] ?? '-' };
}
function patchLines(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}
function fileText(text: string): FileText {
  const at = text.indexOf('\n');
  const eol = at >= 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
  const ending = text.endsWith(eol);
  const lines = text === '' ? [] : text.split(eol);
  if (ending) lines.pop();
  return { lines, eol, ending };
}
function serialize(f: FileText): string { return f.lines.join(f.eol) + (f.ending && f.lines.length ? f.eol : ''); }
function safePath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((p) => p === '' || p === '.' || p === '..');
}
function tree(): State {
  const out: State = new Map();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name), st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.set(relative(process.cwd(), full).split(sep).join('/'), readFileSync(full, 'utf8'));
    }
  };
  walk(process.cwd()); return out;
}
function leading(line: string): string { return (line.match(/^[ \t]*/) ?? [''])[0]; }
function trimBoth(line: string): string { return line.replace(/^[ \t]+|[ \t]+$/g, ''); }
function occurrences(file: string[], old: string[], strict: boolean): { tier: number; positions: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const norm = (s: string): string => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/g, '') : trimBoth(s);
    const positions: number[] = [];
    for (let i = 0; i + old.length <= file.length; i++)
      if (old.every((line, j) => norm(line) === norm(file[i + j]))) positions.push(i);
    if (positions.length) return { tier, positions };
  }
  return null;
}
function reindent(lines: string[], oldFirst: string, fileFirst: string): string[] {
  const p = leading(oldFirst), f = leading(fileFirst);
  return lines.map((line) => line.trim() !== '' && line.startsWith(p) ? f + line.slice(p.length) : line);
}
function output(exit: number, lines: string[]): never {
  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
  process.exitCode = exit; throw new Error('MEND_DONE');
}
function parseError(line: number): never { throw new ParseFault(line); }
type Edit = ((state: State, strict: boolean) => Failure | null) & { move?: [string, string] };
type Op = { kind: ' ' | '+' | '-'; text: string };
type Hunk = { line: number; a: number; ops: Op[]; noFinal: boolean };
type Section = { old: string | null; next: string | null; add: boolean; del: boolean; hunks: Hunk[] };
function unprefix(path: string, side: 'a' | 'b'): string {
  path = path.split('\t')[0].trim(); return path.startsWith(side + '/') ? path.slice(2) : path;
}
function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = []; let i = 0;
  const start = (old: string | null, next: string | null): Section => { const s = { old, next, add: false, del: false, hunks: [] }; sections.push(s); return s; };
  while (i < lines.length) {
    let s: Section | undefined; const d = lines[i].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (lines[i].startsWith('diff --git ') && !d) parseError(i + 1);
    if (d) { s = start(unprefix(d[1], 'a'), unprefix(d[2], 'b')); i++; }
    else if (lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      s = start(unprefix(lines[i].slice(4), 'a'), unprefix(lines[i + 1].slice(4), 'b')); i += 2;
    } else { if (lines[i].startsWith('@@')) parseError(i + 1); i++; continue; }
    while (i < lines.length && !lines[i].startsWith('diff --git ') && !(s.hunks.length && lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ '))) {
      const line = lines[i];
      if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) { s.old = unprefix(line.slice(4), 'a'); s.next = unprefix(lines[i + 1].slice(4), 'b'); i += 2; continue; }
      if (line.startsWith('--- ')) parseError(i + 2);
      if (line.startsWith('new file mode ')) s.add = true;
      else if (line.startsWith('deleted file mode ')) s.del = true;
      else if (line.startsWith('rename from ')) s.old = line.slice(12).trim();
      else if (line.startsWith('rename to ')) s.next = line.slice(10).trim();
      if (line.startsWith('@@')) {
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@(?:.*)$/);
        if (!m) parseError(i + 1);
        const h: Hunk = { line: i + 1, a: Number(m[1]), ops: [], noFinal: false }; i++;
        while (i < lines.length && (lines[i] === '' || /^[ +\-\\]/.test(lines[i]))) {
          if (lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) break;
          const body = lines[i];
          if (body.startsWith('\\')) { h.noFinal = h.ops.length > 0; i++; continue; }
          h.noFinal = false;
          h.ops.push({ kind: body === '' ? ' ' : body[0] as Op['kind'], text: body === '' ? '' : body.slice(1) }); i++;
        }
        while (h.ops.length && h.ops[h.ops.length - 1].kind === ' ' && h.ops[h.ops.length - 1].text === '') h.ops.pop();
        s.hunks.push(h); continue;
      }
      i++;
    }
  }
  if (!sections.length) parseError(1);
  return sections.map((s) => unifiedEdit(s));
}
function unifiedEdit(s: Section): Edit {
  const edit: Edit = (state, strict) => {
    let old = s.old, next = s.next;
    if (old === '/dev/null') old = null; if (next === '/dev/null') next = null;
    if (old && !safePath(old)) return { code: 'unsafe', path: old };
    if (next && !safePath(next)) return { code: 'unsafe', path: next };
    const create = old === null || s.add, del = next === null || s.del;
    const src = old ?? next ?? ''; const dst = next ?? old ?? '';
    if (create && state.has(dst)) return { code: 'exists', path: dst };
    if (!create && !state.has(src)) return { code: 'missing', path: src };
    if (!del && src !== dst && state.has(dst)) return { code: 'exists', path: dst };
    if (del) { state.delete(src); return null; }
    let f = create ? { lines: [] as string[], eol: '\n', ending: true } : fileText(state.get(src)!);
    let delta = 0;
    for (const h of s.hunks) {
      const oldLines = h.ops.filter((o) => o.kind !== '+').map((o) => o.text);
      let pos: number; let tier = 0;
      if (oldLines.length) {
        const found = occurrences(f.lines, oldLines, strict); if (!found) return { code: 'no-match', path: src };
        tier = found.tier; const aim = h.a - 1 + delta;
        pos = found.positions.reduce((best, x) => Math.abs(x - aim) < Math.abs(best - aim) || (Math.abs(x - aim) === Math.abs(best - aim) && x < best) ? x : best);
      } else pos = Math.max(0, Math.min(f.lines.length, h.a + delta));
      const atEnd = oldLines.length ? pos + oldLines.length === f.lines.length : pos === f.lines.length; let oi = 0;
      const replacement = h.ops.flatMap((op) => {
        if (op.kind === '-') { oi++; return []; }
        if (op.kind === ' ') return [f.lines[pos + oi++]];
        let v = op.text; if (tier === 2 && oldLines.length) v = reindent([v], oldLines[0], f.lines[pos] ?? '')[0]; return [v];
      });
      f.lines.splice(pos, oldLines.length, ...replacement); delta += replacement.length - oldLines.length;
      if (atEnd) f.ending = !h.noFinal;
    }
    if (create && s.hunks.length) f.ending = !s.hunks[s.hunks.length - 1].noFinal;
    state.delete(src); state.set(dst, serialize(f)); return null;
  };
  if (!s.add && !s.del && s.old && s.next && s.old !== s.next) edit.move = [s.old, s.next];
  return edit;
}
function parseSearch(lines: string[]): Edit[] {
  const edits: Edit[] = []; let previous: string | null = null, i = 0, previousEnd = 0;
  while (i < lines.length) {
    if (lines[i].replace(/[ \t]+$/g, '') !== '<<<<<<< SEARCH') { i++; continue; }
    const at = i, before = i - 1; let path: string | null = null;
    for (let j = before; j >= previousEnd; j--) {
      const v = lines[j].trim(); if (v && !v.startsWith('```')) { path = v; break; }
    }
    path ??= previous; if (!path) parseError(at + 1); previous = path;
    let mid = i + 1; while (mid < lines.length && lines[mid].replace(/[ \t]+$/g, '') !== '=======') mid++;
    let end = mid + 1; while (end < lines.length && lines[end].replace(/[ \t]+$/g, '') !== '>>>>>>> REPLACE') end++;
    if (mid >= lines.length || end >= lines.length) parseError(at + 1);
    const old = lines.slice(i + 1, mid), fresh = lines.slice(mid + 1, end); edits.push(searchEdit(path, old, fresh)); i = end + 1; previousEnd = i;
  }
  if (!edits.length) parseError(1); return edits;
}
function searchEdit(path: string, old: string[], fresh: string[]): Edit {
  return (state, strict) => {
    if (!safePath(path)) return { code: 'unsafe', path };
    if (!old.length) { if (state.has(path)) return { code: 'exists', path }; state.set(path, fresh.join('\n') + '\n'); return null; }
    if (!state.has(path)) return { code: 'missing', path };
    const f = fileText(state.get(path)!), found = occurrences(f.lines, old, strict);
    if (!found) return { code: 'no-match', path }; if (found.positions.length !== 1) return { code: 'ambiguous', path };
    const pos = found.positions[0], replacement = found.tier === 2 ? reindent(fresh, old[0], f.lines[pos]) : fresh;
    f.lines.splice(pos, old.length, ...replacement); state.set(path, serialize(f)); return null;
  };
}
type Chunk = { anchor: string; eof: boolean; ops: Op[] };
function parseV4a(lines: string[]): Edit[] {
  const nonblank = lines.map((s, i) => s.trim() ? i : -1).filter((i) => i >= 0);
  if (!nonblank.length || lines[nonblank[0]].trim() !== '*** Begin Patch') parseError(nonblank[0] === undefined ? 1 : nonblank[0] + 1);
  if (lines[nonblank[nonblank.length - 1]].trim() !== '*** End Patch') parseError(lines.length + 1);
  const edits: Edit[] = []; let i = nonblank[0] + 1, stop = nonblank[nonblank.length - 1];
  while (i < stop) {
    if (!lines[i].trim()) { i++; continue; }
    const m = lines[i].match(/^\*\*\* (Add|Delete|Update) File: (.*)$/); if (!m) parseError(i + 1);
    const kind = m[1], path = m[2].trim(), at = i++; const body: { line: string; no: number }[] = [];
    while (i < stop && !/^\*\*\* (?:Add|Delete|Update) File: /.test(lines[i])) body.push({ line: lines[i], no: ++i });
    while (body.length && !body[body.length - 1].line.trim()) body.pop();
    if (kind === 'Add') {
      const content: string[] = []; for (const b of body) { if (b.line === '') content.push(''); else if (b.line.startsWith('+')) content.push(b.line.slice(1)); else parseError(b.no); }
      edits.push((state) => { if (!safePath(path)) return { code: 'unsafe', path }; if (state.has(path)) return { code: 'exists', path }; state.set(path, content.join('\n') + '\n'); return null; });
    } else if (kind === 'Delete') {
      if (body.length) parseError(body[0].no);
      edits.push((state) => { if (!safePath(path)) return { code: 'unsafe', path }; if (!state.has(path)) return { code: 'missing', path }; state.delete(path); return null; });
    } else {
      let move: string | null = null, j = 0;
      if (body[0]?.line.startsWith('*** Move to: ')) { move = body[0].line.slice(13).trim(); j++; }
      const chunks: Chunk[] = []; let current: Chunk | null = null;
      for (; j < body.length; j++) {
        const b = body[j], a = b.line.match(/^@@(.*)$/);
        if (a) { if (current) chunks.push(current); current = { anchor: a[1].trim(), eof: false, ops: [] }; continue; }
        if (b.line === '*** End of File') { if (!current) current = { anchor: '', eof: true, ops: [] }; current.eof = true; chunks.push(current); current = null; continue; }
        if (!current) current = { anchor: '', eof: false, ops: [] };
        if (b.line === '') current.ops.push({ kind: ' ', text: '' });
        else if (/^[ +\-]/.test(b.line)) current.ops.push({ kind: b.line[0] as Op['kind'], text: b.line.slice(1) });
        else parseError(b.no);
      }
      if (current) chunks.push(current); if (!chunks.length && move === null) parseError(at + 1);
      const edit: Edit = (state, strict) => v4aUpdate(state, strict, path, move, chunks);
      if (move !== null) edit.move = [path, move]; edits.push(edit);
    }
  }
  return edits;
}
function v4aUpdate(state: State, strict: boolean, path: string, move: string | null, chunks: Chunk[]): Failure | null {
  if (!safePath(path)) return { code: 'unsafe', path }; if (move !== null && !safePath(move)) return { code: 'unsafe', path: move };
  if (!state.has(path)) return { code: 'missing', path }; if (move !== null && state.has(move)) return { code: 'exists', path: move };
  const f = fileText(state.get(path)!); let cursor = 0;
  for (const c of chunks) {
    if (c.anchor) { const found = occurrences(f.lines.slice(cursor), [c.anchor], strict); if (!found) return { code: 'no-match', path }; cursor += found.positions[0] + 1; }
    const old = c.ops.filter((o) => o.kind !== '+').map((o) => o.text);
    let tier = 0, pos = cursor;
    if (old.length) {
      let found: { tier: number; positions: number[] } | null = null;
      for (let t = 0; t <= (strict ? 0 : 2); t++) {
        const norm = (x: string): string => t === 0 ? x : t === 1 ? x.replace(/[ \t]+$/g, '') : trimBoth(x); const positions: number[] = [];
        for (let x = cursor; x + old.length <= f.lines.length; x++) if (old.every((v, q) => norm(v) === norm(f.lines[x + q])) && (!c.eof || x + old.length === f.lines.length)) positions.push(x);
        if (positions.length) { found = { tier: t, positions }; break; }
      }
      if (!found) return { code: 'no-match', path }; tier = found.tier; pos = found.positions[0];
    } else if (c.eof) pos = f.lines.length;
    let oi = 0; const replacement = c.ops.flatMap((o) => { if (o.kind === '-') { oi++; return []; } if (o.kind === ' ') return [f.lines[pos + oi++]]; return [tier === 2 && old.length ? reindent([o.text], old[0], f.lines[pos])[0] : o.text]; });
    f.lines.splice(pos, old.length, ...replacement); cursor = pos + replacement.length;
  }
  state.delete(path); state.set(move ?? path, serialize(f)); return null;
}
function jsonEdits(text: string): Edit[] {
  const first = text.search(/\S/), array = first >= 0 && text[first] === '['; let objects: any[] = [], objectLines: number[] = [];
  if (array) { try { const v = JSON.parse(text); if (!Array.isArray(v)) throw 0; objects = v; } catch { parseError(text.slice(0, first).split('\n').length); } }
  else { const lines = text.split('\n'); for (let i = 0; i < lines.length; i++) if (lines[i].trim()) { try { objects.push(JSON.parse(lines[i])); objectLines.push(i + 1); } catch { parseError(i + 1); } } }
  if (array) objectLines = objects.map(() => text.slice(0, first).split('\n').length);
  if (!objects.length) parseError(array ? text.slice(0, first).split('\n').length : 1);
  return objects.map((o, i) => {
    const bad = (): never => parseError(objectLines[i]);
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.path !== 'string' || typeof o.command !== 'string') bad();
    const path = o.path;
    if (o.command === 'create') { if (typeof o.file_text !== 'string') bad(); return (s: State) => { if (!safePath(path)) return { code: 'unsafe', path }; if (s.has(path)) return { code: 'exists', path }; s.set(path, o.file_text); return null; }; }
    if (o.command === 'str_replace') { if (typeof o.old_str !== 'string' || !o.old_str || o.new_str !== undefined && typeof o.new_str !== 'string') bad(); const fresh = o.new_str ?? ''; return (s: State) => { if (!safePath(path)) return { code: 'unsafe', path }; if (!s.has(path)) return { code: 'missing', path }; const raw = s.get(path)!, crlf = raw.includes('\r\n'), src = raw.replace(/\r\n/g, '\n'), old = o.old_str.replace(/\r\n/g, '\n'), neu = fresh.replace(/\r\n/g, '\n'); let count = 0, at = -1; for (let x = 0; (x = src.indexOf(old, x)) >= 0; x++) { count++; at = x; } if (!count) return { code: 'no-match', path }; if (count > 1) return { code: 'ambiguous', path }; const out = src.slice(0, at) + neu + src.slice(at + old.length); s.set(path, crlf ? out.replace(/\n/g, '\r\n') : out); return null; }; }
    if (o.command === 'insert') { if (!Number.isInteger(o.insert_line) || typeof o.new_str !== 'string') bad(); return (s: State) => { if (!safePath(path)) return { code: 'unsafe', path }; if (!s.has(path)) return { code: 'missing', path }; const f = fileText(s.get(path)!); if (o.insert_line < 0 || o.insert_line > f.lines.length) return { code: 'no-match', path }; const add = patchLines(o.new_str); f.lines.splice(o.insert_line, 0, ...add); s.set(path, serialize(f)); return null; }; }
    bad();
  });
}
function detect(text: string, requested: Format): Format {
  if (requested !== 'auto') return requested; const lines = patchLines(text), first = lines.find((x) => x.trim());
  if (first?.trim() === '*** Begin Patch') return 'v4a'; if (first && /^[\[{]/.test(first.trimStart())) return 'json';
  if (lines.some((x) => x.replace(/[ \t]+$/g, '') === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((x, i) => x.startsWith('diff --git ') || x.startsWith('--- ') && lines[i + 1]?.startsWith('+++ '))) return 'unified';
  return 'auto';
}
function main(): void {
  if (process.env.MAKEFUN_ENV_URL) { runTrial(process.env.MAKEFUN_ENV_URL).catch((e) => { process.stderr.write(String(e) + '\n'); process.exitCode = 1; }); return; }
  try {
    const opt = options(process.argv.slice(2)); if (!opt) output(2, ['error: usage']);
    let text: string; try { text = opt.patch === '-' ? readFileSync(0, 'utf8') : readFileSync(opt.patch, 'utf8'); } catch { output(2, ['error: no-patch']); }
    const format = detect(text!, opt.format); if (format === 'auto') output(2, ['error: format']);
    const lines = patchLines(text!); let edits: Edit[];
    try { edits = format === 'unified' ? parseUnified(lines) : format === 'search-replace' ? parseSearch(lines) : format === 'v4a' ? parseV4a(lines) : jsonEdits(text!); }
    catch (e) { if (e instanceof ParseFault) output(2, [`error: parse ${e.line}`]); throw e; }
    const before = tree(); let state = new Map(before), failures: Failure[] = [], moves: [string, string][] = [];
    for (const edit of edits) { const trial = new Map(state), failure = edit(trial, opt.strict); if (failure) failures.push(failure); else { state = trial; if (edit.move) moves.push(edit.move); } }
    if (failures.length) output(1, [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`]);
    const changed = new Set([...before.keys(), ...state.keys()]);
    const rename = new Map<string, string>(); for (const [a, b] of moves) if (before.has(a) && !state.has(a) && !before.has(b) && state.has(b)) rename.set(b, a);
    const rows: { key: string; line: string }[] = [];
    for (const p of changed) { if (before.get(p) === state.get(p) || [...rename.values()].includes(p)) continue; if (rename.has(p)) rows.push({ key: p, line: `R ${rename.get(p)} -> ${p}` }); else rows.push({ key: p, line: !before.has(p) ? `A ${p}` : !state.has(p) ? `D ${p}` : `M ${p}` }); }
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    if (!opt.check) { for (const p of before.keys()) if (!state.has(p)) rmSync(p, { force: true }); for (const [p, value] of state) if (before.get(p) !== value) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value); } }
    output(0, [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`]);
  } catch (e) { if (e instanceof Error && e.message === 'MEND_DONE') return; process.stderr.write(String(e) + '\n'); process.exitCode = 2; }
}
main();
