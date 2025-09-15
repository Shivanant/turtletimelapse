import React, { useMemo, useRef, useState, useEffect } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert, TextInput, Platform } from "react-native";
import { CameraView, CameraType, useCameraPermissions } from "expo-camera";
import type { CameraCapturedPicture } from "expo-camera";
import { Directory, File, Paths } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useRouter } from "expo-router";

// Proper ref type for CameraView
type CameraViewRef = React.ElementRef<typeof CameraView>;
const KEEP_TAG = "timelapse-capture";

const zpad = (n: number, w = 5) => String(n).padStart(w, "0");
const clampInt = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.floor(n)));

export default function CaptureScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("back");
  const camRef = useRef<CameraViewRef | null>(null);
  const router = useRouter();

  // Controls
  const [ppm, setPpm] = useState<string>("6");     // pictures per minute
  const [hours, setHours] = useState<string>("3"); // duration hours
  const [fps, setFps] = useState<string>("30");    // for final-length estimate

  // Session state (for UI)
  const [sessionDir, setSessionDir] = useState<string | null>(null);
  const [framesPlanned, setFramesPlanned] = useState(0);
  const [framesCaptured, setFramesCaptured] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Idle");

  // Refs for timer-safe values (avoid stale closures)
  const runningRef = useRef(false);
  const sessionDirRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextShotAtRef = useRef<number>(0);
  const frameIndexRef = useRef<number>(0);

  // Derived numbers
  const computed = useMemo(() => {
    const PPM = clampInt(Number(ppm) || 0, 1, 600);
    const H = clampInt(Number(hours) || 0, 1, 24);
    const planned = PPM * H * 60;
    const FPS = clampInt(Number(fps) || 0, 1, 120);
    const estSeconds = Math.round(planned / FPS);
    return { PPM, H, planned, FPS, estSeconds };
  }, [ppm, hours, fps]);

  // KeepAwake only while capturing
  useEffect(() => {
    (async () => {
      try {
        if (isRunning) await activateKeepAwakeAsync(KEEP_TAG);
        else await deactivateKeepAwake(KEEP_TAG);
      } catch {}
    })();
    return () => {
      deactivateKeepAwake(KEEP_TAG).catch(() => {});
    };
  }, [isRunning]);

  // Helpers (new FileSystem API)
  const ensureDir = async (uri: string) => {
    const d = new Directory(uri);
    const info = await d.info();
    if (!info.exists) await d.create({ intermediates: true });
  };

  const startCapture = async () => {
    // permissions
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return;
    }
    if (runningRef.current) return;

    setStatus("Starting…");
    setFramesPlanned(computed.planned);
    setFramesCaptured(0);
    frameIndexRef.current = 0;

    // session folder (SDK54: Paths.document.uri)
    const base = Paths.document.uri || Paths.cache.uri; // fallback just in case
    const id = `session_${Date.now()}`;
    const dir = `${base}timelapse/${id}/`;
    await ensureDir(dir);
    setSessionDir(dir);
    sessionDirRef.current = dir; // timer-safe

    // mark running (ref + state)
    runningRef.current = true;
    setIsRunning(true);

    const intervalMs = Math.max(500, Math.floor(60000 / computed.PPM));
    nextShotAtRef.current = Date.now(); // shoot immediately

    const tick = async () => {
      if (!runningRef.current || !camRef.current) return;

      const now = Date.now();
      if (now >= nextShotAtRef.current) {
        try {
          setStatus("Capturing…");
          const pic: CameraCapturedPicture | undefined =
            await camRef.current.takePictureAsync({ skipProcessing: true, quality: 0.9 });

          const dirNow = sessionDirRef.current;
          if (pic?.uri && dirNow) {
            const idx = frameIndexRef.current + 1;
            const dst = `${dirNow}img_${zpad(idx)}.jpg`;
            await new File(pic.uri).move(new File(dst)); // new API
            frameIndexRef.current = idx;
            setFramesCaptured(idx);
            setStatus(`Captured ${idx}/${computed.planned}`);
          } else {
            console.warn("Missing session dir or pic URI", { dirNow, hasPic: !!pic?.uri });
          }
        } catch (e: any) {
          console.warn("Capture error", e);
          setStatus(`Capture error: ${String(e?.message || e)}`);
        }
        nextShotAtRef.current += intervalMs; // drift-corrected
      }

      const delay = Math.max(0, nextShotAtRef.current - Date.now());
      timerRef.current = setTimeout(tick, Math.min(delay, 1000));
    };

    tick(); // kick off loop
  };

  const stopCapture = () => {
    runningRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setIsRunning(false);
    setStatus("Stopped");
  };

  const clearSession = async () => {
    const dir = sessionDirRef.current;
    if (!dir) return;
    try {
      await new Directory(dir).delete(); // new API
      sessionDirRef.current = null;
      setSessionDir(null);
      setFramesCaptured(0);
      setFramesPlanned(0);
      setStatus("Session cleared");
    } catch (e: any) {
      Alert.alert("Error", String(e?.message || e));
    }
  };

  // Debug: list saved frames (uses ref so it works right after Start)
  const listFrames = async () => {
    const dir = sessionDirRef.current;
    if (!dir) {
      Alert.alert("No session");
      return;
    }
    try {
      const entries = await new Directory(dir).list(); // returns (File|Directory)[]
      const imgs = entries
        .filter((e): e is File => e instanceof File && e.name.startsWith("img_"))
        .map((f) => f.name)
        .sort();

      Alert.alert(
        "Frames on disk",
        `${imgs.length} files\n${imgs.slice(0, 5).join("\n")}${imgs.length > 5 ? "\n…" : ""}`
      );
    } catch (e: any) {
      Alert.alert("List error", String(e?.message || e));
    }
  };

  // Permissions UI
  if (!permission) {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>Requesting camera permission…</Text>
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>We need your permission to show the camera</Text>
        <TouchableOpacity style={styles.pill} onPress={requestPermission}>
          <Text style={styles.pillText}>Grant permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      <CameraView
        ref={camRef}
        style={{ flex: 1 }}
        facing={facing}
        onCameraReady={() => console.log("Camera ready")}
      />

      {/* Overlay UI */}
      <View style={styles.overlay}>
        {/* Controls row 1 */}
        <View style={styles.row}>
          <Field label="PPM" value={ppm} onChange={setPpm} placeholder="6" />
          <Field label="Hours" value={hours} onChange={setHours} placeholder="3" />
        </View>
        {/* Controls row 2 */}
        <View style={styles.row}>
          <Field label="FPS" value={fps} onChange={setFps} placeholder="30" />
          <TouchableOpacity
            style={styles.pill}
            onPress={() => setFacing(facing === "back" ? "front" : "back")}
          >
            <Text style={styles.pillText}>Flip</Text>
          </TouchableOpacity>
        </View>

        {/* Actions */}
        <View style={styles.row}>
          {!isRunning ? (
            <TouchableOpacity style={[styles.pill, styles.primary]} onPress={startCapture}>
              <Text style={styles.primaryText}>Start</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.pill, styles.stop]} onPress={stopCapture}>
              <Text style={styles.pillText}>Stop</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.pill, { opacity: framesCaptured ? 1 : 0.5 }]}
            disabled={!framesCaptured}
            onPress={() => {
              const dir = sessionDirRef.current;
              if (!dir) return;
              router.push({ pathname: "/build", params: { dir, fps: String(computed.FPS) } });
            }}
          >
            <Text style={styles.pillText}>Build video</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.pill} onPress={clearSession}>
            <Text style={styles.pillText}>Clear</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.pill} onPress={listFrames}>
            <Text style={styles.pillText}>List</Text>
          </TouchableOpacity>
        </View>

        {/* Stats */}
        <View style={styles.panel}>
          <Text style={styles.stat}>Status: {status}</Text>
          <Text style={styles.stat}>
            Frames: {framesCaptured}
            {framesPlanned ? ` / ${framesPlanned}` : ""}
          </Text>
          <Text style={styles.stat}>
            Final video ≈ {computed.estSeconds}s @ {computed.FPS}fps
          </Text>
          <Text style={[styles.stat, styles.dir]}>Dir: {sessionDir ?? "(none)"}</Text>
        </View>
      </View>
    </View>
  );
}

// Small numeric field
function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "numeric"}
        value={value}
        onChangeText={(t) => onChange(t.replace(/[^0-9]/g, ""))}
        placeholder={placeholder}
        placeholderTextColor="#8b8b8b"
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "black" },
  msg: { color: "#ddd", textAlign: "center", padding: 16 },
  overlay: { position: "absolute", left: 12, right: 12, bottom: 20, gap: 10 },
  row: { flexDirection: "row", gap: 10 },
  label: { color: "#bbb", marginBottom: 6, fontSize: 12 },
  input: {
    backgroundColor: "rgba(20,20,20,0.85)",
    color: "white",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
  },
  pill: {
    backgroundColor: "rgba(30,30,30,0.9)",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: "white" },
  stop: { backgroundColor: "#a22" },
  pillText: { color: "white", fontWeight: "700" },
  primaryText: { color: "black", fontWeight: "800" },
  panel: {
    backgroundColor: "rgba(0,0,0,0.6)",
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
  },
  stat: { color: "#ddd", fontSize: 12 },
  dir: { color: "#9aa" },
});
