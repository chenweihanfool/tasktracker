# tasktracker — Vikunja on Replit + MCP Server for HERMES

用 [Vikunja](https://github.com/go-vikunja/vikunja)（開源任務管理，內建甘特圖/看板/清單）
取代原本以 LLM Wiki 為主的任務追蹤，並提供 MCP Server 讓 HERMES 能直接讀寫任務。

## 目前進度

- [x] 第一階段：Vikunja 部署腳本（`.replit` / `replit.nix` / `scripts/`）— 已在 Replit 部署驗證成功
- [x] 第二階段：API 端點與 curl 測試文件（`docs/api-testing.md`）— 已用真實部署驗證過
- [x] 第三階段：MCP Server（`mcp-server/`）— 見下方說明

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

## 已知的坑：Development vs Production 資料庫

Replit 的 Database 面板預設給的是 **Development** 資料庫（hostname 通常是
`helium`），這個 hostname 只能在 Workspace 容器內部網路解析，**Autoscale
部署的容器連不到它**，會在啟動時看到類似
`Migration failed: dial tcp: lookup helium ...` 的錯誤並進入 crash loop。

修法：在 Database 面板切換/建立 **Production** 資料庫（跑在 Neon 上、外部可連線），
然後到 **Deployments 頁面自己的 Secrets 區塊**（跟 Workspace 的 Secrets 是分開兩份，
不會自動同步）確認 `DATABASE_URL` 已經是 Production 資料庫的值，
`VIKUNJA_SERVICE_SECRET`、`VIKUNJA_SERVICE_PUBLICURL` 也要在那裡各自確認一次，
再重新部署。

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

- [x] 能打開 Repl 網址，登入 Vikunja，看到甘特圖與任務清單
- [x] 能用 curl 直接呼叫 API 建立/更新任務，網頁重新整理後立即看到變化
- [x] 到期日時區正確（`due_date` 用帶 `Z` 的 UTC ISO 8601，見 [docs/api-testing.md](docs/api-testing.md) 時區注意事項）
- [x] 確認 `related_tasks`（父子任務關聯）在批次列出任務時就會帶出來，不需要額外呼叫

## MCP Server（給 HERMES 用）

`mcp-server/` 是一個獨立的 TypeScript MCP Server，透過 stdio 跟 HERMES 溝通，
把 Vikunja 包成 6 個工具：

| Tool | 說明 |
|---|---|
| `list_projects()` | 列出所有專案 |
| `create_project(title, description?, parent_project_id?)` | 建立新專案，可選擇性掛在既有專案底下 |
| `list_tasks(project_id)` | 列出該專案下所有任務，回傳含子任務層級的任務樹（用 `related_tasks.parenttask` 關聯建樹，已用真實 API 回應驗證過欄位格式） |
| `create_task(project_id, title, parent_task_id?, due_date?, priority?)` | 建立任務；`due_date` 必須是帶 `Z` 的 UTC ISO 8601（如 `2026-07-10T00:00:00Z`），格式不對會直接拒絕，不會送出模糊時間 |
| `update_task(task_id, {title?, description?, done?, due_date?, priority?})` | 只更新有傳入的欄位，內部會先 GET 目前任務再整包送回，避免清空沒帶到的欄位 |
| `delete_task(task_id)` | 永久刪除任務，無法復原 |
| `set_task_color(task_id, hex_color)` | 設定任務的顯示顏色（甘特圖/看板卡片用），見下方說明 |
| `get_tasks_due_today()` | 列出所有專案中今天到期、未完成的任務 |
| `get_overdue_tasks()` | 列出所有專案中已過期、未完成的任務 |

`get_tasks_due_today` / `get_overdue_tasks` 用 `VIKUNJA_TIMEZONE`（IANA 時區名稱，
預設 `UTC`）判斷「今天」的邊界，避免用 UTC 日界線切錯使用者實際的一天。

所有工具遇到 API 錯誤（HTTP 4xx/5xx、網路錯誤、驗證失敗）都會把 Vikunja
回傳的實際狀態碼與錯誤訊息原文回給呼叫端，並標記 `isError: true`，
不會吞掉錯誤讓 Agent 自己猜結果。

### 甘特圖「今日」垂直線（gantt-today-line proxy）

Vikunja 官方甘特圖只在日期表頭把「今天」那一格的數字標成藍底
（`GanttTimelineHeader.vue` 的 `.timeunit-wrapper.today`），往下的任務列
沒有對應的垂直線，很難一眼看出今天卡在哪些任務中間。Vikunja 本身也沒有
提供自訂 CSS/JS 的設定選項，而這個 repo 部署的是官方編譯好的 `full`
binary（前端已經打包進 Go 執行檔），沒有前端原始碼可以直接改。

解法是在 Vikunja 前面加一層極簡的 Node reverse proxy
（`scripts/gantt-today-line/proxy.js`）：Vikunja 改成只監聽內部 port
（`VIKUNJA_SERVICE_INTERFACE` 內部化為 `:3457`，見
`scripts/start-vikunja.sh`），proxy 監聽原本對外的 public port，把所有
request 轉給 Vikunja；只有回傳的 `text/html` 文件會被插入一段
`<link>`/`<script>`（`inject.css` / `inject.js`），在瀏覽器端用
`.timeunit-wrapper.today` 目前的位置畫一條貫穿所有任務列的垂直線，並用
`MutationObserver` 追蹤 Vikunja SPA 的畫面切換與跨午夜的日期變化。其餘
API/JS/CSS/websocket 流量原封不動地 pipe 過去，不受影響。

這個做法不需要 fork Vikunja、不需要 Go/Vue build 環境，之後升級
`VIKUNJA_VERSION` 也不用重新套用任何 patch；代價是依賴
`.timeunit-wrapper.today` 這個 class 名稱不變（截至 go-vikunja/vikunja
`main` 分支現況如此）。`replit.nix` / `.replit` 已加入 `nodejs_20` 依賴。

### 已知限制：甘特圖顏色不會繼承專案顏色

用 Saved Filter 把多個專案的任務合併在同一張甘特圖時，每個任務條的顏色是讀
**任務自己的 `hex_color` 欄位**（確認自 Vikunja 前端原始碼
`frontend/src/components/gantt/GanttChart.vue` 的 `getHexColor(t.hexColor)`），
不會自動套用該任務所屬專案側邊欄的顏色。要讓不同專案的任務在合併甘特圖上
顯示不同顏色，需要手動（或透過 `set_task_color`）把每筆任務的顏色設成跟
所屬專案一致；`list_projects()` 回傳的每個專案物件裡就有 `hex_color`
欄位可以拿來對照。

### 設定與啟動

```bash
cd mcp-server
npm install
npm run build
VIKUNJA_API_BASE_URL="https://tasktracker-cwh.replit.app" \
VIKUNJA_API_TOKEN="你的 API Token" \
VIKUNJA_TIMEZONE="Asia/Taipei" \
npm start
```

HERMES 那邊把它設定成一個 stdio MCP Server（command: `node`, args:
`["dist/index.js"]`，並帶上上面三個環境變數）即可。

### 測試

`mcp-server/test/` 有一個不需要真實 Replit 帳號的端對端測試：用真實部署
curl 出來的 JSON 形狀做了一個假 Vikunja API，實際透過 MCP client/stdio
呼叫全部 6 個工具，驗證任務樹巢狀、`due_date` 不失真、部分更新不清空其他欄位、
無效 token 會回真正的 HTTP 401 而不是幻覺結果。

```bash
cd mcp-server
npm test
```

## 目錄結構

```
.replit                  Replit 執行/部署設定（Autoscale，build 階段先裝好 binary）
replit.nix                系統套件（curl/unzip/cacert）
scripts/install-vikunja.sh  下載官方 full binary（v2.3.0，可用 VIKUNJA_VERSION 覆蓋）
scripts/start-vikunja.sh    解析 DATABASE_URL、檢查必要 Secrets、啟動 Vikunja
docs/api-testing.md         API 端點清單 + curl 測試腳本
mcp-server/                 給 HERMES 用的 MCP Server（TypeScript）
  src/vikunja-client.ts       Vikunja REST API 封裝，統一處理 HTTP 錯誤
  src/time.ts                 時區相關的「今天」邊界計算
  src/index.ts                MCP Server 進入點，註冊 6 個 tools
  test/mock-vikunja.mjs       用真實資料形狀做的假 API，供測試使用
  test/run.mjs                端對端 smoke test
```
