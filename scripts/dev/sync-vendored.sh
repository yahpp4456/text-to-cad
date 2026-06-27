#!/usr/bin/env bash
#
# sync-vendored.sh — 純 cp 的 vendored Python 套件傳播器（Windows / 無 rsync 用）。
#
# 背景：本 fork 無 symlink、Git Bash 沒有 rsync，scripts/bundle/bundle.sh 的
# `rsync -a --delete` 套件傳播會直接失敗。本腳本以正本 packages/<pkg> 為準，把內容
# 鏡像到所有 vendored 複本（skills/、viewer/、plugins/ 下），含 --delete 語意。
# 詳見 memory: fork-workflow / local-cad-env。
#
# 範圍：只處理「整包鏡像」的純 Python 套件 cadpy / cadpy_metadata，套用與
# scripts/bundle 相同的排除規則（*.md、*.egg-info、test_*.py、tests/…）。
#   - 刻意不處理 cadjs / implicitjs：JS 套件 vendoring 會剝除 *.test.js、/common、
#     /lib 等（規則複雜），且 Viewer 跑預建 dist/，改 JS 源碼需重建 vite 才生效，
#     不是單純檔案鏡像能解的。要動 JS 請走 viewer 的 build 流程。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# 以整包方式 vendored、且純 cp 即可同步的 Python 套件。
PACKAGES=(cadpy cadpy_metadata)

MODE="write"   # write | check
ONLY_PKG=""

usage() {
  cat <<'EOF'
用法: scripts/dev/sync-vendored.sh [--check] [--package <name>]

  把 packages/<pkg> 正本鏡像到所有 vendored 複本（skills/、viewer/、plugins/）。
  取代 Windows/無 rsync 環境下 scripts/bundle/bundle.sh 的 Python 套件傳播。

  --check            只比對、不寫入；任一複本與正本不符就印 DRIFT/STALE 並 exit 1。
  --package <name>   只處理單一套件（cadpy|cadpy_metadata）。
  -h, --help         顯示說明。

  典型流程：改完正本 packages/<pkg>/src 後跑本腳本，skill/CLI runtime 即看到最新邏輯。
  （cadjs / implicitjs 不在範圍內，原因見檔頭註解。）
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --package) shift; ONLY_PKG="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知參數: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [ -n "$ONLY_PKG" ]; then
  case "$ONLY_PKG" in
    cadpy|cadpy_metadata) ;;
    cadjs|implicitjs)
      echo "不支援 $ONLY_PKG：JS 套件需走 viewer build 流程，非檔案鏡像（見檔頭註解）。" >&2
      exit 2 ;;
    *) echo "未知套件: $ONLY_PKG" >&2; exit 2 ;;
  esac
fi

# 與 scripts/bundle 的 cadpy 排除一致：剝除產物/快取/測試/markdown，
# 並保護 editable install 的 *.egg-info（既不複製也不刪）。
list_files() {  # $1 = 根目錄；輸出相對檔案路徑（NUL 分隔）
  find "$1" \
    -type d \( -name '__pycache__' -o -name '.pytest_cache' -o -name '*.egg-info' \
               -o -name 'build' -o -name 'dist' -o -name 'tests' -o -name '__tests__' \) -prune -o \
    -type f ! -name '*.pyc' ! -name '*.md' ! -name 'test_*.py' ! -name '*_test.py' -print0
}

changed=0
drift=0
copies_seen=0

for pkg in "${PACKAGES[@]}"; do
  [ -n "$ONLY_PKG" ] && [ "$ONLY_PKG" != "$pkg" ] && continue
  src_root="packages/$pkg"
  if [ ! -d "$src_root/src" ]; then
    echo "略過 $pkg：找不到正本 $src_root/src" >&2
    continue
  fi

  # 找出所有 vendored 複本的「套件根目錄」（排除正本與 node_modules）。
  while IFS= read -r -d '' dest_root; do
    # 白名單：只認真正的 runtime 複本路徑，擋掉 tests/(單元測試目錄)、tmp/、ref/ 等同名目錄。
    case "$dest_root" in
      ./skills/*|./viewer/*|./plugins/*) ;;
      *) continue ;;
    esac
    copies_seen=$((copies_seen + 1))

    # 1) 以正本為準：缺檔或內容不同 → 複製（check 模式只記 DRIFT）。
    while IFS= read -r -d '' f; do
      rel="${f#"$src_root"/}"
      d="$dest_root/$rel"
      if [ ! -f "$d" ] || ! cmp -s "$f" "$d"; then
        if [ "$MODE" = "check" ]; then
          echo "DRIFT: $d"; drift=1
        else
          mkdir -p "$(dirname "$d")"; cp -p "$f" "$d"
          echo "更新: $d"; changed=$((changed + 1))
        fi
      fi
    done < <(list_files "$src_root")

    # 2) --delete 語意：複本內、正本已不存在的多餘檔 → 刪除（egg-info 等已被 prune，不會誤刪）。
    while IFS= read -r -d '' d; do
      rel="${d#"$dest_root"/}"
      if [ ! -f "$src_root/$rel" ]; then
        if [ "$MODE" = "check" ]; then
          echo "STALE: $d"; drift=1
        else
          rm -f "$d"; echo "刪除多餘: $d"; changed=$((changed + 1))
        fi
      fi
    done < <(list_files "$dest_root")

  done < <(find . -type d -path "*/packages/$pkg" \
              -not -path "./packages/*" -not -path "*/node_modules/*" -print0)
done

echo "----"
echo "掃描 vendored 複本套件根: $copies_seen 個"
if [ "$MODE" = "check" ]; then
  if [ "$drift" -ne 0 ]; then
    echo "✗ 有複本與正本不同步（見上 DRIFT/STALE）" >&2
    exit 1
  fi
  echo "✓ 全部 vendored 複本與正本同步"
else
  echo "✓ 傳播完成，更新 $changed 個檔案"
fi
