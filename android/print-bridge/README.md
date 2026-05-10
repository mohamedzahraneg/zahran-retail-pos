# Zahran Print Bridge — Android (Phase 2)

Local Android app that listens on **`http://127.0.0.1:8911`** and bridges
HTTP print requests from the Zahran web POS to a Bluetooth-Classic
ESC/POS thermal printer (the field unit is **XP-P323B BT** / Bluetooth
name `3dea`).

The web side (Phase 1) was shipped in commit `5ea88c9`. With this APK
installed on the same Android phone that runs the POS in Chrome /
Samsung Internet, every print button on the web side will route
**directly** to the paired thermal printer instead of opening the
browser print dialog.

> **Phase 2 build status:** scaffolded. **Not built locally**: this
> machine has no Android SDK / JDK / Gradle installed (verified —
> see *Build instructions* below). The APK does not yet exist; build
> it on any machine with Android Studio and the steps below produce
> `app/build/outputs/apk/debug/app-debug.apk`.

---

## What's here

```
android/print-bridge/
├── README.md                                           ← you are here
├── .gitignore
├── settings.gradle.kts
├── build.gradle.kts                                    ← AGP 8.2 + Kotlin 1.9
├── gradle.properties
└── app/
    ├── build.gradle.kts
    ├── proguard-rules.pro
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml                     ← BT + foreground service perms
        │   ├── res/                                    ← layout + strings + colors + icon
        │   └── java/com/zahran/printbridge/
        │       ├── BridgeApplication.kt
        │       ├── MainActivity.kt                     ← UI: status / printers / test print
        │       ├── BridgeService.kt                    ← foreground service host
        │       ├── BridgeServer.kt                     ← NanoHTTPD endpoints + CORS
        │       ├── BluetoothPrinter.kt                 ← bonded list + RFCOMM write
        │       ├── EscposBitmapEncoder.kt              ← Bitmap → GS v 0
        │       ├── ReceiptRenderer.kt                  ← Arabic-aware Bitmap render
        │       ├── JobModels.kt                        ← PrintJob parser + responses
        │       └── PermissionsHelper.kt
        └── test/java/com/zahran/printbridge/
            ├── EscposBitmapEncoderTest.kt              ← header bytes / padding
            ├── JobParsingTest.kt                       ← happy path + every error code
            ├── HealthEndpointTest.kt                   ← response shape contract
            └── BridgeServerCorsTest.kt                 ← CORS headers + jsonResponse
```

Total: **9 Kotlin source files** + **4 test files** + **6 resource
files** + **5 build/config files**, ~1,200 lines of Kotlin.

---

## Toolchain (you must install before you can build)

| Tool | Version | Where |
|---|---|---|
| **JDK** | 17 (Temurin / Adoptium recommended) | `https://adoptium.net/temurin/releases/?version=17` |
| **Android Studio** | Iguana / Jellyfish or newer | `https://developer.android.com/studio` |
| **Android SDK Platform 34** | API 34 | Studio → SDK Manager |
| **Android SDK Build Tools** | 34.x | Studio → SDK Manager |
| **Gradle wrapper** | 8.5 (matches AGP 8.2.2) | Auto-downloaded by `gradle wrapper` |

After installing Android Studio:

1. Open **Android Studio** → File → Open → select
   `android/print-bridge/`. Studio will detect the `settings.gradle.kts`
   and offer to download the matching Gradle distribution and AGP.
2. Wait for the initial sync (downloads dependencies on first open).
3. The first sync will also generate the Gradle wrapper. If it
   doesn't, run from a terminal in `android/print-bridge/`:

   ```bash
   gradle wrapper --gradle-version 8.5
   ```

   (Requires Gradle on PATH. Brew: `brew install gradle`.)

---

## Build the APK

From the `android/print-bridge/` directory after the wrapper is in
place:

```bash
# Debug APK (sideload-friendly, no signing required)
./gradlew assembleDebug

# Output:
# android/print-bridge/app/build/outputs/apk/debug/app-debug.apk
```

