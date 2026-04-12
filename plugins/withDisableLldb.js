/**
 * Expo config plugin — two fixes for building on iOS 26 beta devices:
 *
 * 1. NODE_BINARY (.xcode.env.local)
 *    Expo 52 requires Node 18. If the system default is Node 20+ the Xcode
 *    bundle-embedding phase silently fails (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 *    leaving the app with no JS bundle → crash after splash.
 *    This plugin writes .xcode.env.local pointing at the Homebrew node@18 binary.
 *
 * 2. xcscheme (LaunchAction)
 *    iOS 26 beta doesn't allow LLDB to attach, so Xcode aborts with
 *    "Could not attach — IDEDebugSessionErrorDomain 3".
 *    The LaunchAction is switched to:
 *      - buildConfiguration = Release  (embeds JS bundle; no Metro needed)
 *      - selectedDebuggerIdentifier = ""
 *      - selectedLauncherIdentifier = PosixSpawn
 *    The scheme file is then locked (chmod 444) so Xcode can't revert it.
 */

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ── Node 18 path (Homebrew) ───────────────────────────────────────────────────
const NODE18_BINARY = '/opt/homebrew/opt/node@18/bin/node';

function writeNodeEnv(platformRoot) {
  const envLocalPath = path.join(platformRoot, '.xcode.env.local');
  const content = `export NODE_BINARY=${NODE18_BINARY}\n`;
  try {
    const existing = fs.existsSync(envLocalPath)
      ? fs.readFileSync(envLocalPath, 'utf8')
      : '';
    if (existing.trim() === content.trim()) {
      console.log('[withDisableLldb] .xcode.env.local already correct');
    } else {
      fs.writeFileSync(envLocalPath, content, 'utf8');
      console.log(`[withDisableLldb] wrote .xcode.env.local → NODE_BINARY=${NODE18_BINARY} ✓`);
    }
  } catch (e) {
    console.warn('[withDisableLldb] could not write .xcode.env.local:', e.message);
  }
}

/**
 * Patch the LaunchAction:
 *  - buildConfiguration → Release  (embeds the JS bundle; no Metro needed)
 *  - selectedDebuggerIdentifier → "" (iOS 26 beta cannot attach LLDB)
 *  - selectedLauncherIdentifier → PosixSpawn (launch without debugger)
 * TestAction is left untouched.
 */
function patchScheme(xml) {
  return xml.replace(
    /(<LaunchAction\s[^>]*?)buildConfiguration\s*=\s*"[^"]*"/,
    '$1buildConfiguration = "Release"'
  ).replace(
    /(<LaunchAction[\s\S]*?selectedDebuggerIdentifier\s*=\s*)"[^"]*"([\s\S]*?selectedLauncherIdentifier\s*=\s*)"[^"]*"/,
    '$1""$2"Xcode.DebuggerFoundation.Launcher.PosixSpawn"'
  );
}

module.exports = function withDisableLldb(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectName = cfg.modRequest.projectName ?? 'RunCoachAI';
      const schemePath = path.join(
        cfg.modRequest.platformProjectRoot,
        `${projectName}.xcodeproj`,
        'xcshareddata',
        'xcschemes',
        `${projectName}.xcscheme`
      );

      if (!fs.existsSync(schemePath)) {
        console.warn(`[withDisableLldb] scheme not found at ${schemePath}`);
        return cfg;
      }

      const original = fs.readFileSync(schemePath, 'utf8');
      const patched  = patchScheme(original);

      // Ensure NODE_BINARY in .xcode.env.local points to Node 18
      writeNodeEnv(cfg.modRequest.platformProjectRoot);

      // Unlock before writing (file may be read-only from a previous run)
      try { fs.chmodSync(schemePath, 0o644); } catch {}

      if (patched === original) {
        console.log('[withDisableLldb] scheme already patched');
      } else {
        fs.writeFileSync(schemePath, patched, 'utf8');
        console.log('[withDisableLldb] disabled LLDB in LaunchAction ✓');
      }

      // Lock the file so Xcode cannot revert the setting while the project is open
      try {
        fs.chmodSync(schemePath, 0o444);
        console.log('[withDisableLldb] scheme locked (read-only)');
      } catch {}

      return cfg;
    },
  ]);
};
