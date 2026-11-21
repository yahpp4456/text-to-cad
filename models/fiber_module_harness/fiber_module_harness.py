"""光纖模組線 DEMO-FIBER(GM210 四槽:3 條 OM4 光纖 + 2 條 Cat7)— 車上設備箱安裝示意。

來源(SuiYaoEE repo,唯讀,2026-11-16 讀取)
  * 線材表 customers/zhiqi/wiretables/wt_mwduecejtzqp01.json「示範:光纖模組線(GM210)」item DEMO-FIBER:
    - C1–C3:TT-4BB-0029NEA(Belden RAILTUFF 雙芯 OM4 breakout,外徑 7.4、Aqua、子單元 Ø2.1)各 1000 mm;
      A 端 Telegärtner F80073A0000(STX V1 LC-Duplex,多模);兩端分歧處 3M HDBB-205-1-250(全長 68.58);
      芯線號碼管 1A/1B、2A/2B、3C1/3C2(兩端同字);B 端 6 芯進 GMM1-OSC-3-T:
      M1(槽 1)= 1A、2A、3C1(pin 1/2/3),M2(槽 2)= 1B、2B、3C2(pin 1/2/3)。
    - C4–C5:313310 DATA-ENX GigaCAT7 4x2xAWG24 黑 各 1500 mm;A 端 HARTING 21038811805(M12 X 編碼 8 極公頭);
      B 端進 GMM1-CAT7A-IS(C4 → M3 槽 3、C5 → M4 槽 4)。
    - H1:Gimota GM210-40-4P-TAC(殼號 40、4 槽、方法蘭、卡口)。
  * 外形尺寸:app/db/families/{gm210_40_4p_tac, gmm1_osc_3_t, gmm1_cat7a_is, f80073a0000dp, m12_x}.json、
    app/db/accessories/hdbb-205-1-250.json。族檔多半是照片比例估計(見各檔 meta.assumptions)。

示意 / 推定(不是實際外形,看到請當示意)
  * F80073A0000 照片估計全長約 46 mm;GM210 法蘭孔距 55.6 借同廠 GB210;GM210 / GMM1 外廓為估計。
  * GMM1-CAT7A-IS 族檔估 Ø22 × 62,與 GM210 槽位 Ø16 矛盾 → 這裡畫成與光纖模組同級(最大 Ø16.8)才裝得進去。
  * 模組背面的芯線出口(節圓 Ø7.6 上三點)方位是示意,只為了讓 6 條芯線排得開。Cat7 外徑 8.6 為推定(線種檔沒有外徑)。
  * 使用情境是推定(線材表沒寫):軌道車輛設備箱的一角。GM210 從箱外鎖在側牆,配合面朝箱外給車間跳線;
    箱內 3 條光纖下到 C 型軌、P 型夾固定,接車載乙太網路交換器的 3 個 STX 口;Cat7 比光纖長 500 mm,
    走外側兩道,經過交換器旁邊接後方第二台車載設備的 M12 X 編碼口。牆、底板、兩台設備、插座都是示意。
  * 判斷加入的件(線材表沒有):法蘭墊片 10-40451-40(客戶問過)、法蘭 M4 螺絲 / 墊圈 / 螺帽、
    C 型軌 41×21 + M8 底座螺栓、EPDM 內襯 P 型電纜夾(連 M6 螺絲與槽螺帽建成一體)、外被識別套管 C1–C5。

座標
  原點 = 側牆內面與底板頂面交線的中點;+X = 從側牆往箱內(往設備);+Y = 面向設備時的左手邊;+Z 向上。
  側牆 x ∈ [-2, 0]、底板 z ∈ [-2, 0]。GM210 軸線沿 X,配合面朝 -X(箱外)。

總長(線材表 length_datum = connector_rear)
  光纖 = B 側芯線(模組背面 → 分歧點,兩芯平均)+ 外被(分歧點 → 分歧點)+ A 側芯線(分歧點 → STX 尾端);
  Cat7 = 模組背面 → M12 尾端。設備位置由 PARAMS 的長度反算;三條光纖 B 側芯線長短不同,
  差額由各自外被下彎的水平距離吸收,所以每條總長都精確等於參數。

電纜一律用 cadpy.parts.swept_solid(平面路徑):每段電纜都在自己的平面內走(起訖切向 +X,中間一個 S 彎),
用 at=Plane 擺到世界座標。套在線上的件(熱縮分歧套、號碼管、識別套管、P 型夾內襯)內徑 = 線徑 + 0.04,
不靠干涉宣告。
"""
import math

from build123d import Box, Color, Cylinder, Plane, Polygon, Pos, RegularPolygon, Rot, extrude
from cadpy.assembly import AssemblyHelper, label_shape
from cadpy.parts import path_polyline, profile_loops, swept_solid

# ---------------------------------------------------------------------------
# 可調參數
# ---------------------------------------------------------------------------
PARAMS = {
    "fiber_len_mm": 1000.0,   # 光纖 C1–C3 總長(線材表 1000)
    "cat7_len_mm": 1500.0,    # Cat7 C4–C5 總長(線材表 1500)
}

# ---------------------------------------------------------------------------
# 線材(mm)
# ---------------------------------------------------------------------------
FIBER_OD = 7.4            # TT-4BB-0029NEA 外被
LEG_OD = 2.1              # 子單元(芯線)
CAT7_OD = 8.6             # GigaCAT7 4x2xAWG24(推定)
FIT = 0.04                # 套在線上的件:內徑 = 線徑 + FIT(直徑)
LEG_PITCH = 2.6           # 兩芯在分歧套 / STX 尾端的半間距(±)

R_FIBER = 75.0            # 光纖外被彎曲半徑(≈ 10 × OD)
R_LEG = 25.0              # 芯線彎曲半徑
R_CAT7 = 65.0             # Cat7 彎曲半徑(≈ 7.5 × OD)

# ---------------------------------------------------------------------------
# 設備箱(示意)
# ---------------------------------------------------------------------------
WALL_T = 2.0
FLOOR_T = 2.0
WALL_H = 300.0
HALF_W = 140.0            # 側牆 / 底板半寬(Y)

