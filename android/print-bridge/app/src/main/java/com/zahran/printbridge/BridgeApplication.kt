package com.zahran.printbridge

import android.app.Application

/**
 * Application class — currently a no-op placeholder.  Exists because
 * the manifest declares `android:name=".BridgeApplication"`, which
 * gives us a stable hook for future Application-scope wiring (DI
 * graph, crash reporting, settings preload).
 */
class BridgeApplication : Application()
