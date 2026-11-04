"""cadpy.surface — Alias 式曲面建模(cad-chat 產品設計模式的幾何後端)。

草稿契約 ``surface-draft-v1``(``spec.py``,OCP-free)→ ``SurfaceBuilder``(曲線 → 曲面 → 鏡射 →
縫合 → 加厚/閉殼成實體 → 融合 → 圓角)。每個運算帶建構保證(ValueError 閘,見各模組 docstring 的
探針結論);``analysis`` 量邊連續性(G0/G1/G2)、開放邊、曲率統計、控制點籠、曲率梳。

產生器樣板(由 cad-chat ``surfaceGen.mjs`` 編譯):
    from cadpy.surface import SurfaceBuilder, check_surface_model
    SURFACE_SPEC = {...}
    PARAMS = {"thick": 2.0}
    def gen_step():
        return SurfaceBuilder(SURFACE_SPEC, PARAMS).build()
    def check_geometry(shape):
        check_surface_model(shape, SURFACE_SPEC)

套件 import 保持 OCP-free;build123d/OCP 在呼叫時才載入。
"""
from __future__ import annotations

from cadpy.surface.builder import SurfaceBuilder, check_surface_model, design_rows, harvest_meta, last_build
from cadpy.surface.spec import (
    CONTINUITY,
    CURVE_KINDS,
    SCHEMA_VERSION,
    SURFACE_OPS,
    TOP_OPS,
    SpecError,
    apply_params,
    normalize_spec,
    scalar_params,
    validate_spec,
)

__all__ = [
    "CONTINUITY",
    "CURVE_KINDS",
    "SCHEMA_VERSION",
    "SURFACE_OPS",
    "TOP_OPS",
    "SpecError",
    "SurfaceBuilder",
    "apply_params",
    "check_surface_model",
    "design_rows",
    "harvest_meta",
    "last_build",
    "normalize_spec",
    "scalar_params",
    "validate_spec",
]
