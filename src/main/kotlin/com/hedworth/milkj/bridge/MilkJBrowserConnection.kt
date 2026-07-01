package com.hedworth.milkj.bridge

import com.hedworth.milkj.web.MilkJWebResources
import com.intellij.openapi.Disposable
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefLoadHandlerAdapter

/**
 * The bridge's only touchpoints with the embedded page. Extracted so [MilkJBridge] can be
 * exercised in tests with a fake connection instead of a real JCEF browser.
 */
interface MilkJBrowserConnection {
    /**
     * Wires up the page: after every main-frame load, `window.milkjSendToIde` is installed into the
     * page, and every message the page sends through it is delivered to [onMessageFromPage].
     * Note: JCEF delivers these messages on a browser thread, not the EDT.
     */
    fun connect(onMessageFromPage: (String) -> Unit)

    fun executeJavaScript(script: String)
}

/** Production implementation backed by a [JBCefBrowser]. */
class JcefBrowserConnection(private val browser: JBCefBrowser) : MilkJBrowserConnection, Disposable {
    // JBCefBrowser is a JBCefBrowserBase, which is what JBCefJSQuery.create expects.
    private val jsToIde: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private var loadHandler: CefLoadHandler? = null

    override fun connect(onMessageFromPage: (String) -> Unit) {
        jsToIde.addHandler { message ->
            onMessageFromPage(message)
            null
        }

        val handler = object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                if (frame?.isMain == true) {
                    installJavaScriptBridge()
                }
            }
        }
        loadHandler = handler
        browser.jbCefClient.addLoadHandler(handler, browser.cefBrowser)
    }

    private fun installJavaScriptBridge() {
        val script = """
            window.milkjSendToIde = function (payload) {
              ${jsToIde.inject("payload")}
            };
            window.milkjBridgeInstalled?.();
        """.trimIndent()
        executeJavaScript(script)
    }

    override fun executeJavaScript(script: String) {
        browser.cefBrowser.executeJavaScript(script, MilkJWebResources.indexUrl, 0)
    }

    override fun dispose() {
        loadHandler?.let { browser.jbCefClient.removeLoadHandler(it, browser.cefBrowser) }
        loadHandler = null
        jsToIde.dispose()
    }
}
