"""盤點原始碼對 OCP 類別的屬性存取(靜態方法、列舉值),在「執行本腳本的直譯器」下哪些不存在。

用法同 ocp-names.py。只看得到「以 from OCP.x import Name 綁定的名稱」上的屬性;實例方法
(例如 Bnd_Box().Get())查不到,那一類要靠 fixtures 回歸與測試。
"""
import ast, importlib, sys
from collections import defaultdict
from pathlib import Path
missing = defaultdict(set); checked = 0
for root in map(Path, sys.argv[1:]):
    for f in (root.rglob("*.py") if root.is_dir() else [root]):
        if "__pycache__" in f.parts: continue
        try: tree = ast.parse(f.read_text(encoding="utf-8"))
        except SyntaxError: continue
        bound = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("OCP"):
                for a in node.names:
                    try: bound[a.asname or a.name] = getattr(importlib.import_module(node.module), a.name)
                    except Exception: pass
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in bound:
                checked += 1
                if not hasattr(bound[node.value.id], node.attr):
                    missing[f"{node.value.id}.{node.attr}"].add(f"{f.name}:{node.lineno}")
print(f"checked {checked} attribute uses; missing {len(missing)} distinct")
for name, where in sorted(missing.items()):
    print(f"  {name}  x{len(where)}  e.g. {sorted(where)[0]}")