# ---------------------------------------------------------------------------
# GM210-40-4P-TAC(族檔 gm210_40_4p_tac;法蘭在箱外貼墊片,本體穿過側牆)
# ---------------------------------------------------------------------------
GM_Z = 150.0              # 軸線高度
GM_SQ = 70.0              # 方法蘭
GM_CHAMFER = 4.0
GM_FLANGE_T = 4.0
GM_HOLE_PITCH = 55.6
GM_HOLE_D = 5.0
GASKET_T = 1.0
X_FLANGE_BACK = -WALL_T - GASKET_T            # -3
X_FLANGE_FRONT = X_FLANGE_BACK - GM_FLANGE_T  # -7
X_COLLAR_FRONT = X_FLANGE_FRONT - 5.0         # -12
X_FRONT = X_COLLAR_FRONT - 23.0               # -35 配合端
X_BODY_END = 20.0         # 後段 Ø66 本體
X_REAR = 30.0             # 後端螺紋(N1 2 5/16"-16UN,Ø58.8)
GM_ID = 52.0
GM_REAR_ID = 56.0
WALL_CUT_D = 67.0
SLOT_OFF = 12.5 / math.sqrt(2.0)              # 槽位節圓半徑 12.5 → Y/Z 偏移 8.84
# 槽位(面對插座配合面:1 左上、2 右上、3 右下、4 左下)→ 世界 (y, z) 相對軸線
SLOT_YZ = {
    1: (+SLOT_OFF, +SLOT_OFF),
    2: (-SLOT_OFF, +SLOT_OFF),
    3: (-SLOT_OFF, -SLOT_OFF),
    4: (+SLOT_OFF, -SLOT_OFF),
}

# 模組(GMM1):凸緣貼在絕緣座前面,本體穿過絕緣座
X_CARRIER = (-13.5, -5.5)
X_NOSE = (-28.0, -16.8)
X_MOD_FLANGE = (-16.8, -13.5)
X_OSC_REAR = 5.0          # 光纖模組背面(芯線從這裡出來)
X_CAT7_GLAND = 14.0       # CAT7 模組後端壓線座
X_CAT7_REAR = 20.0        # CAT7 模組背面(Cat7 外被從這裡出來)
MOD_BODY_D = 14.9
MOD_FLANGE_D = 16.8
CARRIER_HOLE_D = 15.2
PIN_R = 3.8               # 模組背面芯線出口節圓半徑(示意)
TUBE_X = (31.0, 43.0)     # B 側號碼管(GM210 後端外面)

# ---------------------------------------------------------------------------
# 光纖 B 側(GM210 背後):芯線 → 分歧套(三顆並排,軸線高於 GM210)
# 版面(走線道、出口方位、轉彎順序)以中心線距離檢查挑過:芯線之間 ≥ 芯徑 + 0.8
# ---------------------------------------------------------------------------
FIBER_LANE_Y = {1: 30.0, 2: 0.0, 3: -30.0}    # 走線道(Y)
PIN_ANGLE = {                                  # 模組背面出口方位(deg,自 +Y 往 +Z),key = (模組, 光纖)
    ("m1", 1): 90.0, ("m1", 2): 330.0, ("m1", 3): 210.0,
    ("m2", 1): 90.0, ("m2", 2): 210.0, ("m2", 3): 330.0,
}
LEG_BEND_ORDER = (1, 2, 3)                     # 哪條光纖的芯線先轉(依序佔用 X 區段)
X_LEG_S0 = 60.0           # 第一段 S 彎的轉角點
LEG_S_SPAN = 55.0         # 每條光纖芯線 S 彎的 X 長度
BOOT_Z = GM_Z + 45.0      # B 側分歧套軸線高度
X_BOOT_B = 240.0          # B 側分歧套芯線端

# 分歧套 HDBB-205-1-250(收縮後):從芯線端量起
BOOT_LEN = 68.58
BOOT_TUBE = 30.0          # 兩支芯線腳 [0, 30]
BOOT_SADDLE = (22.0, 30.0)  # 腳與本體之間的鞍部
BOOT_CROTCH = 40.0        # 分歧點(外被端面 / 芯線起點)
BOOT_TUBE_OD = 3.9
BOOT_BODY_OD = 9.6
MARKER_LEN = 15.0         # 外被識別套管長

# 光纖外被下彎(到 C 型軌高度)
X_JACKET_S0 = 370.0
JACKET_SPAN_MAX = 180.0
JACKET_SPAN_MIN = 70.0

# ---------------------------------------------------------------------------
# C 型軌 + P 型夾(示意;41 × 21 輕型 C 型鋼)
# ---------------------------------------------------------------------------
RAIL_W = 41.0
RAIL_H = 21.0
RAIL_T = 2.5
RAIL_SLOT = 22.0
RAIL_HALF = 97.0
RAIL_BOLT_Y = 55.0
RAIL_S1 = 620.0           # 第一道軌(光纖下彎之後)
RAIL_MIN_GAP = 100.0      # 兩道軌最小間距
CLAMP_W = 12.0            # P 型夾帶寬(X)
CLAMP_TAB_W = 24.0        # 底片寬(X,跨在 C 型軌兩唇上)
LINER_T = 1.0
BAND_T = 0.8
TAB_T = 1.0
SCREW_OFF = 11.5          # 螺絲離線中心(Y)


def _liner_od(cable_od):
    return cable_od + FIT + 2 * LINER_T


def _band_od(cable_od):
    return _liner_od(cable_od) + FIT + 2 * BAND_T


def _run_height(cable_od):
    """線中心高度:軌頂 + 底片 + 夾帶半徑(夾帶壓進底片 0.1,一起建成一件)。"""
    return RAIL_H + TAB_T + _band_od(cable_od) / 2 - 0.1


Z_RUN_FIBER = _run_height(FIBER_OD)
Z_RUN_CAT7 = _run_height(CAT7_OD)

# ---------------------------------------------------------------------------
# A 側:分歧套 → 芯線 → STX V1 插頭 → 交換器;Cat7 → M12 → 第二台設備
# ---------------------------------------------------------------------------
A_LEG_FREE = 50.0         # A 側芯線露出長(分歧套腳端 → STX 尾端)
A_LEG = BOOT_CROTCH + A_LEG_FREE
STX_BOOT_STEPS = ((0.0, 4.0, 8.0), (4.0, 8.0, 9.0), (8.0, 12.0, 10.0))   # (起, 訖, 直徑),從尾端量起
STX_BODY = (12.0, 33.0)
STX_LC = (33.0, 43.0)
STX_FERRULE = (43.0, 45.8)
STX_W, STX_H = 14.0, 11.0
STX_LC_PITCH = 6.25
STX_LC_Z = -2.0           # LC 中心低於本體中心
SW_DEPTH, SW_WIDTH, SW_HEIGHT = 140.0, 110.0, 90.0
STX_FLANGE = 26.0
STX_FLANGE_T = 3.0
STX_CAVITY = (14.4, 11.4)

