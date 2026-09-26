package lat.citrons.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.ContextMenu
import android.view.MenuItem
import android.view.View
import android.webkit.CookieManager
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
import androidx.core.view.WindowCompat

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
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        progress = findViewById(R.id.progress)

        setupWebView()
        webView.isLongClickable = true
        webView.setOnLongClickListener {
            openContextMenu(it)
            true
        }
        registerForContextMenu(webView)

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

    override fun onCreateContextMenu(
        menu: ContextMenu,
        v: View,
        menuInfo: ContextMenu.ContextMenuInfo?,
    ) {
        super.onCreateContextMenu(menu, v, menuInfo)
        menuInflater.inflate(R.menu.main_menu, menu)
        menu.setHeaderTitle(R.string.app_name)
    }

    override fun onContextItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_refresh -> {
                refreshGame()
                true
            }
            R.id.action_browser -> {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(webView.url ?: HOME_URL)))
                true
            }
            else -> super.onContextItemSelected(item)
        }
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        // Avoid destroying across config changes handled by android:configChanges.
        (webView.parent as? android.view.ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = WebSettings.LOAD_DEFAULT
            // Strip the "wv" WebView marker so Google/Clerk OAuth is less likely to block sign-in.
            userAgentString = chromeLikeUserAgent(userAgentString)
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }

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
                            // Don't auto-grant camera/etc.
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

    /**
     * Keep first-party + OAuth/game hosts inside the WebView.
     * Opening Google in Custom Tabs breaks Clerk redirect back into the app.
     */
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

    private fun refreshGame() {
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

        fun isCitronsHost(host: String): Boolean {
            return hostMatches(host, "citrons.lat")
        }

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
            // Keep Google OAuth inside WebView so the redirect returns to Citrons.
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
