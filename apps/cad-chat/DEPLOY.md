# cad-chat GCP VM 部署計畫(內部同事版;伺服器端持 key)

> **給執行者(VM 上的 Claude Code)**:本文件自包含——你沒有撰寫者的對話上下文,
> 一切以本文與 repo 實碼為準。逐節由上而下執行;每步的「驗證」綠了才前進。
> 標 🤖 = 你執行;標 👤 = 只有 Sam 能做(做到該步**停下來等 Sam**,不要繞過)。
> **鐵律:絕不在 VM 上修改 repo 程式碼**(這是 pull-only 副本;發現需要改碼的問題
> → 回報 Sam,由 Windows 開發機修好推上來)。**祕密(API key)絕不進對話、絕不進 git**。
>
> 撰於 2026-07-14(Windows fork,分支「部署」)。應用架構詳見 `apps/cad-chat/README.md`;
> 端點契約也在該文件(驗證步驟需要時自行 Read)。

## 0. 目標與架構

把 `apps/cad-chat`(node:http server + React 前端 + Python CAD pipeline +
Claude Agent SDK)以**伺服器端服務**跑在這台 GCP VM 上,同事用瀏覽器經 HTTPS +
帳密使用。相對 Electron 內測版的關鍵差異:**API key 只存在 VM,不出貨**;
**教訓(lessons.json)集中累積在 VM 的資料根**(= Sam 的核心私有資產)。

```
同事瀏覽器 ──HTTPS+BasicAuth──▶ 反向代理(Caddy 或既有 nginx,443)
                                   │ 改寫 Host: 127.0.0.1:8788
                                   ▼
                        cad-chat server(systemd,綁 127.0.0.1:8788)
                        ├─ spawn claude(SDK linux 二進位;key 經 env 注入)
                        └─ spawn python(/opt/cadchat/pyenv;env 已剝除憑證)
資料根 /srv/cadchat/data(session 產物、lessons.json、transcripts)← 定期備份
程式根 /opt/cadchat/repo(唯讀角色;更新=git pull)
```

**認證/路徑機制(實碼錨點,已在 Windows 打包版驗證過同一套接線):**
- `src/server/config.mjs:24-45`:`CADCHAT_RUNTIME_ROOT`/`CADCHAT_DATA_ROOT`/
  `CADCHAT_PYTHON_EXE` env 覆寫根路徑;設了 `CADCHAT_RUNTIME_ROOT` → `PACKAGED=true`
  → agent transcripts 隔離到 `DATA_ROOT/.claude`(config.mjs:31、188-190)。
- `config.mjs:47`:server 恆綁 `127.0.0.1`——**對外一律走反向代理**,正好。
- `start.mjs:85-88`:Host 守衛只放行 `127.0.0.1:<port>`/`localhost:<port>`
  (防 DNS-rebinding)。全 codebase 僅此一處讀 Host → **代理端改寫 Host 標頭即可,
  零程式碼改動**(此守衛順便保持原樣繼續防 rebinding)。
- `config.mjs:216-221` `sandboxEnv`:spawn 的 Python 子程序 env 已剝除
  `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`(LLM 生成碼拿不到憑證的第一道)。
- `config.mjs:198-212` `resolveClaudeCliExe`:非 asar 環境回 null → SDK 內建解析
  → 用 npm 裝好的 `@anthropic-ai/claude-agent-sdk-linux-x64` 原生二進位,免設定。

## 1. 先問 Sam(👤 佔位符,開工前一次問齊)

| 佔位符 | 說明 | 值 |
|---|---|---|
| `<DOMAIN>` | 服務網域,如 `cad.公司網域.com`(需可設 DNS A 記錄) | |
| `<USERS>` | 同事帳號名單(每人一組 BasicAuth 帳密;**一人一組**,可個別停用=溯源) | |
| 既有 web server? | 這台 VM 的 80/443 是否已被公司網站占用(nginx/apache/Caddy?)——決定 §7 走哪個分支 | |
| repo 來源 | VM 上已有 checkout(路徑?)或需從 GitHub clone(private fork,需 Sam 的 git 認證) | |

## 2. 前置盤點(🤖)

