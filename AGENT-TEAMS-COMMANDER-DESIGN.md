# Agent Teams Commander — 獨立 TUI 監控與異常排除入口

**狀態：**可合併的整合分支 `feat/agent-teams-commander-integration`，基底為目前主線 `7c370dec4c7c104ce9c8fd57ad81769e72dad22c`。原型在 `feat/agent-teams-commander` worktree 基於舊 `70e0bc4` 開發，當時複製了 90 個未提交的 Task Pi 來源／測試，歷史清單保存在 `docs/commander-source-snapshot.txt`（SHA-256 `89631b85450feb0a26a283960dd7c8d3a138c3330c2d611b701a7da4950d7df8`）。主線後來已正式提交這些基底及後續修正；本整合分支只移植 Commander 專屬變更，不回退主線。原型 worktree 按使用者選擇原樣保留且不作合併來源。新實作集中於 `task-runtime/commander-projection.mjs`、`extensions/teams-orchestrator/commander-panel.mjs`、orchestrator／HerdrPort 窄接線、定向測試與證據報告。

## 1. 成果與界線

使用者在 Pi L0 工作時，無論模型正在串流、Worker 在 Herdr pane 工作，或葉節點由 `pi-subagents` 執行，按 **Ctrl+Alt+T** 都能打開不經模型回合的 Commander overlay；閒置時也可用 `/teams-commander`。同一入口列出 focused Goal-X 的任務、Task Pi execution／修復版次／角色 wave／獨立 review／整合與驗收關卡、同專案其他 open execution、L0 原生 fleet 摘要，以及證據不足／異常。使用者可從精確 pane ID 跳到 Herdr workspace，再在 Worker pane 進入其原生 Fleet／inspector 查原始步驟。無 focused Goal 時仍可看同專案 open Task Pi 和 L0 native fleet，不捏造 Goal focus。

「異常排除」按使用者確認採 **唯讀診斷＋導向既有公開工具**：面板提供來源／run ID、現況、失敗證據狀態、下一個允許的核對步驟；不在 overlay 發起 stop、repair、cancel、apply、Goal completion、模型 prompt，也不新增第二個控制器。使用者在原 L0 既有 `team_task_*`、Worker `team_role_control` 或原生 supervisor 流程操作；既有確認、預算、owner、來源與期限 gate 不變。導航 workspace 是明確按 `w` 的 UI 效果，不是執行任務的控制動作。

**非目標：**通用跨主機監控、取代 Herdr terminal 或 Fleet transcript、額外任務／Goal 資料庫、產生固定 DAG／百分比、僅憑 process/pane 推導完成、跨 session 劫持 owner、秘密內容全文檢索、自動恢復、補造遺失歷史、將普通團隊委派自動提升為 Goal Task。

## 2. 系統邊界與資料來源

```text
                         Agent Teams Commander (同 L0 Pi session，唯讀投影)
                      Ctrl+Alt+T / /teams-commander / team_goal_board
                                    │
    ┌───────────────────────────────┼──────────────────────────────────────┐
    │                               │                                      │
Goal-X persisted v3             Task Pi Ledger                        pi-subagents
.pi/goals/active_goal_*.md     ledger.sqlite read methods            public in-process RPC status
(唯讀版本檢查；可未 flush)        listGoalLatest/listProjectOpen          fleet DTO (僅 L0 直接 child)
    │                               │                                      │
    │                         execution mailbox                            │
    │                         events→receipts, plans, results              │
    │                         integration/reviews/target-apply             │
    │                               │                                      │
    └──────────────同一 Goal/Task/Execution ID 綁定──┼───────────────────┘
                                    │
                            Herdr pane get / workspace focus
                            (只為導航；Worker pane 的原生 Fleet 顯示葉節點)
```

