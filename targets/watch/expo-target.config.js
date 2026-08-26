/** RunCoach AI — watchOS app (companion). Receives KPI data from the phone via
 *  WatchConnectivity and shows scrollable KPI curves. */
module.exports = {
  type: "watch",
  name: "RunCoach",
  icon: "../../assets/icon.png",
  deploymentTarget: "11.0",
  frameworks: ["SwiftUI", "WatchConnectivity", "Charts", "WidgetKit", "HealthKit", "AVFoundation"],
  entitlements: {
    // App Group shared with the watch complication so it can read the selected KPI.
    "com.apple.security.application-groups": ["group.com.netweaver1970.runcoachai"],
    // Run guidance records the run in-app via an HKWorkoutSession (keeps the app + voice alive in background).
    "com.apple.developer.healthkit": true,
  },
};
