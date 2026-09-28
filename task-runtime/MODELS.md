# Task Pi 模型設定

固定設定檔：`task-runtime/models.json`。這不是 Pi 的 provider/auth `models.json`；不存 API key，不改主聊天室或全域 agent profiles。

| 設定 | 預設模型 |
| --- | --- |
| `l0`：新 E2E L0 | `openai-codex/gpt-5.6-luna` |
| `taskPi`：Herdr 內新 Task Pi | `openai-codex/gpt-5.6-luna` |
| `roles.*`：全部 13 個 Task 角色 | `openai-codex/gpt-5.6-luna` |

全域 14 個 `team.*` profiles（含 advisor）與 subagents 預設／strict modelScope 也統一為 GPT-5.6 Luna。各 profile 原有 `thinking` 依 role 保留（low／medium／high）。主聊天室預設亦已切換為同一模型。

## 使用

正常使用既有 Task dispatch／E2E 入口即可，不必在每次 prompt 重新交代模型。

- L0／Task Pi launcher 顯式傳入官方 Pi `--model`。
- RoleController 的 single／wave，以及 L0 的 final review，都透過原生公開 `model` 參數選擇；覆蓋該次呼叫的 agent profile 模型，不改角色工具／權限／thinking／budget。
- 只使用已註冊的完整 `provider/model-id`：`openai-codex/gpt-5.6-luna`；不使用簡稱或自動 fallback。
- 子代理（in-process child）的模型解析只依賴 profile 自身的 extensions：extension-registered provider（如 pi-antigravity）必須列在角色 profile 的 extensions，否則子代理啟動即失敗（G1 r2 根因）。內建 provider（openrouter、openai-codex）不需任何 provider extension。回歸：`task-runtime/test/child-model-resolution.test.mjs`。
- 沒有設定的角色（目前包括 advisor）會拒絕派工，不默默沿用昂貴模型。Task 原有 allowedRoles 限制仍生效。

若要改預設，編輯 JSON 中相應欄位，再新開／重新載入相關 L0。已啟動的 Pi session 不會被強制切換；Herdr adapter 在該 L0 初始化時選取 Task Pi 預設。不要在未完成的 review plan 中途改設定，新的 launch input 必須與原 plan 一致。

模型選擇是普通設定讀取，不消耗模型 inference tokens。provider 的輸入／輸出／快取費率與額度依當下帳號政策。角色原有 thinking 設定保留，並由 profile／每次 launch 的 thinking suffix 控制。Token 預算與驗收 gates 不變。

## 驗證與限制

- E2E observer 的原生 `get_state` 必須與設定模型完全一致，否則在第一個模型 prompt 前拒絕。
- 設定檔含在既有 runtimeDigest 中；改設定後舊 readiness 不會被冒用。
- CLI 支援不等於 provider inference 或完整 teams E2E 成功；正式驗收 gates 不變。
- 此設定功能不自動追認舊 execution；需新開／重新載入相關 L0。

驗證證據：`goal-team-evidence/task-runtime-model-settings-20260912/README.md`。
