# cad-proxy — `/cad` 前門認證代理(Phase 3)

零外部相依的單檔 Node 服務,取代舊 `my-rest-api/app.js` 內的 `checkCadAuth` +
`createProxyMiddleware`。正式帳號(test/test2/test3)走 Basic Auth;一般訪客走共用
密碼的 **session/cookie** 登入(每瀏覽器獨立 `demo-<id>` 身分、2h 自動過期)。

## 🔴 紅線
Basic 與 cookie 兩模式共用同一段 `injectIdentity()`:**先刪 client 自帶的所有
`x-remote-user`,再注入已驗證身分**。cad-chat 後端只綁 127.0.0.1、無條件信任此
header,所以這段是唯一防冒充關卡。煙測 `server.test.js` 兩模式都驗過。

## 佈署(對外開放前才做;gated on Stage 0 已上線)
1. 複製到 VM:`sudo install -D -m 0644 server.mjs /opt/cadchat/proxy/server.mjs`
2. 建服務帳號 + 祕密檔(root:600):
   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin cadproxy || true
   # demo 密碼(存 sha256 hex,非明文):
   printf '%s' '你要的展示密碼' | sha256sum | awk '{print $1}' | sudo tee /etc/cadchat/demo-password >/dev/null
   sudo head -c 32 /dev/urandom | sudo tee /etc/cadchat/demo-secret >/dev/null   # HMAC 金鑰(持久,勿 lazy 生成)
   sudo chmod 600 /etc/cadchat/demo-password /etc/cadchat/demo-secret
   sudo chown cadproxy:cadproxy /etc/cadchat/demo-password /etc/cadchat/demo-secret
   # webauth(既有);proxy 讀取即可,勿含 demo- 開頭帳號(啟動自檢會擋)
   sudo chgrp cadproxy /etc/cadchat/webauth && sudo chmod 640 /etc/cadchat/webauth
   ```
3. systemd unit `/etc/systemd/system/cadproxy.service`:
   ```ini
   [Unit]
   Description=cad-chat /cad auth proxy
   After=network.target
   [Service]
   User=cadproxy
   Group=cadproxy
   ExecStart=/opt/cadchat/node22/bin/node /opt/cadchat/proxy/server.mjs
   Environment=PROXY_PORT=8790
   Environment=CADCHAT_BACKEND=127.0.0.1:8788
   Environment=CADCHAT_BASE_PATH=/cad
   # 硬化
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   ReadOnlyPaths=/etc/cadchat
   Restart=on-failure
   [Install]
   WantedBy=multi-user.target
   ```
   `sudo systemctl daemon-reload && sudo systemctl enable --now cadproxy`
4. **冒充煙測(flip 前必跑)**:直打 8790,分別在 Basic 與 cookie 模式送
   `X-Remote-User: test2`,確認後端收到的身分仍是驗證身分。等同 `server.test.js`
   的兩條紅線測試。
5. **Caddy 切換**(全站單一 Caddyfile,務必安全):
   ```bash
   sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-cadproxy.$(date +%s)
   # 把 handle /cad* 的 reverse_proxy 127.0.0.1:8080 改成 127.0.0.1:8790
   sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
   ```
   回滾:改回 8080、`caddy validate` + `reload`,或還原備份。

## 環境變數
`PROXY_PORT`(8790)`PROXY_HOST`(127.0.0.1)`CADCHAT_BACKEND`(127.0.0.1:8788)
`CADCHAT_BASE_PATH`(/cad)`CADCHAT_WEBAUTH`/`CADCHAT_DEMO_PASSWORD_FILE`/
`CADCHAT_DEMO_SECRET_FILE`(預設 `/etc/cadchat/*`)`CADCHAT_DEMO_TTL_SECONDS`(7200)
`CADCHAT_DEMO_LOGIN`(1;0=停用 demo 登入只留 Basic)`PROXY_TRUST_XFF`(1)
`PROXY_LOGIN_MAX`(10)/`PROXY_LOGIN_WINDOW_MS`(600000)。

## 與後端 demo 憑證的關係
proxy 只負責「鑄造 `demo-<id>` 身分」;該身分走哪把 LLM 憑證由 **cad-chat 後端**決定
(`CADCHAT_DEMO_API_KEY` / 開發期 `CADCHAT_DEMO_ALLOW_OAUTH`)。**對外開放前**務必:
後端設好 demo API key(Console 建、設月花費上限)並移除 `CADCHAT_DEMO_ALLOW_OAUTH`。

## 煙測
```bash
/opt/cadchat/node22/bin/node --test apps/cad-chat/deploy/cad-proxy/server.test.js
```
