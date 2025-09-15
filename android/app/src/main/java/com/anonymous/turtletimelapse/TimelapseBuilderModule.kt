package com.anonymous.turtletimelapse

import android.graphics.*
import android.media.*
import android.os.Build
import android.util.Log
import android.view.Surface   // <-- add this import
import com.facebook.react.bridge.*
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class TimelapseBuilderModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TimelapseBuilder"

  @ReactMethod
  fun build(options: ReadableMap, promise: Promise) {
    var codec: MediaCodec? = null
    var muxer: MediaMuxer? = null
    var inputSurface: Surface? = null

    fun i16(v: Int) = (v / 16) * 16 // multiple of 16

    try {
      val dir = options.getString("dir") ?: return promise.reject("E_ARGS", "Missing dir")
      val fps = max(1, min(120, if (options.hasKey("fps")) options.getInt("fps") else 30))
      val outName = options.getString("outFileName") ?: "timelapse.mp4"

      val dirPath = dir.removePrefix("file://")
      val folder = File(dirPath)
      if (!folder.exists() || !folder.isDirectory) {
        return promise.reject("E_DIR", "Dir not found: $dirPath")
      }

      val frames = folder.listFiles { f -> f.name.startsWith("img_") && f.name.endsWith(".jpg") }
        ?.sortedBy { it.name } ?: emptyList()
      if (frames.isEmpty()) return promise.reject("E_EMPTY", "No frames")

      var w: Int
      var h: Int
      if (options.hasKey("width") && options.hasKey("height")) {
        w = max(2, options.getInt("width"))
        h = max(2, options.getInt("height"))
      } else {
        val first = BitmapFactory.decodeFile(frames.first().absolutePath)
          ?: return promise.reject("E_IMG", "Cannot decode first frame")
        w = first.width; h = first.height
        first.recycle()
      }
      w = max(16, i16(w))
      h = max(16, i16(h))

      val outFile = File(folder, outName)
      if (outFile.exists()) outFile.delete()

      val mime = MediaFormat.MIMETYPE_VIDEO_AVC
      val format = MediaFormat.createVideoFormat(mime, w, h).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)

        val target = (w.toLong() * h.toLong() * fps * 0.07).roundToInt()
        val bitrate = target.coerceIn(2_000_000, 12_000_000)
        setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
        setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
        setInteger(MediaFormat.KEY_FRAME_RATE, fps)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)

        if (Build.VERSION.SDK_INT >= 23) {
          try {
            setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31)
          } catch (_: Throwable) { }
        }
      }

      try {
        codec = MediaCodec.createEncoderByType(mime)
        codec!!.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      } catch (ce: MediaCodec.CodecException) {
        val msg = "configure failed ${w}x$h @${fps}fps, info=${ce.diagnosticInfo}"
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
              val encoded: ByteBuffer = codec!!.getOutputBuffer(outIndex)
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
      val frameMillis = (1000.0 / fps).roundToInt().toLong()

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

        drainEncoder(false)
        try { Thread.sleep(frameMillis) } catch (_: InterruptedException) {}
      }

      drainEncoder(true)

      try { muxer!!.stop() } catch (_: Throwable) {}
      try { muxer!!.release() } catch (_: Throwable) {}
      try { codec!!.stop() } catch (_: Throwable) {}
      try { codec!!.release() } catch (_: Throwable) {}
      try { inputSurface?.release() } catch (_: Throwable) {}  // now resolved

      promise.resolve("file://${outFile.absolutePath}")
    } catch (e: MediaCodec.CodecException) {
      val diag = if (Build.VERSION.SDK_INT >= 21) e.diagnosticInfo else "no-diagnostic"
      Log.e("TimelapseBuilder", "CodecException: $diag", e)
      promise.reject("E_CODEC", "CodecException: $diag", e)
    } catch (e: Throwable) {
      Log.e("TimelapseBuilder", "build error", e)
      try { muxer?.release() } catch (_: Throwable) {}
      try { codec?.release() } catch (_: Throwable) {}
      try { inputSurface?.release() } catch (_: Throwable) {}
      promise.reject("E_EXC", e.message, e)
    }
  }
}
