// A faster drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
//
// run(input) returns exactly the output tree makefun-site's build returns for
// the same input: every page's index.html, the index and tag pages,
// build-report.txt and each static file, byte for byte. The semantics are
// makefun-site's own, stated in its README (strict front matter, its own
// Markdown subset, its own template dialect, its own slug rule and report)
// with its code as the reference wherever the two differ. This file
// re-implements those rules from that specification, in its own code.
//
// Speed comes from doing less work per character than the reference:
//  - Markdown renders in one fused pass over the lines (no token objects,
//    no second walk), and inline markup renders over index ranges into a
//    shared output array, so nested strong/emphasis never copies substrings.
//  - HTML escaping works on whole plain runs at once.
//  - Slugs are cached per build; words are counted by a manual scan.
//  - Templates are compiled once into flat operation lists and rendered with
//    an explicit scope stack, instead of a recursive tree walk.
// Nothing is kept from one run(input) call to the next.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const KNOWN_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const SLUG_MAX = 64;

const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `ch` (one character) is whitespace in JavaScript's \s sense. */
function isWS(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
    || ch === '\u00a0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a')
    || ch === '\u2028' || ch === '\u2029' || ch === '\u202f' || ch === '\u205f'
    || ch === '\u3000' || ch === '\ufeff';
}

const ESC_RE = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtmlStr(text) {
  return ESC_RE.test(text) ? text.replace(/[&<>"']/g, (c) => ESCAPES[c]) : text;
}

/** One escaped character (only '>' of the escapable set needs it). */
function pushEscaped(out, ch) {
  out.push(ch === '>' ? '&gt;' : ch);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Results are cached for this build.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text[i])) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

/** Whether `s[a..b)` holds only digits. */
function isDigits(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return b > a;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `s` is a template name (a-z, 0-9 and "-"). */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug (a-z and 0-9, single "-" between). */
function isSlug(s) {
  if (s.length === 0) return false;
  let i = 0;
  while (i < s.length) {
    const j = s.indexOf('-', i);
    const end = j === -1 ? s.length : j;
    if (end === i) return false;
    for (let k = i; k < end; k++) {
      const c = s.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return false;
    }
    i = end + 1;
  }
  return true;
}

// ---------------------------------------------------------------- front matter

/** A quoted string value: "..." with \" and \\ its only escapes. */
function parseQuoted(key, raw) {
  if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: `key "${key}": a quoted string is not closed` };
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
      out += n;
      i++;
    } else if (c === '"') return { error: `key "${key}": a quoted string holds a stray quote` };
    else out += c;
  }
  return { value: out };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      if (raw.charCodeAt(0) === 34) return parseQuoted(key, raw);
      if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
      return { value: raw };
    }
    case 'date': {
      const ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45
        && isDigits(raw, 0, 4) && isDigits(raw, 5, 7) && isDigits(raw, 8, 10);
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let j = 0; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) !== 32) return { error: `line ${i + 1} is not "key: value"` };
    else raw = line.slice(k + 2);
    raw = raw.replace(/[ \t]+$/, '');
    if (!KNOWN_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 35) c++;
  if (c === 0 || c > 6) return null;
  let j = c;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === c) return null;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: c, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null when `line` does not open one. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { text: line.slice(2) };
  return null;
}

/** An ordered item's number and text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  return line.charCodeAt(0) === 32 && line.charCodeAt(1) === 32 && line.length > 2 && !isWS(line[2]);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wl = what.length;
  for (let j = from; j <= end - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace. */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s[i])) return true;
  return false;
}

/**
 * `s[a..b)` rendered inline into `out`; `link(target)` is a link's href.
 * Ranges replace the reference's substring copies: nested strong/emphasis
 * recurse on the same string, and plain runs are escaped whole.
 */
