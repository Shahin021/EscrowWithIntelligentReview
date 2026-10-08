import { defineConfig } from "vite";

// Relative base so the build works under a GitHub Pages repository subpath
// (/<repo>/) as well as at a domain root, without hardcoding the repo name.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  test: { environment: "node", include: ["test/**/*.test.js"] },
});
