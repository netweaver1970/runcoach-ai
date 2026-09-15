/**
 * Expo config plugin — adopt the UIScene lifecycle (required by the iOS 27 SDK / Xcode 27).
 *
 * A binary linked against the iOS 27 SDK HARD-TRAPS at launch (NoSceneLifecycleAdoption) unless it
 * declares a UIApplicationSceneManifest — and declaring the manifest WITHOUT a scene delegate leaves the
 * window RCTAppDelegate creates in didFinishLaunchingWithOptions unattached to the connecting UIWindowScene,
 * i.e. a BLACK SCREEN. The manifest itself lives in app.json (ios.infoPlist.UIApplicationSceneManifest, with
 * UISceneDelegateClassName = "SceneDelegate"); THIS plugin injects the matching SceneDelegate implementation
 * into AppDelegate.mm on every prebuild (ios/ is gitignored expo-prebuild output, so a hand edit is dropped
 * on the next `expo prebuild`). The delegate re-parents RN's window onto the scene and forwards the URL /
 * user-activity callbacks that, under the scene lifecycle, arrive on the scene rather than the app delegate
 * (custom-scheme OAuth redirects for Google Drive, universal links).
 *
 * RN 0.76 keeps window creation in the app delegate; RN/Expo 0.77+ moves it into the scene delegate, at
 * which point this plugin (and the manifest's explicit delegate class) can be retired.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '// [withSceneDelegate] iOS 27 UIScene lifecycle adoption';

const SCENE_DELEGATE = `
${MARKER}
@interface SceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation SceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions
{
  if (![scene isKindOfClass:[UIWindowScene class]]) { return; }
  UIWindowScene *windowScene = (UIWindowScene *)scene;
  AppDelegate *appDelegate = (AppDelegate *)UIApplication.sharedApplication.delegate;
  UIWindow *window = appDelegate.window;
  if (window == nil) {
    window = [[UIWindow alloc] initWithWindowScene:windowScene];
    appDelegate.window = window;
  } else {
    window.windowScene = windowScene;
  }
  self.window = window;
  [window makeKeyAndVisible];

  // A URL or universal link that launched the app is delivered via the connection options here.
  if (connectionOptions.URLContexts.count > 0) {
    [self scene:scene openURLContexts:connectionOptions.URLContexts];
  }
  for (NSUserActivity *activity in connectionOptions.userActivities) {
    [self forwardUserActivity:activity];
  }
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts
{
  UIApplication *application = UIApplication.sharedApplication;
  id<UIApplicationDelegate> delegate = application.delegate;
  for (UIOpenURLContext *ctx in URLContexts) {
    NSMutableDictionary<UIApplicationOpenURLOptionsKey, id> *options = [NSMutableDictionary dictionary];
    if (ctx.options.sourceApplication != nil) {
      options[UIApplicationOpenURLOptionsSourceApplicationKey] = ctx.options.sourceApplication;
    }
    options[UIApplicationOpenURLOptionsOpenInPlaceKey] = @(ctx.options.openInPlace);
    if ([delegate respondsToSelector:@selector(application:openURL:options:)]) {
      [delegate application:application openURL:ctx.URL options:options];
    }
  }
}

- (void)scene:(UIScene *)scene continueUserActivity:(NSUserActivity *)userActivity
{
  [self forwardUserActivity:userActivity];
}

- (void)forwardUserActivity:(NSUserActivity *)userActivity
{
  id<UIApplicationDelegate> delegate = UIApplication.sharedApplication.delegate;
  if ([delegate respondsToSelector:@selector(application:continueUserActivity:restorationHandler:)]) {
    [delegate application:UIApplication.sharedApplication
        continueUserActivity:userActivity
          restorationHandler:^(NSArray<id<UIUserActivityRestoring>> *_Nullable restorableObjects) {}];
  }
}

// Rotation while the app is active: RCTDeviceInfo pushes fresh Dimensions to JS (so useWindowDimensions()
// updates) only when this notification fires — normally posted by RCTAppDelegate's own scene-delegate hook,
// which the manifest now routes to us instead. Re-post it here to keep rotation-reactive layouts working.
// The name is React/RCTConstants.h's RCTWindowFrameDidChangeNotification as a literal, so this appended file
// needs no RN header import; NSNotificationCenter matches observers by string name.
- (void)windowScene:(UIWindowScene *)windowScene
    didUpdateCoordinateSpace:(id<UICoordinateSpace>)previousCoordinateSpace
        interfaceOrientation:(UIInterfaceOrientation)previousInterfaceOrientation
             traitCollection:(UITraitCollection *)previousTraitCollection
{
  [NSNotificationCenter.defaultCenter postNotificationName:@"RCTWindowFrameDidChangeNotification" object:self];
}

@end
`;

module.exports = function withSceneDelegate(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectName = cfg.modRequest.projectName ?? 'RunCoachAI';
      const appDelegatePath = path.join(
        cfg.modRequest.platformProjectRoot,
        projectName,
        'AppDelegate.mm'
      );
      // FAIL LOUDLY on any error. The UIApplicationSceneManifest (which names UISceneDelegateClassName =
      // "SceneDelegate") always ships from app.json, so if this injection silently fails the build still
      // compiles but launches to a black screen (manifest points at a class that doesn't exist) with no
      // crash log — invisible in green CI. A missing AppDelegate.mm (e.g. a future Swift-AppDelegate SDK
      // bump) must therefore HALT the prebuild, not warn-and-continue.
      let src;
      try {
        src = fs.readFileSync(appDelegatePath, 'utf8');
      } catch (e) {
        throw new Error(
          `[withSceneDelegate] cannot read ${appDelegatePath} (${e.message}). The iOS 27 scene manifest ` +
          `references a SceneDelegate class that this plugin injects into AppDelegate.mm — without it the app ` +
          `launches to a black screen. If Expo now ships a Swift AppDelegate, port this injection to it.`
        );
      }
      if (src.includes(MARKER)) {
        console.log('[withSceneDelegate] SceneDelegate already present');
        return cfg;
      }
      // The template's AppDelegate.mm ends at the AppDelegate @end; append the SceneDelegate after it.
      src = src.replace(/\s*$/, '\n') + SCENE_DELEGATE;
      fs.writeFileSync(appDelegatePath, src, 'utf8');
      console.log('[withSceneDelegate] injected SceneDelegate into AppDelegate.mm ✓');
      return cfg;
    },
  ]);
};
