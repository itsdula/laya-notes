import { rm } from "node:fs/promises";
import path from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// onnxruntime-node is a native addon, so Vite cannot bundle it. Everything else is bundled into .vite.
const NATIVE_PACKAGES = ["onnxruntime-node", "onnxruntime-common"];
const ORT_BINARIES = "node_modules/onnxruntime-node/bin/napi-v6";

function keepInPackage(file: string): boolean {
  if (!file || file === "/package.json" || file === "/node_modules") return true;
  if (file.startsWith("/.vite")) return true;
  return NATIVE_PACKAGES.some((name) => file === `/node_modules/${name}` || file.startsWith(`/node_modules/${name}/`));
}

const config: ForgeConfig = {
  packagerConfig: {
    name: "Laya Notes",
    executableName: "laya-notes",
    appBundleId: "app.laya.notes",
    appCategoryType: "public.app-category.productivity",
    // Without an extension: Electron Packager picks icon.icns on macOS and icon.ico on Windows.
    icon: "assets/icon",
    asar: {
      unpack: "**/node_modules/onnxruntime-node/bin/**",
    },
    ignore: (file) => !keepInPackage(file),
    extendInfo: {
      NSDocumentsFolderUsageDescription: "Laya Notes keeps your notes as Markdown files in a folder you choose.",
      NSDesktopFolderUsageDescription: "Laya Notes keeps your notes as Markdown files in a folder you choose.",
      NSRemovableVolumesUsageDescription: "Laya Notes can keep your notes on an external drive.",
      NSNetworkVolumesUsageDescription: "Laya Notes can keep your notes on a network drive.",
    },
  },
  rebuildConfig: {},
  hooks: {
    // Keep only the ONNX Runtime binaries for the platform being packaged.
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => {
      const root = path.join(buildPath, ORT_BINARIES);
      for (const os of ["darwin", "linux", "win32"]) {
        if (os !== platform) await rm(path.join(root, os), { recursive: true, force: true });
      }
      for (const cpu of ["x64", "arm64"]) {
        if (cpu !== arch) await rm(path.join(root, platform, cpu), { recursive: true, force: true });
      }
    },
  },
  makers: [
    new MakerZIP({}, ["darwin", "win32"]),
    new MakerDMG({ name: "Laya Notes", icon: "assets/icon.icns" }),
    new MakerSquirrel({ name: "laya_notes", setupExe: "Laya Notes Setup.exe", setupIcon: "assets/icon.ico" }),
    new MakerDeb({ options: { name: "laya-notes", productName: "Laya Notes", categories: ["Office"], icon: "assets/icon.png" } }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/model-worker/worker.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
