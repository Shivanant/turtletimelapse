// app/build.tsx
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView, TextInput, Platform } from "react-native";
import { Directory, File } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import { useLocalSearchParams, useRouter } from "expo-router";
import { buildTimelapse } from "../lib/timelapse"; // keep if app/lib/timelapse.ts exists

export default function BuildScreen() {
  const router = useRouter();
  const { dir, fps: fpsParam } = useLocalSearchParams<{ dir?: string; fps?: string }>();
  const [fps, setFps] = useState<string>(fpsParam ?? "30");
  const [frameCount, setFrameCount] = useState(0);
  const [building, setBuilding] = useState(false);
  const [log, setLog] = useState<string>("");
  const [outPath, setOutPath] = useState<string | null>(null);

  const sessionDir = useMemo(() => (dir?.endsWith("/") ? dir : `${dir ?? ""}/`), [dir]);

  useEffect(() => {
    (async () => {
      if (!sessionDir) return;
      const entries = await new Directory(sessionDir).list(); // (File|Directory)[]
      const imgs = entries
        .filter((e): e is File => e instanceof File && e.name.startsWith("img_") && e.name.endsWith(".jpg"))
        .map((f) => f.name)
        .sort();
      setFrameCount(imgs.length);
    })().catch((e) => Alert.alert("Error", String(e)));
  }, [sessionDir]);

  const buildVideo = async () => {
    if (!sessionDir) return Alert.alert("No session", "Missing session directory.");
    if (!frameCount) return Alert.alert("No frames", "This session has 0 frames.");

    const FPS = Math.max(1, Math.min(120, Math.floor(Number(fps) || 30)));
    const outputUri = `${sessionDir}timelapse.mp4`;
    try {
      await new File(outputUri).delete(); // idempotent-ish
    } catch {
      /* ignore */
    }

    try {
      setBuilding(true);
      setLog("Encoding…");
      const resultUri = await buildTimelapse({
        dir: sessionDir,
        fps: FPS,
        outFileName: "timelapse.mp4",
      });
      setOutPath(resultUri);
      setLog((s) => s + "\nDone.");
      Alert.alert("Build complete", "Timelapse video created.");
    } catch (e: any) {
      Alert.alert("Build error", String(e?.message || e));
      setLog(String(e?.message || e));
    } finally {
      setBuilding(false);
    }
  };

  const saveToGallery = async () => {
    if (!outPath) return Alert.alert("No video", "Build the video first.");
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (perm.status !== "granted") return Alert.alert("Permission needed", "Photos/Media permission is required.");
    try {
      const asset = await MediaLibrary.createAssetAsync(outPath);
      let album = await MediaLibrary.getAlbumAsync("Turtle Timelapse");
      if (!album) album = await MediaLibrary.createAlbumAsync("Turtle Timelapse", asset, false);
      else await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
      Alert.alert("Saved", "Video added to your gallery.");
    } catch (e: any) {
      Alert.alert("Save error", String(e?.message || e));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      <View style={styles.header}>
        <Text style={styles.h1}>Build Video</Text>
        <Text style={styles.sub}>Dir: <Text style={styles.mono}>{sessionDir ?? "(none)"}</Text></Text>
        <Text style={styles.sub}>Frames: {frameCount}</Text>

        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>FPS</Text>
            <TextInput
              value={fps}
              onChangeText={(t) => setFps(t.replace(/[^0-9]/g, ""))}
              keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "numeric"}
              placeholder="30"
              placeholderTextColor="#8b8b8b"
              style={styles.input}
            />
          </View>

          <TouchableOpacity style={[styles.btn, styles.primary]} disabled={building} onPress={buildVideo}>
            <Text style={styles.btnPrimaryText}>{building ? "Building…" : "Build"}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.row}>
          <TouchableOpacity style={[styles.btn, { opacity: outPath ? 1 : 0.5 }]} disabled={!outPath} onPress={saveToGallery}>
            <Text style={styles.btnText}>Save to Gallery</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btn} onPress={() => router.back()}>
            <Text style={styles.btnText}>Back</Text>
          </TouchableOpacity>
        </View>

        {outPath ? <Text style={styles.sub}>Output: <Text style={styles.mono}>{outPath}</Text></Text> : null}
      </View>

      <Text style={styles.logTitle}>Logs</Text>
      <ScrollView style={styles.logBox}>
        <Text style={styles.logText}>{log || "—"}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 14, paddingTop: 16 },
  h1: { color: "white", fontSize: 20, fontWeight: "800", marginBottom: 6 },
  sub: { color: "#bbb", marginBottom: 4 },
  mono: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) ?? undefined, color: "#ccc" },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 10 },
  label: { color: "#bbb", marginBottom: 6, fontSize: 12 },
  input: {
    backgroundColor: "rgba(20,20,20,0.85)",
    color: "white",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)",
  },
  btn: {
    backgroundColor: "rgba(30,30,30,0.9)",
    paddingVertical: 12, paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)",
  },
  btnText: { color: "white", fontWeight: "700" },
  primary: { backgroundColor: "white" },
  btnPrimaryText: { color: "black", fontWeight: "800" },
  logTitle: { color: "#aaa", marginTop: 12, marginLeft: 14 },
  logBox: {
    flex: 1, margin: 14,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)",
    padding: 10,
  },
  logText: { color: "#cfcfcf", fontSize: 12 },
});
