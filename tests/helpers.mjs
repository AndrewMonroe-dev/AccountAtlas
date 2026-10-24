// Shared test setup: an in-memory localStorage and the vendored SheetJS as a global.
import fs from 'node:fs';
import vm from 'node:vm';

export function installStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
  return m;
}
installStorage();

// The vendored file is a CommonJS/UMD bundle, but the package is type: module,
// so load it through a CommonJS-style wrapper instead of require.
const xlsxSource = fs.readFileSync(new URL('../vendor/xlsx/xlsx.full.min.js', import.meta.url), 'utf8');
const xlsxModule = { exports: {} };
vm.runInThisContext(`(function (module, exports) {${xlsxSource}
})`)(xlsxModule, xlsxModule.exports);
export const XLSX = xlsxModule.exports;
globalThis.XLSX = XLSX;

// Builds an ArrayBuffer workbook from an array of rows.
export function workbook(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer;
}

export const HEADER = ['Store Full Name', 'Store Number', 'Store Address', 'City', 'County', 'State', 'Zip Code'];
