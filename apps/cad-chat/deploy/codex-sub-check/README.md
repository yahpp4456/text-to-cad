# Codex 訂閱到期檢查

每天台北時間 00:05 以各服務帳號的身分更新 Codex 的 ChatGPT 登入資訊，檢查訂閱到期日。檢查只看到期日，不查額度用量。root 將結果寫入 `/var/lib/codex-sub/<名稱>.json`，名稱為 `cadchat` 或 `suiyaoee`。

```json
{"status":"ok","activeUntil":"2026-12-01T00:00:00Z","planType":"plus","checkedAt":"2026-11-26T16:05:00Z"}
```

`activeUntil` 是訂閱到期時間，`planType` 是方案名稱，缺少時各為 `null`。`checkedAt` 是本次檢查的 UTC 時間。`status` 可能有四個值：

| 值 | 意義 |
|---|---|
| `ok` | 登入有效，訂閱尚未到期 |
| `expired` | 已到訂閱到期時間 |
| `login_invalid` | 無法確認有效的 ChatGPT 登入 |
| `unknown` | 無法取得到期日或完成檢查 |

DEMO 選用 Codex 時，設定 `CADCHAT_CODEX_STATE_FILE` 才啟用訂閱檢查。app 每次請求都檢查狀態檔，修改時間改變就重讀。`status=ok`、現在早於 `activeUntil` 且 `checkedAt` 在 3 天內，才會使用 Codex，其餘情況走 Claude。更新狀態檔後不需重啟 app。

## 安裝

從本目錄以 root 執行：

```bash
install -m 755 codex-sub-check /usr/local/sbin/codex-sub-check
install -d -m 755 /usr/local/lib/codex-sub-check
install -m 644 probe.py /usr/local/lib/codex-sub-check/probe.py
install -m 644 codex-sub-check.service codex-sub-check.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now codex-sub-check.timer
systemctl start codex-sub-check
```

續訂後若要立即切回 Codex，手動再執行一次 `systemctl start codex-sub-check` 更新狀態即可。