CAT7_LANE_Y = {4: -75.0, 5: 75.0}             # C4 → 槽 3(-Y)、C5 → 槽 4(+Y)
CAT7_SLOT = {4: 3, 5: 4}
X_CAT7_S0 = 80.0
X_CAT7_S1 = 280.0
M12_BODY = ((0.0, 6.0, 10.5), (6.0, 27.0, 13.0))                          # 黑色本體 + 護套
M12_METAL = ((27.0, 29.0, 9.0), (29.0, 39.0, 14.1), (39.0, 43.0, 10.5))   # 肩、滾花螺帽、接合端
M12_NUT_FRONT = 39.0
M12_FLANGE = 20.0
M12_FLANGE_T = 2.0
M12_CAVITY_D = 11.0
D2_DEPTH, D2_WIDTH, D2_HEIGHT = 150.0, 200.0, 120.0

# ---------------------------------------------------------------------------
# 顏色
# ---------------------------------------------------------------------------
COLOR_AQUA = Color(0.0, 0.70, 0.76)
COLOR_LEG = Color(0.36, 0.82, 0.86)
COLOR_CAT7 = Color(0.07, 0.07, 0.08)
COLOR_BOOT = Color(0.12, 0.12, 0.13)
COLOR_WHITE = Color(0.95, 0.95, 0.93)
COLOR_LC = Color(0.90, 0.84, 0.68)
COLOR_METAL = Color(0.74, 0.76, 0.79)
COLOR_GREY = Color(0.45, 0.46, 0.49)
COLOR_GM = Color(0.17, 0.17, 0.19)
COLOR_INSUL = Color(0.30, 0.30, 0.32)
COLOR_MODULE = Color(0.10, 0.10, 0.11)
COLOR_GOLD = Color(0.86, 0.68, 0.22)    # GM210 模組接點 pin(使用者 2026-11-16 指定金色)
COLOR_RUBBER = Color(0.05, 0.05, 0.05)
COLOR_STEEL = Color(0.80, 0.81, 0.83)
COLOR_RAIL = Color(0.66, 0.68, 0.71)
COLOR_PANEL = Color(0.76, 0.78, 0.82, 0.28)
COLOR_SWITCH = Color(0.28, 0.32, 0.38, 0.55)
COLOR_DEVICE2 = Color(0.34, 0.30, 0.40, 0.55)


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) * Box(abs(x1 - x0), abs(y1 - y0), abs(z1 - z0))


def _xcyl(d, x0, x1, y=0.0, z=0.0):
    """沿 X 的圓柱(直徑 d)。"""
    lo, hi = min(x0, x1), max(x0, x1)
    return Pos((lo + hi) / 2, y, z) * Rot(0, 90, 0) * Cylinder(d / 2, hi - lo)


def _xtube(d_out, d_in, x0, x1, y=0.0, z=0.0):
    lo, hi = min(x0, x1), max(x0, x1)
    return _xcyl(d_out, lo, hi, y, z) - _xcyl(d_in, lo - 1, hi + 1, y, z)


def _zcyl(d, z0, z1, x=0.0, y=0.0):
    return Pos(x, y, (z0 + z1) / 2) * Cylinder(d / 2, z1 - z0)


def _zhex(af, z0, z1, x=0.0, y=0.0):
    """沿 Z 的六角柱(對邊 af)。"""
    return Pos(x, y, z0) * extrude(RegularPolygon(af / math.sqrt(3), 6), amount=z1 - z0)


def _xhex(af, x0, x1, y=0.0, z=0.0):
    """沿 X 的六角柱(對邊 af)。"""
    return Pos(min(x0, x1), y, z) * Rot(0, 90, 0) * extrude(RegularPolygon(af / math.sqrt(3), 6), amount=abs(x1 - x0))


def _chamfered_square(size, chamfer, x0, x1, z_center):
    """YZ 平面上的倒角方板(法蘭 / 墊片),沿 X 從 x0 到 x1。"""
    h = size / 2
    c = chamfer
    pts = [(-h + c, -h), (h - c, -h), (h, -h + c), (h, h - c), (h - c, h), (-h + c, h), (-h, h - c), (-h, -h + c)]
    plate = extrude(Plane.YZ * Polygon(*pts, align=None), amount=abs(x1 - x0))
    return Pos(min(x0, x1), 0, z_center) * plate


def _yz_plane(origin, vy, vz):
    """swept_solid 的 at:路徑 (d, e) → 世界 origin + d·(+X) + e·(0, vy, vz)。"""
    return Plane(origin=origin, x_dir=(0.0, vz, -vy), z_dir=(0.0, vy, vz))


def _s_length(d1, d2, d3, delta, radius):
    """直 → S(兩個圓角)→ 直 的弧長(解析)。"""
    if delta < 1e-6:
        return d3
    theta = math.atan2(delta, d2 - d1)
    poly = d1 + math.hypot(d2 - d1, delta) + (d3 - d2)
    return poly - 2 * (2 * radius * math.tan(theta / 2) - radius * theta)


def _s_excess(span, delta, radius):
    """S 彎比同樣 X 距離的直線多出的長度。"""
    return _s_length(0.0, span, span, delta, radius) - span


def _tangent(span, delta, radius):
    """S 彎轉角點到圓弧起點的距離(沿線)。"""
    if delta < 1e-6:
        return 0.0
    return radius * math.tan(math.atan2(delta, span) / 2)


class Run:
    """一段電纜:起點 (x0, y0, z0) 沿 +X,轉角點 xs0 / xs1 之間一個 S 彎移到 (y1, z1),直走到 x_end。"""

    def __init__(self, x0, yz0, xs0, xs1, x_end, yz1, radius, od):
        self.x0, self.yz0, self.xs0, self.xs1, self.x_end, self.yz1 = x0, yz0, xs0, xs1, x_end, yz1
        self.radius, self.od = radius, od
        dy, dz = yz1[0] - yz0[0], yz1[1] - yz0[1]
        self.delta = math.hypot(dy, dz)
        origin = (x0, yz0[0], yz0[1])
        if self.delta < 1e-6:
            self.spec = {"kind": "line", "length": x_end - x0}
            self.at = _yz_plane(origin, 0.0, 1.0)
        else:
            d1, d2, d3 = xs0 - x0, xs1 - x0, x_end - x0
            self.spec = {"kind": "waypoints", "points": [[0, 0], [d1, 0], [d2, self.delta], [d3, self.delta]],
                         "radius": radius}
            self.at = _yz_plane(origin, dy / self.delta, dz / self.delta)

    @property
    def length(self):
        return _s_length(self.xs0 - self.x0, self.xs1 - self.x0, self.x_end - self.x0, self.delta, self.radius)

    @property
    def lead_end(self):
        """第一段直線的終點 X(之後開始彎)。"""
        return self.xs0 - _tangent(self.xs1 - self.xs0, self.delta, self.radius)

    @property
    def tail_start(self):
        """最後一段直線的起點 X。"""
        return self.xs1 + _tangent(self.xs1 - self.xs0, self.delta, self.radius)

    def solid(self):
        return swept_solid({"kind": "circle", "d": self.od}, self.spec, at=self.at)

    def polyline(self, n=128):
        return path_polyline(self.spec, n, at=self.at)


