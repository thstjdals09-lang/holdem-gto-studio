// SDK 빌드: 저장소 루트에서 `node sdk/build.mjs` (타입 선언은 `npx tsc -p sdk`)
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
const banner = { js: `/*! holdem-gto-solver ${pkg.version} — (c) thstjdals09-lang. 무단 재배포 금지. */` };
const common = { bundle: true, format: "esm", target: "es2022", minify: true, legalComments: "none", logLevel: "warning", banner };
const out = (f) => new URL(`./dist/${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await Promise.all([
  build({ ...common, entryPoints: ["sdk/src/index.ts"], outfile: out("gto.js"), platform: "neutral", mainFields: ["module", "main"] }),
  build({ ...common, entryPoints: ["sdk/src/node.ts"], outfile: out("gto-node.js"), platform: "node" }),
  build({ ...common, entryPoints: ["sdk/src/sub-worker.ts"], outfile: out("gto-sub-worker.js"), platform: "browser" }),
  build({ ...common, entryPoints: ["sdk/src/sub-worker-node.ts"], outfile: out("gto-sub-worker-node.js"), platform: "node" })
]);
console.log("SDK 빌드 완료: sdk/dist");
