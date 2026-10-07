// Dev server for the long QA runs (dev/vqa-stage.mjs, dev/qa-film.mjs):
// no file watching and no HMR, so edits elsewhere (other worktrees under
// .claude/, the art pipeline) never reload the stage in the middle of a
// filmed scenario.
//
//   npx vite --config dev/vqa-vite.config.ts --port 1450 --strictPort
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  clearScreen: false,
  server: { hmr: false, watch: { ignored: ["**/*"] } },
});