# ---------------------------------------------------------------------------
# 版面(由 PARAMS 反算)
# ---------------------------------------------------------------------------
LEG_NAMES = {1: ("1A", "1B"), 2: ("2A", "2B"), 3: ("3C1", "3C2")}


def _pin_yz(module, cable):
    cy, cz = SLOT_YZ[1 if module == "m1" else 2]
    a = math.radians(PIN_ANGLE[(module, cable)])
    return (cy + PIN_R * math.cos(a), GM_Z + cz + PIN_R * math.sin(a))


def _leg_b_runs():
    """B 側芯線 → [(光纖, 芯線名, 模組, Run)]。M1 的芯線到分歧套 +Y 腳,M2 到 -Y 腳。"""
    x_crotch = X_BOOT_B + BOOT_CROTCH
    out = []
    for j, cable in enumerate(LEG_BEND_ORDER):
        xs0 = X_LEG_S0 + j * LEG_S_SPAN
        lane = FIBER_LANE_Y[cable]
        for module, side, name in (("m1", +1, LEG_NAMES[cable][0]), ("m2", -1, LEG_NAMES[cable][1])):
            run = Run(X_OSC_REAR, _pin_yz(module, cable), xs0, xs0 + LEG_S_SPAN, x_crotch,
                      (lane + side * LEG_PITCH, BOOT_Z), R_LEG, LEG_OD)
            out.append((cable, name, module, run))
    return out


def _solve_span(target_excess, drop):
    """外被下彎要多吃 target_excess 時的 X 長度(多出長度隨 X 長度遞減,二分)。"""
    lo, hi = JACKET_SPAN_MIN, JACKET_SPAN_MAX
    if not _s_excess(hi, drop, R_FIBER) - 1e-9 <= target_excess <= _s_excess(lo, drop, R_FIBER):
        raise ValueError("三條光纖 B 側芯線長度差太多,外被下彎吸收不了(請調整芯線版面)")
    for _ in range(80):
        mid = (lo + hi) / 2
        if _s_excess(mid, drop, R_FIBER) > target_excess:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def _layout():
    """所有由長度反算的位置與電纜路徑;不可行時丟 ValueError(訊息給使用者看)。"""
    p = PARAMS
    legs = _leg_b_runs()
    x_crotch_b = X_BOOT_B + BOOT_CROTCH
    x_boot_b_end = X_BOOT_B + BOOT_LEN
    # 光纖總長 = (x_crotch_a - X_OSC_REAR) + B 芯線 S 彎多出(兩芯平均)+ 外被下彎多出 + A 芯線
    leg_excess = {c: sum(r.length for cc, _, _, r in legs if cc == c) / 2 - (x_crotch_b - X_OSC_REAR)
                  for c in (1, 2, 3)}
    drop = BOOT_Z - Z_RUN_FIBER
    worst = max(leg_excess.values())
    base = _s_excess(JACKET_SPAN_MAX, drop, R_FIBER)
    x_crotch_a = X_OSC_REAR + p["fiber_len_mm"] - worst - base - A_LEG
    jackets = {}
    for c in (1, 2, 3):
        span = _solve_span(base + worst - leg_excess[c], drop)
        lane = FIBER_LANE_Y[c]
        jackets[c] = Run(x_crotch_b, (lane, BOOT_Z), X_JACKET_S0, X_JACKET_S0 + span, x_crotch_a,
                         (lane, Z_RUN_FIBER), R_FIBER, FIBER_OD)

    x_boot_a_cable = x_crotch_a - (BOOT_LEN - BOOT_CROTCH)   # A 側分歧套外被端(較小 X)
    x_stx = x_crotch_a + A_LEG                                # STX 尾端
    x_switch = x_stx + STX_BODY[1] + STX_FLANGE_T             # 交換器前面

    cat7 = {}
    for c in (4, 5):
        sy, sz = SLOT_YZ[CAT7_SLOT[c]]
        start = (sy, GM_Z + sz)
        end = (CAT7_LANE_Y[c], Z_RUN_CAT7)
        span = X_CAT7_S1 - X_CAT7_S0
        excess = _s_excess(span, math.hypot(end[0] - start[0], end[1] - start[1]), R_CAT7)
        x_m12 = X_CAT7_REAR + p["cat7_len_mm"] - excess
        cat7[c] = Run(X_CAT7_REAR, start, X_CAT7_S0, X_CAT7_S1, x_m12, end, R_CAT7, CAT7_OD)
    x_m12 = cat7[4].x_end
    x_dev2 = x_m12 + M12_NUT_FRONT + M12_FLANGE_T

    # 檢查:每段要彎的地方都在直線件(號碼管、分歧套、識別套管)之外
    lead_min = min(r.lead_end for *_, r in legs)
    if lead_min < TUBE_X[1] + 1:
        raise ValueError("B 側芯線轉彎太早,壓到號碼管(X_LEG_S0 要加大)")
    if max(r.tail_start for *_, r in legs) > X_BOOT_B - 1:
        raise ValueError("B 側芯線還沒轉完就進分歧套(X_BOOT_B 要加大)")
    if min(j.lead_end for j in jackets.values()) < x_boot_b_end + MARKER_LEN + 4:
        raise ValueError("光纖外被轉彎太早,壓到識別套管(X_JACKET_S0 要加大)")
    tail = max(j.tail_start for j in jackets.values())
    if tail > RAIL_S1 - CLAMP_TAB_W:
        raise ValueError("光纖外被還沒下到 C 型軌高度就到第一道軌(RAIL_S1 要加大)")
    if x_boot_a_cable - MARKER_LEN - 4 < RAIL_S1 + CLAMP_TAB_W:
        raise ValueError(f"光纖總長 {p['fiber_len_mm']:.0f} mm 太短:下到 C 型軌之後放不下 A 側分歧套與識別套管")
    if min(r.lead_end for r in cat7.values()) < X_REAR + 4 + MARKER_LEN + 1:
        raise ValueError("Cat7 轉彎太早,壓到識別套管(X_CAT7_S0 要加大)")

    rails = [(RAIL_S1, True)]
    s2 = x_boot_a_cable - MARKER_LEN - 4 - CLAMP_TAB_W - 12
    if s2 - RAIL_S1 >= RAIL_MIN_GAP:
        rails.append((s2, True))
    s3 = x_m12 - MARKER_LEN - 4 - CLAMP_TAB_W - 12          # 只夾 Cat7(在交換器後面)
    if s3 - RAIL_W / 2 < x_switch + SW_DEPTH + 15:
        raise ValueError(
            f"Cat7 總長 {p['cat7_len_mm']:.0f} mm 太短:要比光纖長到能繞過交換器"
            f"(目前交換器後緣在 X {x_switch + SW_DEPTH:.0f},Cat7 插頭在 X {x_m12:.0f})")
    rails.append((s3, False))

    return {
        "legs": legs, "jackets": jackets, "cat7": cat7,
        "x_crotch_b": x_crotch_b, "x_boot_b_end": x_boot_b_end,
        "x_crotch_a": x_crotch_a, "x_boot_a_cable": x_boot_a_cable, "x_stx": x_stx, "x_switch": x_switch,
        "x_m12": x_m12, "x_dev2": x_dev2, "rails": rails,
        "x_floor_end": x_dev2 + D2_DEPTH + 40.0,
    }


