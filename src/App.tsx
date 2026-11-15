import { useEffect, useState } from 'react';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { routeFromHash } from './lib/nav';
import { ocr } from './lib/ocr';

export default function App() {
  const [route, setRoute] = useState(routeFromHash);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    // Ask the browser not to evict our library under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
    // Resume any OCR left unfinished last time.
    ocr.kick();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return route.docId ? <Reader key={route.docId} docId={route.docId} autoplay={route.autoplay} /> : <Library />;
}
