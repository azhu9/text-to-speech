/** [start, end) character offsets into Block.text */
export type Sentence = [number, number];

export interface Block {
  /** `${page}-${index}`, stable for a given page */
  id: string;
  page: number;
  text: string;
  sentences: Sentence[];
  heading?: boolean;
  /** smaller than the page's body text (footnotes, captions) */
  small?: boolean;
  /** header, footer, page number or margin notice (marked at import) */
  margin?: boolean;
  /** text was corrected by the user */
  edited?: boolean;
}

export type PageStatus = 'ready' | 'ocr-pending' | 'ocr-failed';

export interface PageRecord {
  docId: string;
  page: number;
  status: PageStatus;
  blocks: Block[];
}

export type DocKind = 'pdf' | 'txt' | 'md';

export interface Position {
  blockId: string;
  sentence: number;
}

export interface DocRecord {
  id: string;
  title: string;
  kind: DocKind;
  fileName: string;
  createdAt: number;
  openedAt: number;
  pageCount: number;
  /** pages still waiting for OCR */
  ocrPending: number;
  position?: Position;
  /** 0..1 */
  progress: number;
  /** the user's own skip choices for this document */
  rules?: DocRules;
}

export interface DocRules {
  /** paragraphs the user chose not to hear */
  skip?: string[];
  /** paragraphs to read even though they'd be skipped automatically */
  read?: string[];
  /** example texts: skip every paragraph similar to one of these */
  patterns?: string[];
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export interface AnnotationRange {
  blockId: string;
  start: number;
  end: number;
}

export interface Annotation {
  id: string;
  docId: string;
  ranges: AnnotationRange[];
  quote: string;
  color: HighlightColor;
  note: string;
  createdAt: number;
  updatedAt: number;
}
