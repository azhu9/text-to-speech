export interface Paragraph {
  text: string;
  heading?: boolean;
}

/** Join hard-wrapped lines into one paragraph, removing end-of-line hyphenation. */
export function joinLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) out = line;
    else if (/[\p{L}]-$/u.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line;
    else out += ' ' + line;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Paragraphs separated by blank lines; single newlines are treated as wrapping. */
export function textToParagraphs(raw: string): Paragraph[] {
  return raw
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => joinLines(p.split('\n')))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((text) => ({ text }));
}

function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1');
}

export function markdownToParagraphs(raw: string): Paragraph[] {
  const out: Paragraph[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = joinLines(buf.map(stripInline));
    if (/[\p{L}\p{N}]/u.test(text)) out.push({ text });
    buf = [];
  };
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (/^```/.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) {
      flush();
      const text = stripInline(h[1]).replace(/#+$/, '').trim();
      if (text) out.push({ text, heading: true });
      continue;
    }
    if (!t) {
      flush();
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(t);
    if (item) {
      flush();
      buf.push(item[1]);
      continue;
    }
    buf.push(t.replace(/^>\s?/, ''));
  }
  flush();
  return out;
}

const PAGE_NUMBER = /^(?:page\s*)?(?:\d{1,4}|[ivxlcdm]{1,6})$/i;

export function isPageNumber(s: string): boolean {
  return PAGE_NUMBER.test(s.trim());
}
