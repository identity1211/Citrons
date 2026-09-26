package lat.citrons.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar

    private var pendingPermissionRequest: PermissionRequest? = null

    private val audioPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val req = pendingPermissionRequest
            pendingPermissionRequest = null
            if (req == null) return@registerForActivityResult
            grantMediaPermissions(req, granted)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        applyImmersiveWindow()
        setContentView(R.layout.activity_main)

        val root = findViewById<ViewGroup>(R.id.root)
        // Never pad the shell for status/nav bars — that was the green letterbox.
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            WindowInsetsCompat.CONSUMED
        }
        root.fitsSystemWindows = false

        webView = findViewById(R.id.webView)
        progress = findViewById(R.id.progress)
        webView.fitsSystemWindows = false

        setupWebView()

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            val startUrl = intent?.data?.toString()?.takeIf { isCitronsUrl(it) } ?: HOME_URL
            webView.loadUrl(startUrl)
        }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) webView.goBack() else finish()
                }
            },
        )
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val url = intent.data?.toString()?.takeIf { isCitronsUrl(it) } ?: return
        webView.loadUrl(url)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    private fun applyImmersiveWindow() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        run {
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()
    }

    private fun hideSystemBars() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
        // Relayout after bars hide so WebView claims the full display.
        if (::webView.isInitialized) {
            webView.post {
                webView.layoutParams =
                    webView.layoutParams.apply {
                        width = ViewGroup.LayoutParams.MATCH_PARENT
                        height = ViewGroup.LayoutParams.MATCH_PARENT
                    }
                webView.requestLayout()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.setBackgroundColor(Color.parseColor("#145230"))
        // Consume long-press so Android never shows a context menu; JS still gets touch events for stacking.
        webView.isLongClickable = false
        webView.isHapticFeedbackEnabled = false
        webView.setOnLongClickListener { true }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = chromeLikeUserAgent(userAgentString)
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }

        webView.addJavascriptInterface(CitronsBridge(), "CitronsAndroid")

        webView.webViewClient =
            object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val url = request.url?.toString() ?: return false
                    return handleExternalUrl(url)
                }

                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    progress.visibility = View.VISIBLE
                    progress.progress = 0
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    progress.visibility = View.GONE
                    CookieManager.getInstance().flush()
                    hideSystemBars()
                    // App-only: force the page to the real display size (does not change hosted web files).
                    injectAppViewportFix()
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    if (!request.isForMainFrame) return
                    Toast.makeText(this@MainActivity, R.string.load_error, Toast.LENGTH_LONG).show()
                }
            }

        webView.webChromeClient =
            object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    progress.progress = newProgress
                    progress.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
                }

                override fun onPermissionRequest(request: PermissionRequest?) {
                    if (request == null) return
                    runOnUiThread {
                        val needsAudio =
                            request.resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                        if (!needsAudio) {
                            val safe =
                                request.resources
                                    .filter {
                                        it != PermissionRequest.RESOURCE_AUDIO_CAPTURE &&
                                            it != PermissionRequest.RESOURCE_VIDEO_CAPTURE &&
                                            it != PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID
                                    }.toTypedArray()
                            if (safe.isNotEmpty()) request.grant(safe) else request.deny()
                            return@runOnUiThread
                        }
                        if (ContextCompat.checkSelfPermission(
                                this@MainActivity,
                                Manifest.permission.RECORD_AUDIO,
                            ) == PackageManager.PERMISSION_GRANTED
                        ) {
                            grantMediaPermissions(request, true)
                        } else {
                            pendingPermissionRequest = request
                            audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        }
                    }
                }

                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?,
                ): Boolean {
                    filePathCallback?.onReceiveValue(null)
                    return true
                }
            }
    }

    private fun injectAppViewportFix() {
        // Stretch the document to the WebView size and zero CSS env(safe-area) via overrides.
        // Hosted citrons.lat is unchanged; this runs only inside the native shell.
        val js =
            """
            (function(){
              if (window.__citronsAppViewport) return;
              window.__citronsAppViewport = true;
              var s = document.getElementById('citrons-app-viewport');
              if (!s) {
                s = document.createElement('style');
                s.id = 'citrons-app-viewport';
                s.textContent = [
                  'html,body,#root{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;min-height:100%!important;max-height:none!important;margin:0!important;overflow:hidden!important;}',
                  'html{height:100%!important;}'
                ].join('');
                (document.head || document.documentElement).appendChild(s);
              }
              try {
                window.dispatchEvent(new Event('resize'));
                if (window.visualViewport) {
                  window.visualViewport.dispatchEvent(new Event('resize'));
                }
              } catch (e) {}
            })();
            """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private inner class CitronsBridge {
        @JavascriptInterface
        fun refreshGame() {
            runOnUiThread { hardRefresh() }
        }
    }

    private fun grantMediaPermissions(request: PermissionRequest, audioGranted: Boolean) {
        val granted =
            request.resources
                .filter { res ->
                    when (res) {
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> audioGranted
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> false
                        else -> true
                    }
                }.toTypedArray()
        if (granted.isEmpty()) request.deny() else request.grant(granted)
    }

    private fun handleExternalUrl(url: String): Boolean {
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase().orEmpty()
        if (scheme == "mailto" || scheme == "tel") {
            return try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
                true
            } catch (_: Exception) {
                false
            }
        }
        if (scheme != "http" && scheme != "https") {
            return try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
                true
            } catch (_: Exception) {
                false
            }
        }

        val host = uri.host?.lowercase().orEmpty()
        if (host.isEmpty()) return false
        if (isAllowedInWebView(host)) return false

        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun hardRefresh() {
        webView.clearCache(true)
        webView.loadUrl(HOME_URL)
        Toast.makeText(this, R.string.menu_refresh, Toast.LENGTH_SHORT).show()
    }

    companion object {
        const val HOME_URL = "https://citrons.lat/"

        fun isCitronsUrl(url: String): Boolean {
            val host = Uri.parse(url).host?.lowercase() ?: return false
            return isCitronsHost(host)
        }

        fun hostMatches(host: String, domain: String): Boolean {
            return host == domain || host.endsWith(".$domain")
        }

        fun isCitronsHost(host: String): Boolean = hostMatches(host, "citrons.lat")

        fun isAllowedInWebView(host: String): Boolean {
            if (isCitronsHost(host)) return true
            if (hostMatches(host, "railway.app")) return true
            if (hostMatches(host, "clerk.accounts.dev") ||
                hostMatches(host, "clerk.com") ||
                hostMatches(host, "accounts.dev")
            ) {
                return true
            }
            if (hostMatches(host, "daily.co")) return true
            if (hostMatches(host, "cloudflare.com") ||
                hostMatches(host, "jsdelivr.net") ||
                hostMatches(host, "github.io")
            ) {
                return true
            }
            if (hostMatches(host, "stripe.com") || hostMatches(host, "stripe.network")) return true
            if (hostMatches(host, "google.com") ||
                hostMatches(host, "googleusercontent.com") ||
                hostMatches(host, "gstatic.com") ||
                hostMatches(host, "googleapis.com")
            ) {
                return true
            }
            return false
        }

        fun chromeLikeUserAgent(defaultUa: String): String {
            val cleaned =
                defaultUa
                    .replace("; wv)", ")")
                    .replace(" Version/4.0", "")
                    .replace(Regex("\\s*;\\s*wv\\b"), "")
            return "$cleaned CitronsAndroid/1.0"
        }
    }
}
