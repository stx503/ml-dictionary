# English → Malayalam Dictionary (Android)

Search an English word and get:
- Malayalam meaning
- English synonyms (tap one to search it)
- One or two example sentences (with Malayalam translation)

Also included:
- **Bookmarks:** tap the star on a result to save the word. Saved words are listed on the home screen and work offline.
- **Themes:** tap the theme button at the top to cycle Auto, Light, Dark and AMOLED black (pure black background).
- **Fast search:** built-in words appear instantly while you type. Words found online are cached on the phone,
  so they open instantly the next time, even offline. Online results fill in piece by piece as they arrive.

About 100 common words are stored offline. Any other word is looked up online
(MyMemory for the Malayalam meaning, dictionaryapi.dev and Datamuse for synonyms and examples).
Online results are machine-sourced, so check important words.

## Get the APK (no installs needed): GitHub Actions

1. Create a free GitHub account and a new empty repository.
2. Upload everything in this folder (drag and drop works on github.com; keep the `.github` folder).
3. Open the **Actions** tab, choose **Build APK**, then **Run workflow**.
4. After a few minutes, open the finished run and download **EN-ML-Dictionary-APK** under *Artifacts*.
5. Unzip it, copy `app-debug.apk` to your phone, open it, and allow "Install unknown apps" when asked.

## Build on your own computer

Requirements: Node 22+, JDK 21, Android SDK (install Android Studio, which includes it).

```bash
npm install
npm test
npm run build:apk
```

The APK is created at `android/app/build/outputs/apk/debug/app-debug.apk`.

## Add or change words

Edit `www/data.js`. Each entry looks like:

```js
happy: ["adjective", ["സന്തോഷമുള്ള"], ["glad", "joyful"],
  [["She was happy.", "അവൾക്ക് സന്തോഷമായി."]]],
```

Then run `npm test` (it checks every entry) and rebuild.

## Notes

- This builds a **debug** APK, fine for installing on your own phone. To publish on Google Play you need
  a signed release build (`./gradlew bundleRelease`) and a keystore.
- The app icon is the default Capacitor icon. Use `@capacitor/assets` to generate your own.
