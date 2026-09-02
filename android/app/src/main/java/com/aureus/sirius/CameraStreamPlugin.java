package com.aureus.sirius;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Reads the dog's MJPEG stream in native code and hands JavaScript one complete
 * JPEG at a time as base64. This exists because the WebView will not render a
 * multipart/x-mixed-replace stream in an <img> or an iframe (recent Chromium
 * dropped that for sub-resources) and a JS fetch is blocked by the missing CORS
 * header and private-network policy. A native socket is subject to none of that.
 */
@CapacitorPlugin(name = "CameraStream")
public class CameraStreamPlugin extends Plugin {

    private volatile boolean running = false;
    private Thread thread;
    private volatile HttpURLConnection conn;
    private volatile InputStream in;

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        stopInternal();
        running = true;
        thread = new Thread(() -> pump(url));
        thread.setDaemon(true);
        thread.start();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopInternal();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
        super.handleOnDestroy();
    }

    private void stopInternal() {
        running = false;
        // Closing the socket unblocks a read() that is waiting for the next frame.
        try { if (in != null) in.close(); } catch (Exception ignored) {}
        try { if (conn != null) conn.disconnect(); } catch (Exception ignored) {}
        in = null;
        conn = null;
        if (thread != null) {
            thread.interrupt();
            thread = null;
        }
    }

    private void emitError(String message) {
        JSObject ev = new JSObject();
        ev.put("message", message);
        notifyListeners("error", ev);
    }

    private void pump(String urlStr) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setRequestProperty("Connection", "keep-alive");
            c.connect();
            conn = c;

            int code = c.getResponseCode();
            if (code != 200) {
                emitError("camera server returned HTTP " + code);
                return;
            }

            InputStream stream = new BufferedInputStream(c.getInputStream(), 1 << 16);
            in = stream;

            ByteArrayOutputStream frame = new ByteArrayOutputStream(1 << 15);
            boolean capturing = false;
            int prev = -1;
            int b;
            long lastEmit = 0;

            while (running && (b = stream.read()) != -1) {
                if (!capturing) {
                    // start of a JPEG: FF D8
                    if (prev == 0xFF && b == 0xD8) {
                        capturing = true;
                        frame.reset();
                        frame.write(0xFF);
                        frame.write(0xD8);
                    }
                } else {
                    frame.write(b);
                    // end of a JPEG: FF D9
                    if (prev == 0xFF && b == 0xD9) {
                        capturing = false;
                        long now = System.currentTimeMillis();
                        // Throttle to ~11 fps so the JS bridge is not flooded.
                        if (now - lastEmit >= 90) {
                            lastEmit = now;
                            String b64 = Base64.encodeToString(
                                    frame.toByteArray(), Base64.NO_WRAP);
                            JSObject ev = new JSObject();
                            ev.put("data", b64);
                            notifyListeners("frame", ev);
                        }
                    }
                }
                prev = b;
            }
        } catch (Exception e) {
            if (running) {
                emitError(e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) {}
            try { if (conn != null) conn.disconnect(); } catch (Exception ignored) {}
        }
    }
}
