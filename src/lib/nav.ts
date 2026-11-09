export function docIdFromHash(): string | null {
  const m = /^#\/doc\/(.+)$/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export const openDoc = (id: string) => {
  window.location.hash = `#/doc/${encodeURIComponent(id)}`;
};

export const openLibrary = () => {
  window.location.hash = '';
};
