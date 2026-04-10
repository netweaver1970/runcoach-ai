# RunCoach AI — Build & Install Guide

## What you need (one-time)
- [ ] Apple Developer account — $99/yr at developer.apple.com
- [ ] Expo account — free at expo.dev
- [ ] Anthropic API key — free tier at console.anthropic.com
- [ ] Node.js on your Mac (already installed ✓)

---

## Step 1 — Install Expo + EAS CLI (Mac terminal)

```bash
npm install -g expo-cli eas-cli
```

## Step 2 — Install app dependencies

```bash
cd "running-coach-app"
npm install
```

## Step 3 — Log in to Expo

```bash
eas login
```

## Step 4 — Configure your bundle ID

Edit `app.json` and change:
```json
"bundleIdentifier": "com.yourname.runcoachai"
```
to something unique like `com.geert.runcoachai`.

## Step 5 — Set up EAS project

```bash
eas build:configure
```

This links the project to your Expo account.

## Step 6 — Build for iOS (cloud build — no Mac Xcode needed)

**Preview build (for TestFlight):**
```bash
eas build --platform ios --profile preview
```

This uploads your code to Expo's build servers.
Build takes ~10–15 minutes. You'll get a download link when done.

## Step 7 — Upload to TestFlight

```bash
eas submit --platform ios --latest
```

Or manually: download the `.ipa` from Expo dashboard, upload via Transporter app.

## Step 8 — Install on iPhone via TestFlight

1. Install TestFlight from the App Store on your iPhone
2. Open the TestFlight invite email Apple sends
3. Install RunCoach AI

## Step 9 — First launch

1. Open RunCoach AI
2. Allow Apple Health access when prompted
3. Tap ⚙️ → enter your Anthropic API key
4. Tap **Get Running Coach Advice**

---

## Ongoing use

| Action | How |
|--------|-----|
| Ad-hoc analysis | Open app → tap "Get Running Coach Advice" |
| Weekly reminder | Settings → toggle "Every Monday at 8:00 AM" |
| Refresh data | Pull down on home screen |
| Share report | Analysis screen → "↑ Share" |

---

## Costs

| Item | Cost |
|------|------|
| Apple Developer | $99/yr (needed for TestFlight) |
| Expo EAS Build | Free (up to 15 builds/month) |
| Anthropic API | ~$0.01–0.03 per coaching report |

**Alternative without Apple Developer account:**  
Use `eas build --profile development` and install via Expo Dev Client directly (no TestFlight needed, but more steps).
