"""SMC CG1 圓身氣壓缸 — 標準件原子(pneumatic_cylinder 產生器 dogfood）。

尺寸不是手打:由 ``cadpy.parts.load_specs('cylinders')`` 取回規格庫裡
``model == PARAMS['model']`` 那一列(bore / rod_dia / body_dia），再餵給
``pneumatic_cylinder`` 產生簡化替身(缸身 + 伸縮桿)。也就是「規格庫決定尺寸
包絡、產生器決定長相」的完整鏈路,換型號只要改 PARAMS['model']。

外觀是 fit/motion 替身(圓身 + 圓桿),不是 SMC datasheet 上的拉桿/法蘭外形——
忠實外形要走匯入真 STEP。桿沿 +Z 伸出,缸底在 z=0。
"""

from __future__ import annotations

from cadpy.parts import load_specs, pneumatic_cylinder

PARAMS = {
    "model": "CG1BN63",   # 規格庫 cylinders.json 內的 SMC CG1 列
    "stroke": 100.0,      # 行程(mm;需落在該列 stroke_min~stroke_max）
    "extension": 0.0,     # 目前桿伸出量(0=全縮;0~stroke）
    "rod_protrusion": 8.0,  # 全縮時桿仍外露量(給夾頭/接頭用）
}


def _row():
    """從規格庫取回 PARAMS['model'] 那一列(單一真相源）。"""
    for r in load_specs("cylinders"):
        if r.get("model") == PARAMS["model"]:
            return r
    raise ValueError(f"cylinders.json 找不到 model={PARAMS['model']!r}")


def gen_step():
    row = _row()
    stroke = float(PARAMS["stroke"])
    lo, hi = row["stroke_min"], row["stroke_max"]
    if not lo <= stroke <= hi:
        raise ValueError(
            f"{row['series']} {row['model']} 行程 {stroke} 超出型錄範圍 [{lo}, {hi}]"
        )
    return pneumatic_cylinder(
        bore=row["bore"],
        stroke=stroke,
        extension=float(PARAMS["extension"]),
        rod_dia=row["rod_dia"],
        body_dia=row["body_dia"],
        rod_protrusion=float(PARAMS["rod_protrusion"]),
        label_prefix="cg1",
    )


def check_geometry(shape):
    """沿用產生器自身的驗收閘:實體有效 + 只允許 body~rod 的意圖接觸。"""
    from cadpy.parts.pneumatic_cylinder import check_geometry as gate

    gate(shape)


if __name__ == "__main__":
    row = _row()
    shape = gen_step()
    print(f"built: {row['series']} {row['model']} bore{row['bore']} rod{row['rod_dia']} "
          f"body{row['body_dia']} port {row['port']} conf={row['confidence']}")
    print("children:", [c.label for c in shape.children])
    check_geometry(shape)
    print("geometry checks: passed")