```bash
lsb_release -a || cat /etc/os-release        # 假設 Ubuntu 22.04+/Debian 12+;其他發行版自行對應套件指令
sudo -v                                       # 需要 sudo;沒有 → 停,找 Sam
node --version                                # 需 ≥ 22.12(Vite 7 門檻);不足 → §4 裝 NodeSource 22
python3 --version                             # 需 ≥ 3.10,建議 3.12/3.13(dev 機是 3.13.14)
git lfs version                               # 缺 → sudo apt-get install -y git-lfs
df -h /                                       # 建議可用 ≥ 30GB(pyenv 1-2GB + node_modules + 資料成長)
nproc; free -h                                # 建議 ≥ 4 vCPU / 8GB(OCP 幾何吃 CPU;同事併用會搶)
sudo ss -ltnp | grep -E ':80 |:443 '          # 判斷 §7 分支:空 → 裝 Caddy;有 nginx/apache → 掛 vhost
```

## 3. 系統帳號與目錄(🤖)

```bash
sudo useradd --system --create-home --home-dir /srv/cadchat/data --shell /usr/sbin/nologin cadchat
sudo mkdir -p /opt/cadchat /srv/cadchat/data
sudo chown cadchat:cadchat /srv/cadchat/data
sudo chmod 750 /srv/cadchat/data
```

專用低權限使用者是 RCE 圍堵的地基:這個 app 的本質是**執行 LLM 生成的 Python**,
service user 不可有 sudo、不可與公司網站共用帳號。

## 4. Repo 與依賴(🤖)

### 4a. 取得 repo(分支「部署」)

```bash
# 情況 A:VM 已有 Sam 的 checkout(問到路徑後)——本機 clone,免 GitHub 認證,LFS 走本地:
sudo git clone --branch 部署 /home/<sam-user>/<repo-path> /opt/cadchat/repo
# 情況 B:fresh clone(需 Sam 的 GitHub 認證已配置):
sudo git clone --branch 部署 <fork-url> /opt/cadchat/repo

cd /opt/cadchat/repo
sudo git lfs install --local
sudo git lfs pull --include="models/**"       # few-shot fixtures(~23MB)必須實體化
head -c 20 models/xyz_pickplace_gantry/*.step # 驗證:開頭必須是 ISO-10303-21,不是 LFS pointer
sudo chown -R root:root /opt/cadchat/repo     # 程式根唯讀角色:cadchat 使用者不可寫
```

注意:情況 A 的 origin 是本機路徑——日後更新流(§10)先更新來源 checkout 再 pull。

### 4b. Node + 前端 build

```bash
# node < 22.12 才需要:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

cd /opt/cadchat/repo/apps/cad-chat
sudo npm ci || sudo npm install               # linux 上會自動抓 @anthropic-ai/claude-agent-sdk-linux-x64
ls node_modules/@anthropic-ai/ | grep linux   # 驗證:SDK linux 原生二進位在
sudo env CADCHAT_BASE_PATH=/cad npm run build # vite build → dist/(⚠ 必帶 base path,sudo 會清環境變數)
test -f dist/index.html && echo BUILD-OK
```

### 4c. Python 環境(釘版對齊 dev 機;**這是生死線,煙測沒過後面全白做**)

```bash
python3 -m venv /opt/cadchat/pyenv
sudo tee /opt/cadchat/constraints.txt >/dev/null <<'EOF'
build123d==0.11.0
ezdxf==1.4.4
numpy==2.5.0
scipy==1.18.0
ocpsvg==0.6.0
trianglesolver==1.2
EOF
# 優先:novtk 鏈(dev 機同款,省 ~300MB;若這組在 linux 解析失敗,退路見下)
/opt/cadchat/pyenv/bin/pip install "cadquery-ocp-novtk==7.9.3.1.1" "cadquery-ocp-proxy==7.9.3.1.1" || true
/opt/cadchat/pyenv/bin/pip install -c /opt/cadchat/constraints.txt build123d ezdxf
# 退路(novtk 在 linux 裝不起來時):直接 pip install -c constraints build123d ezdxf,
# 接受 vtk 進來(只肥不壞,功能不受影響)。
/opt/cadchat/pyenv/bin/pip install --no-deps /opt/cadchat/repo/packages/cadpy   # 非-editable、路徑無關

# 出口閘(必過):
/opt/cadchat/pyenv/bin/python -c "import OCP, build123d, ezdxf, cadpy.geometry_checks, cadpy.glb, cadpy.parts, cadpy.motion_decl; print('PY-OK')"
```

