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

## 部署方式：Autoscale + Replit Postgres（省錢優先）

Reserved VM 是固定月費（約 $20+/mo，不管有沒有人用），Autoscale 則是「有 request
才計費、閒置降到 0」，對個人任務追蹤這種低流量用途便宜很多。

Autoscale 唯一的限制是**每個 instance 都是無狀態、隨時可能被換成全新容器**，
所以原本「Vikunja 用本機 SQLite 檔案」的作法在 Autoscale 上會導致資料庫和 JWT
簽章密鑰被重置。解法是把狀態搬到容器之外：

- **資料庫**：改用 Replit 內建的 Postgres（在 Repl 的 Database 面板一鍵建立，
  會自動注入 `DATABASE_URL`），而不是本機 SQLite 檔案。`scripts/start-vikunja.sh`
  會自動解析 `DATABASE_URL` 並轉成 Vikunja 需要的 `VIKUNJA_DATABASE_*` 環境變數。
- **JWT 簽章密鑰**：改成你自己產生、寫死在 Replit Secrets 裡的固定值
  （`VIKUNJA_SERVICE_SECRET`），而不是啟動時自動產生一個寫到本機檔案的密鑰
  （那樣在 Autoscale 換容器時會失效，害使用者被登出、API Token 也可能失效）。
- **已知限制**：Vikunja 的任務附件（attachments）預設存在本機磁碟，在 Autoscale
  下不會持久保存。這次需求（甘特圖、到期日、子任務、API）用不到附件功能，
  先不處理；如果之後需要附件，得另外接 Replit App Storage 或 S3。

如果你之後改變主意想要 Reserved VM + 本機 SQLite（更簡單但比較貴），把
`.replit` 的 `deploymentTarget` 改回 `"vm"`，並在 Secrets 設定
`VIKUNJA_DATABASE_TYPE=sqlite` 即可，`start-vikunja.sh` 已經同時支援兩種模式。

## 部署到 Replit 的步驟

1. 在 Replit 建立新 Repl → **Import from GitHub** → 指向這個 repo
   （`https://github.com/chenweihanfool/tasktracker`）。
2. 在 Repl 的 **Database** 面板建立 Postgres 資料庫（會自動設定
   `DATABASE_URL`，不用手動填）。
3. 到 Repl 的 **Secrets** 面板，設定：
   | Key | 說明 |
   |---|---|
   | `VIKUNJA_SERVICE_SECRET` | 必填。本機先跑 `openssl rand -hex 32` 產生一組固定密鑰貼上去，不要留空（留空會直接啟動失敗，而不是自動生成，避免 Autoscale 換容器後密鑰跑掉）。 |
   | `VIKUNJA_SERVICE_PUBLICURL` | （可選）你的 Repl 公開網址，例如 `https://tasktracker.yourname.repl.co`。不設的話，啟動腳本會嘗試從 `REPLIT_DOMAINS` 自動偵測。 |
   | `VIKUNJA_API_TOKEN` | 第二階段拿到 API Token 後回填，供之後 MCP Server 使用。 |
   | `VIKUNJA_API_BASE_URL` | 同上，填你的 Repl 公開網址（給 MCP Server 用，非 Vikunja 本身需要）。 |
4. 先在 Workspace 裡按一次 **Run**，讓 `scripts/install-vikunja.sh` 把 Vikunja
   binary 下載下來（這樣部署 Autoscale 時會把 binary 一起打包進 image，
   之後每次冷啟動才不用重新下載）。確認能正常啟動、開啟預覽網址沒問題後，
   再到 **Deployments** 頁面選 **Autoscale** 正式部署。
5. 打開網址，第一次會看到註冊頁面（Vikunja 預設沒有內建帳號），
   註冊一個帳號、建立一個測試專案。
6. 在該專案下手動建立一筆任務，設定到期日，並建立一個子任務，
   切換到 Gantt / 甘特圖視圖確認正常顯示。
7. 依照 [docs/api-testing.md](docs/api-testing.md) 建立 API Token，
   並用文件裡的 curl 指令驗證能透過 API 建立/更新任務。
   拿到 Token 後回填到 Secrets 裡的 `VIKUNJA_API_TOKEN`。

## 驗證清單（對照原始需求的驗收標準）

- [ ] 能打開 Repl 網址，登入 Vikunja，看到甘特圖與任務清單
- [ ] 能用 curl 直接呼叫 API 建立/更新任務，網頁重新整理後立即看到變化
- [ ] 到期日時區正確（`due_date` 用帶 `Z` 的 UTC ISO 8601，見 [docs/api-testing.md](docs/api-testing.md) 時區注意事項）

完成以上勾選後回報結果，確認無誤即可開始第三階段 MCP Server 開發。

## 目錄結構

```
.replit                  Replit 執行/部署設定（Autoscale，build 階段先裝好 binary）
replit.nix                系統套件（curl/unzip/cacert）
scripts/install-vikunja.sh  下載官方 full binary（v2.3.0，可用 VIKUNJA_VERSION 覆蓋）
scripts/start-vikunja.sh    解析 DATABASE_URL、檢查必要 Secrets、啟動 Vikunja
docs/api-testing.md         API 端點清單 + curl 測試腳本
mcp-server/                 （第三階段）給 HERMES 用的 MCP Server，尚未開始
```
