package com.aureus.sirius;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the native MJPEG reader before the bridge starts.
        registerPlugin(CameraStreamPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
