import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { target: "es2022", sourcemap: false },
  worker: { format: "es" },
  server: { port: 5188 },
  // 시간 예산(3초)을 재는 테스트가 있어서 파일을 동시에 돌리지 않는다 (CPU 를 나눠 쓰면 예산을 넘긴다)
  test: { environment: "node", include: ["tests/**/*.test.ts"], fileParallelism: false }
} as any);