def _check_params():
    p = PARAMS
    if not 800.0 <= p["fiber_len_mm"] <= 3000.0:
        raise ValueError(f"fiber_len_mm({p['fiber_len_mm']})須在 800~3000 mm")
    if not 800.0 <= p["cat7_len_mm"] <= 4000.0:
        raise ValueError(f"cat7_len_mm({p['cat7_len_mm']})須在 800~4000 mm")
    _layout()   # 幾何上放不下時丟出具體原因


# ---------------------------------------------------------------------------
# 設備箱
# ---------------------------------------------------------------------------
def _flange_holes():
    h = GM_HOLE_PITCH / 2
    return {"tl": (h, GM_Z + h), "tr": (-h, GM_Z + h), "bl": (h, GM_Z - h), "br": (-h, GM_Z - h)}


def _enclosure(lay):
    wall = _box(-WALL_T, 0.0, -HALF_W, HALF_W, 0.0, WALL_H)
    wall -= _xcyl(WALL_CUT_D, -WALL_T - 1, 1, 0.0, GM_Z)
    for y, z in _flange_holes().values():
        wall -= _xcyl(GM_HOLE_D, -WALL_T - 1, 1, y, z)
    floor = _box(-WALL_T, lay["x_floor_end"], -HALF_W, HALF_W, -FLOOR_T, 0.0)
    for xr, _ in lay["rails"]:
        for y in (-RAIL_BOLT_Y, RAIL_BOLT_Y):
            floor -= _zcyl(9.0, -FLOOR_T - 1, 1, xr, y)
    return [
        label_shape(wall, "side_wall", color=COLOR_PANEL),
        label_shape(floor, "floor_plate", color=COLOR_PANEL),
    ]


# ---------------------------------------------------------------------------
# GM210 + 模組 + 法蘭固定件
# ---------------------------------------------------------------------------
def _bayonet_pins():
    """卡口銷(示意,3 支,徑向,獨立一件):Rot(X=120k) 把 +Z 轉到 90°+120k 方位;
    銷根順著前筒外圓切齊(前筒 Ø58 + FIT),與外殼零體積接觸。"""
    pins = None
    for k in range(3):
        a = math.radians(90 + 120 * k)
        y, z = 30.0 * math.cos(a), GM_Z + 30.0 * math.sin(a)
        pin = Pos(-24.0, y, z) * Rot(120 * k, 0, 0) * Cylinder(2.0, 4.0)
        pins = pin if pins is None else pins + pin
    return pins - _xcyl(58.0 + FIT, X_FRONT - 1, X_COLLAR_FRONT + 1, 0.0, GM_Z)


