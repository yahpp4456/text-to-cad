#!/usr/bin/env python
"""看圖 harness(render_view.py,藍圖 E1)的整合測:真的把模型離屏畫成 PNG。

跑法(repo 根):
    PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/test_render_view.py

需 build123d 與可用的 OpenGL(Windows 開發機有;無顯示環境的 Linux 可能沒有——那種環境整個類別會
跳過並說明原因,因為產品在那裡的行為就是「看圖工具回報失敗、agent 照常繼續」)。
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import unittest
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
RENDER = REPO / "apps" / "cad-chat" / "src" / "server" / "cad" / "render_view.py"
GEAR = REPO / "models" / "steering_box_rack_pinion" / "steering_box_rack_pinion.py"
WORKDIR = REPO / "models" / ".cadchat" / f"_test_render_view_{os.getpid()}"

sys.path.insert(0, str(REPO / "apps" / "cad-chat" / "py"))


def _run(*argv):
    env = {**os.environ, "PYTHONUTF8": "1"}
    r = subprocess.run([sys.executable, str(RENDER), *map(str, argv)], capture_output=True, text=True,
                       timeout=300, env=env, cwd=str(REPO), encoding="utf-8")
    lines = [line for line in r.stdout.splitlines() if line.strip()]
    try:
        return r.returncode, json.loads(lines[-1])
    except (IndexError, ValueError):
        return r.returncode, {"ok": False, "error": f"no JSON: {r.stdout[-200:]} {r.stderr[-400:]}"}


def _png(path):
    """回 (寬, 高, 不同顏色的像素種類數, 有顏色的像素比例);只支援 8-bit RGB/RGBA、非交錯(OCCT 寫出來的就是這種)。

    「有顏色」= 不是接近白色的背景(三個通道都 > 235)。零件正對鏡頭的平面若過曝成白色,這個比例會掉到接近 0。
    """
    data = Path(path).read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"
    pos, chunks, header = 8, [], None
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            chunks.append(body)
        pos += 12 + length
    width, height, depth, color_type, _c, _f, interlace = header
    assert depth == 8 and interlace == 0 and color_type in (2, 6), header
    bpp = 3 if color_type == 2 else 4
    raw = zlib.decompress(b"".join(chunks))
    stride = width * bpp
    colors, prev = set(), bytearray(stride)
    sampled = tinted = 0
    for y in range(height):
        row_start = y * (stride + 1)
        kind = raw[row_start]
        row = bytearray(raw[row_start + 1:row_start + 1 + stride])
        for i in range(stride):  # PNG 的列濾波還原
            a = row[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if kind == 1:
                row[i] = (row[i] + a) & 255
            elif kind == 2:
                row[i] = (row[i] + b) & 255
            elif kind == 3:
                row[i] = (row[i] + ((a + b) >> 1)) & 255
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                row[i] = (row[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        if y % 8 == 0:  # 取樣即可,省時間
            for x in range(0, stride, bpp * 4):
                pixel = bytes(row[x:x + 3])
                colors.add(pixel)
                sampled += 1
                tinted += min(pixel) <= 235
        prev = row
    return width, height, len(colors), tinted / max(1, sampled)


class RenderHelpersTests(unittest.TestCase):
    """不需要 OpenGL 的部分:視角解析與圖例。"""

    def test_parse_view_presets_and_angles(self):
        from cadchat_ext import render

        self.assertEqual(render.parse_view("ISO"), ("iso", (1.0, -1.0, 1.0)))
        name, (x, y, z) = render.parse_view("90:0")
        self.assertEqual(name, "90:0")
        self.assertAlmostEqual(x, 0.0, places=9)
        self.assertAlmostEqual(y, 1.0, places=9)
        self.assertAlmostEqual(z, 0.0, places=9)
        self.assertAlmostEqual(render.parse_view("0:90")[1][2], 1.0, places=9)
        for bad in ("sideways", "10", "a:b", "0:120", "999:0"):
            with self.assertRaises(ValueError, msg=bad):
                render.parse_view(bad)

    def test_legend_names_each_part_and_marks_repeats(self):
        from cadchat_ext import render

        legend = render.legend_for(["base", "arm", "pin"])
        self.assertEqual([row["part"] for row in legend], ["base", "arm", "pin"])
        self.assertEqual(len({row["color"] for row in legend}), 3)
        many = render.legend_for([f"p{i}" for i in range(len(render.PALETTE) + 2)])
        self.assertEqual(len({row["color"] for row in many}), len(many))  # 色盤用完後加序號,名稱仍不重複


class RenderViewE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not GEAR.exists():
            raise unittest.SkipTest("steering_box_rack_pinion fixture 不存在")
        WORKDIR.mkdir(parents=True, exist_ok=True)
        code, cls.first = _run(GEAR, WORKDIR, "--views", "iso,front,top", "--stem", "probe")
        if not cls.first.get("ok") and "渲染失敗" in str(cls.first.get("error")):
            shutil.rmtree(WORKDIR, ignore_errors=True)
            raise unittest.SkipTest(f"這個環境無法離屏渲染: {cls.first.get('error')}")
        assert code == 0 and cls.first.get("ok"), cls.first

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(WORKDIR, ignore_errors=True)

    def test_one_png_per_view_with_a_legend(self):
        out = self.first
        self.assertEqual([v["view"] for v in out["views"]], ["iso", "front", "top"])
        self.assertEqual([row["part"] for row in out["legend"]], ["housing", "rack", "pinion", "bearing_front", "bearing_rear"])
        self.assertIsNone(out["pose"])
        for v in out["views"]:
            path = REPO / v["file"]
            self.assertTrue(path.exists(), v)
            width, height, colors, _tinted = _png(path)
            self.assertEqual((width, height), (900, 640))
            self.assertGreater(colors, 3, f"{v['view']} 幾乎是空白圖")  # 背景 + 至少幾種零件色與陰影

    def test_ghosting_the_housing_reveals_more_parts(self):
        """外殼不透明時裡面的零件大多被擋住;設成半透明後畫面上的顏色種類變多。"""
        _, solid = _run(GEAR, WORKDIR, "--views", "iso", "--stem", "solid")
        _, ghost = _run(GEAR, WORKDIR, "--views", "iso", "--stem", "ghost", "--ghost", "housing")
        self.assertTrue(solid["ok"] and ghost["ok"], (solid, ghost))
        a, b = (REPO / out["views"][0]["file"] for out in (solid, ghost))
        self.assertNotEqual(a.read_bytes(), b.read_bytes())
        self.assertGreater(_png(b)[2], _png(a)[2])

    def test_faces_square_to_the_camera_keep_their_colour(self):
        """正視 / 俯視時,正對鏡頭的平面要看得到零件的顏色。

        預設材質有鏡面反射:平行光加正交鏡頭,整個平面的反射方向相同,會一起過曝成白色——零件只剩
        輪廓線、分不出顏色(2026-11-25 看真回合的圖才發現;當時的測試只檢查「不是空白」所以沒抓到)。
        """
        gen = WORKDIR / "blocks.py"
        gen.write_text(
            "\n".join([
                "from build123d import Box, Compound, Pos",
                "def gen_step():",
                "    a = Box(40, 20, 30); a.label = 'a'",
                "    b = Pos(50, 0, 0) * Box(40, 20, 30); b.label = 'b'",
                "    return Compound(label='blocks', children=[a, b])",
                "",
            ]),
            encoding="utf-8",
        )
        _, out = _run(gen, WORKDIR, "--views", "front,top,right", "--stem", "square")
        self.assertTrue(out["ok"], out)
        for v in out["views"]:
            _w, _h, _colors, tinted = _png(REPO / v["file"])
            # 兩個方塊正對鏡頭:畫面上應有一大片是零件的顏色(過曝時這個比例不到 2%)
            self.assertGreater(tinted, 0.10, f"{v['view']} 的平面幾乎全白: {tinted:.3f}")

    def test_hide_drops_the_part_from_the_legend(self):
        _, out = _run(GEAR, WORKDIR, "--views", "iso", "--stem", "hidden", "--hide", "housing")
        self.assertTrue(out["ok"], out)
        self.assertNotIn("housing", [row["part"] for row in out["legend"]])

    def test_clip_and_wire_modes_render(self):
        _, clip = _run(GEAR, WORKDIR, "--views", "iso", "--stem", "clip", "--clip", "x:0")
        _, wire = _run(GEAR, WORKDIR, "--views", "iso", "--stem", "wire", "--mode", "wire")
        self.assertTrue(clip["ok"] and wire["ok"], (clip, wire))
        self.assertNotEqual((REPO / clip["views"][0]["file"]).read_bytes(), (REPO / self.first["views"][0]["file"]).read_bytes())

    def test_pose_moves_the_parts_before_rendering(self):
        """指定具名姿態 → 零件先擺到那個位置再畫(與驗證、前端播放同一套擺法)。"""
        gen = WORKDIR / "posecase.py"
        gen.write_text(
            "from build123d import Box, Compound, Pos\n"
            "def gen_step():\n"
            "    base = Box(60, 20, 4); base.label = 'base'\n"
            "    slider = Pos(-20, 0, 7) * Box(10, 10, 10); slider.label = 'slider'\n"
            "    return Compound(label='posecase', children=[base, slider])\n"
            "MOTION = {'dofs': [{'id': 'x', 'axis': [1, 0, 0], 'travel': 40.0, 'moving': ['slider'],\n"
            "                    'pairs': [['slider', 'base']]}],\n"
            "          'states': {'home': {}, 'out': {'x': 1.0}}}\n",
            encoding="utf-8",
        )
        _, home = _run(gen, WORKDIR, "--views", "front", "--stem", "home")
        _, out = _run(gen, WORKDIR, "--views", "front", "--stem", "out", "--pose", "out")
        self.assertTrue(home["ok"] and out["ok"], (home, out))
        self.assertEqual((home["pose"], out["pose"]), (None, "out"))
        self.assertNotEqual((REPO / home["views"][0]["file"]).read_bytes(), (REPO / out["views"][0]["file"]).read_bytes())
        code, bad = _run(gen, WORKDIR, "--pose", "nope")
        self.assertEqual(code, 1)
        self.assertIn("已宣告的姿態: home, out", bad["error"])

    def test_errors_are_reported_as_json(self):
        code, out = _run(GEAR, WORKDIR, "--hide", "nope")
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertIn("hide / ghost 引用不存在的零件: nope", out["error"])
        self.assertIn("housing", out["error"])  # 順便告訴呼叫端有哪些零件可用
        code, out = _run(GEAR, WORKDIR, "--views", "sideways")
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertIn("視角無效", out["error"])
        code, out = _run(GEAR, WORKDIR, "--pose", "open")
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertIn("未知的姿態 'open'", out["error"])
        code, out = _run(GEAR, WORKDIR, "--clip", "q:1")
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertIn("clip.axis 無效", out["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
