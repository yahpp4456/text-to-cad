#!/usr/bin/env bash
# 逐組跑 Python 測試:不因某一組失敗而中止,每組印一行 PASS/FAIL 摘要(完整 log 在 tmp/pysuite-*.log)。
# scripts/test/test-python.sh 用 set -e,在 Windows 會停在 bambu-labs 的既有失敗,後面的組跑不到。
# 用法(repo 根,Git Bash):bash scripts/dev/run-python-suites.sh
cd "$(dirname "${BASH_SOURCE[0]}")/../.." && mkdir -p tmp
source scripts/test/common.sh
export PYTHONUTF8=1 PYTHON_BIN="$REPO_ROOT/.venv/Scripts/python.exe"
cd "$REPO_ROOT"
run() { # name dir paths...
  local name="$1"; shift
  local log="tmp/pysuite-$(echo "$name" | tr ' /' '__').log"
  if run_python_unittest "$name" "$@" > "$log" 2>&1; then status=PASS; else status=FAIL; fi
  echo "$status  $name  :: $(grep -E '^Ran |^OK|^FAILED' "$log" | tr '\n' ' ')"
}
run "cadpy" tests/python/packages/cadpy packages/cadpy/src
run "cadpy_metadata" tests/python/packages/cadpy_metadata packages/cadpy_metadata/src
for skill in cad dxf gcode sdf srdf urdf; do
  paths=("skills/$skill/scripts")
  if [ "$skill" = cad ] || [ "$skill" = dxf ]; then paths+=("skills/$skill/scripts/packages/cadpy/src"); fi
  [ -d "tests/python/skills/$skill" ] && run "skill-$skill" "tests/python/skills/$skill" "${paths[@]}"
done
run "global" tests/python/global packages/cadpy/src
for t in apps/cad-chat/tests/test_build_meta.py apps/cad-chat/tests/test_validate_motion.py apps/cad-chat/tests/test_validate_sibling_import.py apps/cad-chat/tests/test_worker.py; do
  log="tmp/pysuite-$(basename "$t" .py).log"
  if "$PYTHON_BIN" "$t" > "$log" 2>&1; then status=PASS; else status=FAIL; fi
  echo "$status  $t  :: $(grep -E '^Ran |^OK|^FAILED' "$log" | tr '\n' ' ')"
done
