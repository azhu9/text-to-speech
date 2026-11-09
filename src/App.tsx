import { useEffect, useState } from 'react';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { docIdFromHash } from './lib/nav';
import { ocr } from './lib/ocr';

export default function App() {
  const [docId, setDocId] = useState(docIdFromHash);

  useEffect(() => {
    const onHash = () => setDocId(docIdFromHash());
    window.addEventListener('hashchange', onHash);
    // Ask the browser not to evict our library under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
    // Resume any OCR left unfinished last time.
    ocr.kick();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return docId ? <Reader key={docId} docId={docId} /> : <Library />;
}
