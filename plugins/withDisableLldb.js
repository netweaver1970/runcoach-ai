/**
 * Expo config plugin — disable LLDB on the LaunchAction of the Xcode scheme.
 *
 * iOS 26 beta (and some other pre-release OSes) does not allow LLDB to attach,
 * so Xcode aborts the run with "Could not attach — IDEDebugSessionErrorDomain 3".
 * Switching the LaunchAction to the PosixSpawn launcher (no debugger) lets the
 * app deploy and run normally without a debug session.
 *
 * This plugin re-applies the patch every time `expo prebuild` regenerates the
 * xcscheme, so we never need to manually chmod 444 the scheme again.
 */

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/** Replace only the LaunchAction debugger/launcher identifiers, leave TestAction alone. */
function patchScheme(xml) {
  // Match the LaunchAction element and replace only its debugger/launcher attributes
  return xml.replace(
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
