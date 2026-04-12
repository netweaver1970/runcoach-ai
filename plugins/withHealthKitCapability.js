/**
 * Expo config plugin — enable the HealthKit System Capability in project.pbxproj.
 *
 * expo prebuild regenerates the Xcode project from scratch and does NOT
 * carry over the "Signing & Capabilities → HealthKit" toggle that was set
 * manually in Xcode.  Without the SystemCapabilities entry the app crashes
 * at launch because the OS denies the HealthKit entitlement.
 *
 * This plugin adds (or updates) the SystemCapabilities block for the main
 * app target every time expo prebuild runs.
 */

const { withXcodeProject } = require('@expo/config-plugins');

module.exports = function withHealthKitCapability(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;

    // ── Find the main app target key ──────────────────────────────────────
    const nativeTargets = project.pbxNativeTargetSection();
    let mainTargetKey = null;

    for (const [key, obj] of Object.entries(nativeTargets)) {
      if (
        obj &&
        typeof obj === 'object' &&
        obj.productType === '"com.apple.product-type.application"'
      ) {
        mainTargetKey = key.replace(/_comment$/, '');
        break;
      }
    }

    if (!mainTargetKey) {
      console.warn('[withHealthKitCapability] Could not find main app target');
      return cfg;
    }

    // ── Locate the PBXProject object ──────────────────────────────────────
    const projectSection = project.pbxProjectSection();
    for (const [, obj] of Object.entries(projectSection)) {
      if (!obj || typeof obj !== 'object' || obj.isa !== 'PBXProject') continue;

      // Ensure nested structure exists
      obj.attributes          = obj.attributes          ?? {};
      obj.attributes.TargetAttributes = obj.attributes.TargetAttributes ?? {};
      obj.attributes.TargetAttributes[mainTargetKey] =
        obj.attributes.TargetAttributes[mainTargetKey] ?? {};

      const ta = obj.attributes.TargetAttributes[mainTargetKey];
      ta.SystemCapabilities = ta.SystemCapabilities ?? {};

      if (ta.SystemCapabilities['com.apple.HealthKit']?.enabled === 1) {
        console.log('[withHealthKitCapability] HealthKit capability already set ✓');
      } else {
        ta.SystemCapabilities['com.apple.HealthKit'] = { enabled: 1 };
        console.log('[withHealthKitCapability] HealthKit capability enabled ✓');
      }

      break; // only one PBXProject object
    }

    return cfg;
  });
};
