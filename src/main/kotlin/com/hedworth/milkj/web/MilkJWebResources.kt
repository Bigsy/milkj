package com.hedworth.milkj.web

import com.intellij.ui.jcef.JBCefApp
import org.cef.CefApp
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefCallback
import org.cef.callback.CefSchemeHandlerFactory
import org.cef.handler.CefResourceHandler
import org.cef.handler.CefResourceHandlerAdapter
import org.cef.misc.IntRef
import org.cef.misc.StringRef
import org.cef.network.CefRequest
import org.cef.network.CefResponse
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean

object MilkJWebResources {
    private const val HOST = "milkj.localhost"
    const val indexUrl: String = "http://$HOST/index.html"
    private val registered = AtomicBoolean(false)

    fun registerSchemeHandler() {
        if (!registered.compareAndSet(false, true)) {
            return
        }

        JBCefApp.getInstance()
        CefApp.getInstance().registerSchemeHandlerFactory("http", HOST, MilkJResourceHandlerFactory)
    }

    private object MilkJResourceHandlerFactory : CefSchemeHandlerFactory {
        override fun create(
            browser: CefBrowser?,
            frame: CefFrame?,
            schemeName: String?,
            request: CefRequest?,
        ): CefResourceHandler = MilkJResourceHandler(request?.url)
    }

    /**
     * Serves bundled web resources to the JCEF browser.
     *
     * We extend [CefResourceHandlerAdapter] rather than implement [CefResourceHandler] directly: at
     * runtime JCEF (through 2026.x) drives the legacy processRequest/readResponse path, which we
     * override here. JCEF 2026.2+ also added abstract open/read/skip methods to the interface; the
     * adapter provides those, so a single build compiled against 2024.1 keeps working — and passes
     * the Plugin Verifier — across the whole supported range without referencing the newer API types.
     */
    private class MilkJResourceHandler(url: String?) : CefResourceHandlerAdapter() {
        private val response: ResourceResponse = ResourceResponse.from(url)
        private var offset = 0

        override fun processRequest(request: CefRequest?, callback: CefCallback?): Boolean {
            callback?.Continue()
            return true
        }

        override fun getResponseHeaders(
            response: CefResponse?,
            responseLength: IntRef?,
            redirectUrl: StringRef?,
        ) {
            response?.status = this.response.status
            response?.statusText = this.response.statusText
            response?.mimeType = this.response.mimeType
            response?.setHeaderByName("Cache-Control", "no-store", true)
            responseLength?.set(this.response.bytes.size)
        }

        override fun readResponse(
            dataOut: ByteArray?,
            bytesToRead: Int,
            bytesRead: IntRef?,
            callback: CefCallback?,
        ): Boolean {
            if (dataOut == null || offset >= response.bytes.size) {
                bytesRead?.set(0)
                return false
            }

            val count = minOf(bytesToRead, response.bytes.size - offset)
            response.bytes.copyInto(dataOut, destinationOffset = 0, startIndex = offset, endIndex = offset + count)
            offset += count
            bytesRead?.set(count)
            return true
        }

        override fun cancel() {
            offset = response.bytes.size
        }
    }

    private data class ResourceResponse(
        val status: Int,
        val statusText: String,
        val mimeType: String,
        val bytes: ByteArray,
    ) {
        companion object {
            fun from(url: String?): ResourceResponse {
                val resourcePath = resourcePath(url)
                val bytes = MilkJWebResources::class.java.classLoader
                    .getResourceAsStream(resourcePath)
                    ?.use { it.readBytes() }

                if (bytes == null) {
                    return ResourceResponse(
                        status = 404,
                        statusText = "Not Found",
                        mimeType = "text/plain",
                        bytes = "MilkJ resource not found: $resourcePath".toByteArray(),
                    )
                }

                return ResourceResponse(
                    status = 200,
                    statusText = "OK",
                    mimeType = mimeType(resourcePath),
                    bytes = bytes,
                )
            }

            private fun resourcePath(url: String?): String {
                val path = url
                    ?.let { runCatching { URI(it).path }.getOrNull() }
                    ?.takeIf { it.isNotBlank() && it != "/" }
                    ?: "/index.html"

                return "web/${path.removePrefix("/")}"
            }

            private fun mimeType(path: String): String =
                when (path.substringAfterLast('.', missingDelimiterValue = "")) {
                    "html" -> "text/html"
                    "js" -> "application/javascript"
                    "css" -> "text/css"
                    "svg" -> "image/svg+xml"
                    "png" -> "image/png"
                    "jpg", "jpeg" -> "image/jpeg"
                    "gif" -> "image/gif"
                    "webp" -> "image/webp"
                    "woff" -> "font/woff"
                    "woff2" -> "font/woff2"
                    "map" -> "application/json"
                    "wasm" -> "application/wasm"
                    else -> "application/octet-stream"
                }
        }
    }
}