1. **Goal-X**：使用目前安裝版本的 active Goal v3 檔案，讀首個 JSON 物件中的 Goal ID、狀態、`currentTaskId` 與遞迴 taskList。只讀 canonical repo 內 `.pi/goals` 的 bounded regular files，拒絕 symlink、未知版本／超限；不存在／已歸檔／未 flush 應顯示 unavailable，而非改讀別的 Goal。真正完成仍以原生 Goal tool readback 為準。此檔案解析是版本相依的 read-only adapter，Goal-X 未提供給另一 extension 使用的穩定 in-process read API；升級必須針對真格式重驗，失配時只降級此投影，不動 Goal-X。
2. **Task Pi**：`RuntimeLedger.listGoalLatest` 以 `(projectId,goalId,taskId)` 取唯一最新執行，`listProjectOpen` 另列不屬 focused Goal 的 open execution。讀到的 Task Pi Task 絕不可用同名其他 Goal 的 receipt 補足；接受與 reservation 狀態由 ledger 決定。`team_task_status` 原有欄位保持不變，增加 `projection`；`team_goal_board` 回 focused Goal 範圍的 bounded 投影。其內容只供顯示，不能作 apply／accept 入參。
3. **Worker／角色**：透過原有 mailbox 逐事件／payload digest 及 `readRoleLifecycle` 重建 wave key、role、native run ID、complete 與 process-terminal 的**分離**事實；公開 native status 只補充成員當下狀態。失聯／解析錯誤標 unobserved；即使 native UI 顯示 complete，沒有 Task Pi terminal proof 仍不得宣稱角色可驗收。Worker pane 的 `/subagents-fleet` 是目前可見 tool/transcript 的責任擁有者；Pi event bus 不跨 Worker 行程，不從 L0 假裝能控制它。
4. **L0 直接子代理**：只讀公開 `pi-subagents:rpc:v1` 的 `status`／`fleet` DTO；其 `key` 是 opaque display key，**不是 run ID**，不得從中推導 Task Pi 所屬。缺能力／timeout 顯示 unavailable，不改用私有 runner 執行控制；有 `omitted` 必須顯示。此處與 Worker leaf 是兩個可見範圍，不混成同一筆。
5. **Herdr**：只用已有 `HerdrPort.status` 查精確 pane；按 `w` 時由 `pane get` 的 `workspace_id` 取得 ID 再呼叫 `workspace focus`。不能由 pane ID 字串猜 workspace，也不以 idle/done 判 Task 完成。若 Herdr 不在當前 session，board 仍可讀，導航顯示不可用。

## 3. 投影資料模型與不變量

每張 Task card 有 `{goalId,taskId,executionId,revision,ownerSessionId,ownership,state,reservationOpen,goalCommitState,paneId,updatedAt,recentAt,taskTokenCeiling,phase,next,alerts,waves,reviews}`。Wave 有 `{key,runId,asyncDir,status,terminal,stopRequested,members[]}`，member 有 `{key,role,mode,isolation,status}`。另有 Goal card `{status,currentTaskId,updatedAt,tasks[]}`、fleet `{state,entries,omitted}`。清單上限：64 個 active Goal 檔、256 個顯示 Task、每 Task 1,024 事件、每份 JSON 1 MiB、最多 64 review directories；超限即顯示 projection unknown，不能默默截掉影響驗收的 Task。UI 原生 fleet 最多取公開 DTO 的 12 行並顯示 omitted。

顯示值 **不是交易快照**：Goal-X、ledger、mailbox、native status 由不同 producer 更新。每次刷新帶 `capturedAt`、來源時間；讀取途中身份／digest／檔案不符時整個受影響 Task 顯示 `unobservable`，並保留最後一次 board 的錯誤，不借用舊 PASS 消除警示。1.2 秒只在 overlay 存活時讀本地投影、5 秒讀一次 L0 native RPC；關閉即銷毀 timers。刷新沒有模型回合／新 child／host check／Goal 寫入。通常變化可在下一刷新看見，但不保證無延遲或跨 process 原子性。

以**事實而非百分比**呈現可分支的 flow：

```text
Goal-only／reserved／spawning → Worker → role wave(s) → RESULT_READY candidate
      → staged (可為 checks-passed) → independent review in flight
      → review PASS（未 seal） → sealed candidate
      ├ verify-only → final host checks → AcceptanceReceipt → Goal-X readback
      └ approved-integration → exact target plan → 待逐計畫使用者確認
             → target applied → applied review／final host checks
             → AcceptanceReceipt → Goal-X readback
失敗／取消／未知 → reconcile（依原 owner 與實際 effects 證據；不重派）
review BLOCKED → findings／授權下的有界修復，不能 seal 或以舊 execution 驗收
```

`RESULT_READY`、`reviews:pass`、`integration/receipt.json`、`ACCEPTED` 與 Goal committed 各有不同含義；`ACCEPTED` 未完成 Goal readback 顯示 `goal-readback`，不標完整完成。已關閉 E0 與後繼 E1 不合併成一筆新歷史：卡片顯示最新 revision，精確執行 ID 與原 ledger 歷史仍供已有 status/reconcile 工具查閱。`unobservable`、`unknown`、blocked、stopped、no-progress advisory 必須分色分語義。review verdict 阻塞優先於正常下一關；只在原 ledger accepted＋Goal commit 才顯示 complete。

## 4. 獨立 UI panel 與執行中開啟

