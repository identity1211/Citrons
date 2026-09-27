package lat.citrons.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
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
    private lateinit var root: ViewGroup

    private var pendingPermissionRequest: PermissionRequest? = null
    private var lastImeBottom = -1

    private val audioPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val req = pendingPermissionRequest
            pendingPermissionRequest = null
            if (req == null) return@registerForActivityResult
            grantMediaPermissions(req, granted)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Do not call enableEdgeToEdge() — it keeps status/nav overlays visible.
        super.onCreate(savedInstanceState)
        applyImmersiveWindow()
        setContentView(R.layout.activity_main)

        root = findViewById(R.id.root)
        root.fitsSystemWindows = false
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            if (imeBottom != lastImeBottom) {
                lastImeBottom = imeBottom
                // Shrink the shell above the keyboard so lobby chat / IME bar stay visible.
                v.setPadding(0, 0, 0, imeBottom)
                pushImeHeightToPage(imeBottom)
            }
            // Keep status/nav hidden when the keyboard is closed.
            if (imeBottom == 0 &&
                (
                    insets.isVisible(WindowInsetsCompat.Type.statusBars()) ||
                        insets.isVisible(WindowInsetsCompat.Type.navigationBars())
                    )
            ) {
                v.post { hideSystemBars() }
            }
            WindowInsetsCompat.CONSUMED
        }

        webView = findViewById(R.id.webView)
        progress = findViewById(R.id.progress)
        webView.fitsSystemWindows = false

        setupWebView()
        hideSystemBars()
        Toast.makeText(this, R.string.boot_version, Toast.LENGTH_SHORT).show()

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
            // Avoid FLAG_FULLSCREEN — it often blocks IME inset delivery to the WebView.
            window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            window.clearFlags(WindowManager.LayoutParams.FLAG_FORCE_NOT_FULLSCREEN)
        }

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes =
                window.attributes.apply {
                    layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            window.isStatusBarContrastEnforced = false
            @Suppress("DEPRECATION")
            window.isNavigationBarContrastEnforced = false
        }

        @Suppress("DEPRECATION")
        window.decorView.setOnSystemUiVisibilityChangeListener { visibility ->
            val visible = visibility and View.SYSTEM_UI_FLAG_FULLSCREEN == 0
            if (visible && lastImeBottom <= 0) hideSystemBars()
        }
    }

    private fun pushImeHeightToPage(imeBottom: Int) {
        if (!::webView.isInitialized) return
        val js =
            """
            (function(){
              window.__citronsImeH = $imeBottom;
              document.documentElement.style.setProperty('--kb-h', '0px');
              try {
                window.dispatchEvent(new Event('resize'));
                if (window.visualViewport) window.visualViewport.dispatchEvent(new Event('resize'));
              } catch (e) {}
            })();
            """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        val decor = window.decorView

        // Legacy sticky immersive — most reliable for games on OEM skins.
        decor.systemUiVisibility =
            (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let { ic ->
                ic.hide(
                    android.view.WindowInsets.Type.statusBars() or
                        android.view.WindowInsets.Type.navigationBars(),
                )
                ic.systemBarsBehavior =
                    android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }

        val controller = WindowInsetsControllerCompat(window, decor)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.statusBars())
        controller.hide(WindowInsetsCompat.Type.navigationBars())
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.isAppearanceLightStatusBars = false
        controller.isAppearanceLightNavigationBars = false

        if (::webView.isInitialized) {
            webView.post {
                webView.requestLayout()
                injectAppViewportFix()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.setBackgroundColor(Color.parseColor("#145230"))
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
                    hideSystemBars()
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    progress.visibility = View.GONE
                    CookieManager.getInstance().flush()
                    hideSystemBars()
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
        if (!::webView.isInitialized) return
        val js =
            """
            (function(){
              var s = document.getElementById('citrons-app-viewport');
              if (!s) {
                s = document.createElement('style');
                s.id = 'citrons-app-viewport';
                (document.head || document.documentElement).appendChild(s);
              }
              s.textContent = [
                'html,body,#root{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;min-height:100%!important;max-height:none!important;margin:0!important;padding:0!important;overflow:hidden!important;}',
                'html{height:100%!important;}'
              ].join('');
              try {
                window.dispatchEvent(new Event('resize'));
                if (window.visualViewport) window.visualViewport.dispatchEvent(new Event('resize'));
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

        @JavascriptInterface
        fun openApkUpdate(url: String) {
            runOnUiThread {
                try {
                    val uri = Uri.parse(url)
                    val intent = Intent(Intent.ACTION_VIEW, uri)
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                    Toast.makeText(this@MainActivity, R.string.apk_update_opened, Toast.LENGTH_SHORT).show()
                } catch (_: Exception) {
                    Toast.makeText(this@MainActivity, R.string.apk_update_failed, Toast.LENGTH_LONG).show()
                }
            }
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
        // APK downloads must leave the WebView (Chrome / package installer).
        val path = uri.path?.lowercase().orEmpty()
        if (path.endsWith(".apk")) {
            return try {
                startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                true
            } catch (_: Exception) {
                false
            }
        }
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
