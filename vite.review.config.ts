// 복기 앱만 따로 빌드한다 (스튜디오 빌드와 섞지 않음). 결과: dist-review/
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist-review",
    sourcemap: false,
    rollupOptions: { input: { index: "review.html" } }
  },
  worker: { format: "es" },
  server: { port: 5189, open: "/review.html" },
  preview: { port: 4189, open: "/review.html" }
});
