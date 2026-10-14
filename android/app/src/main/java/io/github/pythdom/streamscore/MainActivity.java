package io.github.pythdom.streamscore;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Android shell for StreamScore: the web app is loaded from GitHub Pages inside this app's own WebView, so
 * its localStorage (OMDb/TMDB keys, OMDb cache, Seen flags) lives in the app's private data and survives
 * closing the app and clearing Chrome's browsing data.
 */
public class MainActivity extends Activity {

    private static final String APP_URL = "https://pythdom.github.io/streamscore/";
    private static final String APP_HOST = "pythdom.github.io";
    private static final String APP_PATH = "/streamscore";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // without this localStorage is unavailable and the keys can't be saved
        s.setAllowFileAccess(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isAppUrl(uri)) return false;
                // Metacritic, Rotten Tomatoes, etc.: open in the phone's browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(APP_URL);
        }
    }

    private static boolean isAppUrl(Uri uri) {
        String path = uri.getPath();
        return "https".equals(uri.getScheme()) && APP_HOST.equals(uri.getHost())
                && path != null && (path.equals(APP_PATH) || path.startsWith(APP_PATH + "/"));
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        webView.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }
}
