import { defineConfig } from "wxt";

export default defineConfig({
  // Load .output/chrome-mv3-dev into your own Chrome (Nano needs a real profile); the dev script still rebuilds it.
  webExt: { disabled: true },
  manifest: {
    name: "TWICE",
    icons: { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" },
    default_locale: "en",
    description: "__MSG_description__",
    permissions: ["sidePanel", "scripting", "storage", "activeTab"],
    // Toolbar button; background.ts makes a click open the side panel.
    action: { default_title: "TWICE" },
    // Requested from the side panel on start so it can capture whichever tab you read in.
    optional_host_permissions: ["<all_urls>"],
    // Tesseract (OCR) runs as WebAssembly.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