Commander 是 L0 Pi TUI 的**獨立 overlay**（不是一行 status widget，亦非 browser server）。`registerShortcut("ctrl+alt+t")` 可在 Pi 工作中打開；`/teams-commander` 是等價命令。overlay 顯示：標題／聚焦 Goal-X 狀態／L0 native fleet；Task 清單列 `Goal/Task`、phase、ledger state、owner、警示數；選中後展開 execution revision、pane、最近證據、Goal commit／reservation／unresolved、Task token ceiling（非已耗用量）、waves→members→native status、reviews、下一關；`a` 篩異常、`h` 顯示針對狀態的排除指引、`r` 即時刷新、`j/k` 選擇、Enter 展開、PgUp/PgDn 捲動完整細節、`w` 明確導航 Worker workspace、Esc 關閉。小終端限制 viewport、標示被省略項目；訊息長度與控制字元都截斷，不讓 untrusted 訊息注入 ANSI。

畫面不佔用 L0 的模型回合，不停止 Worker，也不接管原生 Fleet。由 `w` 切到 Worker workspace 後，使用者以精確 pane ID 找到 Worker 再開 `/subagents-fleet` 查看 leaf transcript。現行 Herdr CLI 只能直接 focus workspace，不能用已核公開 API 對任意 pane ID 做遠端直接 focus；不可把導航稱作已開啟 child inspector。快捷鍵是否被個別終端攔截需實機驗證；TUI 模式之外提供 `team_goal_board` 與原有 `team_task_status` 的文字／結構投影，RPC/print 不呼叫 `ctx.ui.custom()`。

## 5. 異常排除矩陣（唯讀、不自動補救）

| 觀察 | 顯示與下一動作 | 禁止推論 |
|---|---|---|
| Worker admission failed、身份／來源 digest 缺失 | `unobservable`；保存精確 execution，原 owner 讀完整 evidence，使用公開 reconcile／cancel | 沒看到 pane 就當未執行，或自動重派 |
| leaf launch unknown、native status 消失／跨 ID | unknown／unobserved；Worker 用既有 `team_role_control(status)` 與原生 receipt 對帳 | 把 unknown 當 failed-safe-to-retry |
| role failed/stopped、healthy siblings 尚在 | 分別列 waves/members；Worker 診斷並在原限額內定向 repair，保留 siblings | 直接停整 Goal 或把 stop ACK 當 terminal |
| source-bound review BLOCKED、需要使用者決策 | 顯示 review key／verdict 與精確 findings 閱讀要求；原 L0 判斷限定修復資格 | 將 PASS 據為無阻塞、封 BLOCKED、改寫舊結果 |
| 沒有 durable progress 超過 15 分鐘 | advisory；進 Worker pane 看 native 活動／求助；不改 Task 狀態 | 宣稱 timeout、hang 或自動殺進程 |
| exact target plan 待確認 | UI 顯示 `awaiting-confirmation`，原 L0 走原逐計畫確認工具 | 從 panel 確認、繞過套用權限 |
| ACCEPTED 但 Goal 尚未 committed | `goal-readback`，原 L0 核對 Goal tool 原生結果 | 只憑 acceptance／pane idle 宣稱 Goal 已完成 |
| 其他 session owns execution | `read-only`；只允許定位，不能以目前 session 執行 owner 操作 | takeover、跨 process RPC 代理控制 |

Supervisor need_decision 只在 Worker 原生 process 可被擁有者安全回覆；此面板目前不跨行程代理其 reply，使用者先導航 Worker pane。若未來公開跨行程只讀 pending／精確 owner relay，須先另立版本化協定及驗證；不得從對話文字抽取批准。普通 advisor／persistent specialist 不因此預設啟用。

## 6. 安全、性能與相容性

- 本 extension 仍在 L0 process，不能繞過 OS 權限；只讀投影不能作為不可竄改證據。開 panel 不提升角色工具、模型、token 上限或 Goal 權限。所有驗收沿用 `HostAcceptance`／`GoalGuard`。
- Goal 與 native evidence 採 bounded regular-file／symlink 檢查，幫助文字及 title 清理控制字元；不顯示 prompt、憑證、完整 transcript、來源 diff，詳細檢查跳原有 inspectors。若任何來源不可信、版本不符或讀取失敗，局部 unknown，不能不聲不響 fallback。
- 聚焦 Goal 的 Task 列表以 Task Pi ledger 的實際 goal ID 綁定；不讀其他專案的 task，其他同專案 open execution 只供監看並保留 owner ID。L0 fleet DTO 是當前 session scope；不能和跨 process leaf 直接合併作控制。
- Goal-X v3 檔案格式、pi-subagents fleet DTO v1、Task Pi mailbox v1／result v3 和 Herdr `pane get` 是版本釘；升級時針對實際包做相容測試。Goal-X 顯示可能落後緩衝中的 in-turn 變更；不得以 UI 對抗 GoalService 決策。缺 Herdr／RPC 可保留部分投影並標 unavailable。
- 無 persistent service、檔案 watcher、外部端口或 DB migration。overlay 在 session shutdown／reload 前需依 Pi custom component lifecycle 清掉 interval；不能對同一快捷鍵重複疊面板。刷新不跨信任界線執行命令；Herdr workspace focus 只在使用者按 `w` 時透過已有 adapter 執行。

