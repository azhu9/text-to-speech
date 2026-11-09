// Copies runtime files from node_modules into public/ so the app serves them
// itself instead of loading them from a CDN. Runs automatically before dev/build.
//  - public/ocr: OCR engine (tesseract.js worker + WebAssembly core) and English data
//  - public/ort: ONNX runtime used by the Kokoro voice model
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const out = join(process.cwd(), 'public', 'ocr');
// Packages live in node_modules; some don't export package.json, so build the path directly.
const pkgDir = (name) => join(process.cwd(), 'node_modules', name);

const copies = [[join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), join(out, 'worker.min.js')]];
const core = pkgDir('tesseract.js-core');
for (const f of readdirSync(core)) if (/-lstm\.wasm\.js$/.test(f)) copies.push([join(core, f), join(out, 'core', f)]);
copies.push([
  join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'),
  join(out, 'lang', 'eng.traineddata.gz'),
]);

const tfDist = join(pkgDir('@huggingface/transformers'), 'dist');
for (const f of readdirSync(tfDist)) if (/^ort-wasm-simd-threaded\.jsep\.(mjs|wasm)$/.test(f)) copies.push([join(tfDist, f), join(process.cwd(), 'public', 'ort', f)]);

for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  if (!existsSync(to)) copyFileSync(from, to);
}
console.log('Runtime assets ready in public/ocr and public/ort');
