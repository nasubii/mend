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
  readonly moves: { from: string; to: string }[] = [];
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

// ---------------------------------------------------------------------------
// Lines, tiers and matching (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

/** A file split into its lines, its own line break, and whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; finalBreak: boolean } {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');

function tierOf(tier: number, s: string): string {
  return tier === 0 ? s : tier === 1 ? rstripWs(s) : stripWs(s);
}

/**
 * One line of a replacement: a context line (in both the old and the new lines), a deleted
 * line (old only) or an added line (new only). `noNl` is set when a `\` line follows it in a
 * unified body; `fromEmpty` marks a context line that came from an empty patch line.
 */
interface Entry {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNl: boolean;
  fromEmpty?: boolean;
}

const entry = (kind: Entry['kind'], text: string): Entry => ({ kind, text, noNl: false });

/** The old lines of an entry list: its context and deleted lines, in order. */
const oldOf = (entries: Entry[]): string[] => entries.filter((e) => e.kind !== 'add').map((e) => e.text);

/** Occurrences of O in `lines` at or after `from`, at the first tier that has one. */
function findPositions(
  lines: string[],
  O: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const o = O.map((s) => tierOf(tier, s));
    const at: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      if (eofOnly && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (tierOf(tier, lines[i + j]!) !== o[j]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/**
 * Splice a replacement into `lines` at `at`: context lines are written as the file's own
 * matched lines, and at tier 2 the added lines are re-indented from the old lines' first
 * line's indent to the file's (section 5).
 */
function applyEntries(lines: string[], at: number, entries: Entry[], tier: number, O: string[]): string[] {
  const F = leadWs(lines[at] ?? '');
  const P = leadWs(O[0] ?? '');
  const out: string[] = [];
  let m = at;
  for (const e of entries) {
    if (e.kind === 'ctx') {
      out.push(lines[m]!);
      m += 1;
    } else if (e.kind === 'del') {
      m += 1;
    } else {
      let t = e.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return [...lines.slice(0, at), ...out, ...lines.slice(m)];
}

/** The text of a file an edit creates from plain lines: LF breaks, a final one unless empty. */
function createdText(lines: string[]): string {
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  entries: Entry[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to a tab, spaces removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (gitOld: string | null, gitNew: string | null): Section => {
    const s: Section = {
      gitOld,
      gitNew,
      pairOld: null,
      pairNew: null,
      hasPair: false,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    const pairStart = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: .*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      i += 1;
      const entries: Entry[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          entries.push({ kind: 'ctx', text: '', noNl: false, fromEmpty: true });
          i += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') entries.push(entry('ctx', bl.slice(1)));
        else if (c === '-') entries.push(entry('del', bl.slice(1)));
        else if (c === '+') entries.push(entry('add', bl.slice(1)));
        else if (c === '\\') {
          const last = entries[entries.length - 1];
          if (last !== undefined) last.noNl = true;
          i += 1;
          continue;
        } else break;
        i += 1;
      }
      while (entries.length > 0 && entries[entries.length - 1]!.fromEmpty === true) entries.pop();
      cur.hunks.push({ a: Number(m[1]), entries });
      continue;
    }
    if (pairStart) {
      if (cur !== null && inHeader && !cur.hasPair && cur.gitOld !== null) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        const s = newSection(null, null);
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]!);
        s.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).replace(/^ +| +$/g, '');
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).replace(/^ +| +$/g, '');
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text (section 6), or fail the section. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const file = splitFile(text);
  let lines = file.lines;
  let finalBreak = file.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const O = oldOf(h.entries);
    const nLen = h.entries.filter((e) => e.kind !== 'del').length;
    if (O.length === 0) {
      const adds = h.entries.filter((e) => e.kind === 'add');
      const pos = Math.min(h.a + d, lines.length);
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...adds.map((e) => e.text), ...lines.slice(pos)];
      if (atEnd && adds.length > 0) finalBreak = !adds[adds.length - 1]!.noNl;
      d += adds.length;
      continue;
    }
    const found = findPositions(lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    for (const p of found.at) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    const touchesEnd = best + O.length === lines.length;
    lines = applyEntries(lines, best, h.entries, found.tier, O);
    if (touchesEnd) {
      const last = [...h.entries].reverse().find((e) => e.kind !== 'del');
      if (last !== undefined) finalBreak = !last.noNl;
    }
    d += nLen - O.length;
  }
  return joinFile(lines, file.br, finalBreak);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.hasPair ? sec.pairOld : sec.renameFrom ?? sec.gitOld;
    const newP = sec.hasPair ? sec.pairNew : sec.renameTo ?? sec.gitNew;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.newFile || oldP === null;
    const isDelete = sec.delFile || newP === null;
    if (isCreate) {
      const target = newP ?? oldP;
      if (target === null) return;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const adds: Entry[] = [];
      for (const h of sec.hunks) for (const e of h.entries) if (e.kind === 'add') adds.push(e);
      if (adds.length === 0) {
        tree.now.set(target, '');
        return;
      }
      const last = adds[adds.length - 1]!;
      tree.now.set(target, adds.map((e) => e.text).join('\n') + (last.noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP ?? newP;
      if (target === null) return;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, applyHunks(before, sec.hunks, strict, oldP));
      tree.now.set(oldP, null);
      tree.moves.push({ from: oldP, to: newP });
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let t = i - 1; t >= searchFrom; t--) {
      const l = lines[t]!;
      if (l.trim() === '' || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    prevPath = path;
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, createdText(newLines));
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const file = splitFile(text);
      const found = findPositions(file.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const entries: Entry[] = [
        ...oldLines.map((t) => entry('del', t)),
        ...newLines.map((t) => entry('add', t)),
      ];
      const out = applyEntries(file.lines, found.at[0]!, entries, found.tier, oldLines);
      tree.now.set(p, joinFile(out, file.br, file.finalBreak));
    });
    searchFrom = k + 1;
    i = k + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  entries: Entry[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let t = lines.length - 1; t >= 0; t--) {
    if (!blank(lines[t]!)) {
      last = t;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secKind = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    const path = line.slice(line.indexOf(': ') + 2).trim();
    i += 1;
    if (kind === 'add') {
      const content: string[] = [];
      while (i < last && secKind(lines[i]!) === null) {
        const l = lines[i]!;
        if (blank(l)) {
          content.push('');
          i += 1;
          continue;
        }
        if (!l.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        content.push(l.slice(1));
        i += 1;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, createdText(content));
      });
      continue;
    }
    if (kind === 'del') {
      while (i < last && secKind(lines[i]!) === null) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    // An Update File section: an optional Move to, then chunks.
    while (i < last && blank(lines[i]!)) i += 1;
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i += 1;
    }
    const chunks: Chunk[] = [];
    let chunk: Chunk | null = null;
    while (i < last && secKind(lines[i]!) === null) {
      const l = lines[i]!;
      if (blank(l)) {
        if (chunk !== null) chunk.entries.push({ kind: 'ctx', text: '', noNl: false, fromEmpty: true });
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        chunk = { anchor: l.slice(2).trim() || null, entries: [], eof: false };
        chunks.push(chunk);
        i += 1;
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (chunk === null) {
          chunk = { anchor: null, entries: [], eof: true };
          chunks.push(chunk);
        } else chunk.eof = true;
        i += 1;
        continue;
      }
      if (l.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
      const c = l[0]!;
      if (c !== ' ' && c !== '-' && c !== '+') throw new Exit2(`error: parse ${i + 1}`);
      if (chunk === null) {
        chunk = { anchor: null, entries: [], eof: false };
        chunks.push(chunk);
      }
      chunk.entries.push(entry(c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', l.slice(1)));
      i += 1;
    }
    if (chunks.length > 0) {
      const tail = chunks[chunks.length - 1]!;
      while (tail.entries.length > 0 && tail.entries[tail.entries.length - 1]!.fromEmpty === true) tail.entries.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
    edits.push((tree) => v4aUpdate(tree, path, moveTo, chunks, strict));
  }
  return edits;
}

function v4aUpdate(tree: Tree, path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): void {
  if (!safe(path)) throw new Fail('unsafe', path);
  if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
  const file = splitFile(text);
  let lines = file.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundAt = -1;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        const key = tierOf(tier, ch.anchor);
        for (let t = cursor; t < lines.length; t++) {
          if (tierOf(tier, lines[t]!) === key) {
            foundAt = t;
            break;
          }
        }
        if (foundAt >= 0) break;
      }
      if (foundAt < 0) throw new Fail('no-match', path);
      cursor = foundAt + 1;
    }
    const O = oldOf(ch.entries);
    if (O.length === 0) {
      const adds = ch.entries.filter((e) => e.kind === 'add').map((e) => e.text);
      const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
      lines = [...lines.slice(0, pos), ...adds, ...lines.slice(pos)];
      cursor = pos + adds.length;
      continue;
    }
    const found = findPositions(lines, O, strict, cursor, ch.eof);
    if (found === null) throw new Fail('no-match', path);
    const at = found.at[0]!;
    lines = applyEntries(lines, at, ch.entries, found.tier, O);
    cursor = at + ch.entries.filter((e) => e.kind !== 'del').length;
  }
  const out = joinFile(lines, file.br, file.finalBreak);
  if (moveTo !== null) {
    tree.now.set(moveTo, out);
    tree.now.set(path, null);
    tree.moves.push({ from: path, to: moveTo });
  } else {
    tree.now.set(path, out);
  }
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
            ? searchReplaceEdits(lines, strict)
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
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const after = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const mv of tree.moves) {
    if (tree.original(mv.from) === null || after(mv.from) !== null) continue;
    if (tree.original(mv.to) !== null || after(mv.to) === null) continue;
    if (consumed.has(mv.from) || consumed.has(mv.to)) continue;
    consumed.add(mv.from);
    consumed.add(mv.to);
    rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const lines0 = rows.map((r) => r.line);
  return { code: 0, out: [...lines0, `ok: ${lines0.length} ${lines0.length === 1 ? 'file' : 'files'}`] };
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
