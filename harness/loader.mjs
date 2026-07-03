// Runs the REAL coach engine (src/services/coach.ts) in plain Node:
//  • resolve(): alias the few native/device modules to mocks, and add the .ts extension Node ESM needs
//    for the RN source's extensionless relative imports.
//  • load():   transpile .ts with sucrase (strips types AND drops type-only value imports like
//    `import { HealthSnapshot } from '../types'` — which Node's native type-stripping can't do).
import { extname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transform } from 'sucrase';

const HERE = new URL('./', import.meta.url);
const alias = (rel) => ({ url: new URL(rel, HERE).href, shortCircuit: true });

export async function resolve(specifier, context, nextResolve) {
  // Native leaves. Only SecureStore + FileSystem are truly needed (seeded from the scenario); rest are stubs.
  if (specifier === 'expo-secure-store') return alias('mocks/secure-store.mjs');
  if (specifier === 'expo-file-system')  return alias('mocks/file-system.mjs');
  if (specifier === 'expo-location' || specifier === '@kingstinct/react-native-healthkit') return alias('mocks/stub.mjs');
  // Heavy service modules that reach for device data — alias to light mocks so HealthKit/weather never load.
  if (/(^|\/)healthkit$/.test(specifier)) return alias('mocks/healthkit.mjs');
  if (/(^|\/)weather$/.test(specifier))   return alias('mocks/weather.mjs');
  // Node ESM requires explicit extensions; the RN source imports './llm' etc. → append .ts.
  if (specifier.startsWith('.') && !extname(specifier)) {
    try { return await nextResolve(specifier + '.ts', context); } catch { /* fall through to default */ }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const src = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = transform(src, {
      transforms: ['typescript'],   // keep ESM import/export; strip types + type-only imports
      disableESTransforms: true,    // leave modern JS (optional chaining etc.) for Node to run natively
      keepUnusedImports: false,
      filePath: fileURLToPath(url),
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
