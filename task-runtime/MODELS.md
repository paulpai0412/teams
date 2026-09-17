# Task Pi 模型設定

固定設定檔：`task-runtime/models.json`。這不是 Pi 的 provider/auth `models.json`；不存 API key，不改主聊天室或全域 agent profiles。

| 設定 | 預設模型 |
| --- | --- |
| `l0`：新 E2E L0 | `antigravity/gemini-3.8-flash` |
| `taskPi`：Herdr 內新 Task Pi | `antigravity/gemini-3.7-flash` |
| `roles.team.planner` | `antigravity/gemini-3.8-flash` |
| `roles.team.implementer`、verifier、e2e、qa、debugger、docs、researcher、release、curator 等 | `antigravity/gemini-3.7-flash` |
| `roles.team.reviewer`、security、challenger | `antigravity/gemini-3.8-flash` |

## 使用

正常使用既有 Task dispatch／E2E 入口即可，不必在每次 prompt 重新交代模型。

- L0／Task Pi launcher 顯式傳入官方 Pi `--model`。
- RoleController 的 single／wave，以及 L0 的 final review，都透過原生公開 `model` 參數選擇；覆蓋該次呼叫的 agent profile 模型，不改角色工具／權限／thinking／budget。
- planner 全域 profile 仍可保持 Sol；經 Task Pi 的 planner 呼叫由這份設定明確指定 Terra。
- 只使用已註冊的完整 `provider/model-id` 格式（如 `antigravity/gemini-3.8-flash`、`antigravity/gemini-3.7-flash` 或 `openai-codex/...`）。不使用簡稱、provider fallback 或讓模型自行推測。
- 沒有設定的角色（目前包括 advisor）會拒絕派工，不默默沿用昂貴模型。Task 原有 allowedRoles 限制仍生效。

若要改預設，編輯 JSON 中相應欄位，再新開／重新載入相關 L0。已啟動的 Pi session 不會被強制切換；Herdr adapter 在該 L0 初始化時選取 Task Pi 預設。不要在未完成的 review plan 中途改設定，新的 launch input 必須與原 plan 一致。

模型選擇是普通設定讀取，不消耗模型 inference tokens。它不保證總 tokens 下降，也不是實際帳單折扣承諾。

## 驗證與限制

- E2E observer 的原生 `get_state` 必須與設定模型完全一致，否則在第一個模型 prompt 前拒絕。
- 設定檔含在既有 runtimeDigest 中；改設定後舊 readiness 不會被冒用。
- CLI 支援不等於 provider inference 或完整 teams E2E 成功；正式驗收 gates 不變。
- 此設定功能不更改目前主聊天室的模型、不自動啟動 E2E，也不追認舊 execution。

驗證證據：`goal-team-evidence/task-runtime-model-settings-20260912/README.md`。
