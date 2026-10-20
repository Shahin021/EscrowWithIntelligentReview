import { defineConfig } from "vite";

// Relative base so the build works under a GitHub Pages repository subpath
// (/<repo>/) as well as at a domain root, without hardcoding the repo name.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, rolldownOptions: { input: { main: "index.html", oneTx: "one-tx.html" } } },
  test: { environment: "node", include: ["test/**/*.test.js"] },
});