## 5. 祕密與設定 `/etc/cadchat/env`(🤖 建骨架、👤 填 key)

```bash
sudo tee /etc/cadchat/env >/dev/null <<'EOF'
# ── 認證(👤 Sam 親自填;絕不經過對話/git)──
ANTHROPIC_API_KEY=REPLACE_ME_SAM
# ── 模型 ──
CADCHAT_MODEL=claude-sonnet-5
CADCHAT_EFFORT=xhigh
# ── 路徑(config.mjs env 覆寫;設 RUNTIME_ROOT 也順便讓 transcripts 隔離到 DATA_ROOT/.claude)──
CADCHAT_RUNTIME_ROOT=/opt/cadchat/repo
CADCHAT_DATA_ROOT=/srv/cadchat/data
CADCHAT_PYTHON_EXE=/opt/cadchat/pyenv/bin/python
CADCHAT_PORT=8788
# ── 營運 ──
CADCHAT_GC_DAYS=30          # 多人共用,7 天預設太短(同事專案默默消失會嚇到人)
HOME=/srv/cadchat/data
EOF
sudo chmod 600 /etc/cadchat/env && sudo chown root:root /etc/cadchat/env
```

**👤 Sam:** `sudoedit /etc/cadchat/env` 把 `REPLACE_ME_SAM` 換成**專屬 key**(不是主 key),
並確認 Anthropic Console 已設**花費上限**。檔案 root:600 + systemd 以 root 讀後注入
→ cadchat 使用者在**檔案層**讀不到 key(殘餘風險見 §11)。

## 6. systemd 服務(🤖)

```bash
sudo tee /etc/systemd/system/cadchat.service >/dev/null <<'EOF'
[Unit]
Description=cad-chat conversational CAD server
After=network-online.target
Wants=network-online.target

[Service]
User=cadchat
Group=cadchat
EnvironmentFile=/etc/cadchat/env
WorkingDirectory=/opt/cadchat/repo/apps/cad-chat
ExecStart=/usr/bin/node src/server/server.mjs
Restart=always
RestartSec=3
# ── 圍堵(LLM 生成碼在此 unit 內執行)──
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/srv/cadchat/data
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now cadchat
```

**驗證(直連層):**
```bash
systemctl status cadchat --no-pager                      # active (running)
journalctl -u cadchat -n 20 --no-pager                   # 期望啟動 log:「認證:API key ✓」「模型:claude-sonnet-5」
curl -s http://127.0.0.1:8788/api/health                 # 期望 "authMode":"apikey","agentReady":true
curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' http://127.0.0.1:8788/api/health   # 期望 403(Host 守衛活著)
```
若啟動失敗,先 `journalctl -u cadchat -e` 對症;疑似 hardening 指令擋到 → 逐項註解
重試定位(定位到後回報 Sam,不要永久放寬整組)。

## 7. 反向代理 + TLS + BasicAuth

**關鍵(兩分支皆同):後端只認 Host `127.0.0.1:8788` → 代理必須改寫 Host;
SSE(`/api/chat` 串流)必須關閉緩衝;AI 回合可長達數分鐘 → 讀逾時放寬。**

### 分支 A:80/443 空著 → 裝 Caddy(🤖;自動 HTTPS)

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

