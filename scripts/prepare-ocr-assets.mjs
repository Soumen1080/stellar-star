import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

// No network downloads at runtime: ship the lockfile-pinned worker, core and model.
const root = process.cwd();
const destination = path.join(root, "public/ocr");
await mkdir(path.join(destination, "core"), { recursive: true });
await copyFile(path.join(root, "node_modules/tesseract.js/dist/worker.min.js"), path.join(destination, "worker.min.js"));
const core = path.join(root, "node_modules/tesseract.js-core");
for (const file of await readdir(core)) {
  if (/\.wasm(?:\.js)?$/.test(file)) await copyFile(path.join(core, file), path.join(destination, "core", file));
}
await copyFile(path.join(root, "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"),
  path.join(destination, "eng.traineddata.gz"));
await copyFile(path.join(root, "node_modules/tesseract.js/LICENSE.md"), path.join(destination, "LICENSE-tesseract.txt"));
await copyFile(path.join(core, "LICENSE"), path.join(destination, "LICENSE-core.txt"));
await copyFile(path.join(root, "node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt"),
  path.join(destination, "worker.min.js.LICENSE.txt"));
await copyFile(path.join(root, "docs/RECEIPT_OCR_NOTICES.txt"), path.join(destination, "NOTICE.txt"));
console.log("Prepared same-origin OCR assets.");
