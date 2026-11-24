
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { runTrial } from './runner.ts';

const failParse = (n) => ({ error: 'error: parse ' + n });
function argsOf(argv) {
  let format = 'auto', check = false, strict = false, ended = false, seen = new Set(), pos = [];
  for (const arg of argv) {
    if (!ended && arg === '--') { ended = true; continue; }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check' || arg === '--strict') {
        if (seen.has(arg)) return null; seen.add(arg);
        if (arg === '--check') check = true; else strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seen.has('--format')) return null; seen.add('--format'); format = arg.slice(9);
        if (!['auto', 'unified', 'search-replace', 'v4a', 'json'].includes(format)) return null;
      } else return null;
    } else pos.push(arg);
  }
  return pos.length > 1 ? null : { format, check, strict, patch: pos[0] };
}
function patchLines(text) {
  const a = text.split('\n'); if (a[a.length - 1] === '') a.pop();
  return a.map((s) => s.endsWith('\r') ? s.slice(0, -1) : s);
}
function detectFormat(lines) {
  const first = lines.find((s) => s.trim() !== ''); if (first === undefined) return null;
  if (first.trim() === '*** Begin Patch') return 'v4a';
  if (first.trimStart()[0] === '[' || first.trimStart()[0] === '{') return 'json';
  if (lines.some((s) => s.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('diff --git ') || (lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ '))) return 'unified';
  return null;
}
function safePath(p) { return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => !s || s === '.' || s === '..'); }
function splitFile(text) {
  if (!text) return { lines: [], final: false, br: '\n' };
  const n = text.indexOf('\n'), br = n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n';
  const a = text.split(br), final = a[a.length - 1] === ''; if (final) a.pop();
  return { lines: a, final, br };
}
function joinFile(lines, final, br) { return lines.join(br) + (final && lines.length ? br : ''); }
function normTier(s, t) { return t === 1 ? s.replace(/[ \t]+$/, '') : t === 2 ? s.replace(/^[ \t]+|[ \t]+$/g, '') : s; }
function occurrences(hay, needle, tier, start = 0, eof = false) {
  const out = []; if (!needle.length) return out;
  for (let i = Math.max(0, start); i + needle.length <= hay.length; i++) {
    if (eof && i + needle.length !== hay.length) continue;
    if (needle.every((x, j) => normTier(hay[i + j], tier) === normTier(x, tier))) out.push(i);
  }
  return out;
}
function findTier(hay, needle, strict, start = 0, eof = false) {
  for (let t = 0; t <= (strict ? 0 : 2); t++) { const at = occurrences(hay, needle, t, start, eof); if (at.length) return { tier: t, at }; }
  return null;
}
function reindent(line, fileLine, oldLine) {
  if (!line.trim()) return line;
  const fp = (fileLine.match(/^[ \t]*/) || [''])[0], op = (oldLine.match(/^[ \t]*/) || [''])[0];
  return line.startsWith(op) ? fp + line.slice(op.length) : line;
}
function readTree() {
  const m = new Map(), root = process.cwd();
  const walk = (d) => { for (const name of readdirSync(d)) { const p = join(d, name), st = statSync(p); if (st.isDirectory()) walk(p); else if (st.isFile()) m.set(relative(root, p).split(sep).join('/'), readFileSync(p, 'utf8')); } };
  walk(root); return m;
}
function outError(message, code = 2) { process.stdout.write(message + '\n'); process.exitCode = code; }
function parseUnified(lines) {
  const sections = []; let sec = null;
  const finish = () => { if (sec) sections.push(sec); sec = null; };
  const start = (oldPath = null, newPath = null, gitOld = null, gitNew = null, line = 1) => ({ type: 'unified', oldPath, newPath, gitOld, gitNew, hunks: [], line, newFile: false, deletedFile: false, renameFrom: null, renameTo: null });
  const pathOf = (s) => { let p = s.slice(4).split('\t')[0].trim(); if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2); return p; };
  const git = /^diff --git a\/(.+) b\/(.+)$/;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i], gm = s.match(git), paired = s.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
    if (s.startsWith('diff --git ')) { if (!gm) return failParse(i + 1); finish(); sec = start(null, null, gm[1], gm[2], i + 1); continue; }
    if (paired && (!sec || sec.hunks.length)) { finish(); sec = start(pathOf(s), pathOf(lines[i + 1]), null, null, i + 1); i++; continue; }
    if (s.startsWith('@@')) {
      if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?:.*)?$/.test(s) || !sec) return failParse(i + 1);
      const a = Number(s.match(/^@@ -(\d+)/)[1]), h = { a, body: [], noNewline: false, line: i + 1 }; i++;
      for (; i < lines.length; i++) {
        const b = lines[i];
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && lines[i + 1]?.startsWith('+++ '))) { i--; break; }
        if (b === '' || b[0] === ' ' || b[0] === '+' || b[0] === '-') h.body.push({ kind: b === '' ? ' ' : b[0], text: b === '' ? '' : b.slice(1), empty: b === '' });
        else if (b.startsWith('\\')) { if (h.body.length) { const last = h.body[h.body.length - 1]; h.noNewline = last.kind === ' ' || last.kind === '+'; } }
        else { i--; break; }
      }
      while (h.body.length && h.body[h.body.length - 1].empty) h.body.pop();
      sec.hunks.push(h); continue;
    }
    if (sec && !sec.hunks.length) {
      if (s.startsWith('--- ')) { if (!lines[i + 1]?.startsWith('+++ ')) return failParse(i + 2); sec.oldPath = pathOf(s); sec.newPath = pathOf(lines[++i]); continue; }
      if (s.startsWith('rename from ')) { sec.renameFrom = s.slice(12); continue; }
      if (s.startsWith('rename to ')) { sec.renameTo = s.slice(10); continue; }
      if (s.startsWith('new file mode ')) sec.newFile = true;
      if (s.startsWith('deleted file mode ')) sec.deletedFile = true;
    }
  }
  finish();
  for (const x of sections) {
    if (x.oldPath === null) x.oldPath = x.renameFrom ?? x.gitOld;
    if (x.newPath === null) x.newPath = x.renameTo ?? x.gitNew;
    if (x.oldPath === '/dev/null') x.oldPath = null;
    if (x.newPath === '/dev/null') x.newPath = null;
  }
  return sections.length ? { edits: sections } : failParse(1);
}

