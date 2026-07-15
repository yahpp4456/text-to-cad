"""SMC CQ2 籠型方身薄型缸 — 標準件原子(pneumatic_cylinder 方身路徑 dogfood）。

已升級成 family:尺寸不手打,由 ``load_specs('cylinders')`` 取回
``model == PARAMS['model']`` 那一列(方身 body_shape=square,帶 body_w / corner_hole /
base_len），餵給 ``pneumatic_cylinder`` 生成方塊身 + 四角穿孔 + 圓桿。可被
``select_cylinder(..., body_shape='square')`` 選到。

外觀是 fit/motion 替身,不含端面油口凸座/緩衝等細節。桿沿 +Z 伸出,缸底在 z=0。
換型號改 PARAMS['model'](CQ2B20/25/32/40/50/63)。
"""

from __future__ import annotations

from cadpy.parts import load_specs, pneumatic_cylinder

PARAMS = {
    "model": "CQ2B40",   # 規格庫 cylinders.json 內的 SMC CQ2 方缸列
    "stroke": 30.0,      # 行程(mm;需落在該列 stroke_min~stroke_max）
    "extension": 0.0,    # 目前桿伸出量(0=全縮）
    "rod_protrusion": 6.0,
}


def _row():
    for r in load_specs("cylinders"):
        if r.get("model") == PARAMS["model"]:
            return r
    raise ValueError(f"cylinders.json 找不到 model={PARAMS['model']!r}")


def gen_step():
    row = _row()
    if row.get("body_shape") != "square":
        raise ValueError(f"{row['model']} 不是方身缸(body_shape={row.get('body_shape')!r})")
    stroke = float(PARAMS["stroke"])
    lo, hi = row["stroke_min"], row["stroke_max"]
    if not lo <= stroke <= hi:
        raise ValueError(f"{row['series']} {row['model']} 行程 {stroke} 超出 [{lo}, {hi}]")
    return pneumatic_cylinder(
        bore=row["bore"],
        stroke=stroke,
        extension=float(PARAMS["extension"]),
        rod_dia=row["rod_dia"],
        rod_protrusion=float(PARAMS["rod_protrusion"]),
        body_shape="square",
        body_w=row["body_w"],
        corner_hole=row.get("corner_hole"),
        base_len=row.get("base_len"),
        label_prefix="cq2",
    )


def check_geometry(shape):
    """沿用產生器自身的驗收閘:實體有效 + 只允許 body~rod 的意圖接觸。"""
    from cadpy.parts.pneumatic_cylinder import check_geometry as gate

    gate(shape)


if __name__ == "__main__":
    row = _row()
    shape = gen_step()
    print(f"built: {row['series']} {row['model']} 方身{row['body_w']}×{row['body_w']} "
          f"rod{row['rod_dia']} 角孔{row.get('corner_hole')} port {row['port']} conf={row['confidence']}")
    print("children:", [c.label for c in shape.children])
    check_geometry(shape)
    print("geometry checks: passed")