## 7. 啟用、回退與遷移

本功能不修改全域 Pi 設定；合併主線亦不會熱載入到目前正在執行的 Pi session。要在**新互動 Pi session**從本 worktree 試用，可執行 `pi --no-extensions --extension "$HOME/.pi/agent/npm/node_modules/pi-goal-x/extensions/goal.ts" --extension "$HOME/.pi/agent/npm/node_modules/pi-subagents/index.ts" --extension "$PWD/extensions/teams-orchestrator/index.mjs"`。合併後正式啟用應由原 owner 確認既有 Pi extension 載入路徑及新 session；這個 smoke 指令不是生產 migration。

撤除只須在新 session 停止載入本分支 orchestrator 或退回既有來源；Commander 不建立 schema／獨立資料庫，故無資料遷移／回滾寫入。若 Pi、Goal-X、subagents 或 Herdr 升級後契約不相容，失配來源標 unavailable、保留原 runtime；先測來源與 readback，再恢復 UI。不能從 fallback 導航繞過 role／Goal 權限。

## 8. 驗證與交付準則

**離線自動測試：**Goal active v3／無 focus／子任務、Task Pi 最新 revision 與其他 open Goal、candidate→staged→review PASS/BLOCKED→plan→apply→accept→Goal readback 各獨立狀態；漏檔、symlink、錯 digest、錯身份、過大 evidence、讀不到 native status／fleet 必須顯示 unknown；同一 Task 兩版不得重用舊接受；UI 在串流期間快捷鍵入口、scroll/resize、Esc／`w`、timer 清理、無 model invocation 或來源寫入。檢查 `team_task_status` 舊 fields 相容、`team_goal_board` 只取 focused Goal，沒有另一個派工／接管 path。

**真實互動驗收（不得用 fixture 冒充）：**在使用者授權的 disposable Goal／Task 中，L0 模型執行中按 Ctrl+Alt+T，反覆觀察 Worker pane 和 leaf wave 的實際變化；展示同時執行兩 Task、至少一個需要協助／失敗或未知的隔離案例、verify-only 與 approved-integration 的不同等待關卡；`w` 導航正確 Herdr workspace，從 Worker 原生 Fleet 開 leaf inspection；最後核對真正 AcceptanceReceipt＋Goal readback，目標工作樹未被 panel 改寫。對任何真環境無法測的項目明列未驗證，不以工具顯示綠色宣稱完成。

**交付判定：**設計文件、獨立 panel、Goal-X／Task Pi／Herdr／native fleet 接線與離線測試均有真實證據；原工作樹不變，功能 worktree 可用且來源清楚。若無 disposable 真 Goal 或環境不允許真 Herdr 互動測試，交付應標「實作與離線驗證完成；live 互動未驗」，不是完整 E2E PASS。

### 本分支已驗證與剩餘限制（2026-09-28）

- 實機 Herdr 暫時 pane 載入此 worktree orchestrator＋Goal-X 0.31.2＋pi-subagents 0.66.0，實際 `/teams-commander` 和 Ctrl+Alt+T 開 overlay；在無 focused Goal 下顯示 unfocused 與 L0 native fleet；Esc 關閉；測試 Pi 正常結束且暫時 pane 已關閉。沒有發出模型請求或建立 Goal。這是**空 Goal 的互動 smoke**，不證明 Worker 正在執行時的投影／排除流程。
- 以**更新後主線**為基底，Commander／public entry 19 項、public check／seal／applied-review／acceptance 5 項、既有 runtime＋roles 104 項及獨立 R31-H 回歸 1 項均通過。舊原型基底的 98/100 及 R31-H 失敗被後來主線修正取代，不能當本整合分支當前失敗；完整 integration/lifecycle 全組未執行，不能聲稱全套 PASS。原始 TAP 及精確路徑見 `docs/commander-verification-20260928/index.html`。
- 依使用者已選定的離線＋空 Goal 實機驗證範圍，尚未驗證 Worker／wave／review／target plan 全路徑的真實 TUI 畫面；合併／推送不會自動啟用目前運行的主 session。
