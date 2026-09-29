package com.pognali.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.ConsoleMessage;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.widget.Toast;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import android.view.WindowInsets;
import android.graphics.Insets;
import android.os.Bundle;
import android.os.Build;
import android.location.LocationManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;

public class MainActivity extends Activity {
    private WebView webView;
    private static final int LOCATION_REQUEST = 1001;
    private static final int FILE_CHOOSER_REQUEST = 1002;
    private android.webkit.ValueCallback<Uri[]> filePathCallback;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;
    private final StringBuilder diagnostics = new StringBuilder();
    private final Object diagnosticsLock = new Object();

    private void diag(String source, String message) {
        String line = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date())
                + " [" + source + "] " + String.valueOf(message) + "\n";
        synchronized (diagnosticsLock) {
            diagnostics.append(line);
            if (diagnostics.length() > 200000) diagnostics.delete(0, diagnostics.length() - 200000);
        }
        android.util.Log.e("PognaliDiag", line.trim());
    }

    private String diagnosticsText() {
        synchronized (diagnosticsLock) {
            return "POGNALI DIAGNOSTICS\n"
                    + "Android=" + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")\n"
                    + "WebView UA=Pognali/1.0 (Android; com.pognali.app)\n"
                    + "generated=" + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSSZ", Locale.US).format(new Date()) + "\n\n"
                    + diagnostics.toString();
        }
    }

    private void saveDiagnosticsFile() {
        String name = "pognali-diagnostics-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".txt";
        byte[] data = diagnosticsText().getBytes(StandardCharsets.UTF_8);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                android.content.ContentValues values = new android.content.ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Pognali");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new Exception("MediaStore insert returned null");
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) throw new Exception("openOutputStream returned null");
                    out.write(data);
                }
                Toast.makeText(this, "Лог сохранён в Downloads/Pognali/" + name, Toast.LENGTH_LONG).show();
            } else {
                java.io.File dir = new java.io.File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Pognali");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("mkdirs failed: " + dir);
                java.io.File file = new java.io.File(dir, name);
                try (OutputStream out = new java.io.FileOutputStream(file)) { out.write(data); }
                Toast.makeText(this, "Лог сохранён: " + file.getAbsolutePath(), Toast.LENGTH_LONG).show();
            }
            diag("NATIVE", "Diagnostics file saved: " + name);
        } catch (Exception e) {
            diag("NATIVE", "Diagnostics save FAILED: " + e);
            Toast.makeText(this, "Не удалось сохранить лог: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    public class DiagnosticsBridge {
        @JavascriptInterface public void log(String message) { diag("JS", message); }
        @JavascriptInterface public void saveDiagnostics() { runOnUiThread(() -> saveDiagnosticsFile()); }
    }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        webView.addJavascriptInterface(new DiagnosticsBridge(), "PognaliDiagnostics");
        setContentView(webView);
        diag("NATIVE", "App start");
        // Keep the WebView full-size. The HTML owns safe-area spacing so Android
        // insets are not applied twice (once by WebView and once by CSS).
        webView.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(
                WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            String js = "(function(){document.documentElement.style.setProperty('--safe-top','" + bars.top
                + "px');document.documentElement.style.setProperty('--safe-bottom','" + bars.bottom + "px');})();";
            webView.evaluateJavascript(js, null);
            return insets;
        });
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setUserAgentString("Pognali/1.0 (Android; com.pognali.app)");
        // Always load the current bundled HTML/JS assets. This prevents a stale WebView
        // cache from keeping an older map implementation after an APK update.
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.clearCache(true);
        webView.clearHistory();
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                diag("PAGE", "Finished: " + url);
                view.evaluateJavascript("(function(){"
                        + "window.addEventListener('error',function(e){if(window.PognaliDiagnostics)PognaliDiagnostics.log('window.error: '+(e.message||'')+' @ '+(e.filename||'')+':'+(e.lineno||0)+':'+(e.colno||0));});"
                        + "window.addEventListener('unhandledrejection',function(e){if(window.PognaliDiagnostics)PognaliDiagnostics.log('unhandledrejection: '+(e.reason&&e.reason.stack||e.reason||'unknown'));});"
                        + "if(window.PognaliDiagnostics)PognaliDiagnostics.log('JS diagnostics hooks installed; location='+location.href);"
                        + "})()", null);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                String u = request != null && request.getUrl() != null ? request.getUrl().toString() : "<unknown>";
                diag("WEB_RESOURCE_ERROR", u + " code=" + (error != null ? error.getErrorCode() : "?")
                        + " desc=" + (error != null ? error.getDescription() : "?"));
                super.onReceivedError(view, request, error);
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                String u = request != null && request.getUrl() != null ? request.getUrl().toString() : "<unknown>";
                diag("HTTP_ERROR", u + " status=" + (response != null ? response.getStatusCode() : "?")
                        + " reason=" + (response != null ? response.getReasonPhrase() : "?"));
                super.onReceivedHttpError(view, request, response);
            }
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view, android.webkit.WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                try { view.destroy(); } catch (Exception ignored) {}
                Intent restart = new Intent(MainActivity.this, MainActivity.class);
                restart.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                startActivity(restart);
                finish();
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage cm) {
                diag("CONSOLE", "[" + cm.messageLevel() + "] " + cm.message() + " @ " + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                    checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = callback;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
                }
            }

            @Override public boolean onShowFileChooser(WebView webView, android.webkit.ValueCallback<Uri[]> filePath, FileChooserParams fileChooserParams) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = filePath;
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("image/*");
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });
        webView.loadUrl("https://appassets.androidplatform.net/assets/pognali_final.html?v=2");
    }

    private void runJs(String js) {
        if (webView == null) return;
        try { webView.post(() -> webView.evaluateJavascript(js, null)); } catch (Exception ignored) {}
    }

    private boolean locationServicesEnabled() {
        try {
            LocationManager lm = (LocationManager)getSystemService(LOCATION_SERVICE);
            if (lm == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return lm.isLocationEnabled();
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) { return false; }
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
            runJs("if(typeof onAndroidAppResume==='function')onAndroidAppResume();");
            if (!locationServicesEnabled()) runJs("if(typeof onAndroidLocationServicesOff==='function')onAndroidLocationServicesOff();");
        }
    }

    @Override protected void onPause() {
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            try { webView.stopLoading(); } catch (Exception ignored) {}
            try { webView.onPause(); } catch (Exception ignored) {}
            try { webView.destroy(); } catch (Exception ignored) {}
            webView = null;
        }
        super.onDestroy();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == LOCATION_REQUEST && pendingGeoCallback != null) {
            boolean granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            GeolocationPermissions.Callback callback = pendingGeoCallback;
            String origin = pendingGeoOrigin;
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
            callback.invoke(origin, granted, false);
            runJs("if(typeof onAndroidLocationPermissionChanged==='function')onAndroidLocationPermissionChanged(" + granted + ");");
            if (granted && !locationServicesEnabled()) runJs("if(typeof onAndroidLocationServicesOff==='function')onAndroidLocationServicesOff();");
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                Uri uri = data.getData();
                if (uri != null) results = new Uri[]{uri};
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override public void onBackPressed() {
        webView.evaluateJavascript(
            "(function(){" +
            "var m=document.getElementById('modal');" +
            "if(m&&m.classList.contains('open')){closeModal();return true;}" +
            "if(typeof currentTab!=='undefined'&&currentTab!=='events'){go('events');return true;}" +
            "return false;" +
            "})()",
            value -> { if ("true".equals(value)) return; MainActivity.super.onBackPressed(); }
        );
    }
}
