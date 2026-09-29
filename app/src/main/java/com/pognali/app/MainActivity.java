package com.pognali.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.net.Uri;
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

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);
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
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        webView.setWebViewClient(new WebViewClient() {
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
        webView.loadUrl("https://appassets.androidplatform.net/assets/pognali_final.html");
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
