#!/usr/bin/env bash
# 빌드 결과물(dist)을 공개 저장소 thstjdals09-lang/gto-studio 의 main 브랜치로 배포한다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$ROOT/../gto-studio-site"
cd "$ROOT"
npx vite build
if [ ! -d "$SITE/.git" ]; then
  mkdir -p "$SITE"
  git -C "$SITE" init -q -b main
  git -C "$SITE" remote add origin https://github.com/thstjdals09-lang/gto-studio.git
fi
# .git 을 제외한 기존 파일 정리 후 복사
find "$SITE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
# 이전 캐시 기준 포스트플랍 조각(btn-bb-srp 등)과 보관용 *.old.json 은 배포하지 않는다
tar -C "$ROOT/dist" --exclude='./lib/postflop/btn-bb-srp' --exclude='./lib/postflop/co-bb-srp' --exclude='./lib/postflop/sb-bb-srp' --exclude='./lib/postflop/bb-btn-3bp' --exclude='*.old.json' -cf - . | tar -C "$SITE" -xf -
touch "$SITE/.nojekyll"
cat > "$SITE/README.md" <<'MD'
# 홀덤 GTO 스튜디오 (배포본)

https://thstjdals09-lang.github.io/gto-studio/

브라우저에서 동작하는 홀덤 GTO 학습 웹앱의 빌드 결과물과 미리 풀어둔 솔루션 데이터입니다.
MD
cd "$SITE"
git add -A
if git diff --cached --quiet; then echo "변경 없음"; exit 0; fi
git commit -q -m "배포 $(date +%Y-%m-%d_%H:%M)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q -u origin main
echo "배포 완료"
