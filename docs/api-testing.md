# Vikunja API — 第二階段測試手冊

> 版本基準：go-vikunja/vikunja v2.3.0（截至撰寫時的最新穩定版）。
> 之後升級版本後，請務必重新核對本文件列出的路徑與欄位，官方偶爾會調整。

## 1. Swagger 文件

部署完成後，Swagger UI 預設在：

```
<VIKUNJA_API_BASE_URL>/api/v1/docs
```

原始 OpenAPI JSON：

```
<VIKUNJA_API_BASE_URL>/api/v1/docs/swagger.json
```

若 404，代表該版本把 swagger 文件關掉了（`service.enableswagger` 設為 false），
可在 `scripts/start-vikunja.sh` 加一行 `export VIKUNJA_SERVICE_ENABLESWAGGER=true` 後重啟。

## 2. 核心端點（實測前先以此為準，實際部署後請對照 Swagger 校正）

| 用途 | Method | Path |
|---|---|---|
| 列出所有專案 | GET | `/api/v1/projects` |
| 取得單一專案 | GET | `/api/v1/projects/:project` |
| 建立專案 | PUT | `/api/v1/projects` |
| 列出某專案下所有任務 | GET | `/api/v1/projects/:project/tasks` |
| 取得單一任務 | GET | `/api/v1/tasks/:id` |
| 建立任務（於指定專案下） | PUT | `/api/v1/projects/:project/tasks` |
| 更新任務 | POST | `/api/v1/tasks/:id` |
| 刪除任務 | DELETE | `/api/v1/tasks/:id` |
| 建立任務關聯（父/子任務） | PUT | `/api/v1/tasks/:id/relations` |
| 刪除任務關聯 | DELETE | `/api/v1/tasks/:id/relations/:relationKind/:otherTaskId` |
| 列出個人 API Token | GET | `/api/v1/tokens` |
| 建立個人 API Token | PUT | `/api/v1/tokens` |
| 刪除個人 API Token | DELETE | `/api/v1/tokens/:id` |

Task 物件關鍵欄位：`id`, `title`, `description`, `done`, `due_date`（RFC3339 字串，例如
`2026-07-10T00:00:00Z`）, `priority`（int，慣例為 0=未設定,1=低,2=中,3=高,4=緊急,5=立刻做，
部署後請在網頁 UI 建一筆任務調整優先度並用 GET 確認實際數值), `project_id`。

**時區注意**：`due_date` 一定要帶明確的 `Z`（UTC）或 `+08:00` 偏移量字串，不要傳
不含時區的裸日期（如 `2026-07-10`），否則 Vikunja/瀏覽器各自猜測時區會造成偏移。
MCP Server 一律以 UTC ISO 8601（帶 `Z`）送出。

任務父子關係沒有 `parent_task_id` 欄位，是透過關聯表達：

```json
PUT /api/v1/tasks/{parent_id}/relations
{
  "relation_kind": "subtask",
  "other_task_id": {child_id}
}
```

部署後請實際建一組父子任務，用 GET `/api/v1/tasks/{parent_id}` 確認回傳的
`related_tasks.subtask` 陣列，驗證方向是否符合預期（用 UI 的甘特圖/子任務清單對照）。

## 3. 取得 API Token

### 方法 A（建議）：網頁 UI
登入 Vikunja → 右上角頭像 → Settings → API Tokens → Create new token，
勾選至少 `tasks`（create/read_all/read_one/update/delete）與 `projects`（read_all）權限，
複製產生的字串（只會顯示一次）。

### 方法 B：純 API（供自動化 / 驗證用）

```bash
BASE_URL="https://your-repl-domain"
USERNAME="your-username"
PASSWORD="your-password"

# 1) 登入取得短效 JWT
JWT=$(curl -sf -X POST "$BASE_URL/api/v1/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" | jq -r '.token')

# 2) 用 JWT 建立長效個人 API Token
curl -sf -X PUT "$BASE_URL/api/v1/tokens" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "hermes-mcp",
    "permissions": {
      "tasks": ["create", "read_one", "read_all", "update", "delete"],
      "projects": ["read_all"]
    },
    "expires_at": "2027-07-06T00:00:00Z"
  }'
# 回應中的 "token" 欄位就是要存進 VIKUNJA_API_TOKEN 的值，只顯示這一次。
```

## 4. 驗證 Token 可用：建立一筆任務

```bash
BASE_URL="https://your-repl-domain"
TOKEN="貼上剛剛拿到的 API Token"

# 列出專案，取得要建任務的 project_id
curl -sf "$BASE_URL/api/v1/projects" -H "Authorization: Bearer $TOKEN"

# 在 project_id=1 下建立一筆任務，due_date 帶明確 UTC 時區
curl -sf -X PUT "$BASE_URL/api/v1/projects/1/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "API 測試任務",
    "due_date": "2026-07-10T00:00:00Z",
    "priority": 3
  }'
```

成功會回傳新任務的完整 JSON（含 `id`）。重新整理網頁前端，應該立刻看到這筆任務出現。

## 5. 更新任務範例

```bash
curl -sf -X POST "$BASE_URL/api/v1/tasks/{task_id}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": {task_id}, "title": "API 測試任務（已更新）", "done": true}'
```

`POST` 更新端點目前是整包覆蓋語意，建議先 GET 該任務、在回傳的 JSON 上修改要變更的欄位，
再整包送回，避免未帶到的欄位被清空。MCP Server 的 `update_task` 會照此模式實作。
