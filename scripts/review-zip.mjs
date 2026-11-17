// 배포용 ZIP: 문서 + 빌드된 앱(app/) + 커밋된 전체 소스(source/). 먼저 npm run review:build 와 커밋을 끝낸다.
// 한글 파일 이름 때문에 파이썬 zipfile 로 묶는다 (Windows tar·Compress-Archive 는 이름이 깨질 수 있음).
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const version = readFileSync("src/review/types.ts", "utf8").match(/REVIEW_VERSION = "([^"]+)"/)[1];
const name = `holdem-hand-review-${version}`;
const stage = join("release", name);
if (!existsSync("dist-review/review.html")) throw new Error("dist-review 가 없습니다. 먼저 npm run review:build");
if (execSync("git status --porcelain", { encoding: "utf8" }).trim()) throw new Error("커밋하지 않은 변경이 있습니다. 소스 ZIP 은 커밋된 내용만 담습니다");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
// 소스: 커밋된 파일 그대로 (git archive → 압축 해제)
mkdirSync(join(stage, "source"));
const tar = join("release", `${name}-source.tar`);
execSync(`git archive --format=tar -o "${tar}" HEAD`, { stdio: "inherit" });
execSync(`python -c "import sys,tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter='data')" "${tar}" "${join(stage, "source")}"`, { stdio: "inherit" });
rmSync(tar);
// 앱: 빌드 결과 + 로컬 서버 + 실행 파일
cpSync("dist-review", join(stage, "app"), { recursive: true });
cpSync("scripts/review-serve.mjs", join(stage, "app", "serve.mjs"));
writeFileSync(join(stage, "app", "실행하기.bat"), Buffer.from("@echo off\r\ncd /d %~dp0\r\nstart \"\" http://127.0.0.1:4189/review.html\r\nnode serve.mjs 4189\r\npause\r\n", "utf8"));
// 문서
cpSync("REVIEW.md", join(stage, "README.md"));
for (const f of ["DATA-CONTRACT.md", "MODEL-LIMITATIONS.md", "TEST-RESULTS.md"]) cpSync(join("docs/review", f), join(stage, f));
const prov = JSON.parse(readFileSync("src/review/provenance.json", "utf8"));
writeFileSync(join(stage, "PROVENANCE.json"), JSON.stringify({ ...prov, package: name, sourceCommit: commit, branch: "hand-review", builtAt: new Date().toISOString() }, null, 2) + "\n");
const zip = join("release", `${name}.zip`);
rmSync(zip, { force: true });
// 윈도우 cmd 는 -c 인자의 줄바꿈에서 명령을 끊으므로 한 줄로 쓴다
execSync(`python -c "import os,sys,zipfile; root,out=sys.argv[1],sys.argv[2]; base=os.path.dirname(root); z=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=9); [z.write(os.path.join(d,f), os.path.relpath(os.path.join(d,f),base)) for d,_,fs in os.walk(root) for f in fs]; z.close()" "${stage}" "${zip}"`, { stdio: "inherit" });
if (!existsSync(zip)) throw new Error("ZIP 을 만들지 못했습니다");
console.log(`ZIP: ${zip} (소스 커밋 ${commit.slice(0, 7)})`);
