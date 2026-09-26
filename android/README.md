# Citrons Android (WebView shell)

Thin Android wrapper around https://citrons.lat — same multiplayer server as the website.

## Build a debug APK

Needs JDK 17–21 (not JDK 25 from newer Android Studio bundles):

```bash
export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/jbr-21.0.11/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd android
./gradlew :app:assembleDebug
```

APK path:

```text
app/build/outputs/apk/debug/app-debug.apk
```

A copy is also written to `android/dist/citrons-debug.apk` after a manual copy (not required).

Install on a phone (USB debugging):

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or copy the APK to the phone and open it (allow install from unknown sources).

## Release APK (for sharing / GitHub Releases)

1. Create a keystore once (keep it private):

```bash
keytool -genkey -v -keystore citrons-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias citrons
```

2. Add `keystore.properties` (gitignored) and wire signing in `app/build.gradle.kts`, or sign with:

```bash
./gradlew :app:assembleRelease
```

## In-app refresh

Long-press anywhere on the game → **Refresh game** (clears cache and reloads https://citrons.lat).

Also available: **Open in browser**.

## Download (no Play Store)

- Site: https://citrons.lat/app/citrons-android.apk
- GitHub Releases: see the latest `android-*` release on the Citrons repo

- Debug builds use `lat.citrons.app.debug`
- Google sign-in may open Chrome Custom Tabs if Google blocks the embedded WebView
- Microphone permission is requested for in-game voice