def _gm210(lay):
    parts = []
    shell = _xtube(58.0, GM_ID, X_FRONT, X_COLLAR_FRONT, 0.0, GM_Z)
    shell += _xtube(62.0, GM_ID, X_COLLAR_FRONT, X_FLANGE_FRONT, 0.0, GM_Z)
    flange = _chamfered_square(GM_SQ, GM_CHAMFER, X_FLANGE_FRONT, X_FLANGE_BACK, GM_Z)
    flange -= _xcyl(GM_ID, X_FLANGE_FRONT - 1, X_FLANGE_BACK + 1, 0.0, GM_Z)
    for y, z in _flange_holes().values():
        flange -= _xcyl(GM_HOLE_D, X_FLANGE_FRONT - 1, X_FLANGE_BACK + 1, y, z)
    shell += flange
    shell += _xtube(66.0, GM_REAR_ID, X_FLANGE_BACK, X_BODY_END, 0.0, GM_Z)
    shell += _xtube(58.8, GM_ID, X_BODY_END, X_REAR, 0.0, GM_Z)
    parts.append(label_shape(shell, "gm210_shell", color=COLOR_GM))
    parts.append(label_shape(_bayonet_pins(), "bayonet_pins", color=COLOR_GOLD))

    gasket = _chamfered_square(GM_SQ, GM_CHAMFER, X_FLANGE_BACK, -WALL_T, GM_Z)
    gasket -= _xcyl(WALL_CUT_D, X_FLANGE_BACK - 1, 0, 0.0, GM_Z)
    for y, z in _flange_holes().values():
        gasket -= _xcyl(GM_HOLE_D, X_FLANGE_BACK - 1, 0, y, z)
    parts.append(label_shape(gasket, "flange_gasket", color=COLOR_RUBBER))

    carrier = _xcyl(GM_ID - FIT, *X_CARRIER, 0.0, GM_Z)
    for slot in (1, 2, 3, 4):
        sy, sz = SLOT_YZ[slot]
        carrier -= _xcyl(CARRIER_HOLE_D, X_CARRIER[0] - 1, X_CARRIER[1] + 1, sy, GM_Z + sz)
    parts.append(label_shape(carrier, "insert_carrier", color=COLOR_INSUL))

    for name, (y, z) in _flange_holes().items():
        screw = _xcyl(7.0, X_FLANGE_FRONT - 2.8, X_FLANGE_FRONT, y, z) + _xcyl(4.0, X_FLANGE_FRONT, 6.5, y, z)
        parts.append(label_shape(screw, "flange_screw", name, color=COLOR_STEEL))
        parts.append(label_shape(_xtube(9.0, 4.3, 0.0, 0.8, y, z), "flange_washer", name, color=COLOR_STEEL))
        nut = _xhex(7.0, 0.8, 4.0, y, z) - _xcyl(4.0 + FIT, -1, 6, y, z)
        parts.append(label_shape(nut, "flange_nut", name, color=COLOR_STEEL))

    # 光纖模組 M1 / M2(GMM1-OSC-3-T):鼻端 + 凸緣 + 本體;前面 3 支 SC 插芯另成一件(金色)
    for module, slot in (("m1", 1), ("m2", 2)):
        sy, sz = SLOT_YZ[slot]
        y, z = sy, GM_Z + sz
        body = _xcyl(13.4, *X_NOSE, y, z) + _xcyl(MOD_FLANGE_D, *X_MOD_FLANGE, y, z)
        body += _xcyl(MOD_BODY_D, X_MOD_FLANGE[1], X_OSC_REAR, y, z)
        parts.append(label_shape(body, "fiber_module", module, color=COLOR_MODULE))
        pins = None
        for cable in (1, 2, 3):
            py, pz = _pin_yz(module, cable)
            pin = _xcyl(2.5, X_NOSE[0] - 2.0, X_NOSE[0], py, pz)
            pins = pin if pins is None else pins + pin
        parts.append(label_shape(pins, "contact_pins", module, color=COLOR_GOLD))
    # CAT7 模組 M3 / M4(GMM1-CAT7A-IS):後端壓線座出 Cat7;前面 8 支針(族檔:節圓 Ø8.4、八角排列)另成一件(金色)
    for module, slot in (("m3", 3), ("m4", 4)):
        sy, sz = SLOT_YZ[slot]
        y, z = sy, GM_Z + sz
        body = _xcyl(15.0, *X_NOSE, y, z) + _xcyl(MOD_FLANGE_D, *X_MOD_FLANGE, y, z)
        body += _xcyl(MOD_BODY_D, X_MOD_FLANGE[1], X_CAT7_GLAND, y, z)
        body += _xcyl(12.0, X_CAT7_GLAND, X_CAT7_REAR, y, z)
        parts.append(label_shape(body, "cat7_module", module, color=COLOR_MODULE))
        pins = None
        for k in range(8):
            a = math.radians(22.5 + 45.0 * k)
            pin = _xcyl(1.2, X_NOSE[0] - 3.0, X_NOSE[0], y + 4.2 * math.cos(a), z + 4.2 * math.sin(a))
            pins = pin if pins is None else pins + pin
        parts.append(label_shape(pins, "contact_pins", module, color=COLOR_GOLD))
    return parts


# ---------------------------------------------------------------------------
# 光纖(外被 + 芯線 + 分歧套 + 號碼管 + 識別套管 + STX 插頭)
# ---------------------------------------------------------------------------
def _boot(x_legs, sign, y, z):
    """HDBB 分歧套:x_legs = 芯線端,sign = 往外被端的方向(+1 / -1)。"""
    def at(s):
        return x_legs + sign * s

    boot = _xcyl(BOOT_BODY_OD, at(BOOT_TUBE), at(BOOT_LEN), y, z)
    s0, s1 = BOOT_SADDLE
    boot += _xcyl(4.6, at(s0), at(s1), y - 2.5, z) + _xcyl(4.6, at(s0), at(s1), y + 2.5, z)
    boot += _box(at(s0), at(s1), y - 2.5, y + 2.5, z - 2.3, z + 2.3)
    for side in (-1, 1):
        boot += _xcyl(BOOT_TUBE_OD, at(0.0), at(BOOT_TUBE), y + side * LEG_PITCH, z)
    boot -= _xcyl(FIBER_OD + FIT, at(BOOT_CROTCH), at(BOOT_LEN + 1), y, z)
    for side in (-1, 1):
        boot -= _xcyl(LEG_OD + FIT, at(-1.0), at(BOOT_CROTCH), y + side * LEG_PITCH, z)
    return boot


def _stx_plug(x, y, z, cable):
    boot = None
    for s0, s1, d in STX_BOOT_STEPS:
        piece = _xcyl(d, x + s0, x + s1, y, z)
        boot = piece if boot is None else boot + piece
    body = _box(x + STX_BODY[0], x + STX_BODY[1], y - STX_W / 2, y + STX_W / 2, z - STX_H / 2, z + STX_H / 2)
    lc = None
    for side in (-1, 1):
        cy, cz = y + side * STX_LC_PITCH / 2, z + STX_LC_Z
        piece = _box(x + STX_LC[0], x + STX_LC[1], cy - 2.275, cy + 2.275, cz - 2.3, cz + 2.3)
        piece += _box(x + STX_LC[0], x + STX_LC[0] + 7.0, cy - 1.2, cy + 1.2, cz + 2.3, cz + 3.9)   # 卡榫
        piece += _xcyl(1.25, x + STX_FERRULE[0], x + STX_FERRULE[1], cy, cz)
        lc = piece if lc is None else lc + piece
    return [
        label_shape(boot, "stx_boot", f"c{cable}", color=COLOR_GREY),
        label_shape(body, "stx_body", f"c{cable}", color=COLOR_METAL),
        label_shape(lc, "stx_lc", f"c{cable}", color=COLOR_LC),
    ]


def _number_tube(x0, x1, y, z, name):
    tube = _xtube(LEG_OD + FIT + 0.9, LEG_OD + FIT, x0, x1, y, z)
    return label_shape(tube, "number_tube", name, color=COLOR_WHITE)


def _marker(x0, x1, y, z, od, name):
    sleeve = _xtube(od + FIT + 1.0, od + FIT, x0, x1, y, z)
    return label_shape(sleeve, "cable_marker", name, color=COLOR_WHITE)


