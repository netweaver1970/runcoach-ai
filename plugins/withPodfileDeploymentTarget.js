/**
 * Expo config plugin — floor every CocoaPod at iOS 15.1 (for Xcode 27+).
 *
 * Xcode 27 raised the minimum supported iOS deployment target to 15.0. Some pods
 * (e.g. ReachabilitySwift) still ship a 12.0 target and fail the build with:
 *   "The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 12.0, but the
 *    range of supported deployment target versions is 15.0 to 27.0."
 * `ios/` is gitignored (expo prebuild output), so a manual Podfile edit is dropped on the
 * next `expo prebuild`. This plugin re-injects, on every prebuild, a post_install loop that
 * bumps any pod target below 15.1 up to 15.1 (the app's own min). Idempotent via a marker.
 *
 * Reminder: after prebuild, run `pod install` with a UTF-8 locale on this Mac —
 * `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install` — CocoaPods 1.16 on Ruby 4.0 otherwise
 * throws "Unicode Normalization not appropriate for ASCII-8BIT".
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const FLOOR = '15.1';
const MARKER = '# [withPodfileDeploymentTarget] floor pods for Xcode 27';

const SNIPPET = `
    ${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |bc|
        cur = bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if cur.nil? || cur.to_f < ${FLOOR}
          bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${FLOOR}'
        end
      end
    end
`;

module.exports = function withPodfileDeploymentTarget(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      try {
        let src = fs.readFileSync(podfile, 'utf8');
        if (src.includes(MARKER)) {
          console.log('[withPodfileDeploymentTarget] already applied');
          return cfg;
        }
        const anchor = /post_install do \|installer\|\n/;
        if (!anchor.test(src)) {
          console.warn('[withPodfileDeploymentTarget] post_install hook not found — skipping');
          return cfg;
        }
        src = src.replace(anchor, (m) => m + SNIPPET);
        fs.writeFileSync(podfile, src, 'utf8');
        console.log(`[withPodfileDeploymentTarget] floored all pods at iOS ${FLOOR} ✓`);
      } catch (e) {
        console.warn('[withPodfileDeploymentTarget] could not patch Podfile:', e.message);
      }
      return cfg;
    },
  ]);
};
