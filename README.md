# tasktracker — Vikunja on Replit + MCP Server for HERMES

用 [Vikunja](https://github.com/go-vikunja/vikunja)（開源任務管理，內建甘特圖/看板/清單）
取代原本以 LLM Wiki 為主的任務追蹤，並提供 MCP Server 讓 HERMES 能直接讀寫任務。

## 目前進度

- [x] 第一階段：Vikunja 部署腳本（`.replit` / `replit.nix` / `scripts/`）
- [x] 第二階段：API 端點與 curl 測試文件（`docs/api-testing.md`）
- [ ] 第三階段：MCP Server（`mcp-server/`）— **等第一、二階段在 Replit 上實測通過後再開始**

> 這份 repo 是在本機準備好、由使用者手動 import 到 Replit 部署，
> 因為本機開發環境沒有 Replit API/CLI 存取權限，也沒有 Docker。
> 部署方式改用 Vikunja 官方發行的單一二進位檔（`full` bundle，API + 前端合一），
> 而非 docker-compose。

## 為什麼是 Reserved VM 而不是 Autoscale

Vikunja 用本機 SQLite 檔案存資料，且需要長駐一個 process。
Replit 的 Autoscale Deployment 是無狀態、每次 request 可能落在全新容器上，
會導致 SQLite 檔案和 JWT 簽章密鑰在 scale 事件後被重置、資料消失或使用者被登出。
`.replit` 裡已設定 `deploymentTarget = "vm"`（Reserved VM），使用持久化磁碟。

## 部署到 Replit 的步驟

1. 在 Replit 建立新 Repl → **Import from GitHub** → 指向這個 repo
   （`https://github.com/chenweihanfool/tasktracker`）。
2. 到 Repl 的 **Secrets** 面板，設定：
   | Key | 說明 |
   |---|---|
   | `VIKUNJA_SERVICE_PUBLICURL` | （可選）你的 Repl 公開網址，例如 `https://tasktracker.yourname.repl.co`。不設的話，啟動腳本會嘗試從 `REPLIT_DOMAINS` 自動偵測。 |
   | `VIKUNJA_API_TOKEN` | 第二階段拿到 API Token 後回填，供之後 MCP Server 使用。 |
   | `VIKUNJA_API_BASE_URL` | 同上，填你的 Repl 公開網址（給 MCP Server 用，非 Vikunja 本身需要）。 |
3. 按 **Run**（或用 Deployments 頁面選 Reserved VM 部署）。
   啟動腳本會自動下載 Vikunja 二進位檔（`scripts/install-vikunja.sh`）、
   建立 `./data` 資料夾存放 SQLite 與 JWT 密鑰，然後啟動服務監聽 `:3456`。
4. 打開 Repl 給的公開網址，第一次會看到註冊頁面（Vikunja 預設沒有內建帳號），
   註冊一個帳號、建立一個測試專案。
5. 在該專案下手動建立一筆任務，設定到期日，並建立一個子任務，
   切換到 Gantt / 甘特圖視圖確認正常顯示。
6. 依照 [docs/api-testing.md](docs/api-testing.md) 建立 API Token，
   並用文件裡的 curl 指令驗證能透過 API 建立/更新任務。
   拿到 Token 後回填到 Secrets 裡的 `VIKUNJA_API_TOKEN`。

## 驗證清單（對照原始需求的驗收標準）

- [ ] 能打開 Repl 網址，登入 Vikunja，看到甘特圖與任務清單
- [ ] 能用 curl 直接呼叫 API 建立/更新任務，網頁重新整理後立即看到變化
- [ ] 到期日時區正確（`due_date` 用帶 `Z` 的 UTC ISO 8601，見 [docs/api-testing.md](docs/api-testing.md) 時區注意事項）

完成以上勾選後回報結果，確認無誤即可開始第三階段 MCP Server 開發。

## 目錄結構

```
.replit                  Replit 執行/部署設定（Reserved VM）
replit.nix                系統套件（curl/unzip/cacert）
scripts/install-vikunja.sh  下載官方 full binary（v2.3.0，可用 VIKUNJA_VERSION 覆蓋）
scripts/start-vikunja.sh    設定環境變數並啟動 Vikunja
docs/api-testing.md         API 端點清單 + curl 測試腳本
mcp-server/                 （第三階段）給 HERMES 用的 MCP Server，尚未開始
```