function inlineInto(s, a, b, link, out) {
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        pushEscaped(out, s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        out.push('<code>', escapeHtmlStr(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j !== -1 && j > i + 2) {
          out.push('<strong>');
          inlineInto(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j !== -1 && j > i + 1) {
        out.push('<em>');
        inlineInto(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        m = s.indexOf(')', k + 2);
        if (m === -1 || m >= b) m = -1;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !hasWS(target)) {
          out.push('<a href="', escapeHtmlStr(link(target)), '">');
          inlineInto(s, i + 1, k, link, out);
          out.push('</a>');
          i = m + 1;
          continue;
        }
      }
      out.push('[');
      i++;
      continue;
    }
    // A plain run: jump to the next significant character with native
    // indexOf scans instead of walking it one character at a time.
    const e1 = s.indexOf('\\', i);
    const e2 = s.indexOf('`', i);
    const e3 = s.indexOf('*', i);
    const e4 = s.indexOf('[', i);
    let j = b;
    if (e1 !== -1 && e1 < j) j = e1;
    if (e2 !== -1 && e2 < j) j = e2;
    if (e3 !== -1 && e3 < j) j = e3;
    if (e4 !== -1 && e4 < j) j = e4;
    out.push(escapeHtmlStr(s.slice(i, j)));
    i = j;
  }
}

/**
 * `src` rendered in one fused pass: its HTML (each block on its own lines,
 * a "\n" after the last), its table of contents (every level 2 and 3
 * heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, C) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fenceLang = fenceOpen(line);
    if (fenceLang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = '<pre><code';
      if (fenceLang !== '') code += ` class="language-${escapeHtmlStr(fenceLang)}"`;
      code += '>';
      for (const l of body) {
        code += escapeHtmlStr(l);
        code += '\n';
      }
      code += '</code></pre>\n';
      blocks.push(code);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, C.slugCache), ids);
      const tmp = [];
      inlineInto(hd.text, 0, hd.text.length, link, tmp);
      const html = tmp.join('');
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.join('\n');
        const tmp = [];
        inlineInto(joined, 0, joined.length, link, tmp);
        blocks.push(`<blockquote>\n<p>${tmp.join('')}</p>\n</blockquote>\n`);
      }
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const items = [];
      let start = 1;
      if (isOrd) start = ordered.num;
      while (i < n) {
        const l = lines[i];
        const m = isOrd ? orderedOf(l) : bulletOf(l);
        if (m !== null) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      let s = isOrd && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`;
      for (const parts of items) {
        const joined = parts.join('\n');
        const tmp = [];
        inlineInto(joined, 0, joined.length, link, tmp);
        s += `<li>${tmp.join('')}</li>\n`;
      }
      s += `</${tag}>\n`;
      blocks.push(s);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const tmp = [];
    inlineInto(text, 0, text.length, link, tmp);
    const html = tmp.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds only spaces and tabs. */
function isSpaces(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaces(src.slice(lineStart, open)) && isSpaces(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Operation kinds: 0 text, 1 escaped var, 2 raw var, 3 for, 4 if, 5 include.

/** `src` parsed into its tree of operations (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: 0, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? 1 : 2, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 3, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 4, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 4 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 3 : 4;
        if (top.k !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 0 ? parent.body : parent.k === 3 ? parent.body : (parent.els ?? parent.then);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 3 ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the scope stack: its first name from the nearest scope holding it, then own properties. */
function lookup(scopes, path) {
  for (let si = scopes.length - 1; si >= 0; si--) {
    const vs = scopes[si];
    if (Object.hasOwn(vs, path[0])) {
      let v = vs[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/**
 * Compile a parsed template's operations into a render function
 * (scopes, T, R, depth, out), or null when it cannot be compiled. The
 * generated code is plain JavaScript built only from the parsed operations
 * (literals via JSON.stringify); rendering through it does the same lookups
 * and writes as the interpreter below, without a dispatch per operation.
 * A template that does not compile falls back to the interpreter.
 */
function compileTemplate(ops) {
  let src = '';
  const emit = (list) => {
    for (const n of list) {
      switch (n.k) {
        case 0:
          src += `out.push(${JSON.stringify(n.text)});`;
          break;
        case 1:
          src += `out.push(R.ev(scopes,${JSON.stringify(n.path)}));`;
          break;
        case 2:
          src += `out.push(R.rv(scopes,${JSON.stringify(n.path)}));`;
          break;
        case 3: {
          src += `{const xs=R.lk(scopes,${JSON.stringify(n.path)});if(Array.isArray(xs)){for(let k=0;k<xs.length;k++){const vs={};vs[${JSON.stringify(n.name)}]=xs[k];vs.loop={index:k+1,first:k===0,last:k===xs.length-1,length:xs.length};scopes.push(vs);`;
          emit(n.body);
          src += `scopes.pop();}}}`;
          break;
        }
        case 4: {
          src += `if(R.truthy(R.lk(scopes,${JSON.stringify(n.path)}))!==${n.not}){`;
          emit(n.then);
          src += `}`;
          if (n.els !== null) {
            src += `else{`;
            emit(n.els);
            src += `}`;
          }
          break;
        }
        case 5:
          src += `{const t=T[${JSON.stringify(n.name)}];if(t!==undefined&&depth<8)t(scopes,T,R,depth+1,out);}`;
          break;
      }
    }
  };
  emit(ops);
  try {
    return new Function('scopes', 'T', 'R', 'depth', 'out', src);
  } catch {
    return null;
  }
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** One fused step for `{{ path }}`: the value at `path`, as text, HTML-escaped. */
function escVar(scopes, path) {
  const v = lookup(scopes, path);
  if (typeof v === 'string') return escapeHtmlStr(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtmlStr(v.map(textOf).join(', '));
  return '';
}

/** One fused step for `{{{ path }}}`: the value at `path`, as text, raw. */
function rawVar(scopes, path) {
  const v = lookup(scopes, path);
  return typeof v === 'string' ? v : textOf(v);
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `ops` rendered into `out` in the scope stack; `ctx` holds the parsed templates. */
function renderOps(ops, scopes, ctx, depth, out) {
  for (const n of ops) {
    switch (n.k) {
      case 0:
        out.push(n.text);
        break;
      case 1:
        out.push(escapeHtmlStr(textOf(lookup(scopes, n.path))));
        break;
      case 2:
        out.push(textOf(lookup(scopes, n.path)));
        break;
      case 3: {
        const xs = lookup(scopes, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vs = {};
          vs[n.name] = xs[k];
          vs.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          scopes.push(vs);
          renderOps(n.body, scopes, ctx, depth, out);
          scopes.pop();
        }
        break;
      }
      case 4: {
        const v = truthy(lookup(scopes, n.path));
        const branch = v !== n.not ? n.then : n.els;
        if (branch !== null) renderOps(branch, scopes, ctx, depth, out);
        break;
      }
      case 5: {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) renderOps(t, scopes, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const C = { slugCache: new Map(), templates: new Map(), compiled: new Map(), broken: new Set() };
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      C.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const R = { lk: lookup, txt: textOf, esc: escapeHtmlStr, truthy, ev: escVar, rv: rawVar };
  for (const [name, ops] of C.templates) {
    const fn = compileTemplate(ops);
    C.compiled.set(name, fn ?? ((scopes, T, R2, depth, out) => renderOps(ops, scopes, { templates: C.templates }, depth, out)));
  }
  // The compiled render functions index templates by name, so they take a
  // plain object (null-prototype: a template may be named "constructor").
  const T = Object.create(null);
  for (const [name, fn] of C.templates) T[name] = C.compiled.get(name);
  const base = input.site.base_url.replace(/\/+$/, '');
  const b = { sources: [], statics: [], bySource: new Map(), posts: [], tags: [], output: {} };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      b.sources.push({ path: f.path, text });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!C.templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, C.slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      C.broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, C);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, C.slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, C.slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, C.slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = C.compiled.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn([{ site, tags: allTags, recent, ...vars }], T, R, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards, linkOf) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...C.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output['build-report.txt'] = `${lines.join('\n')}\n`;
  return b.output;

  /** A post's card, as lists show it. */
  function cardOf(s) {
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }

  /** A page as its layout reads it (a post reuses its card from the map). */
  function pageOf(s, cardsMap, linkOfFn) {
    return {
      ...(s.post ? cardsMap.get(s) : cardOf(s)),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOfFn(s.newer ?? null),
      older: linkOfFn(s.older ?? null),
      is_post: s.post,
    };
  }
}
