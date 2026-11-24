"""盤點原始碼 import 的 OCP / build123d 名稱,在「執行本腳本的直譯器」下哪些不存在。

升級或降級 kernel 前後,用目標環境的 python 跑:
    <venv>/Scripts/python.exe scripts/dev/ocp-names.py packages/cadpy/src apps/cad-chat/src/server/cad apps/cad-chat/py
只查 import 得到的名稱;類別上的靜態方法與列舉值用 ocp-attrs.py。
cadpy/kernel/ocp_compat.py 的命中是預期的:它本來就把兩個 kernel 的名稱都寫出來,用 try/except 選一邊。
"""
import ast, importlib, sys
from collections import defaultdict
from pathlib import Path
roots = [Path(p) for p in sys.argv[1:]]
uses = defaultdict(set)  # (module, name) -> files
for root in roots:
    for f in (root.rglob("*.py") if root.is_dir() else [root]):
        if "__pycache__" in f.parts: continue
        try: tree = ast.parse(f.read_text(encoding="utf-8"))
        except SyntaxError: continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.module.split(".")[0] in ("OCP", "build123d"):
                for a in node.names: uses[(node.module, a.name)].add(f.as_posix())
missing = defaultdict(list)
for (module, name), files in sorted(uses.items()):
    try:
        mod = importlib.import_module(module)
    except Exception as exc:
        missing[module].append((name + f"  <module: {type(exc).__name__}>", files)); continue
    if name != "*" and not hasattr(mod, name):
        try: importlib.import_module(f"{module}.{name}")
        except Exception: missing[module].append((name, files))
print(f"checked {len(uses)} imported names; missing {sum(len(v) for v in missing.values())}")
for module, items in missing.items():
    for name, files in items:
        print(f"  {module}.{name}   <- {', '.join(sorted(Path(x).name for x in files))[:110]}")
