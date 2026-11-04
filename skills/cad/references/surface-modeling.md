# 曲面建模(Alias 式)— cadpy.surface 的 kernel 事實與方法

cad-chat「產品設計」模式的幾何後端是 `packages/cadpy/src/cadpy/surface/`(OCP 7.9.3 /
build123d 0.11.0;2026-10-10 探針定案)。agent 不手寫 build123d,只產 `surface-draft-v1`
草稿 JSON;本檔是 prompt 教學與未來擴充的事實來源。

## kernel 事實(探針實測;每條都有對應的 ValueError 閘或測試)

| 事實 | 影響 | 對策(在 cadpy.surface 裡) |
|---|---|---|
| 邊連續性量測要在**同一個邊參數**取兩面的 pcurve(SameParameter);改用 3D 最近點配對會把兩半球量成 3° 假 G0 | 分析誤判 | `analysis.edge_continuity`:同一 t 取 `BRepAdaptor_Curve2d(edge, face).Value(t)` |
| `BRepLProp_SLProps(N=2)` 的主曲率符號看面方向;REVERSED 面要翻號 | G2 判定 | `_oriented_props` 翻法向與符號 |
| G2 用「切平面內垂直邊切向的法曲率」相對偏差 `|k0−k1|/(|k0|+|k1|)`(Rhino EdgeContinuity 定義);OCCT `LocalAnalysis_SurfaceContinuity` 的 G2 是絕對差、對尺度敏感 | 門檻 | `G1_TOL_DEG=0.5`、`G2_REL_TOL=0.05`、近平坦 `FLAT_K=1e-4` 視為 G2 |
| `BRepOffsetAPI_MakeFilling` 的 G2 約束在 B-spline/平面/圓柱鄰面可收,**球面鄰面拒收**(`BRepFill : The continuity is not G0 G1 or G2`) | 補面 | `surfaces.patch`:G2 失敗自動降 G1 並回 notes |
| 補面的支撐邊必須是鄰面**自己的 Edge**(要有 pcurve);草稿只給曲線 id | 契約 | builder 以中點+端點距離幾何配對鄰面的邊 |
| 半模鏡射的接縫:截面在對稱面上的端點切線沒垂直對稱面 → 15–40° 摺線 | 外觀/閘 | builder 量對稱面上的 G0 內邊 → ValueError(flat 端蓋例外) |
| `Solid.thicken` 對 t ≥ 曲率半徑的殼照樣回 valid(2.7× 體積的自交垃圾) | 加厚 | `ops.thicken`:`t < 0.9/max|k|` 閘 + 體積比 0.3–3 合理性 |
| 縫合公差小於縫隙 → 回 COMPOUND(沒縫上);**單面**的旋轉體/環會以 FACE 留在頂層不屬任何 SHELL | 縫合 | `ops.sew`:loose face 逐片自成殼(否則花瓶本體在有把手時被靜默丟掉) |
| 閉殼 → `Solid(shell)` 體積精確;開殼成實體只能加厚 | 成形 | result=solid 無加厚且殼開 → ValueError |
| 多個互相重疊的切除體一次 `cut(*tools)` 會把本體炸成碎片;逐一切正常 | 切除 | `ops.cut` 逐一 |
| 旋轉體的「環」:圓面必須**含**旋轉軸方向(軸沿 Y → 圓放 XY 平面);圓面垂直軸只會掃出退化面 | 輪胎/足環 | 草稿教學明寫 |
| fuse 後 `clean()` 的結果可能是 `Solid` 物件包 COMPOUND;圓角要先拆出真 SOLID | 圓角 | `ops.fuse` 拆 `solids()[0]`,`fillet_sharp` 只對二面角 >1° 的邊 |
| 三顆球融合後圓角 r=3 可行;加一條細溝(半徑 1.2 的掃掠切除)後任何半徑圓角都失敗 | 細節 | 刻意細節與全域圓角二選一(玩偶範本去掉嘴巴溝) |
| 閉合樣條的起點在圓周上會讓「幾乎對稱」的截面 bbox 偏 0.2 mm → 逐面判自對稱失敗 | 鏡射 | builder 以**整個曲面運算的面群**判自對稱(容差 1% 尺度) |
| ThruSections 對閉合截面起點錯位會自動對齊(CheckCompatibility);開放截面方向相反會扭成交叉面 | 放樣 | `surfaces.loft` 檢查相鄰截面起點對起點 |
| `Face(wire)` 對非平面閉合迴圈會用填充面封口(仍是閉殼) | 端蓋 | `cap_free_loops` 用 `ShapeAnalysis_FreeBounds.ConnectEdgesToWires` 串自由邊 |

## 方法(Alias 紀律,對應 prompt.product.mjs)

1. 半模 + 對稱面切線垂直(`symmetry:"YZ"` 時端點 `tangents.end:[-1,0,0]`)。
2. 主面先(2–4 條截面、每條 4–6 點、同向、閉合性一致)→ 次面(補面/Gordon,接縫 G2)→ 三級角與圓角。
3. 厚度 ≤ 0.5 × 最小曲率半徑。
4. 細節 = `role:"cut"`(輪拱/開口/凹槽)與 `role:"add"`(切除後融合:輪子/輪轂/把手);所有部件要與本體相交。
5. 成形後讀 `surface_report`:G0 = 法向夾角 > 0.5°(摺線)、G1 = 相切但曲率跳變、G2 = 曲率連續;斑馬紋折/角/順對應三級。

## 範本(models/product_*,各含 .surface.draft.json + 編譯 .py + STEP/GLB/sidecar)

- `product_vase`:旋轉樣條 + 向內加厚 2.5 + 足環/頸環(旋轉圓)+ 雙把手(弧掃掠 capped,對稱鏡射)。
- `product_mouse_shell`:三截面半模放樣 + YZ 鏡射 + 向內加厚 2 + 底板(capped 拉伸)+ 滾輪槽/拇指凹槽(cut)。
- `product_mickey`:頭/耳/眼/鼻皆 360° 旋轉球 → 融合 → 圓角 1.5。
- `product_roadster`:閉合截面放樣車身(capped)+ 座艙放樣 + 輪拱(cut)+ 四輪輪胎環/輪轂(add)+ 尾翼與支柱 + 車燈球(cut)。
