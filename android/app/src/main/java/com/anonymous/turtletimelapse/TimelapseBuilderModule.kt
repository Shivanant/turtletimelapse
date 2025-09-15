package com.anonymous.turtletimelapse

import android.graphics.*
import android.media.*
import android.os.Build
import android.util.Log
import android.view.Surface
import com.facebook.react.bridge.*
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class TimelapseBuilderModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TimelapseBuilder"

  // --- helpers ---------------------------------------------------------------

  private fun mul16(x: Int) = (x / 16) * 16

  private data class Negotiated(
    val width: Int,
    val height: Int,
    val fps: Int
  )

  /**
   * Negotiate encoder size/fps that the device supports for AVC surface input.
   * Tries requested (w,h,fps), then scales long edge down to <= 1920,
   * and if needed reduces fps 30 -> 24 -> 15.
   */
  private fun negotiateSizeFps(requestW: Int, requestH: Int, requestFps: Int): Negotiated {
    val mime = MediaFormat.MIMETYPE_VIDEO_AVC

    // Pick an AVC encoder
    val list = if (Build.VERSION.SDK_INT >= 21) MediaCodecList(MediaCodecList.ALL_CODECS) else null
    val encoderName = if (Build.VERSION.SDK_INT >= 21) {
      list!!.findEncoderForFormat(MediaFormat.createVideoFormat(mime, requestW, requestH))
    } else null

    // If we can’t query caps, just cap to 1080p and go.
    if (encoderName == null) {
      val (w, h) = capTo1080(requestW, requestH)
      val fps = listOf(requestFps, 30, 24, 15).first()
      return Negotiated(mul16(max(16, w)), mul16(max(16, h)), fps)
    }

    val info = list!!.codecInfos.first { it.name == encoderName }
    val caps = info.getCapabilitiesForType(mime)
    val vc = caps.videoCapabilities

    fun supported(w: Int, h: Int, fps: Int): Boolean {
      if (!vc.isSizeSupported(w, h)) return false
      val fr = vc.getSupportedFrameRatesFor(w, h)
      return fr.contains(fps.toDouble())
    }

    // Try exact request first (rounded to multiples of 16).
    var tryW = mul16(max(16, requestW))
    var tryH = mul16(max(16, requestH))
    var tryFps = requestFps

    val fpsCandidates = listOf(requestFps, 30, 24, 15).distinct()

    for (fps in fpsCandidates) {
      if (supported(tryW, tryH, fps)) return Negotiated(tryW, tryH, fps)
    }

    // Cap long edge to 1920 (≈1080p portrait/landscape), preserve aspect.
    val (capW, capH) = capTo1080(tryW, tryH)
    tryW = mul16(max(16, capW))
    tryH = mul16(max(16, capH))

    for (fps in fpsCandidates) {
      if (supported(tryW, tryH, fps)) return Negotiated(tryW, tryH, fps)
    }

    // As an absolute fallback: shrink by steps until size is supported at 15fps.
    tryFps = 15
    var longEdge = max(tryW, tryH)
    var shortEdge = min(tryW, tryH)
    while (longEdge >= 640) {
      if (supported(max(longEdge, shortEdge), min(longEdge, shortEdge), tryFps)) {
        val w = if (tryW >= tryH) longEdge else shortEdge
        val h = if (tryW >= tryH) shortEdge else longEdge
        return Negotiated(mul16(w), mul16(h), tryFps)
      }
      longEdge = mul16((longEdge * 0.9).roundToInt())
      shortEdge = mul16((shortEdge * 0.9).roundToInt())
    }
    // If we somehow get here, return the capped 640p.
    val w = if (tryW >= tryH) longEdge else shortEdge
    val h = if (tryW >= tryH) shortEdge else longEdge
    return Negotiated(max(16, mul16(w)), max(16, mul16(h)), 15)
  }

  private fun capTo1080(w: Int, h: Int): Pair<Int, Int> {
    val longEdge = max(w, h).toFloat()
    val shortEdge = min(w, h).toFloat()
    val MAX = 1920f
    return if (longEdge <= MAX) {
      Pair(w, h)
    } else {
      val scale = MAX / longEdge
      val newLong = (longEdge * scale).roundToInt()
      val newShort = (shortEdge * scale).roundToInt()
      if (w >= h) Pair(newLong, newShort) else Pair(newShort, newLong)
    }
  }

  // --- main ------------------------------------------------------------------

  @ReactMethod
  fun build(options: ReadableMap, promise: Promise) {
    var codec: MediaCodec? = null
    var muxer: MediaMuxer? = null
    var inputSurface: Surface? = null

    try {
      val dir = options.getString("dir") ?: return promise.reject("E_ARGS", "Missing dir")
      val reqFps = max(1, min(120, if (options.hasKey("fps")) options.getInt("fps") else 30))
      val outName = options.getString("outFileName") ?: "timelapse.mp4"

      val dirPath = dir.removePrefix("file://")
      val folder = File(dirPath)
      if (!folder.exists() || !folder.isDirectory) {
        return promise.reject("E_DIR", "Dir not found: $dirPath")
      }

      val frames = folder.listFiles { f -> f.name.startsWith("img_") && f.name.endsWith(".jpg") }
        ?.sortedBy { it.name } ?: emptyList()
      if (frames.isEmpty()) return promise.reject("E_EMPTY", "No frames")

      // Infer size from first frame if not provided
      val first = BitmapFactory.decodeFile(frames.first().absolutePath)
        ?: return promise.reject("E_IMG", "Cannot decode first frame")
      val reqW = first.width
      val reqH = first.height
      first.recycle()

      // Negotiate with encoder
      val neg = negotiateSizeFps(reqW, reqH, reqFps)
      val w = neg.width
      val h = neg.height
      val fps = neg.fps

      val outFile = File(folder, outName)
      if (outFile.exists()) outFile.delete()

      val mime = MediaFormat.MIMETYPE_VIDEO_AVC
      val format = MediaFormat.createVideoFormat(mime, w, h).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)

        // Very conservative bitrate (works on a wide range of phones)
        val target = (w.toLong() * h.toLong() * fps * 0.06).roundToInt()
        val bitrate = target.coerceIn(1_500_000, 10_000_000)
        setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
        setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
        setInteger(MediaFormat.KEY_FRAME_RATE, fps)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)

        // Do NOT force profile/level; let framework choose.
      }

      try {
        codec = MediaCodec.createEncoderByType(mime)
        codec!!.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      } catch (ce: MediaCodec.CodecException) {
        val diag = if (Build.VERSION.SDK_INT >= 21) ce.diagnosticInfo else "no-diagnostic"
        val msg = "configure failed ${w}x$h @$fps" + "fps, info=$diag"
        Log.e("TimelapseBuilder", msg, ce)
        return promise.reject("E_CODEC_CFG", msg, ce)
      }

      inputSurface = codec!!.createInputSurface()
      codec!!.start()

      muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      var trackIndex = -1
      var muxerStarted = false

      fun drainEncoder(endOfStream: Boolean) {
        if (endOfStream) codec!!.signalEndOfInputStream()
        val bufferInfo = MediaCodec.BufferInfo()
        while (true) {
          val outIndex = codec!!.dequeueOutputBuffer(bufferInfo, 10_000)
          when (outIndex) {
            MediaCodec.INFO_TRY_AGAIN_LATER -> { if (!endOfStream) break }
            MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              if (muxerStarted) throw RuntimeException("Format changed twice")
              trackIndex = muxer!!.addTrack(codec!!.outputFormat)
              muxer!!.start()
              muxerStarted = true
            }
            else -> if (outIndex >= 0) {
              val encoded = codec!!.getOutputBuffer(outIndex)
                ?: throw RuntimeException("encoderOutputBuffer $outIndex was null")
              if (bufferInfo.size > 0) {
                if (!muxerStarted) throw RuntimeException("Muxer hasn't started")
                encoded.position(bufferInfo.offset)
                encoded.limit(bufferInfo.offset + bufferInfo.size)
                muxer!!.writeSampleData(trackIndex, encoded, bufferInfo)
              }
              val eos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
              codec!!.releaseOutputBuffer(outIndex, false)
              if (eos) break
            }
          }
        }
      }

      val surface = inputSurface!!
      val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

      for (f in frames) {
        val bmp = BitmapFactory.decodeFile(f.absolutePath) ?: continue
        val canvas = surface.lockCanvas(null)
        try {
          canvas.drawColor(Color.BLACK, PorterDuff.Mode.SRC)
          val scale = min(w.toFloat() / bmp.width, h.toFloat() / bmp.height)
          val dw = bmp.width * scale
          val dh = bmp.height * scale
          val left = (w - dw) / 2f
          val top = (h - dh) / 2f
          val dst = RectF(left, top, left + dw, top + dh)
          canvas.drawBitmap(bmp, null, dst, paint)
        } finally {
          surface.unlockCanvasAndPost(canvas)
        }
        bmp.recycle()

        // Drain frequently so codec doesn't stall
        drainEncoder(false)
      }

      drainEncoder(true)

      try { muxer!!.stop() } catch (_: Throwable) {}
      try { muxer!!.release() } catch (_: Throwable) {}
      try { codec!!.stop() } catch (_: Throwable) {}
      try { codec!!.release() } catch (_: Throwable) {}
      try { inputSurface.release() } catch (_: Throwable) {}

      promise.resolve("file://${outFile.absolutePath}")
    } catch (e: MediaCodec.CodecException) {
      val diag = if (Build.VERSION.SDK_INT >= 21) e.diagnosticInfo else "no-diagnostic"
      Log.e("TimelapseBuilder", "CodecException: $diag", e)
      promise.reject("E_CODEC", "CodecException: $diag", e)
    } catch (e: Throwable) {
      Log.e("TimelapseBuilder", "build error", e)
      promise.reject("E_EXC", e.message, e)
    }
  }
}
