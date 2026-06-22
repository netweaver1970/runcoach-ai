/** RunCoach AI — watchOS app (companion). Receives KPI data from the phone via
 *  WatchConnectivity and shows scrollable KPI curves. */
module.exports = {
  type: "watch",
  name: "RunCoach",
  icon: "../../assets/icon.png",
  deploymentTarget: "9.0",
  frameworks: ["SwiftUI", "WatchConnectivity", "Charts", "WidgetKit"],
  // App Group shared with the watch complication so it can read the selected KPI.
  entitlements: {
    "com.apple.security.application-groups": ["group.com.netweaver1970.runcoachai"],
  },
};
