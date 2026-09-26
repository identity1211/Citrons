# Keep WebView / JS bridge entry points if minify is enabled later.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
