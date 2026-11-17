// 빌드된 복기 앱을 이 컴퓨터에서만 여는 작은 정적 서버 (추가 패키지 없음). ZIP 의 app/serve.mjs 로 들어간다.
// 사용: node serve.mjs [포트]   → http://127.0.0.1:4189/review.html
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.REVIEW_ROOT ?? join(fileURLToPath(new URL(".", import.meta.url))));
const port = Number(process.argv[2] ?? 4189);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".bin": "application/octet-stream", ".ico": "image/x-icon" };

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const file = normalize(join(root, path === "/" ? "review.html" : path));
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("없음");
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`핸드 복기: http://127.0.0.1:${port}/review.html  (끄려면 Ctrl+C)`));
