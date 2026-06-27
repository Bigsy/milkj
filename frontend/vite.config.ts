import { defineConfig } from "vite";

// Builds the Milkdown app straight into the plugin's resources so it ships inside the jar.
// `base: "./"` keeps asset URLs relative, which is required when JCEF loads the page from a
// custom resource scheme rather than an http origin.
export default defineConfig({
  base: "./",
  build: {
    outDir: "../src/main/resources/web",
    emptyOutDir: true,
    target: "chrome120", // JCEF ships a recent Chromium; safe to target modern JS.
    sourcemap: true,
  },
});