caddy hash-password --plaintext '<每人的密碼>'   # 逐人產 bcrypt hash(👤 Sam 提供帳密對)
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
<DOMAIN> {
    basic_auth {
        # 一人一組(個別可刪=個別撤銷+用量可對人)
        sam   <bcrypt-hash>
        alice <bcrypt-hash>
    }
    reverse_proxy 127.0.0.1:8788 {
        header_up Host 127.0.0.1:8788
        flush_interval -1
        transport http {
            read_timeout 3600s
        }
    }
}
EOF
sudo systemctl reload caddy
```
(舊版 Caddy 指令名是 `basicauth`;`caddy validate --config /etc/caddy/Caddyfile` 先驗語法。)

### 分支 B:公司網站已占 80/443(nginx 例)→ 加 vhost(🤖,動既有設定前先備份)

```nginx
server {
    listen 443 ssl http2;
    server_name <DOMAIN>;
    # TLS 憑證:certbot --nginx -d <DOMAIN>(沿用站上既有 certbot 習慣)
    auth_basic "cad-chat";
    auth_basic_user_file /etc/nginx/cadchat.htpasswd;   # sudo htpasswd -c(apache2-utils),一人一行
    client_max_body_size 64m;                            # 圖面/STEP 上傳
    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host 127.0.0.1:8788;            # ← 後端 Host 守衛的鑰匙
        proxy_buffering off;                             # ← SSE 必關
        proxy_read_timeout 3600s;
    }
}
```

### DNS + 防火牆(👤/🤖)

- 👤 **DNS**:`<DOMAIN>` A 記錄 → 這台 VM 的外部 IP(TLS 簽發前必須先生效)。
- 🤖 **GCP 防火牆**:放行 tcp:80,443(`gcloud compute firewall-rules` 或 👤 Console);
  **8788 不開**——server 綁 loopback,本來也進不來,防火牆再守一層。

**驗證(對外層):**
```bash
curl -s -o /dev/null -w '%{http_code}' https://<DOMAIN>/api/health                  # 期望 401(無帳密擋下)
curl -s -u sam:<密碼> https://<DOMAIN>/api/health                                    # 期望 200 + "authMode":"apikey"
curl -s -u sam:<密碼> https://<DOMAIN>/ | head -c 200                                # 期望 index.html
curl -s -u sam:<密碼> 'https://<DOMAIN>/api/files?dir=' | head -c 400                # 期望 fixtures 目錄列表(雙根 fallback 活著)
```

## 8. 端到端驗證階梯(全綠才算部署完成)

| # | 層 | 誰 | 內容 | 期望 |
|---|---|---|---|---|
| 1 | Python | 🤖 | §4c import 煙測 | `PY-OK` |
| 2 | 服務 | 🤖 | §6 health + 啟動 log | `apikey` / `claude-sonnet-5` |
| 3 | 守衛負案例 | 🤖 | 直連假 Host → 403;對外無帳密 → 401 | 兩個都擋下 |
| 4 | 對外鏈路 | 🤖 | §7 四條 curl | 全過 |
| 5 | 免 LLM 全 pipeline | 👤 | 瀏覽器登入 → FileBrowser 開任一專案目錄(如 `flange`)→ 出 3D 圖 + 滑桿 | 開得起來 = rehydrate/build/validate/GLB 的 Python 鏈全通 |
| 6 | **L4 真回合** | 👤 | 極短 prompt(如「一個 20mm 立方體」)跑一輪 | AI 產圖 + `/srv/cadchat/data/models/.cadchat/<session>/` 有產物;燒少量額度 |
| 7 | 併發抽查 | 👤 | 兩個瀏覽器分頁各開 session 同時各跑一輪 | 互不干擾(busy 鎖 per-session) |

第 5、6 步失敗時 🤖 的分診順序:`journalctl -u cadchat -e` → spawn 錯誤(路徑/權限)
還是 SDK 錯誤(認證/網路)→ 對照 §11 疑難表。

## 9. 備份(👤 排程一次;**lessons.json 是核心資產**)

`/srv/cadchat/data` 就是全部可變狀態(session 產物、**lessons.json = 全體同事使用
蒸餾出的私有教訓庫**、transcripts)。二選一:
- GCP Console 對 VM 磁碟設**快照排程**(最省事);或
- cron:`tar czf /srv/backups/cadchat-$(date +\%F).tgz /srv/cadchat/data`(週期+保留 N 份)。

## 10. 日常更新 runbook(部署完成後,新功能上線只做這個)

```bash
cd /opt/cadchat/repo && sudo git pull               # 情況 A 記得先更新來源 checkout
cd apps/cad-chat
sudo npm ci && sudo env CADCHAT_BASE_PATH=/cad npm run build  # 必帶 base path;package.json 沒動可跳過 npm ci
sudo systemctl restart cadchat
curl -s http://127.0.0.1:8788/api/health            # authMode:"apikey" = 完成
```

只有動到**基礎設施層**才回頭補做:新 Python 依賴 → §4c 的 pyenv 補裝(改了
`packages/cadpy` 就重跑 `pip install --no-deps` 那行);新必要 env → `/etc/cadchat/env`
+ restart;換網域/埠 → §7。

## 11. 安全模型與誠實殘餘風險

**已建立的防線:**
key 僅存 root:600 檔,經 systemd 注入 env(cadchat 檔案層讀不到)/ server 綁
loopback + Host 守衛 / 對外 TLS + 一人一組 BasicAuth(可個別停用=溯源+精準撤銷)/
Python 子程序 env 剝除憑證(`sandboxEnv`)/ 專用無 shell 低權使用者 + systemd
hardening(repo 唯讀、僅 data 可寫)/ 專屬 key + Console 花費上限(**最終後盾**)。

**誠實殘餘(接受並記錄,不假裝解掉):**
1. **同 uid /proc 洩漏**:LLM 生成的 Python 與 server 同 uid,理論上可讀
   `/proc/<server-pid>/environ` 拿到 key。真隔離要第二 uid 或容器(見 §12)。
   後盾=花費上限+可撤銷;對象是可信同事,接受。
2. ~~無應用層使用者隔離~~ **已解(2026-07-15,per-user 隔離)**:反代 `onProxyReq`
   注入 `X-Remote-User`(先 removeHeader 防偽),後端 `userContext` middleware 據此
   切 `DATA_ROOT/users/<u>/models(/.cadchat)`;session registry key 含 user(反劫持)、
   `/api/asset` 做租戶檢查(跨 user 403)。無 header=legacy 全域根(dev 零回歸)。
   機制詳見 README「per-user 資料隔離」;既有資料已遷移歸 `test`。
   ⚠ 這是資料整理+防誤用邊界,**不改變 §11-1**(同 uid 的 Python 仍可讀全 DATA_ROOT)。
3. **BasicAuth 憑密外流**=有人能燒額度:一人一組+個別停用+Console 上限圍堵。
4. **CPU 競爭**:OCP 幾何+claude 併發會互搶;人多變慢是容量問題不是故障(升級機型)。

**疑難速查:**
| 症狀 | 對症 |
|---|---|
| health `authMode:"missing"` | `/etc/cadchat/env` 沒填 key 或 systemd 沒讀到(`systemctl show cadchat -p Environment` 不會顯示 EnvironmentFile 內容,看 journal 啟動 log 的認證行) |
| 403 forbidden host(經代理) | 代理沒改寫 Host——檢查 `header_up Host` / `proxy_set_header Host` 必須是 `127.0.0.1:8788` 全等 |
| 對話卡住無串流 | 代理緩衝沒關(`flush_interval -1` / `proxy_buffering off`) |
| AI 回合 spawn 失敗 | SDK linux 二進位缺(§4b 驗證行)或 hardening 擋 exec(journal 對症) |
| 幾何全失敗 | §4c 煙測重跑;LFS pointer 沒實體化(§4a 驗證行) |
| 專案消失 | GC 到期(`CADCHAT_GC_DAYS`)——調大或教同事匯出 |
| 登入後看不到舊專案/對話 | per-user 隔離:資料跟「帳號」走——確認登的是同一個 BasicAuth 帳號(舊資料 2026-07-15 全歸 `test`);直連 :8788(無 header)= legacy 空間,遷移後近乎全空屬預期 |
| 全部請求 403 bad user | webauth 帳號含白名單外字元(`[A-Za-z0-9_-]{1,32}`)——改帳號名 |

## 12. 之後可選的強化(都不是本輪範圍)

- **容器/第二 uid 隔離**:把 Python spawn 移到獨立 uid 或整體進 Docker,消掉 §11-1。
- **per-user key / 後端代理化**:對外散布或要精細計費時的架構(教訓庫也順勢變服務)。
- **監控**:uptime 探測 `/api/health` + 磁碟水位告警。
- **開源切分提醒**:lessons.json 已在 DATA_ROOT(repo 外)= 天然私有;開源前另需
  盤點 `skills/cad/references/lessons.md` 與 few-shot models 是否跟著公開(Sam 決策)。
