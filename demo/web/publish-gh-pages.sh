#!/bin/sh
# Publishes demo/web/public/ as the root of the `gh-pages` branch, for GitHub
# Pages ("Deploy from a branch: gh-pages / root"). Run ./build.sh first.
#
# Works on the plumbing level (hash-object / mktree / commit-tree): the current
# checkout, index and branch are left untouched, and the git-ignored build
# artifacts are included regardless of .gitignore. The branch starts as an
# orphan; later runs chain a commit onto it, so pushes stay fast-forward.
#
# Usage: demo/web/publish-gh-pages.sh [branch]     (default: gh-pages)
# Then:  git push origin gh-pages
set -e
cd "$(dirname "$0")"

BRANCH="${1:-gh-pages}"
FILES="index.html style.css app.js webfirmware.hex webfirmware.dis"
for f in $FILES; do
  [ -f "public/$f" ] || { echo "public/$f is missing — run ./build.sh first" >&2; exit 1; }
done

# One flat tree with the served files at its root.
tree=$(
  for f in $FILES; do
    printf '100644 blob %s\t%s\n' "$(git hash-object -w 'public/'"$f")" "$f"
  done | git mktree
)
message="Web demo build for GitHub Pages (demo/web/public)"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  commit=$(git commit-tree "$tree" -p "refs/heads/$BRANCH" -m "$message")
  git update-ref "refs/heads/$BRANCH" "$commit"
else
  commit=$(git commit-tree "$tree" -m "$message")
  git branch "$BRANCH" "$commit"
fi

echo "$BRANCH -> $(git rev-parse --short "$commit"): $(git ls-tree --full-tree "$tree" | wc -l | tr -d ' ') files"
echo "publish with: git push origin $BRANCH"
