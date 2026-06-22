/** RunCoach AI — watch face complication. Shows the user's chosen KPI (default Stress)
 *  from the shared App Group; tapping opens the watch app. */
module.exports = {
  type: "watch-widget",
  name: "RunCoachComplication",
  deploymentTarget: "9.0",
  frameworks: ["SwiftUI", "WidgetKit"],
  entitlements: {
    "com.apple.security.application-groups": ["group.com.netweaver1970.runcoachai"],
  },
};