For a release APK (signed) you'll need a keystore — see
[Android docs](https://developer.android.com/studio/publish/app-signing).
For sideloading to a single phone the debug APK is fine.

## Install on the phone

1. Enable **Developer Options** + **USB Debugging** on the Android
   phone (Settings → About phone → tap Build number 7 times → back →
   Developer options → USB debugging ON).
2. Connect via USB cable, accept the RSA fingerprint prompt.
3. From `android/print-bridge/`:

   ```bash
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

   `-r` replaces an existing install (useful for updates).

Alternative: copy the APK file to the phone (e.g. via Drive / USB
transfer) and tap it to install. Android may ask you to confirm
"install from unknown sources" once per app.

---

## Pair the XP-P323B BT printer

1. Power on the printer. Hold the feed button until you hear a beep
   (puts it in pairing mode).
2. On the Android phone: **Settings → Bluetooth** → **Pair new device**.
3. The printer should appear as **`3dea`** (or sometimes
   `XP-P323B`). Tap to pair.
4. If asked for a PIN, the Xprinter default is **`0000`** or
   **`1234`** depending on firmware.
5. Once paired, the device shows as **Paired** in Bluetooth settings.

Confirm the pairing held by opening the **Print Bridge** app — the
printer should appear in the "الطابعات المقترنة" list.

---

## Manual test checklist

```
□ 1. Pair XP-P323B BT in Android Bluetooth settings.

□ 2. Install + open Print Bridge app.
     · Grant the BLUETOOTH_CONNECT permission prompt.
     · Grant the POST_NOTIFICATIONS prompt (Android 13+).

□ 3. UI shows:
     · Status: "جسر الطباعة يعمل" with `http://127.0.0.1:8911`.
     · Notification "جسر الطباعة يعمل" with the URL.

□ 4. Tap "تحديث القائمة" → "3dea" appears.

□ 5. Tap on "3dea" to select.  Selection highlights, "اختبار طباعة"
     button enables.

□ 6. Tap "اختبار طباعة" inside the bridge app.
     Expected: small Arabic test receipt prints, partial cut at the end.

□ 7. Open Chrome / Samsung Internet on the SAME phone.
     Navigate to `https://pos.turathmasr.com/settings → الطابعات`.

□ 8. Bridge status chip flips from "غير متاح" to "متصل" within ~8 s.

□ 9. In PrintersTab, "إضافة طابعة":
     · name = `XP-P323B BT`
     · type = `حراري ESC/POS (80/58 مم)`
     · paper = `80 مم`
     · connection = `Bluetooth`
     · bluetooth_name = `3dea`
     · enabled ✓
     Save → row appears.  Set as default for "فاتورة".

□ 10. Tap "اختبار طباعة" in PrintersTab → success toast + print.

□ 11. Open POS → complete a test invoice → tap thermal print.
      Expected: real invoice prints via the bridge route.

□ 12. Force-stop the Print Bridge app.
      Tap thermal print on POS.
      Expected: graceful fallback to today's iframe-print dialog
      (FE router returns reason='bridge_unreachable').
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "غير متاح" never flips to "متصل" on the POS settings page | Bridge not started OR port 8911 already in use | Check the bridge app shows "جسر الطباعة يعمل" — if not, force-stop + reopen. Verify with `adb logcat -s BridgeServer` |
| Test print runs but nothing comes out of the printer | Wrong MAC selected | Verify the row you tapped is `3dea` — the highlight should be on it |
| Test print crashes with `IOException: read failed, socket might closed` | RFCOMM socket dropped — common on Android 12+ first connect | The bridge auto-retries once. If it still fails, unpair + repair the printer in Bluetooth settings |
| Arabic prints as boxes / gibberish | Printer firmware codepage mismatch | The bridge uses the bitmap path which sidesteps codepage entirely. If you still see boxes, double-check the receipt was generated with `widthDots = 576` (80mm) — narrower dots mean text falls off the right edge in RTL |
| The bridge process is killed by Android battery saver | OEM aggressive Doze (Xiaomi, Oppo, Vivo) | Settings → Apps → Print Bridge → Battery → Unrestricted. Add to "auto-start" if the OEM has that menu |
| `BLUETOOTH_CONNECT` permission keeps asking | User dismissed without granting | Settings → Apps → Print Bridge → Permissions → Bluetooth → Allow |
| Bridge port shows different number | Custom config | Defaults are `127.0.0.1:8911` — these match the FE's `DEFAULT_BRIDGE_URL`. Don't change unless you also update `frontend/src/lib/printers/store.ts:DEFAULT_BRIDGE_URL` |

---

## Run unit tests (after toolchain install)

```bash
cd android/print-bridge
./gradlew test
```

Test report:
`app/build/reports/tests/testDebugUnitTest/index.html`

The test suite covers:

- **`EscposBitmapEncoderTest`** — `GS v 0` header bytes, width
  padding to multiples of 8, MSB-first pixel packing, paper-cut on/off,
  feed-line emission. Robolectric (because `Bitmap` is Android-only).
- **`JobParsingTest`** — happy path + every documented error code +
  optional-field defaults. Pure JVM, no Robolectric.
- **`HealthEndpointTest`** — `BridgeResponse` JSON shape contract;
  pinned constants `127.0.0.1:8911`. Pure JVM.
- **`BridgeServerCorsTest`** — CORS headers on every response;
  `jsonResponse` end-to-end shape. Robolectric.

---

## What this scaffold does NOT include

- **Actual APK build artefact.** No JDK/SDK/Gradle on the dev machine
  that wrote this scaffold; build on a phone-paired machine.
- **Live printer test result.** Build + sideload + manually run the
  manual test checklist on the actual hardware.
- **Release signing.** Debug build only for the MVP.
- **Codepage / non-bitmap text path.** The MVP renders everything
  through the bitmap path because Arabic shaping + BiDi is hard to
  get right in raw codepage bytes; bitmaps are a known-good shortcut.
- **A4 / A5 / system print.** The Phase-1 FE has the type fields but
  the bridge MVP only handles `escpos_html` + thermal. A4/A5 lands
  in Phase 3.
- **HTTPS.** Bridge listens on `127.0.0.1` only — same-origin loopback
  doesn't need TLS, and avoids the cert-pinning complications.

---

## File-level guarantees

| File | Public surface | Test |
|---|---|---|
| `BridgeServer` | `/health`, `/printers/scan`, `/print/test`, `/print/jobs`, OPTIONS preflight | `BridgeServerCorsTest`, `HealthEndpointTest` |
| `BluetoothPrinter` | `isReady()`, `listBonded()`, `printBytes(mac, bytes)` | manual on-device |
| `EscposBitmapEncoder` | `encode(bitmap, widthDots)`, `widthDotsFor(mm)` | `EscposBitmapEncoderTest` (8 tests) |
| `ReceiptRenderer` | `renderTestReceipt()`, `renderEscposHtml()` | manual on-device (Arabic shaping) |
| `PrintJobParser` | `parse(json) → ParseResult` | `JobParsingTest` (12 tests) |
| `BridgeService` | foreground service lifecycle | manual on-device |
| `MainActivity` | UI → service binding + permissions flow | manual on-device |

---

## License

Internal — Zahran Retail POS. Apache 2.0 OK for the embedded
NanoHTTPD dependency.
