// // app/lib/timelapse.ts
// // Tiny wrapper around the native encoder so the rest of the app stays simple.

// import { NativeModules, Platform } from "react-native";
// import * as FileSystem from "expo-file-system";

// type BuildOptions = {
//   dir: string;            // session dir; with or without trailing slash
//   fps: number;            // 1..120
//   width?: number;         // optional (native will infer from first frame if omitted)
//   height?: number;        // optional
//   outFileName?: string;   // defaults to "timelapse.mp4"
// };

// type NativeModuleShape = {
//   build(opts: BuildOptions): Promise<string>; // resolves to file:// URI
// };

// const { TimelapseBuilder } = NativeModules as {
//   TimelapseBuilder?: NativeModuleShape;
// };

// function withTrailingSlash(p: string) {
//   if (!p) return p;
//   return p.endsWith("/") ? p : `${p}/`;
// }

// export async function buildTimelapse(opts: BuildOptions): Promise<string> {
//   if (!TimelapseBuilder?.build) {
//     const hint =
//       Platform.OS === "android"
//         ? "Android native module not found. Ensure TimelapseBuilderPackage is registered in MainApplication.kt."
//         : "iOS native module not found. Ensure the Swift module is added and exported.";
//     throw new Error(`TimelapseBuilder native module missing. ${hint}`);
//   }

//   const dir = withTrailingSlash(opts.dir);
//   if (!dir) throw new Error("No session directory provided.");

//   // Sanity checks for nicer errors
//   const info = await FileSystem.getInfoAsync(dir);
//   if (!info.exists || !info.isDirectory) {
//     throw new Error(`Session directory not found: ${dir}`);
//   }
//   const names = await FileSystem.readDirectoryAsync(dir);
//   const frames = names.filter((n) => n.startsWith("img_") && n.endsWith(".jpg")).sort();
//   if (frames.length === 0) {
//     throw new Error("This session has 0 frames.");
//   }

//   const fps = Math.max(1, Math.min(120, Math.floor(opts.fps || 30)));

//   // Delegate to native (MP4/H.264 encoding)
//   const uri = await TimelapseBuilder.build({
//     dir,
//     fps,
//     width: opts.width,  
//     height: opts.height,
//     outFileName: opts.outFileName ?? "timelapse.mp4",
//   });

//   return uri; // file://… path
// }
// app/lib/timelapse.ts
// Tiny wrapper around the native encoder so the rest of the app stays simple.

import { NativeModules, Platform } from "react-native";
import { File, Directory } from "expo-file-system";

type BuildOptions = {
  dir: string;            // session dir; file:// URI or plain path
  fps: number;            // 1..120
  width?: number;         // optional (native will infer from first frame if omitted)
  height?: number;        // optional
  outFileName?: string;   // defaults to "timelapse.mp4"
};

type NativeModuleShape = {
  build(opts: BuildOptions): Promise<string>; // resolves to file:// URI
};

const { TimelapseBuilder } = NativeModules as {
  TimelapseBuilder?: NativeModuleShape;
};

export async function buildTimelapse(opts: BuildOptions): Promise<string> {
  if (!TimelapseBuilder?.build) {
    const hint =
      Platform.OS === "android"
        ? "Android native module not found. Ensure TimelapseBuilderPackage is registered in MainApplication.kt."
        : "iOS native module not found. Ensure the Swift module is added and exported.";
    throw new Error(`TimelapseBuilder native module missing. ${hint}`);
  }

  if (!opts.dir) throw new Error("No session directory provided.");

  // New API: model the session folder as a Directory
  const sessionDir = new Directory(opts.dir);

  // Sanity checks for nicer errors
  if (!sessionDir.exists) {
    throw new Error(`Session directory not found: ${sessionDir.uri}`);
  }

  // New API: list() returns File | Directory instances
  const entries = await sessionDir.list();

  // Keep only JPG frames named img_*.jpg (files only), sorted by name
  const frames = entries
    .filter((e): e is File => e instanceof File)
    .filter((f) => f.name.startsWith("img_") && f.name.endsWith(".jpg"))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (frames.length === 0) {
    throw new Error("This session has 0 frames.");
  }

  const fps = Math.max(1, Math.min(120, Math.floor(opts.fps || 30)));

  // Delegate to native (MP4/H.264 encoding). Pass the directory's URI.
  const uri = await TimelapseBuilder.build({
    dir: sessionDir.uri,
    fps,
    width: opts.width,
    height: opts.height,
    outFileName: opts.outFileName ?? "timelapse.mp4",
  });

  return uri; // file://… path
}
