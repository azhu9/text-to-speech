import { memo } from 'react';
import { buildSegments } from '../lib/segments';
import type { Annotation, Block } from '../lib/types';

interface Props {
  block: Block;
  /** index of the sentence being read in this block, or -1 */
  activeSentence: number;
  word: [number, number] | null;
  annotations: Annotation[];
  /** whole block is skipped when reading */
  skipped: boolean;
  /** parts of the block that are skipped */
  skips: [number, number][];
}

/** One paragraph/heading. The rendered text must equal block.text exactly,
 * because text selections are mapped back to character offsets. */
export const BlockView = memo(function BlockView({ block, activeSentence, word, annotations, skipped, skips }: Props) {
  const segments = buildSegments(block, annotations, activeSentence >= 0 ? word : null, skips);
  const Tag = block.heading ? 'h2' : 'p';
  let markedActive = false;
  return (
    <Tag
      data-block-id={block.id}
      className={`reading-block ${block.heading ? 'mt-8 mb-3 text-[1.3em] font-semibold leading-snug' : 'mb-5'} ${
        skipped ? 'text-stone-400 dark:text-stone-500' : ''
      } ${block.small ? 'text-[0.85em]' : ''}`}
      title={skipped ? 'Skipped when reading aloud (see Skip settings)' : undefined}
    >
      {segments.map((seg) => {
        const ann = seg.annotations[seg.annotations.length - 1];
        const active = seg.sentence >= 0 && seg.sentence === activeSentence;
        const cls: string[] = ['cursor-pointer'];
        if (seg.skipped && !skipped) cls.push('text-stone-400 dark:text-stone-500');
        if (ann) cls.push(`hl-${ann.color}`);
        if (ann?.note) cls.push('underline decoration-dotted decoration-stone-500 underline-offset-4');
        if (active) cls.push(ann ? 'outline outline-2 outline-sky-400/60' : 'bg-sky-100 dark:bg-sky-900/60');
        if (seg.word) cls.push('rounded-sm !bg-sky-300 dark:!bg-sky-600');
        const first = active && !markedActive;
        if (first) markedActive = true;
        return (
          <span
            key={seg.start}
            data-s={seg.sentence >= 0 ? seg.sentence : undefined}
            data-ann={ann?.id}
            data-active={first ? '' : undefined}
            className={cls.join(' ')}
          >
            {block.text.slice(seg.start, seg.end)}
          </span>
        );
      })}
    </Tag>
  );
});