def _fiber(lay, cable):
    lane = FIBER_LANE_Y[cable]
    parts = []
    # B 側
    for c, name, _module, run in lay["legs"]:
        if c != cable:
            continue
        parts.append(label_shape(run.solid(), "fiber_leg", f"{name}_b", color=COLOR_LEG))
        parts.append(_number_tube(TUBE_X[0], TUBE_X[1], run.yz0[0], run.yz0[1], f"{name}_b"))
    parts.append(label_shape(_boot(X_BOOT_B, +1, lane, BOOT_Z), "breakout_boot", f"c{cable}_b", color=COLOR_BOOT))
    x_m = lay["x_boot_b_end"] + 2.0
    parts.append(_marker(x_m, x_m + MARKER_LEN, lane, BOOT_Z, FIBER_OD, f"c{cable}_b"))
    # 外被
    parts.append(label_shape(lay["jackets"][cable].solid(), "fiber_jacket", f"c{cable}", color=COLOR_AQUA))
    # A 側
    z = Z_RUN_FIBER
    x_m = lay["x_boot_a_cable"] - 2.0
    parts.append(_marker(x_m - MARKER_LEN, x_m, lane, z, FIBER_OD, f"c{cable}_a"))
    x_legs_a = lay["x_crotch_a"] + BOOT_CROTCH
    parts.append(label_shape(_boot(x_legs_a, -1, lane, z), "breakout_boot", f"c{cable}_a", color=COLOR_BOOT))
    for side, name in ((+1, LEG_NAMES[cable][0]), (-1, LEG_NAMES[cable][1])):
        y = lane + side * LEG_PITCH
        leg = Run(lay["x_crotch_a"], (y, z), 0, 0, lay["x_stx"], (y, z), R_LEG, LEG_OD)
        parts.append(label_shape(leg.solid(), "fiber_leg", f"{name}_a", color=COLOR_LEG))
        parts.append(_number_tube(x_legs_a + 15.0, x_legs_a + 27.0, y, z, f"{name}_a"))
    parts.extend(_stx_plug(lay["x_stx"], lane, z, cable))
    return parts


# ---------------------------------------------------------------------------
# Cat7(外被 + 識別套管 + M12 X 編碼公頭)
# ---------------------------------------------------------------------------
def _cat7(lay, cable):
    run = lay["cat7"][cable]
    lane = CAT7_LANE_Y[cable]
    z = Z_RUN_CAT7
    x = lay["x_m12"]
    parts = [label_shape(run.solid(), "cat7_jacket", f"c{cable}", color=COLOR_CAT7)]
    parts.append(_marker(X_REAR + 4.0, X_REAR + 4.0 + MARKER_LEN, run.yz0[0], run.yz0[1], CAT7_OD, f"c{cable}_b"))
    parts.append(_marker(x - 4.0 - MARKER_LEN, x - 4.0, lane, z, CAT7_OD, f"c{cable}_a"))
    body = None
    for s0, s1, d in M12_BODY:
        piece = _xcyl(d, x + s0, x + s1, lane, z)
        body = piece if body is None else body + piece
    metal = None
    for s0, s1, d in M12_METAL:
        piece = _xcyl(d, x + s0, x + s1, lane, z)
        metal = piece if metal is None else metal + piece
    parts.append(label_shape(body, "m12_body", f"c{cable}", color=COLOR_MODULE))
    parts.append(label_shape(metal, "m12_coupling", f"c{cable}", color=COLOR_METAL))
    return parts


# ---------------------------------------------------------------------------
# C 型軌 + P 型夾
# ---------------------------------------------------------------------------
def _rail(xr):
    rail = _box(xr - RAIL_W / 2, xr + RAIL_W / 2, -RAIL_HALF, RAIL_HALF, 0.0, RAIL_H)
    inner = RAIL_W / 2 - RAIL_T
    rail -= _box(xr - inner, xr + inner, -RAIL_HALF - 1, RAIL_HALF + 1, RAIL_T, RAIL_H - RAIL_T)
    rail -= _box(xr - RAIL_SLOT / 2, xr + RAIL_SLOT / 2, -RAIL_HALF - 1, RAIL_HALF + 1, RAIL_H - RAIL_T - 0.1, RAIL_H + 1)
    for y in (-RAIL_BOLT_Y, RAIL_BOLT_Y):
        rail -= _zcyl(9.0, -1.0, RAIL_T + 1, xr, y)
    return rail


def _rail_bolt(xr, y):
    bolt = _zhex(13.0, RAIL_T, RAIL_T + 5.3, xr, y) + _zcyl(8.0, -10.0, RAIL_T, xr, y)
    nut = _zhex(13.0, -FLOOR_T - 6.5, -FLOOR_T, xr, y) - _zcyl(8.0 + FIT, -FLOOR_T - 8, 0, xr, y)
    return bolt, nut


def _p_clamp(xr, lane, cable_od, side):
    """P 型夾(不鏽鋼夾帶 + 底片 + M6 螺絲 + 槽螺帽,建成一件)與 EPDM 內襯。"""
    z = _run_height(cable_od)
    band_od = _band_od(cable_od)
    band_id = band_od - 2 * BAND_T
    ys = lane + side * SCREW_OFF
    y_lo, y_hi = sorted((lane - side * 3.0, lane + side * (SCREW_OFF + 7.0)))
    clamp = _xtube(band_od, band_id, xr - CLAMP_W / 2, xr + CLAMP_W / 2, lane, z)
    clamp += _box(xr - CLAMP_TAB_W / 2, xr + CLAMP_TAB_W / 2, y_lo, y_hi, RAIL_H, RAIL_H + TAB_T)
    clamp += _zcyl(10.0, RAIL_H + TAB_T, RAIL_H + TAB_T + 4.0, xr, ys)
    clamp += _zcyl(6.0, 12.0, RAIL_H + TAB_T, xr, ys)
    clamp += _box(xr - 15.0, xr + 15.0, ys - 6.0, ys + 6.0, 12.5, RAIL_H - RAIL_T)
    liner = _xtube(_liner_od(cable_od), cable_od + FIT, xr - CLAMP_W / 2, xr + CLAMP_W / 2, lane, z)
    return clamp, liner


def _fixings(lay):
    parts = []
    lanes = [(f"c{c}", FIBER_LANE_Y[c], FIBER_OD, +1) for c in (1, 2, 3)]
    lanes += [(f"c{c}", CAT7_LANE_Y[c], CAT7_OD, 1 if CAT7_LANE_Y[c] > 0 else -1) for c in (4, 5)]
    for k, (xr, with_fiber) in enumerate(lay["rails"], start=1):
        parts.append(label_shape(_rail(xr), "c_rail", f"s{k}", color=COLOR_RAIL))
        for y, tag in ((-RAIL_BOLT_Y, "right"), (RAIL_BOLT_Y, "left")):
            bolt, nut = _rail_bolt(xr, y)
            parts.append(label_shape(bolt, "rail_bolt", f"s{k}_{tag}", color=COLOR_STEEL))
            parts.append(label_shape(nut, "rail_nut", f"s{k}_{tag}", color=COLOR_STEEL))
        for name, lane, od, side in lanes:
            if not with_fiber and od == FIBER_OD:
                continue
            clamp, liner = _p_clamp(xr, lane, od, side)
            parts.append(label_shape(clamp, "p_clamp", f"s{k}_{name}", color=COLOR_STEEL))
            parts.append(label_shape(liner, "clamp_liner", f"s{k}_{name}", color=COLOR_RUBBER))
    return parts