function parseSearch(lines) {
  const edits = []; let from = 0, prior = null, fence = String.fromCharCode(96, 96, 96);
  const is = (i, s) => (lines[i] || '').replace(/[ \t]+$/, '') === s;
  for (let i = 0; i < lines.length; i++) if (is(i, '<<<<<<< SEARCH')) {
    let mid = i + 1; while (mid < lines.length && !is(mid, '=======')) mid++;
    let end = mid + 1; while (end < lines.length && !is(end, '>>>>>>> REPLACE')) end++;
    if (mid >= lines.length || end >= lines.length) return failParse(i + 1);
    let path = null;
    for (let k = i - 1; k >= from; k--) if (lines[k].trim() && !lines[k].trim().startsWith(fence)) { path = lines[k].trim(); break; }
    if (path === null) path = prior; if (path === null) return failParse(i + 1);
    edits.push({ type: 'search', path, old: lines.slice(i + 1, mid), next: lines.slice(mid + 1, end) }); prior = path; from = end + 1; i = end;
  }
  return edits.length ? { edits } : failParse(1);
}
function parseV4a(lines) {
  const non = []; for (let i = 0; i < lines.length; i++) if (lines[i].trim()) non.push(i);
  if (!non.length || lines[non[0]].trim() !== '*** Begin Patch') return failParse(non.length ? non[0] + 1 : 1);
  const stop = non[non.length - 1]; if (lines[stop].trim() !== '*** End Patch') return failParse(lines.length + 1);
  const edits = []; let i = non[0] + 1;
  while (i < stop) {
    if (!lines[i].trim()) { i++; continue; }
    const h = lines[i], line = i + 1, add = h.startsWith('*** Add File: '), del = h.startsWith('*** Delete File: '), upd = h.startsWith('*** Update File: ');
    if (!add && !del && !upd) return failParse(line);
    const e = { type: add ? 'add' : del ? 'delete' : 'update', path: h.slice(add ? 13 : 17).trim(), line, lines: [], move: null, chunks: [] }; i++;
    while (i < stop && !lines[i].startsWith('*** Add File: ') && !lines[i].startsWith('*** Delete File: ') && !lines[i].startsWith('*** Update File: ')) {
      const b = lines[i];
      if (add) { if (b === '' || b[0] === '+') e.lines.push(b === '' ? '' : b.slice(1)); else return failParse(i + 1); i++; continue; }
      if (del) { if (b.trim()) return failParse(i + 1); i++; continue; }
      if (!e.chunks.length && e.move === null && b.startsWith('*** Move to: ')) { e.move = b.slice(12).trim(); i++; continue; }
      if (b.startsWith('*** End of File')) { if (!e.chunks.length) e.chunks.push({ anchor: null, body: [], eof: true }); else e.chunks[e.chunks.length - 1].eof = true; i++; continue; }
      if (b.startsWith('@@')) { e.chunks.push({ anchor: b.slice(2).trim() || null, body: [], eof: false }); i++; continue; }
      if (!e.chunks.length) e.chunks.push({ anchor: null, body: [], eof: false });
      if (b === '' || b[0] === ' ' || b[0] === '+' || b[0] === '-') e.chunks[e.chunks.length - 1].body.push({ kind: b === '' ? ' ' : b[0], text: b === '' ? '' : b.slice(1) }); else return failParse(i + 1);
      i++;
    }
    while (e.type === 'add' && e.lines.length && e.lines[e.lines.length - 1] === '') e.lines.pop();
    if (e.type === 'update' && e.chunks.length) { const b = e.chunks[e.chunks.length - 1].body; while (b.length && b[b.length - 1].kind === ' ' && b[b.length - 1].text === '') b.pop(); }
    if (e.type === 'update' && !e.chunks.length && e.move === null) return failParse(line);
    edits.push(e);
  }
  return edits.length ? { edits } : failParse(1);
}
function validJsonEdit(x) {
  if (!x || Array.isArray(x) || typeof x !== 'object' || typeof x.path !== 'string' || typeof x.command !== 'string') return false;
  if (x.command === 'create') return typeof x.file_text === 'string';
  if (x.command === 'str_replace') return typeof x.old_str === 'string' && x.old_str.length > 0 && (x.new_str === undefined || typeof x.new_str === 'string');
  return x.command === 'insert' && Number.isInteger(x.insert_line) && typeof x.new_str === 'string';
}
function parseJson(lines, text) {
  const first = lines.findIndex((x) => x.trim()); if (first < 0) return failParse(1);
  if (lines[first].trimStart()[0] === '[') {
    try { const a = JSON.parse(text); if (!Array.isArray(a) || !a.length || !a.every(validJsonEdit)) return failParse(first + 1); return { edits: a.map((data) => ({ type: 'json', data })) }; }
    catch { return failParse(first + 1); }
  }
  const edits = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) {
    try { const data = JSON.parse(lines[i]); if (!validJsonEdit(data)) return failParse(i + 1); edits.push({ type: 'json', data }); }
    catch { return failParse(i + 1); }
  }
  return edits.length ? { edits } : failParse(1);
}
function applyUnified(e, tree, strict) {
  const create = e.oldPath === null || e.newFile, remove = e.newPath === null || e.deletedFile;
  const old = create ? null : e.oldPath, dest = remove ? null : (e.newPath || old);
  for (const p of [old, dest]) if (p !== null && !safePath(p)) return ['unsafe', p];
  if (create) {
    if (tree.has(dest)) return ['exists', dest]; let ls = [], final = true;
    for (const h of e.hunks) { const a = h.body.filter((b) => b.kind === '+').map((b) => b.text); ls.push(...a); if (a.length) final = !h.noNewline; }
    tree.set(dest, joinFile(ls, final, '\n')); return null;
  }
  if (!tree.has(old)) return ['missing', old]; if (remove) { tree.delete(old); return null; }
  if (dest !== old && tree.has(dest)) return ['exists', dest];
  const f = splitFile(tree.get(old)); let ls = f.lines.slice(), final = f.final, delta = 0;
  for (const h of e.hunks) {
    const o = h.body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text), n = h.body.filter((b) => b.kind === ' ' || b.kind === '+').map((b) => b.text);
    const found = o.length ? findTier(ls, o, strict) : null; if (o.length && !found) return ['no-match', old];
    let at;
    if (o.length) { const aim = h.a - 1 + delta; at = found.at.reduce((best, x) => Math.abs(x - aim) < Math.abs(best - aim) || (Math.abs(x - aim) === Math.abs(best - aim) && x < best) ? x : best); }
    else at = Math.min(ls.length, Math.max(0, h.a + delta));
    const original = ls.slice(), out = []; let oi = at;
    for (const b of h.body) { if (b.kind === ' ') out.push(original[oi++]); else if (b.kind === '-') oi++; else if (b.kind === '+') out.push(found && found.tier === 2 ? reindent(b.text, ls[at] || '', o[0] || '') : b.text); }
    const originalEnd = at + o.length === ls.length; ls.splice(at, o.length, ...out); delta += n.length - o.length;
    if (originalEnd) final = !h.noNewline;
  }
  const value = joinFile(ls, final, f.br); if (dest !== old) tree.delete(old); tree.set(dest, value); return null;
}
function applySearch(e, tree, strict) {
  if (!safePath(e.path)) return ['unsafe', e.path];
  if (!e.old.length) { if (tree.has(e.path)) return ['exists', e.path]; tree.set(e.path, joinFile(e.next, true, '\n')); return null; }
  if (!tree.has(e.path)) return ['missing', e.path];
  const f = splitFile(tree.get(e.path)), found = findTier(f.lines, e.old, strict);
  if (!found) return ['no-match', e.path]; if (found.at.length !== 1) return ['ambiguous', e.path];
  const at = found.at[0], next = found.tier === 2 ? e.next.map((line) => reindent(line, f.lines[at], e.old[0])) : e.next;
  tree.set(e.path, joinFile(f.lines.slice(0, at).concat(next, f.lines.slice(at + e.old.length)), f.final, f.br)); return null;
}
function applyV4a(e, tree, strict) {
  if (!safePath(e.path) || (e.move !== null && !safePath(e.move))) return ['unsafe', !safePath(e.path) ? e.path : e.move];
  if (e.type === 'add') { if (tree.has(e.path)) return ['exists', e.path]; tree.set(e.path, joinFile(e.lines, true, '\n')); return null; }
  if (!tree.has(e.path)) return ['missing', e.path]; if (e.type === 'delete') { tree.delete(e.path); return null; }
  if (e.move !== null && tree.has(e.move)) return ['exists', e.move];
  const f = splitFile(tree.get(e.path)); let ls = f.lines.slice(), cursor = 0;
  for (const c of e.chunks) {
    if (c.anchor) { const q = findTier(ls.slice(cursor), [c.anchor], strict); if (!q) return ['no-match', e.path]; cursor += q.at[0] + 1; }
    const o = c.body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text), n = c.body.filter((b) => b.kind === ' ' || b.kind === '+').map((b) => b.text);
    const found = o.length ? findTier(ls, o, strict, cursor, c.eof) : null; if (o.length && !found) return ['no-match', e.path];
    const at = o.length ? found.at[0] : (c.eof ? ls.length : Math.min(cursor, ls.length)), original = ls.slice(), out = []; let oi = at;
    for (const b of c.body) { if (b.kind === ' ') out.push(original[oi++]); else if (b.kind === '-') oi++; else if (b.kind === '+') out.push(found && found.tier === 2 ? reindent(b.text, ls[at] || '', o[0] || '') : b.text); }
    ls.splice(at, o.length, ...out); cursor = at + out.length;
  }
  const dest = e.move === null ? e.path : e.move; if (dest !== e.path) tree.delete(e.path); tree.set(dest, joinFile(ls, f.final, f.br)); return null;
}
function applyJson(e, tree) {
  const x = e.data, p = x.path; if (!safePath(p)) return ['unsafe', p];
  if (x.command === 'create') { if (tree.has(p)) return ['exists', p]; tree.set(p, x.file_text); return null; }
  if (!tree.has(p)) return ['missing', p]; const text = tree.get(p);
  if (x.command === 'str_replace') {
    const crlf = text.includes('\r\n'), src = crlf ? text.replace(/\r\n/g, '\n') : text, old = crlf ? x.old_str.replace(/\r\n/g, '\n') : x.old_str, neu = crlf ? (x.new_str || '').replace(/\r\n/g, '\n') : (x.new_str || '');
    let at = src.indexOf(old), count = 0, pos = 0; while (at >= 0) { count++; pos = at + 1; at = src.indexOf(old, pos); }
    if (count !== 1) return [count ? 'ambiguous' : 'no-match', p];
    const result = src.slice(0, pos - 1) + neu + src.slice(pos - 1 + old.length); tree.set(p, crlf ? result.replace(/\n/g, '\r\n') : result); return null;
  }
  const f = splitFile(text); if (x.insert_line < 0 || x.insert_line > f.lines.length) return ['no-match', p];
  const add = x.new_str === '' ? [] : patchLines(x.new_str); f.lines.splice(x.insert_line, 0, ...add); tree.set(p, joinFile(f.lines, f.final, f.br)); return null;
}
function applyEdit(e, tree, strict) {
  if (e.type === 'unified') return applyUnified(e, tree, strict);
  if (e.type === 'search') return applySearch(e, tree, strict);
  if (e.type === 'add' || e.type === 'delete' || e.type === 'update') return applyV4a(e, tree, strict);
  return applyJson(e, tree);
}
function byteSort(a, b) { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
function main() {
  if (process.env.MAKEFUN_ENV_URL) { runTrial(process.env.MAKEFUN_ENV_URL).catch((e) => { process.stderr.write(String(e) + '\n'); process.exitCode = 1; }); return; }
  const opts = argsOf(process.argv.slice(2)); if (!opts) return outError('error: usage');
  let patch; try { patch = opts.patch === undefined || opts.patch === '-' ? readFileSync(0, 'utf8') : readFileSync(opts.patch, 'utf8'); } catch { return outError('error: no-patch'); }
  const lines = patchLines(patch), format = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (!format) return outError('error: format');
  const parsed = format === 'unified' ? parseUnified(lines) : format === 'search-replace' ? parseSearch(lines) : format === 'v4a' ? parseV4a(lines) : parseJson(lines, patch);
  if (parsed.error) return outError(parsed.error);
  const before = readTree(), tree = new Map(before), errors = [], moves = [];
  for (const e of parsed.edits) {
    const staged = new Map(tree), result = applyEdit(e, staged, opts.strict);
    if (result) errors.push('error: ' + result[0] + ' ' + result[1]);
    else { tree.clear(); for (const [p, v] of staged) tree.set(p, v); if ((e.type === 'unified' && e.oldPath && e.newPath && e.oldPath !== e.newPath) || (e.type === 'update' && e.move)) moves.push([e.type === 'unified' ? e.oldPath : e.path, e.type === 'unified' ? e.newPath : e.move]); }
  }
  if (errors.length) { process.stdout.write(errors.join('\n') + '\nfailed: ' + errors.length + ' of ' + parsed.edits.length + ' edits\n'); process.exitCode = 1; return; }
  const changed = [];
  for (const p of new Set([...before.keys(), ...tree.keys()])) if (before.get(p) !== tree.get(p)) changed.push(p);
  const used = new Set(), renameLines = [];
  for (const [a, b] of moves) if (before.has(a) && !tree.has(a) && !before.has(b) && tree.has(b)) { used.add(a); used.add(b); renameLines.push({ key: b, text: 'R ' + a + ' -> ' + b }); }
  const rows = changed.filter((p) => !used.has(p)).map((p) => ({ key: p, text: (before.has(p) ? (tree.has(p) ? 'M ' : 'D ') : 'A ') + p })).concat(renameLines).sort((a, b) => byteSort(a.key, b.key));
  for (const r of rows) process.stdout.write(r.text + '\n');
  process.stdout.write('ok: ' + rows.length + (rows.length === 1 ? ' file\n' : ' files\n'));
  if (!opts.check) {
    for (const [p] of before) if (!tree.has(p)) unlinkSync(join(process.cwd(), ...p.split('/')));
    for (const [p, value] of tree) if (before.get(p) !== value) { const target = join(process.cwd(), ...p.split('/')); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, value, 'utf8'); }
  }
}
main();
