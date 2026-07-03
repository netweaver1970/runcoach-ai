// Registers the module loader hook (harness/loader.mjs) before the entry file loads, so the RN engine's
// native imports resolve to the mocks. Usage: node --import ./harness/register.mjs harness/run.ts [scenario.json]
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
