// Copies the OCR engine (tesseract.js worker + WebAssembly core) and the
// English language data from node_modules into public/ocr, so OCR is served
// by this app instead of a CDN. Runs automatically before dev/build.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const out = join(process.cwd(), 'public', 'ocr');
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

const copies = [[join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), join(out, 'worker.min.js')]];
const core = pkgDir('tesseract.js-core');
for (const f of readdirSync(core)) if (/-lstm\.wasm\.js$/.test(f)) copies.push([join(core, f), join(out, 'core', f)]);
copies.push([
  join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'),
  join(out, 'lang', 'eng.traineddata.gz'),
]);

for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  if (!existsSync(to)) copyFileSync(from, to);
}
console.log(`OCR assets ready in ${out}`);
