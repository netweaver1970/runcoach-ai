#!/usr/bin/env node
/**
 * Give the watchOS app a COMPLETE app-icon set. Run AFTER `expo prebuild`.
 *
 * @bacons/apple-targets writes only a single 1024×1024 image for the watch target's
 * AppIcon, and it does so in a late prebuild mod phase that a config plugin can't run
 * after (we tried — apple-targets overwrites the plugin's Contents.json). watchOS does
 * NOT synthesize the home-screen sizes from one image, so the app ends up with a grey
 * placeholder icon and "could not be installed at this time".
 *
 * This standalone script (guaranteed to run after prebuild finishes) rasterises the full
 * watchOS icon set from assets/icon.png with `sips` and writes the proper Contents.json.
 *
 * Usage:  node scripts/fix-watch-icon.mjs   (see package.json "prebuild:ios")
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'assets', 'icon.png');
const set = path.join(root, 'targets', 'watch', 'Assets.xcassets', 'AppIcon.appiconset');

// size(px) → watchOS icon role/subtype (explicit legacy set; watchOS needs these).
const ICONS = [
  { px: 48,   idiom: 'watch', role: 'notificationCenter', subtype: '38mm', size: '24x24',     scale: '2x' },
  { px: 55,   idiom: 'watch', role: 'notificationCenter', subtype: '42mm', size: '27.5x27.5', scale: '2x' },
  { px: 58,   idiom: 'watch', role: 'companionSettings',                   size: '29x29',     scale: '2x' },
  { px: 87,   idiom: 'watch', role: 'companionSettings',                   size: '29x29',     scale: '3x' },
  { px: 80,   idiom: 'watch', role: 'appLauncher',        subtype: '38mm', size: '40x40',     scale: '2x' },
  { px: 88,   idiom: 'watch', role: 'appLauncher',        subtype: '40mm', size: '44x44',     scale: '2x' },
  { px: 92,   idiom: 'watch', role: 'appLauncher',        subtype: '41mm', size: '46x46',     scale: '2x' },
  { px: 100,  idiom: 'watch', role: 'appLauncher',        subtype: '44mm', size: '50x50',     scale: '2x' },
  { px: 102,  idiom: 'watch', role: 'appLauncher',        subtype: '45mm', size: '51x51',     scale: '2x' },
  { px: 108,  idiom: 'watch', role: 'appLauncher',        subtype: '49mm', size: '54x54',     scale: '2x' },
  { px: 172,  idiom: 'watch', role: 'quickLook',          subtype: '38mm', size: '86x86',     scale: '2x' },
  { px: 196,  idiom: 'watch', role: 'quickLook',          subtype: '42mm', size: '98x98',     scale: '2x' },
  { px: 216,  idiom: 'watch', role: 'quickLook',          subtype: '44mm', size: '108x108',   scale: '2x' },
  { px: 234,  idiom: 'watch', role: 'quickLook',          subtype: '45mm', size: '117x117',   scale: '2x' },
  { px: 258,  idiom: 'watch', role: 'quickLook',          subtype: '49mm', size: '129x129',   scale: '2x' },
  { px: 1024, idiom: 'watch-marketing',                                    size: '1024x1024', scale: '1x' },
];

if (!fs.existsSync(src)) { console.warn('[fix-watch-icon] assets/icon.png missing — skip'); process.exit(0); }
if (!fs.existsSync(set)) { console.warn(`[fix-watch-icon] ${set} missing — run after prebuild — skip`); process.exit(0); }

for (const f of fs.readdirSync(set)) fs.rmSync(path.join(set, f)); // wipe apple-targets' single-size icon
const images = ICONS.map(({ px, ...meta }) => {
  const filename = `icon_${px}.png`;
  execFileSync('sips', ['-z', String(px), String(px), src, '--out', path.join(set, filename)], { stdio: 'ignore' });
  return { ...meta, filename };
});
fs.writeFileSync(path.join(set, 'Contents.json'), JSON.stringify({ images, info: { version: 1, author: 'runcoach-watch-icon' } }, null, 2));
console.log(`[fix-watch-icon] wrote ${images.length} watchOS app-icon sizes ✓`);
