package com.aureus.sirius;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
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

    /**
     * Save a base64 photo or video into the device gallery under a "Sirius"
     * album, via MediaStore. On Android 10+ this needs no storage permission.
     */
    @PluginMethod
    public void saveMedia(PluginCall call) {
        String base64 = call.getString("base64");
        String mime = call.getString("mime", "image/jpeg");
        String filename = call.getString("filename", "sirius");
        if (base64 == null || base64.isEmpty()) {
            call.reject("base64 is required");
            return;
        }
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            boolean isVideo = mime.startsWith("video");
            ContentResolver resolver = getContext().getContentResolver();
            Uri collection = isVideo
                    ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;

            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            if (Build.VERSION.SDK_INT >= 29) {
                String dir = (isVideo ? Environment.DIRECTORY_MOVIES
                        : Environment.DIRECTORY_PICTURES) + "/Sirius";
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, dir);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            }

            Uri item = resolver.insert(collection, values);
            if (item == null) {
                call.reject("could not create the gallery entry");
                return;
            }
            java.io.OutputStream out = resolver.openOutputStream(item);
            out.write(data);
            out.flush();
            out.close();
            if (Build.VERSION.SDK_INT >= 29) {
                values.clear();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(item, values, null, null);
            }
            JSObject ret = new JSObject();
            ret.put("uri", item.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("save failed: " + e.getMessage());
        }
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
