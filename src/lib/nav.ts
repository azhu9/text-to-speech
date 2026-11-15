export interface Route {
  docId: string | null;
  /** start playing as soon as the document opens (from the queue) */
  autoplay: boolean;
}

export function routeFromHash(): Route {
  const m = /^#\/doc\/([^?]+)(\?.*)?$/.exec(window.location.hash);
  if (!m) return { docId: null, autoplay: false };
  return { docId: decodeURIComponent(m[1]), autoplay: new URLSearchParams(m[2]?.slice(1) ?? '').get('play') === '1' };
}

export const openDoc = (id: string, opts: { autoplay?: boolean } = {}) => {
  window.location.hash = `#/doc/${encodeURIComponent(id)}${opts.autoplay ? '?play=1' : ''}`;
};

export const openLibrary = () => {
  window.location.hash = '';
};