# ---------------------------------------------------------------------------
# 設備(示意)
# ---------------------------------------------------------------------------
def _devices(lay):
    parts = []
    xs = lay["x_switch"]
    z = Z_RUN_FIBER
    switch = _box(xs, xs + SW_DEPTH, -SW_WIDTH / 2, SW_WIDTH / 2, 0.0, SW_HEIGHT)
    cw, ch = STX_CAVITY
    for c in (1, 2, 3):
        y = FIBER_LANE_Y[c]
        cavity = _box(xs - STX_FLANGE_T - 1, xs + 16.0, y - cw / 2, y + cw / 2, z - ch / 2, z + ch / 2)
        switch -= cavity
        flange = _box(xs - STX_FLANGE_T, xs, y - STX_FLANGE / 2, y + STX_FLANGE / 2,
                      z - STX_FLANGE / 2, z + STX_FLANGE / 2) - cavity
        parts.append(label_shape(flange, "stx_receptacle", f"c{c}", color=COLOR_METAL))
    parts.append(label_shape(switch, "ethernet_switch", color=COLOR_SWITCH))

    xd = lay["x_dev2"]
    z = Z_RUN_CAT7
    dev = _box(xd, xd + D2_DEPTH, -D2_WIDTH / 2, D2_WIDTH / 2, 0.0, D2_HEIGHT)
    for c in (4, 5):
        y = CAT7_LANE_Y[c]
        hole = _xcyl(M12_CAVITY_D, xd - M12_FLANGE_T - 1, xd + 6.0, y, z)
        dev -= hole
        flange = _box(xd - M12_FLANGE_T, xd, y - M12_FLANGE / 2, y + M12_FLANGE / 2,
                      z - M12_FLANGE / 2, z + M12_FLANGE / 2) - hole
        parts.append(label_shape(flange, "m12_receptacle", f"c{c}", color=COLOR_METAL))
    parts.append(label_shape(dev, "onboard_device", color=COLOR_DEVICE2))
    return parts


# ---------------------------------------------------------------------------
# 組合
# ---------------------------------------------------------------------------
def gen_step():
    _check_params()
    lay = _layout()
    asm = AssemblyHelper("fiber_module_harness")
    asm.add_module("enclosure", _enclosure(lay))
    asm.add_module("receptacle_gm210", _gm210(lay))
    for c in (1, 2, 3):
        asm.add_module(f"fiber_c{c}", _fiber(lay, c))
    for c in (4, 5):
        asm.add_module(f"cat7_c{c}", _cat7(lay, c))
    asm.add_module("clamps", _fixings(lay))
    asm.add_module("devices", _devices(lay))
    return asm.build()


# 所有接觸都是零體積(面貼面,或套件內徑 = 線徑 + 0.04),不需宣告。
INTENDED_CONTACT = []


def _sweep_paths():
    try:
        lay = _layout()
    except ValueError:
        return []
    out = [{"label": f"c{c}_jacket", "points": lay["jackets"][c].polyline(128)} for c in (1, 2, 3)]
    out += [{"label": f"c{c}_jacket", "points": lay["cat7"][c].polyline(128)} for c in (4, 5)]
    return out


# 3D 視圖疊在外被上的中心線(5 條外被;芯線不列,上限 8 條)
SWEEP_PATHS = _sweep_paths()

SWEEP_VIEW = {
    "pathKind": "waypoints",
    "pathParams": ["fiber_len_mm", "cat7_len_mm"],
    "profileParams": [
        {"key": "fiber_od", "value": FIBER_OD, "unit": "mm"},
        {"key": "cat7_od", "value": CAT7_OD, "unit": "mm"},
        {"key": "leg_od", "value": LEG_OD, "unit": "mm"},
    ],
    "profileLoops": profile_loops({"kind": "circle", "d": FIBER_OD}),
}


def _flatten(shape):
    out = []
    for child in getattr(shape, "children", None) or []:
        grand = getattr(child, "children", None)
        if grand:
            out.extend(_flatten(child))
        else:
            out.append((str(child.label), child))
    return out


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    parts = _flatten(shape)
    assert_all_valid([s for _, s in parts], label="part")
    assert_no_interference(parts, allow=INTENDED_CONTACT)


def _report():
    """自我檢查:總長、版面、芯線中心線間距。"""
    _check_params()
    lay = _layout()
    for c in (1, 2, 3):
        legs = [r for cc, _, _, r in lay["legs"] if cc == c]
        total = sum(r.length for r in legs) / 2 + lay["jackets"][c].length + A_LEG
        print(f"光纖 C{c} 總長 {total:.3f} mm(參數 {PARAMS['fiber_len_mm']}),"
              f"外被下彎 X 長 {lay['jackets'][c].xs1 - lay['jackets'][c].xs0:.1f}")
        assert abs(total - PARAMS["fiber_len_mm"]) < 0.5, total
    for c in (4, 5):
        total = lay["cat7"][c].length
        print(f"Cat7 C{c} 總長 {total:.3f} mm(參數 {PARAMS['cat7_len_mm']})")
        assert abs(total - PARAMS["cat7_len_mm"]) < 0.5, total
    print(f"STX 尾端 X {lay['x_stx']:.1f};交換器前面 X {lay['x_switch']:.1f};M12 尾端 X {lay['x_m12']:.1f};"
          f"第二台設備前面 X {lay['x_dev2']:.1f};底板到 X {lay['x_floor_end']:.1f}")
    print("C 型軌 X:", ", ".join(f"{x:.1f}{'' if f else '(只夾 Cat7)'}" for x, f in lay["rails"]))
    pts = {name: r.polyline(160) for _, name, _, r in lay["legs"]}
    names = list(pts)
    worst = (1e9, None)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            d = min(math.dist(a, b) for a in pts[names[i]] for b in pts[names[j]])
            worst = min(worst, (d, (names[i], names[j])))
    print(f"B 側芯線中心線最小間距 {worst[0]:.2f} mm({worst[1][0]} ↔ {worst[1][1]}),需 ≥ {LEG_OD + 0.8:.1f}")
    assert worst[0] >= LEG_OD + 0.8, worst


if __name__ == "__main__":
    _report()
    print(f"SWEEP_PATHS {len(SWEEP_PATHS)} 條")
    print("static checks passed")
