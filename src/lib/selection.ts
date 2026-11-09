import type { AnnotationRange } from './types';

function offsetIn(el: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  return r.toString().length;
}

export interface TextSelection {
  ranges: AnnotationRange[];
  quote: string;
  rect: DOMRect;
}

/** Map the current browser selection inside `container` to block offsets. */
export function readSelection(container: HTMLElement): TextSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const ranges: AnnotationRange[] = [];
  const quotes: string[] = [];
  for (const el of container.querySelectorAll<HTMLElement>('[data-block-id]')) {
    if (!range.intersectsNode(el)) continue;
    const text = el.textContent ?? '';
    let start = el.contains(range.startContainer) ? offsetIn(el, range.startContainer, range.startOffset) : 0;
    let end = el.contains(range.endContainer) ? offsetIn(el, range.endContainer, range.endOffset) : text.length;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) continue;
    ranges.push({ blockId: el.dataset.blockId!, start, end });
    quotes.push(text.slice(start, end));
  }
  if (!ranges.length) return null;
  return { ranges, quote: quotes.join('\n'), rect: range.getBoundingClientRect() };
}
