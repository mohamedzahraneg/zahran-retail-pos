# Print Bridge — ProGuard / R8 rules.
#
# We rely only on AndroidX + NanoHTTPD; both are R8-safe out of the
# box.  No reflection, no Gson, no resource lookups by name → almost
# no rules needed.  The two `keep` directives below preserve the
# names that show up in adb logcat for crash triage.

-keep class com.zahran.printbridge.BridgeServer { *; }
-keep class com.zahran.printbridge.BridgeService { *; }

# NanoHTTPD has @SuppressWarnings reflection internally; default
# AGP rules cover it but we add belt-and-braces here.
-keep class fi.iki.elonen.NanoHTTPD { *; }
-keep class fi.iki.elonen.NanoHTTPD$* { *; }
