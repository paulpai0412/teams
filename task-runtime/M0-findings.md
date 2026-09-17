# M0 Compatibility Findings

日期：2026-09-10  
分類：磁碟與唯讀 runtime 探針；不是 Task Pi live E2E

## 結果

| 問題 | 結論 | 狀態 |
| --- | --- | --- |
| Goal-X completion seam | 不依賴內部 seam。Pi 公開 `tool_call` 可阻擋／改寫 `update_goal_task` 參數，`tool_result` 可確認持久化後的 Goal/task 狀態。 | VERIFIED_PUBLIC_API |
| Task completion seam | 以公開工具名 `update_goal_task` 攔截 single/batch complete；注入 `task-runtime:<acceptanceId>`，結果 readback 後才釋放 reservation。 | IMPLEMENTING |
| Goal completion seam | 以公開工具名 `update_goal` 攔截 complete；任何同專案 open Task Pi reservation 都 fail closed。 | IMPLEMENTING |
| Goal child safety | 0.31.2 有 `isDelegatedGoalSession`，但 Herdr Task Pi 不是 subagent child，不能依賴它。 | VERIFIED_SOURCE |
| Worker extension 隔離 | Pi 0.84.4 支援 `--no-extensions` 加明列 `-e`；可完全不載入 Goal-X／Herdr extension。 | VERIFIED_CLI |
| pi-subagents task-local API | 0.66.0 提供 workflow resource、preflight、capability ceiling、RPC、mission、project panes 公開 seam。RPC manage 不支援 mission。 | VERIFIED_SOURCE |
| Herdr project-pane API | pi-subagents public API 可開一般 project Pi，但不能指定 Worker-only extension/profile，因此不足以完成安全握手。 | VERIFIED_SOURCE |
| Herdr 外層啟動 | Herdr 0.9.0 CLI 支援 pane split/run 與 agent identity/status；adapter 必須保存 paneId，不能用 pane name/status 當完成證據。 | VERIFIED_CLI |
| Cross-process channel | `pi.events` 只在同 process；必須使用 durable mailbox。 | VERIFIED_SOURCE |
| Crash recovery identity | SQLite execution、mailbox、Herdr paneId、worker boot/session、subagents native run/status 可組合對帳；pane idle/heartbeat age 不是終止證明。 | PARTIAL：需 live fault canary |
| 實際新版本已載入 | 套件已在磁碟 pin 至 Goal-X 0.31.2、subagents 0.66.0，但目前 Pi session 未 reload。 | NOT_VERIFIED |
| Herdr 最新更新 | client/server 皆 0.9.0 stable；`herdr update` 因正在 Herdr session 內被拒絕。 | BLOCKED：detach 後執行 |

## 版本策略

Pi 最新版 0.85.1 超出 Goal-X 0.31.2 的 peer range `>=0.83 <0.85`。依使用者選擇採相容最新版：Pi 保留 0.84.4，Goal-X 0.31.2，pi-subagents 0.66.0，Herdr 0.9.0 stable。不得以 `--force` 安裝不相容 Pi。

原 0.30.5 Goal-X overlays 已被正式套件升級取代；Task Pi 不新增 0.31.2 overlay。曾驗證的 exact-hash external-guard prototype 已撤回，Goal-X 目前保持 npm pristine source。舊套件、subagents 與 Herdr binary仍保存於 compatibility lock 指定的 rollback directory。

升級門檻以 capability/contract 測試為主，不把版本號當相容性證明：若公開工具名、input 或 result schema 不符，Orchestrator 必須停用 Task Pi 並回退 direct，不能 patch 套件或強制安裝。

## 最小實作方案

1. 使用 Node 24 `node:sqlite`，不新增 dependency。
2. Orchestrator 與 Worker 共用 canonical contract/mailbox；Worker 不讀寫 ledger。
3. Herdr adapter 使用固定 executable+argv 建構與嚴格 shell quoting；先記 launch intent，再建立 pane。
4. Worker 以 `--no-extensions` 啟動，只明列 Worker extension 與 pi-subagents；READY 時核對 active tools/source provenance。
5. Orchestrator 用 Pi 公開 `tool_call`／`tool_result` 事件守住 Goal-X complete，完全不 import 或修改 Goal-X internals。
6. pi-subagents 只用公開 RPC/tool contract；READY receipt 記錄實際 capabilities，不以 package path/hash 代替。
7. 未通過新 session、真 Herdr、真 leaf、cancel/restart 與升級 canary 前保持 experimental，executionMode 預設 direct。
