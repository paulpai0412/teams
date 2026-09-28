# Outcome-first Task Pi Agent Teams Runtime

版本：1.23（2026-09-23；第 31 節增限定 D/H 實作與分層驗證，仍非完整 live 證據）

狀態：實作中；未通過 live canary 前不得宣稱 unattended-ready

第 15–30 節保留當時階段快照；scope 排除仍依第 26 節，通用 flow 見第 27 節，共用預算見第 28 節，執行事實修復見第 29 節，離線責任邊界修復見第 30 節。**最新研究、更正及逐項實作計畫以第 31 節為準**，TODO 索引見 [TASK-PI-RUNTIME-TODO.md](TASK-PI-RUNTIME-TODO.md)。r18 已執行且未通過，不能沿用第 30 節當時「尚未啟 live」的時態；R31 部分修正僅離線接線及回歸，真模型/G1 未重驗。G1 等預製 spec/patch 測試不是需求規劃能力的驗收。

**2026-09-14 agent 執行／repair／再審政策修訂（不改 runtime 狀態機）**：新 C3 採 [C3-POLICY.md](task-runtime/e2e/C3-POLICY.md) 與既有入口可讀取的 [c3-prompt.txt](task-runtime/e2e/c3-prompt.txt)。主 agent／Worker 可提出有界 repair／再審請求；依原始證據區分產品、驗證工具、報告與非致命診斷。只修需要修的部分，修後由 auditor 再審；請求不等於 resume／重派／驗收權。Worker 不控制 Goal，terminal execution 不重開，舊失敗與收據不覆寫。新準備的契約須與政策一致，舊 sealed 零修復契約不變。`request_report_repair` 目前僅有 schema 宣告，不代表下述 mailbox report-repair 設計已實作；本次不新增 API 或 controller。

## 1. 決策摘要

本設計不把多 Agent 當成預設。執行模式只有：

```text
executionMode = direct | task-pi
default = direct
```

使用者未指定執行模式時，主 Agent 能在單一上下文內可靠完成的工作直接做。只有當 Task 的診斷輸出、執行時間、恢復需求或工作區隔離收益明顯高於新 session cold start 與重讀成本時，才選 `task-pi`。選擇 Task Pi 前，主 Agent 必須記錄一段具體收益理由；說不出理由就使用 direct。若使用者已明確批准特定模式（例如驗證 Task Pi 協定），啟動端須如實交接該事實；能力／授權不足應回報 blocker，不能因 direct-first 靜默換路。這不預定 Task 數量、角色鏈或實作方法，也不授權普通需求自動建立 Goal。

Task Pi 的價值是**隔離、恢復與完成保護**，不是增加角色數。品質來自 outcome criteria、每個 checkout 的獨佔寫入、Host evidence、source freshness 與 acceptance，而不是 child 數量。沒有固定「一個 implementer + 一個 reviewer」；角色種類、數量、先後和平行性由 orchestrator 依需求與實際證據決定。

## 2. Goal-to-outcome 路徑

```text
使用者需求＋實際專案／授權邊界
  → L0 理解成果、檢查原始要求、決定 direct／ordinary team／Task Pi
  → 只有明確 Goal 授權才建立／使用 Goal-X Goal
  → L0 依成果與依賴定義 Tasks（數量／先後非固定）
  → L0 寫每個 Task spec：objective／criteria／checks／scope／policy／contextRefs
  → 公開 dispatch 將 spec 封成一個成果型 TaskContract
  → 一個 execution reservation
  → 一個 Herdr Task Pi
  → 按需的 pi-subagents leaf waves（串行／平行；沒有固定角色鏈）
  → 必要時整合隔離 lane 的產物，凍結最終 source
  → TaskResult（候選；允許 host 項目尚待驗證）
  → Host checks + 所需獨立 review + Host validation
  → AcceptanceReceipt
  → Goal-X task completion + readback
```

下列狀態永遠不等於完成：pane idle、child pass、測試 exit 0、模型文字「完成」、TaskResult ready。只有 AcceptanceReceipt 已持久化、最終 source 仍新鮮、無 active/unknown runs，且 Goal-X 原生寫入已 readback，才可完成成果 Task。

## 3. 何時使用哪種模式

### Direct（預設）

- 需求與根因清楚。
- 修改範圍小，主 Agent 能一次讀完整實際流程。
- 機械驗證明確，不需要長時間隔離輸出。
- 不需要跨 session crash recovery 或獨立 worktree owner。

### Task Pi（選用）

至少有一項可驗證收益：

- 跨模組未知故障，預期有大量診斷輸出。
- 長時間工作會污染後續 Goal context。
- 需要獨立 worktree、可見 pane 或重啟後 reconciliation。
- 一個成果需多個責任步驟；可平行獨立工作，但每個 checkout 同時最多一個 writer／有副作用的 check。
- 高風險驗收需要 task-local trace，而 root 只保留 bounded projection。

小任務不得只為「使用 teams」而啟動 Task Pi。

## 4. 元件與唯一 owner

| 層 | 元件 | 唯一責任 |
| --- | --- | --- |
| L0 | 主 Agent（現有模型） | 理解使用者需求、拆分／依賴判斷、產生 Task specs、核總預算、整體成果驗收；不是 extension 自動規劃 |
| L0 | Teams Orchestrator Pi extension | 合約機械驗證／封存、reservation、dispatch、host/receipt gates、Goal 回寫保護 |
| L0 | Goal-X 0.31.2 | Goal/Task/criteria/完成狀態唯一真實來源 |
| L0 | Runtime ledger | execution owner、state、event 去重、budget、acceptance journal |
| L0 | Herdr adapter | Task Pi pane 的建立、查詢、精確停止 |
| L1 | Teams Worker Pi extension | READY/grant、task-local 控制、bounded result、cancel/drain |
| L1 | pi-subagents 0.66.0 | Worker process 內 leaf run/mission/receipt |
| L2 | `team.*` leaf | 有界角色工作；不得 Goal mutation、Herdr launch 或再派工 |

Task Pi 以 Pi `--no-extensions` 啟動，再明列 Worker 與 pi-subagents extension。不得偽造 `PI_SUBAGENT_CHILD`；Goal-X 直接不載入。Worker READY receipt 必須列出實際 session、cwd、active tools 與 extension provenance，發現 Goal/Herdr mutation 能力即 fail closed。

## 5. 儲存與通訊

### SQLite execution ledger

使用 Node 24 內建 `node:sqlite`，不新增 dependency。SQLite 只保存 execution control，不複製 Goal backlog。主要不變量：

- 同 project/goal/task 同時只有一個 open reservation。
- controller ownership 用遞增 epoch fencing；換 owner 必須有明確 proof。
- 所有 state transition 使用 expected state + revision CAS。
- timeout/heartbeat stale 只進 UNKNOWN，不釋放 reservation。
- AcceptanceReceipt 先保存，Goal commit 另欄追蹤。

### Durable file mailbox

```text
<runtimeRoot>/projects/<projectId>/executions/<executionId>/
  task-request.json
  bootstrap.json
  commands/*.json
  events/*.json
  receipts/*.json
  results/*.json
  evidence/*
```

每個 producer 只寫自己的區域；temporary file + fsync + no-clobber publish。採 at-least-once + idempotency，不宣稱 exactly-once。相同 ID 不同內容、相同 sequence 不同事件均為 protocol error。

## 6. 避免 token 與時間浪費

1. **不固定角色流水線：** 根因已知不派 debugger；已有新鮮 Host receipt 不派 verifier。
2. **機械工作零模型：** hash、path、schema、state、budget、event reduction、checks 由程式執行。
3. **bounded root context：** 一般 progress 不觸發 LLM；root 只看 criteria、風險、decision 與 evidence refs。每 Task summary 最大 4 KiB。
4. **每 checkout 獨佔寫入：** Task 可有多個隔離 mutation lanes；共享 checkout 不得同時寫入或邊寫邊 review/check。只有確定獨立的工作才平行；reviewer 不可批准自己的修改。
5. **不盲 retry：** timeout、lost reply、stale heartbeat 先 reconcile；UNKNOWN 不開第二個 writer。
6. **局部失效：** source digest 未變的 Host receipt 可重用；只重跑受影響 checks。
7. **報告與產品分離：** schema/格式錯誤最多一次 report repair，不重跑 implementation。
8. **跨 execution budget：** 同 Task/role 最多三次 product repair；換 phase、process 或 execution 不重置。

## 7. State 與完成

```text
RESERVED → SPAWNING → RUNNING → RESULT_READY → VALIDATING → ACCEPTED
                         ↘ WAITING_DECISION
                         ↘ CANCEL_REQUESTED → CANCELLED
                         ↘ FAILED / UNKNOWN
RESULT_READY / VALIDATING → REJECTED
```

`goalCommitState`、`reservationOpen`、`workspaceIntegration` 與 execution state 分欄，避免一個 `complete` 同時冒充程序終止、產品驗收、整合與 Goal 寫入。

## 8. 可升級的 Goal-X completion guard

Task Pi 不修改、不 import Goal-X 內部檔案。Orchestrator 只使用 Pi 的公開 extension events：

- `tool_call` 攔截公開工具 `update_goal_task`：single/batch complete 都先查 ledger；有 opted-in execution 時，只有 `ACCEPTED` 可通過，並把 input evidence 原地改為 `task-runtime:<acceptanceId>`。
- `tool_result` 讀 `details.goal` 的公開 tool result：只有 matching Goal/task 確實為 complete 且 evidence readback 相符，才標記 `goalCommitState=committed` 並釋放 reservation。
- `tool_call` 攔截 `update_goal(status=complete)`：同專案仍有 open Task Pi reservation 就 fail closed。
- 沒有 matching execution 的 direct/legacy Goal 完全維持原行為。
- Goal-X 工具缺失、input/result schema 改變或 readback 不明時，停用 Task Pi／保持 reservation，不 patch 套件、不猜測成功。

此做法依賴穩定的公開工具契約，而非 Goal-X source hash。若未來 Goal-X 提供正式 external guard API，可新增 adapter 並保留同一 ledger/mailbox contract，不改 Worker。

在 guard 與 live canary 通過前，Task Pi 只能是 experimental opt-in，不能無人值守。

## 9. Pi extension 表面

### Orchestrator extension

- `team_task_dispatch`：讀取並驗證已封存 TaskContract，取得 reservation，啟動並握手。
- `team_task_status`：bounded execution projection，不讀 transcript。
- `team_task_stage_integration`：L0-only，保存 native handoff，於新的隔離 Git checkout 排練與執行可搬移的核准 checks；不套用 target、不驗收、不盲重試。
- `team_task_target_integration`：L0-only，prepare／inspect／apply／rollback；只套成 staged diff、不 commit 或移動 ref，寫入前需獨立互動確認。必要 review 缺 binding、後續修改、未完成 intent 均拒絕；見第 17 節。
- `team_task_inspect`：讀指定 result/evidence metadata。
- `team_task_reconcile`：先唯讀對帳；修復狀態需明確 action。
- `team_task_cancel`：persist intent、停止 admission、drain、確認終態後才關 pane。

### Worker extension

- 啟動時寫 boot/READY；無 grant 不啟動產品工作。
- grant 後送入 bounded Task prompt。
- 只允許 contract 中的角色、路徑、budget 與 deadline。
- `team_task_result` 封存候選 result；封存後 quiescent，不再修改產品。
- decision/cancel/report-repair 經 mailbox command；cancel 必須核對 leaf terminal。

## 10. 實作與驗收順序

1. **M0：** compatibility lock、實際 seam、版本與 rollback。
2. **M1：** contracts、canonical hash、SQLite ledger、mailbox；T01–T04/T20/T21。
3. **M2：** no-op Worker READY/grant 與 Herdr identity；T05–T07/T19。
4. **M3：** task-local subagents、budget、result seal、report repair；T11/T12/T23。
5. **M4：** Pi public-event Goal guard、Host acceptance、Goal readback；T08–T10/T22。
6. **M5：** crash/unknown/pause/cancel/late result；T13–T18。
7. **M6：** direct legacy regression、真 Herdr/Task Pi/leaf canary、matched-task A/B。

每階段保存 command、exit code、source digest 與 offline/mock/live 分類。Mock PASS 不可冒充 live PASS。

## 11. 效率與品質判定

以同一 source、criteria、model routing、budget 比較 direct 與 task-pi：

- time-to-accepted。
- root、Task Pi、leaf 及總 tokens。
- 首次驗收成功率。
- product repair／report repair 次數。
- 重複 writer 數與錯誤完成數。
- 無效 LLM wake/polling turns。

MVP 硬要求是在已執行案例中同一 checkout 的 duplicate writer = 0、false completion = 0；不同受控 worktrees 的獨立 writers 不算重複 writer。Task Pi 若沒有在長任務上證明 context/recovery 收益，不擴大為預設。

## 12. 本機版本盤點（live 背景 runner 不相容）

| 元件 | 本次採用 |
| --- | --- |
| Pi | 0.84.4（Goal-X peer range 要求 `<0.85`） |
| Goal-X | 0.31.2 |
| pi-subagents | 0.66.0 |
| Herdr client/server | 0.9.0 stable |
| Node | 24.18.0 |

Goal-X 與 pi-subagents 已透過 Pi package manager 升級並 pin。Goal-X 目前保持 npm pristine source；Task Pi 不需要 overlay。原 `0.30.5/0.64.0` 與 Herdr binary 備份位於 `~/.pi/agent/backups/teams-runtime/20260910T035407Z`。目前 session 未 reload，因此只證明磁碟版本；新 runtime 的實際載入仍待新 session canary。Herdr 在自身 session 內拒絕 `herdr update`，需 detach 後另行執行；目前 client/server 皆為 0.9.0、protocol compatible。

2026-09-10 web todo canary 更正：上述組合的 schema／peer／extension load 通過，**但背景 leaf 啟動失敗**。pi-subagents 0.66.0 要求從 Pi package 解析 `@earendil-works/chord` 與 `/context`，Pi 0.84.4 未提供；因此最新 harness 為 `offlineCompatible=false`、`direct-only-incompatible-background-host`。RPC ping 廣告不是實際 spawn 證據。

使用者要求不要 hardcode 後，已撤回針對已知套件名／版本的 host 特判。一般 Herdr dispatch 要有完整 live readiness 收據，公開 manifests 與本專案 source fingerprint 只檢查證據新鮮度，不能充當能力或成功證明；缺收據／只有 simulation 則 direct-only。獨立 canary 僅由主代理在明確使用者授權後啟用，不設定版本例外。角色 handoff value schema 共用本專案 `handoff-schema.mjs`，Runtime 不載入 legacy `handoff-contract.mjs` 的私有 dependency adapter。

經使用者核准，主 Pi 0.84.4 + Goal-X 保持不動，僅於 disposable prefix 安裝官方 Pi 0.85.1 給不含 Goal-X 的 Worker。Run 239aa32c 的真 leaf／observed process proof／Edge 11 情境通過（252,911ms），但 native review-required、budget exceeded、越界測試產物與模擬 Goal readback 令主稽核否決；沒有簽發完整 readiness 收據。HostAcceptance 已補 native gate 檢查，Worker spawn 改 terminate 讓出 turn，不盲重派修報告；仍待真 Goal readback、scope gate 及新的完整驗收。

## 13. 持續升級策略

1. **不 pin internals：** 不引用 Goal-X/pi-subagents 私有檔案、未導出的 function 或資料庫格式。
2. **capability handshake：** 每次 session 啟動核對 `update_goal_task`、`update_goal`、pi-subagents RPC ping capabilities、Worker active tools 與 Herdr protocol；版本號只作診斷資料。
3. **fail closed + direct fallback：** capability 缺失只停用 Task Pi，主 Pi direct 工作與原生 Goal-X 保持可用。
4. **schema ownership：** TaskContract 預設仍為 `teams-task-runtime/2`，保留 `/1` reader 與原語意。只有明確提供新 review policy 才可選 `/3`；目前已接 review 準備、離線 transport 與 review-bound apply；v3 必須有完整 writer／sealed review binding 才可另行互動批准 apply，final acceptance 仍明確拒絕（第 18 節）。SQLite/mailbox 不另造儲存系統；未知版本 fail closed，不遷移既有 open executions。
5. **upgrade canary：** 升級順序為 backup → 官方 package update → pristine-source check → offline contract tests → 新 session load → no-op handshake → disposable Goal/task readback → live Task Pi；任一階段失敗即 rollback 套件或維持 direct-only。
6. **相容矩陣：** `compatibility-lock.json` 記錄已驗證組合與 capabilities，但不得靠修改 expected hash 把未知版本標成相容。
7. **棄用窗口：** adapter 變更以新版本並存一個 release/canary 週期；不得在尚有 open reservations 時升級或移除 reader。

## 14. 動態編排、worktree 與整合（本輪設計）

### 14.1 決策權與動態 wave

L0 orchestrator 依使用者意圖核定 outcome、權限、必要 gates、角色 allowlist、總 budget 與併發上限；L1 Task Pi 是該 Task 的 orchestrator，在這個授權範圍內根據新證據決定下一個 wave。Role 數量沒有 quota／固定配對，也不按 Todo、檔名、套件版本或文字關鍵字分支。

每個 wave 僅描述當下可開始的工作，含 stable key、role、task、mode、isolation、tokens 配額與平行理由。相依工作不得放進同一平行 wave；consume 結果後再決定下一步，不預先產生固定 DAG。多角色使用一次公開 RPC `spawn(workflowScript)`，內部 `await runs.all(...)`；下一 wave 等上一個 native completion + process-terminal proof，避免多個 top-level async roots 與 native admission 矛盾。

同一角色可負責數個不同 slices；可只有調查、只做文件、單一 writer，或多個獨立 writers，再按需 review/security。`maxActiveRoleRuns` 是契約資源上限，不是必須派滿的人數；native 的配置／capability ceiling 仍可縮小它，不能修改全域設定突破限制。

### 14.2 何時需要 worktree

| 情境 | 決策 |
| --- | --- |
| 單一 writer，或有副作用的單一 check | 可共享 checkout，但獨佔；不為儀式額外建 worktree |
| 多個純讀取調查／review，source 不再變動 | 可共享凍結的 checkout |
| 多個獨立 writers／有副作用的 checks | 使用不同 managed worktrees；ports、DB、browser profiles、cache 另須隔離 |
| writer 與 reviewer 需要同一份正在變更的 source | 不平行；先 freeze，review 該精確 source |
| 修改範圍高度重疊、有未穩定共享介面 | 先做相依部分再分工；不同 worktree 不能消除語意衝突 |
| 非 Git、dirty baseline、未提交需求檔、隔離資源不足 | 不自動 stash/commit/copy；先建立經授權 baseline，否則串行／direct |

使用 native `worktree: true`，不另造 worktree manager。檢查 canonical repository root、clean HEAD、TaskContract baseCommit；不把 SHA 塞進只接受 named ref 的 native baseRef。配置資料與需求必須在可見的 baseline 或明確 contextRefs，不能假設 worktree 會帶入 untracked 檔案。Mode/claims 是 admission 契約，不是 OS sandbox；角色工具能力仍由公開 preflight 與既有 profiles 約束。

### 14.3 Merge／整合

1. **先收產物，不直接 merge target：** 保存 native workflow receipt、每 lane 的真實 run identity、base、patch/hash、handoff、terminal 與 scope 證據。原生可能已刪除臨時 worktree，不以路徑存在與否猜成功，不憑模型提供的 patch 路徑。
2. **唯一 integrator：** L0 owns integration；managed writers 不各自 merge 共用 target。只有 `approved-integration` 且 target/base/操作在使用者授權內才能寫入。`verify-only` 只能驗證／交付 patch，不能冒充 target 已更新。
3. **先在乾淨 integration checkout 排練：** 按依賴順序套用已核對 patch／commit；parent-owned argv、無 arbitrary shell。記錄每步 before/after tree、套用範圍與原始失敗。共享 target 不因其中一 lane 成功便部分發布。
4. **衝突不盲解：** 停止整合並保留 artifacts；由 orchestrator 決定小範圍單一修復 lane 或請使用者裁決。不用 ours/theirs、force、重新生成整個產品當預設。
5. **整合後才最終驗收：** 對 integration tree 跑必要 checks／review。Lane 的舊 PASS 不自動覆蓋合併後的新 source。跨 lane API 與資料相容性需整體情境測試。
6. **target freshness 與發布：** 寫入前再次確認 target 仍等於批准 baseline；改變則停止重評，不能 reset/stash 使用者修改。外部 push/PR merge/deploy 仍需另授權。
7. **失敗與清理：** 缺 patch、錯 base、unknown process、dirty/uncaptured work 一律保留；原生 cleanup eligibility 不是發布批准。受控本地 integration receipt 保存後，才允許 HostAcceptance 接受隔離產物。

D1/D2 已接動態 wave 與 worktree admission；D3a 已補 native handoff ingest 與 verify-only 排練（見第 16 節）；D3b 有受限 staged apply/rollback（第 17 節），review binding 仍列 TODO。在這些能力完成前，隔離 mutation 只能產生候選，HostAcceptance 必須拒絕「未證實整合」；不能靠改 gate 先讓 E2E 綠燈。

### 14.4 Candidate、review、budget 與 recovery

- TaskResult 是 producer observations：host 所負責項目可為 indeterminate；`not_met`／`needs_user` 不能當 ready。L0 用真正的 source-bound host receipt 判定，不要求模型先報 met。
- 必要 review 由風險與授權 gate 決定，不以某個固定角色名或固定一人次實作。原生 required 不事後關閉、status 不改寫。使用者已批准新 v3 由 L0 以公開獨立 review 證據裁定；v1/v2 保持 strict-native gate。缺最終 source／native identity／terminal／usage binding 仍 blocked，詳第 18 節。
- `usageBudget` 的公開語意是 completed-child reported usage 阻止後續派工，**不會中止既有 child**。設計採 wave admission 配額＋累計實際用量＋deadline／安全 checkpoint；不得承諾 provider 呼叫中途精確 token 硬停止。超額／未知用量阻止後續 admission，不能事後加額追認。
- 取消／失敗後由原 controller drain、核對所有 roots/children terminal、Worker 終態、ledger reservation 與 pane。owner 不明先 reconciliation；不能冒用舊 session ID。此次新觀察 pane w3:p8 已不在 Herdr list，但這不等 ledger 已釋放。

### 14.5 本輪 gates 與交付範圍

Required：零模型 contract／RPC wave／共享寫入拒絕／真 Git clean-base／candidate→host 回歸，修改檔 LSP、parser、既有回歸。之後 required：native worktree handoff＋整合／衝突故障測試、真 Goal single/batch readback、完整新 Todo E2E、matched direct/task-pi 比較。

本輪 source-only、主代理實作：不啟 reviewer/implementer child、不 reload、不操作既有 Goal／舊 reservations、不升級套件或改模型權限。獨立 review/live canary 未取得前不稱整體驗收完成。

## 15. D1/D2 實作快照（v1.2）

D1/D2 已接線並完成離線回歸：新合約 v2（v1 保持可讀）、dynamic wave → 單一 native workflow、共享寫入／check 獨佔、managed worktree clean-base admission、逐成員真實 budget events、pending host criteria 候選、native member identity 與未整合拒絕。這是 admission／協定驗證，不是任意 shell 的隔離保證，也尚未 live 驗證 native worktree 完整 lifecycle。

Todo harness 不再內建角色／預算或 exactly-one-writer 指令；`TEAMS_E2E_POLICY_FILE` 必须提供主代理核定的絕對 policy JSON 路徑。它仍是舊的非 Git／Goal projection fixture，所以即使所有現有檢查通過也只回 partial；V2/V3 將替換成真 disposable Goal＋可用 Git baseline。不能用這支舊 harness 冒充新版完整 E2E。

證據：`goal-team-evidence/task-runtime-dynamic-20260910/`。目前 29 runtime tests、43 handoff cases、native workflow 靜態驗證通過；a2d16f35 的首次誠實候選以 pure validator replay 通過 v2，未改舊 execution／Goal。後續 D3a/D3b 見下節；D4 review binding、D5 actual-usage admission、D6 原 workspace baseline、D7 cleanup 仍待實作；無 readiness approval。

## 16. D3a — Native handoff 與 verify-only integration

入口為 `HostAcceptance.stageIntegration()`／L0 `team_task_stage_integration`。要求同一 controller／epoch、execution 為 RESULT_READY、sealed result digest 正確、target clean HEAD 仍等於 Task base，且原 source snapshot 未變。不授予 Worker 新工具。

1. 只從已登記 role-started 的 native asyncDir 讀公開 status；核對 complete／observed terminal／root identity。由 `status.workflow.value` 的 compiler-owned return 與 `workflowReceiptPath` 核對 key、agent、child run ID 與 continuation。只搜尋 native 明列的 JSON artifact refs，不猜 handoff／worktree 路徑。單一 shared reader 可沒有 workflow receipt，不強制固定角色鏈。
2. Handoff v1 的 child/root/base/patch capture 必須一致；missing／ambiguous／future shape 拒絕。原生檔案與 patch 有界、canonical、無 symlink，複製到 mailbox integration/captures 並保存 SHA-256。這是公開 artifact adapter，不 import dependency 私有 parser；升級後需新 canary，不靠版本白名單。
3. 新的 shallow、no-hardlinks Git clone 與 source 的 Git metadata 分離；不是重造 leaf worktree allocator。每 lane 先在獨立 index 對原 base 驗證 patch，再用 Git cached three-way apply 整合。新增／刪除／binary／同檔非重疊修改可套用；conflict／scope violation／symlink／gitlink／credential path 拒絕。不做 commit、target update、force 或 native cleanup。
4. Materialize 後，執行 Task 已核准且可搬移的 argv checks。明顯引用原 sourceRoot 的 executable/argv 先拒絕，不替換字串猜新命令。核對全 integration workspace（只排除 .git）前後快照，再核對 tree/index、check receipt/log 與 target freshness；避免 assume-unchanged 隱藏 sourcePaths 之外的修改。
5. 封存 `teams-integration-rehearsal/1`，status 為 staged／checks-passed，固定 `acceptance:not-assessed`、`targetModified:false`。重複呼叫只驗證保存的 native captures／同份 workspace／check receipts，不重跑；原生暫存資料刪除不影響已保存證據。未完成 intent 或 failure 保留現場，必須 reconcile。

界限：v1 handoff 的一 child／一 group、單次非 resume lineage；patch 8 MiB、整批 native captures 64 MiB、JSON 1 MiB，整合快照沿用 host 的 512 files／64 MiB 上限。路徑只接受普通檔案與可安全表示的相對路徑；Git global filters/hooks/helper 設定不帶入。核准 checks 仍是 trusted OS execution，不是 sandbox，間接外部路徑／外部系統副作用仍由 L0 審核。

驗證為真 Git + 合成 native 格式 receipts，非 native allocator 或模型 E2E：40 runtime、43 handoff、23 host-evidence 回歸通過，8 修改檔 primary LSP clean。證據 `goal-team-evidence/task-runtime-integration-20260910/README.md`。HostAcceptance 的未整合 worktree 拒絕仍保留；D3a receipt 不可完成 Goal。D3b 後續實作見第 17 節；D4 最終 source review binding 仍待。

## 17. D3b — 明確批准的 staged apply／rollback

最小交付操作是把合併好的 patch 套到原 target **index＋working tree**；不自動 commit、不移動 HEAD/ref、不 push。這不是原子檔案系統 transaction，亦不是最終驗收。`approved-integration` 僅容許準備操作，不能代替使用者對該 plan/action 的互動確認。

- `prepare`：同 controller/epoch、RESULT_READY、sealed candidate、D3a captures/檢查/source 都須新鮮。從真 Git base 以 scratch index materialize baseline，再比整個 target workspace（含 ignored/assume-unchanged 隱藏修改）及 index。保存固定 targetRoot／named branch／base／merged tree／完整 before/after digest、index bytes digest、merged patch 與 plan hash。target 不寫入，缺 completion 不重建。
- `apply`：v1/v2 保持原 strict-native gate，只有明確無 required review、criteria 僅需 host-check binding 才可套用。新 v3 自 D4e 起要求 checked/verified writer evidence、完整 sealed integrated-source review 與獨立互動確認；native reviewed 字串不替代整合後 review，也不改寫 review-required。其他 evidence kind 仍 blocked，不靠角色名或版本特判。
- 寫入前，L0 顯示精確 target/ref/base/tree/plan hash 並要求互動確認；工具參數不能傳 `approved:true`，headless 拒絕。確認等待後重新檢查 owner/source，獨佔 operation lock、保存 intent。
- 用公開 Git `update-ref --stdin` 的 `start → verify HEAD <base> → prepare` 同時鎖 HEAD 與其 referent；在鎖內再次核對 named branch、全 workspace 與 index，才 `git apply --index --binary`。最後 commit 的是 **verify-only ref transaction**，沒有 ref 更新。Git 不支援 protocol 或不能鎖定時，在 mutation 前失敗，不設版本例外。
- 分別保存 ref-fence 與 mutation 命令的 observed close／exit／signal；ref-fence 結束不能冒充 mutation 已 settled。命令失敗、signal、半套用或 owner 改變，保存 command evidence 與實際可讀狀態，不盲重跑。成功重複呼叫只核對 receipt/intent/command/target，不再次確認或寫入。
- `inspect` 唯讀比對 baseline／applied／diverged，另列 intent／receipt／lock 與已驗證的 command close metadata；不是 acceptance、retry 或 release 許可。
- `rollback` 需新的互動確認、原 apply intent 與雙命令終態證據，而且 target/ref/index bytes／整個 workspace 必須精確等於已記錄的 applied 狀態。只反向套同一 patch；後續編輯／commit 一律拒絕，不 reset/stash/force。命令非零但正常退出、完整效果可核對時，可以明確批准 rollback；signal／missing close／部分或不明效果只保留，不自動恢復。
- 未完成 intent、process crash 留下的 operation lock 不能直接刪除或自動重試。失敗後即使 source 回到 baseline，也不重用已消耗的 apply plan。更完整的 owner-safe crash reconciliation 仍屬 D7。

重用 bounded host evidence、Git invocation 與 D3a readback；新增 `integration-apply.mjs`，沒有 dependency、scheduler 或 ledger schema 變更。全工作區上限仍為 512 files／64 MiB；這只補 apply 邊界，**不是 D6 的 task-start/end scope baseline**。Git locks 不能阻止任意 OS 程式直接改檔；每 checkout 的 cooperative writer/check 獨佔與 trusted commands 仍是前提。

證據：`goal-team-evidence/task-runtime-apply-20260910/README.md`。真 Git/Node 命令、合成 native receipts，無新模型／真 native allocator／Goal readback；source-only、新 tool 未 reload。HostAcceptance 的 worktree 拒絕及 D4 必要 review 保持，未簽 readiness。

## 18. D4 — L0 source-bound review（使用者已批准；部分實作）

公開 API 查核：installed native 的四個 acceptance evaluator 呼叫都未傳入 reviewResult，公開 RPC／exports 沒有回填 writer review 的入口。不是多派 reviewer 就能使 native status 變成 reviewed。查核 source/hash 見 `goal-team-evidence/task-runtime-review-20260910/source-audit.json`，此結論不代表未來官方版本永遠缺 API。

使用者明確選擇：**只對新契約，由 L0 驗證獨立 reviewer 與最終 source 的證據，不再把 native reviewed 字串當唯一裁定**。required review 仍須滿足；保留 native review-required 原值，不修改其 ledger、不能追認 native rejected 或舊 execution。這不是关闭 required gate。

### D4a 已接的 source-only 準備

- 顯式 `/3` 契約要求 `policy.review = { authority: "l0-source-bound", allowedRoles, allowedTools }`。角色是原 allowedRoles 的子集，工具是 L0 核准的唯讀 ceiling；沒有預設角色、人數或工具名推測。v1/v2 不接受這個額外欄位，不做歷史遷移。
- `HostAcceptance.prepareIntegrationReview()`；重用 `team_task_stage_integration(action: "prepare-review")`，不增加 root 工具或 Worker 權限。只接受已有 D3a rehearsal 的 RESULT_READY，核 owner/epoch/result/target 與完整整合 source freshness。
- 封存 `integration/review-request.json` 與 exact raw-byte `review.patch`；subject digest 綁 Task identity、owner、contract/result/rehearsal、base/merged tree、全 workspace/source、patch hash、現有／刪除路徑、writer roles、criteria 及 review policy。原始 patch bytes 不 UTF-8 roundtrip。
- 重複只比對保存內容與新鮮 source，不重跑 checks；native temp 刪除後仍可 readback。缺 request completion 或 patch/subject 改動均拒絕，不重建 partial preparation。
- 純 `validateReviewLaunch()` 核公開 launch-contract schema、fresh context、不同 writer role、定義／launch digest、相同 cwd、explicit allowlist、無 ambient extensions／nesting、工具未超核准 ceiling；unresolved host facts 拒絕。**D4a 當時只有合成公開格式回歸；D4b 已補實際 public resolver 零模型探測，仍未啟動 native review。**
- `integrationReviewSchema()` 與 `validateReviewReport()` 綁精確 request digest、每一 criterion、source 路徑、findings；PASS 不能含 blocker 或 unmet criterion。source path membership 由 host 驗證，不把全部檔名清單重複塞入每項 JSON schema。

Allowlist 名單須由 L0 根據可信 profile／工具能力核准，字串名單本身不會證明工具無副作用；工具與 source 快照皆非 OS sandbox。以上格式驗證只回 report／not-assessed，**不是 native run 或最終 acceptance 的證據**。D4a–d 階段 v3 apply 在互動確認前拒絕；D4e 後可依下節的 writer/review binding 另行確認套用。acceptance 仍在入口拒絕；唯讀 apply plan 仍不是 write authority。

### D4b 已接的 source-only transport

- 重用 `role-wave.mjs` compiler、公開 `pi-subagents/preflight` 與 event-bus RPC。既有 stage 工具新增 plan-review／start-review／collect-review actions，不增加工具或改 profiles；L0 選擇當下所需的 reviewer 數量與角度，不重跑 writer。
- `review-runs.mjs` 保存 owner-locked plan、完整 launch intent、native started binding、bounded terminal/workflow/session captures 與 completion。plan 與 dispatch 前重新 preflight，核 requested role、definition／launch digest；collect 核整份預期 dispatch envelope，而非只核 workflowScript。
- 公開套件與 Pi host 分開安裝；以已安裝 jiti 的 ESM public resolver，從 host entry 解析套件 manifest 宣告的 peer exports。沒有硬編碼版本、dependency patch 或 private runtime import。零模型探測已成功載入並呼叫實際 resolver；未傳 live registry 的探測仍回 `host_required`，不是 admissible launch 或背景 runner 相容性證明。
- 核對 root／child／workflow key／native owner／session 的一致性與跨 wave 不重用；只接受 fresh、non-resumed、成功且 terminal 的已知形狀。報告必須同時符合 schema、native 兩份 projection，並等於該 native session 中唯一成功的 `structured_output` call＋tool result；usage-only session 不再構成報告證據。
- Session v3 的重複 identity／header、分支父 session、missing／failed／foreign submission、未知格式與用量拒絕。strict usage 計 assistant、tool-result usage、compaction／branch-summary 本次 usage，不把 retained tail 重複計入；未知／overflow／超額均 blocked。這不是 D5 全 task 的實際用量 admission。
- 捕獲前後再次核 frozen request／完整 integration source／原 target／check freshness；native temp 清理後只驗 durable copies。intent 已消耗、owner lock／partial captures／unknown lifecycle 均保留且拒絕重派；不提供自動 reconcile／drain／刪 lock。completion 固定 `acceptance:not-assessed`。
- start 必須取得 host-owned admission。D5a 已把 actual usage 改為主程式直接讀 bytes（第 19 節）；lifecycle assertion 仍獨立 required，production adapter 刻意不提供，因此 D5/D7 未完成前 live start 仍拒絕。測試 assertion 不是 production grant。

### D4c 已接的 host-owned candidate 封存（source-only）

- `HostAcceptance.sealIntegrationReview()`／既有 stage 工具 `action: "seal-review"`，不新增工具。必須回收**全部已登記 waves**，不接受 wave/key selectors；未啟動／未回收、BLOCKED／needs-user、unknown marker、未知 inventory 均拒絕。封存不自動 collect、preflight 或 dispatch。
- 重用 review owner lock、`collectUnlocked` 的完整 native/capture/source readback；另以全 inventory 獨立核對 root/child/session identity 不重用，不信任單一 intent 的 predecessor 清單。每 wave 的 plan/completion digest 綁到同一 frozen request，保存 `review-candidate-intent.json`＋`review-candidate.json` 與 candidateDigest。
- 封存後拒絕新 plan/start；相同 plan 可唯讀 readback。重複 seal 重新驗 source、captures、全部 inventory 與 seal bytes，不重跑模型／checks。partial intent、source/capture/seal tamper、追加或遺失 wave 保留並拒絕，不重建或刪 lock。
- 候選固定 `acceptance:not-assessed`，不批准 writer evidence、不改 native required/status、不授權 apply 或完成 Goal。所有已登記 plan 暫視為 required；尚無 plan withdrawal/supersession API，不能以刪目錄撤回 review。
- 真 Git/FS/native-format fixtures 及實際 extension tool callback 的隔離 host 測試通過；後者是模擬 Pi event bus/manifest/ledger，不是真 Pi reload／native run。主代理自查、非獨立 review。證據：`goal-team-evidence/task-runtime-review-candidate-20260911/README.md`。

### D4d 已接的 after-apply proof/readback（source-only）

- `verifyIntegrationApply()` 從既有成功 apply journal 唯讀驗證；共用原 execute 的 idempotent receipt reader，不再有兩套判定。核 plan/intent/command/receipt、互動確認來源、雙命令 close/code/signal/error、observationError、精確 before/after/完整 target/index/ref；operation lock 或任何 rollback journal 均拒絕。缺 receipt 不會呼叫 confirm、補寫 journal 或重新 apply。
- 原 idempotent reader 漏查的 mutation signal/error、observationError、intent/receipt 同時偽改的 before，以及 retained lock 現已拒絕；rollback readback 也核 input 是原完整 applied state。成功 apply/rollback 語意不變，不替失敗命令補出成功證據。
- `readAppliedIntegrationReview`／`readAppliedReviewCandidate` 必須顯式給 **target apply plan digest**，且 frozen request、完整 captures、sealed candidate 早已存在。每次原本 clean-baseline freshness 檢查改走嚴格成功 apply proof，仍比對原 request/candidate bytes 與全部 review inventory；沒有 permissive bool/callback 或失敗後退回 clean 檢查。
- 既有 stage tool 加 `read-applied-review` action，拒絕 wave/key selectors；不新增 tool。原 prepare/seal/plan/start 仍走 pre-apply clean-baseline gate，不得藉新 reader 建立新 review/candidate。missing/foreign proof、target hidden drift、rollback、unsealed candidate 皆拒絕。
- 測試以真 Git/journal executor 驗 after-apply 路徑，但 **v3 future L0 apply gate 在 fixture 中模擬**；公開 HostAcceptance v3 首次寫入 gate 在確認前仍拒絕，final acceptance 仍拒絕。公開 tool callback 是隔離模擬 Pi host，非正式 reload/native/model/Goal E2E。證據：`goal-team-evidence/task-runtime-applied-review-20260911/README.md`。

### D4e 已接的 writer evidence／review-bound apply（source-only）

- `integration-authority.mjs` 重用同一 `inspectNativeHandoffs` 公開 artifact parser，改從已封存 captures 讀取；重验完整 role/workflow key/run/base/lane/terminal/hash，不依 step 陣列位置猜 writer。原生 temp 清理後仍可驗證。
- v3 writer 要有 checked/verified evidence、明確 level/review policy、exit 0、childReport、無 parse error、required criteria 滿足、runtime checks 無失敗/未知、verify inventory/command/exit 匹配；native rejected、parent rejection、review blockers 不得用外部 PASS 救回。保留原 required/status；v1/v2 不變。
- native root 必須有 version 1、source=reported 的已知 usageBudget，used/hard/outcome 與 wave allocation 相符。這不是 D5 全 task/Worker/reviewer 的累積 raw session usage，也不允許 production reviewer 缺 admission 就啟動。
- 首次 apply 只讀**既存** sealed request/candidate；不自動封存。await 完整 gate 後才顯示互動確認；等待後重驗並比較相同 binding。intent/command/receipt 同時保存 `teams-integration-review-binding/1`（request/candidate/writer evidence digest）。應用後及 idempotent Host readback 再核完整 review inventory、writer 證據與成功 apply proof 的 binding；缺/錯/替換 binding 均拒絕，不補寫舊 journal。
- 真 Git fixture 現在走真正 `HostAcceptance.applyIntegration()`，移除 D4d 的 future apply gate stub；仍模擬 native producer、review admission 與 UI 回覆，非 live/native/Goal E2E。既有 stage callback 也重驗新版 applied evidence，不增加工具/權限。證據：`goal-team-evidence/task-runtime-review-authority-20260911/README.md`。

### D4 final acceptance 尚待接通

D4c–e 已提供 sealed candidate、writer gate、review-bound apply 與套用後 readback；仍需將 applied target/check freshness 接 final AcceptanceReceipt，以及真 native review run/session/terminal canary。不能把局部套用成功或 fixture PASS 當作完整驗收。v3 final acceptance 與 production review 的缺 admission gate 保持拒絕；不改 native required／review-required、不追認舊 execution。D3 final gate、D5–D7、真 Goal readback／E2E／matched A/B／升級驗收仍未完成，維持 direct-only。

本切片 required：contract／scope／tamper／partial／legacy negative tests、真 Git bytes/snapshot 回歸、公開 resolver 零模型探測、native script 靜態驗證、LSP/parser/既有 runtime 與 host checks、主代理安全自查。依使用者 main-only 不派獨審；live model/Goal/E2E 不在本輪授權內且仍是整體 required evidence。證據：`goal-team-evidence/task-runtime-review-runs-20260911/README.md`。

## 19. D5a — Review 派工的完整 session 計量（source-only）

這是 review start 的用量切片，**不是 D5 整個 task admission／D7 lifecycle／final acceptance 完成**。不替 production adapter 補 permissive assertion，不增加工具、權限、dependency 或 native patch。

- 新 Worker CLI 使用公開 `--session-dir <execution>/worker-sessions`；公開 `getSessionFile()` 寫入 boot receipt，v3 缺路徑不能 READY。RoleController 的公開 RPC 明列 `<execution>/role-sessions/<launchId>` 並保存於 role-started。只讀這些明列根下的 native `steps[].sessionFile`，不掃描 session home、不猜檔名。v3 stage 將所有成員的完整 session 與既有 native evidence 一起保存 bounded captures，temp 刪除後仍可讀。
- `task-usage.mjs` 重用 strict `sessionUsageBytes()`：從一次 bounded snapshot 計 Worker、全部已登記 leaf、既有完整回收的 reviews；input/output/cacheRead/cacheWrite 分列。review collect 同樣使用共用 `measureSessionBytes()` 與已驗證的 bytes，不再另讀檔或略過未知 entry。核 boot execution/epoch/nonce/contract/cwd/session、native root/member/owner/terminal、完整 inventory、session v3 header／entry IDs、無繼承或身份重用；unknown shape、partial、缺用量、overflow、超額均拒絕。每 session 8 MiB，Worker/native 計量 corpus 64 MiB；不是 provider billing audit。
- 非 PASS review 仍計入下一次 admission。低階計量器也能讀已知 terminal 的 failed/stopped native session，不以成功篩選省掉成本；但 integration 或 review collect 無法證實失敗 run 的完整證據時仍拒絕，不能把缺少的用量補零。hook summary 缺 usage 也是 unknown，不能用 `fromHook:true` 假定零消耗。
- 在 lifecycle assertion 前與 await 後，皆重讀實際 bytes，檢查 leaf 配額及 `累計實際用量 + 新 wave 全額 reservation <= maxTaskTokens`；原有累計配額／spawn cap 仍保留。Worker bytes 必須保留前次計量及已回收 review checkpoint 的完整 prefix；截短、換檔內容或等待期間超額拒絕，不寫 launch intent／不呼叫 spawn。
- 新 `teams-review-launch-intent/2` 保存來源 SHA/byte counts、完整各來源 counters、policy/reservation 與 usageAdmissionDigest；completion 重驗並保留 checkpoint，固定 `acceptance:not-assessed`。這是啟動時計量紀錄，不是未來 final acceptance 的 freshness 證據。舊 unmetered v3 intent `/1`、缺 planned session root 的舊資料不補寫、不追認；v1/v2 strict-native acceptance 語意不變。
- Prepare 記錄 ledger 查到的 `priorExecutionId`。目前只容許明確無前次 execution 的 review admission；缺標記或有舊 execution 但無完整累積證據即拒絕，不能換 execution 重置 budget。跨 execution corpus reconciliation、Worker 每回合用量 admission、取消／重啟／active run drain、最終再計量仍是 D5/D7 required 工作；D5b1 已加 v3 role-spawn 的局部 guard，見第 20 節。

證據與分類：`goal-team-evidence/task-runtime-review-usage-20260911/README.md`。真 Git/FS、實際 HostAcceptance consumer、合成 native producer／lifecycle assertion；另有實際公開 SessionManager 序列化（synthetic counters、無模型建立/呼叫）。主代理安全自查，非獨審或 native/Goal live E2E。依賴可信 host owner/filesystem，不宣稱阻止任意 OS writer；仍 direct-only。

## 20. D5b1 — v3 Worker role 派工的實際用量（source-only）

- `RoleController.spawn()`／`spawnWave()` 共用的 dispatch，在任何新 reservation／native RPC 前重用 D5a reader 與用量界限。新 v3 計目前 Worker＋全部已知 terminal leaf（含 failed/stopped 和 cache）；actual+新 wave 全配額、member cap、原累計 allocation/spawn cap 都須通過。v1/v2 維持原行為，沒有舊 execution 遷移。
- Native role-started 的 launch/run/asyncDir/sessionDir/members/mode 必須符合本 controller 的實際 launch inventory；status completion 與 process-terminal identity 必須吻合已收到的 completion/proof。沒有完整 session 或 terminal、未知狀態、身份不符即拒絕，不以 native summary 或零代替。v3 spawn 回覆缺 canonical asyncDir／重用 run ID 保存 unknown，不視為可重派。
- 原 wave-plan 先持久化，再保存 `receipts/role-usage-<launchId>.json`；原 launch-intent 保存 ref/digest。Checkpoint 只記 source hashes/byte counts/counters 與 allocation，不帶完整 transcript 給模型，固定 not-assessed。重讀每個 checkpoint 必須吻合記憶體內原 digest；之後 Worker 可追加但不能截短，已計入的 closed leaf/review bytes 不能縮小或換掉。
- 本 controller 的 wave-plan 檔案 census 必須吻合自身 launches；重建 controller、有 partial plan 或舊 metadata 不自行恢復／重置 budget，保留並要求 reconciliation。已有 priorExecutionId／缺歷史也仍拒絕。Native temp 尚無這條 Worker 路徑的 durable replay；被刪除就拒絕，不猜資料。
- 派工前與計量後處理已落盤 controls，核 RUNNING、原 bootstrap 與 Worker session；已看到 cancel 就不 dispatch。這只是 Worker-local guard，**不是新鮮 L0 ownership lease、完整 cancellation/drain 或 Worker 每回合模型 admission**。不承諾 provider 執行中精確 token ceiling，D7 仍 required。

驗證使用真 WorkerRuntime／RoleController／Mailbox／FS 與合成公開 RPC producer、session counters、completion/process events；不是實際 native Worker/leaf/model canary。Required：拒絕回歸、完整 runtime/host/parser、修改檔診斷、source freshness、文件與主代理安全自查；main-only 不派獨審，live E2E／跨 execution／D7／final acceptance 未完成且不列通過。證據：`goal-team-evidence/task-runtime-role-usage-20260911/README.md`。未新增工具／依賴／權限、未 reload/deploy、未動舊 Goal/execution/reservation，仍 direct-only。

## 21. D6 — 原工作區開始／結果／host 範圍檢查

- 新 v3 在 reserve 前以既有 bounded snapshot 捕獲 sourceRoot 與明列 worktreePath；baseline 放既有 receipts，digest 綁 bootstrap。只排除根 `.git` 與 host 選定的 runtimeRoot，逐根明列 exclusions，write scope 不可與這些保留路徑重疊。不使用 gitignore、node_modules 或報告檔名推測豁免。
- Worker boot、每次 role admission、ready result 封存，以及 host 入口重讀 baseline／全工作區。比較新增、修改、刪除、mode 與空目錄，不只 sourcePaths；拒絕越界、symlink、敏感路徑與非普通檔案。共用 reader 使用 O_NONBLOCK，避免 FIFO 在 fstat 驗證前卡住。
- Ready result 另存一份綁 resultDigest 的全工作區結束快照。collect、host checks 前後、首次 stage 都要求其仍新鮮；即使變動位於 allowedWritePaths 內但不在 sourcePaths，也不會沿用舊結果／checks。失敗結果仍可回報，不因 scope 失敗假報 ready；缺 baseline／結果快照不事後補造。
- 沿用 512 files／64 MiB／每檔 8 MiB 的既有界限；不支援的樹在工作開始前拒絕，不暗中忽略檔案。v1/v2 原行為不變，舊 v3 缺 baseline 不追認。這是明列原工作區的起訖檢查，不是 OS sandbox、連續檔案監控，亦不證明已刪除 native worktree 中沒有未匯出的副作用；native handoff/live scope 仍需真 canary。
- 回歸重用現有 Worker/RoleController/HostAcceptance/Git fixtures。驗證與限制集中於 `goal-team-evidence/task-runtime-workspace.md` 及同名 `.log`，不新增驗證框架、工具、dependency、ledger migration 或微切片 TODO。D3/D4 最終驗收、D5 完整預算及 live 驗收仍待；取消清理進展見第 22 節，未放寬原 gate。

## 22. 取消與清理 — source 路徑

- 既有 `team_task_cancel` 先持久化意圖，再有界等候原 controller 的 drain/reconcile；預設等候 30 秒，逾時／中止等待仍保留 cancellation 與 reservation，不宣稱完成。既有 `team_task_reconcile` 可繼續核實，但不重播未知 stop／pane close。
- Worker 在 role dispatch、source/result publication 與 `turn_start` 消費已落盤 controls；取消時用公開 `ctx.abort()` 停止自身 agent run，已取消不再發第一個 prompt，也不重寫帶新 timestamp 的舊 ack。僅在完整 durable launch/terminal inventory 歸零後確認取消與呼叫既有 shutdown；不是 provider 執行中的精確 token ceiling。
- 重建 RoleController 只可恢復 drain：wave plans、逐成員 intents、started、completion、observed native process proof 全部對照，不以空 RAM 推論零角色、不恢復派工／budget grant。公開 native status 可補遺失通知；未知 scope、部分 spawn、成員／owner 不符保留。stop intent 先落盤，逾時不重送。
- L0 同時核 Worker roles 與已登記 review waves。只有 plan、沒有 launch intent 的 review 可判未開始；未收到 spawn 身份或仍有 operation lock 不判零。停止 L0 reviews 要當前公開 RPC owner 精確吻合；Worker 自己的 native runs 不由 L0 冒用 owner 停止。
- Worker 崩潰時，原 L0 可獨立查核已登記 native run 的完整終止證據。沿用既有 review captures；必要時將有界 native status 原始 bytes 與 SHA 存於 mailbox，供 temp 消失／controller 中斷後重驗。不得冒寫 Worker completion/cancelled events；取消證據不授權接受產品、重派或重置用量。
- reservation 釋放須 Worker PID/start-time 證明退出、所有 native runs 終止，以及指定 pane 的 idle/cwd 檢查及公開 close 成功回覆。pane 尚未 idle 時只等待、不先消耗 close intent；真的 close 前仍重驗 idle/cwd。pane intent／reply 綁 execution/epoch/owner/Worker/完整 inventory；收到 close reply 即保存，即使 owner 隨後改變也不丟失外部效果證據。最終由單一 ledger CAS 轉 CANCELLED 並釋放；scope/owner 改變或只有 close intent 時保留，不猜測已關閉、不強制重試。Herdr split 後立即記錄 pane，取消後的晚到 launch 不再 grant。

驗證／限制：`goal-team-evidence/task-runtime-cancellation.md` 與 `.log`。包含真 disposable Node Worker boot/grant/cancel/OS exit/host cleanup；native producer 與 Herdr pane 為 fixtures，Pi provider abort／排隊訊息時序仍待真 canary，非模型／真 Herdr／Goal E2E或獨審。此階段當時尚缺 fresh L0 ownership admission、跨 execution budget、每回合用量與 final acceptance；後續 source 進展見第 23 節。既有 executions、套件、profiles/權限、Goal 與部署均不動。

## 23. 逐回合／一次重試 budget 與 L0 instance admission — source 接線

- Worker 的 `turn_start`、role dispatch、compaction／tree 前置事件走同一 admission：先消費 cancel，核 RUNNING、bootstrap、L0 PID/start ticks、controller session/epoch、execution binding、deadline 與完整 workspace。Ledger admission reader 只讀既有 schema v2，不建立／遷移資料庫。
- 第一個 assistant 之前，Pi SessionManager 可能尚未 flush 檔案。只透過公開 header/entries/session ID/path/cwd 讀取本次記憶體 corpus；磁碟存在時須為其 exact prefix，缺檔僅允無 assistant 且零 usage 的真正初始 session。已有 assistant 卻缺 transcript 仍拒絕，不能把缺檔當零。
- `worker-usage-NNNNNN.json` 連續 checkpoint（最多 1024）綁完整用量與來源；下一回合須與 RAM 及既有 prefix 一致，重建不 reset。已有 leaf 尚未 terminal 時 abort／讓出模型回合；timer 只在完整 native proof、idle、無 queued message 時喚醒，不用 LLM polling。漏 completion callback 可從登記 status 補 proof；failed/cache/summary 用量不能略過。
- 同 Task 依既有 `maxProcessRestarts` 0–1，最多容許一次新 execution。`prepare` 在新 reserve 前唯讀核對已關閉前次的 Worker exit、完整 roles/reviews、raw session usage、歷史 capture SHA/identity；成功與 failed/stopped 都計。重用 integration/review/cancellation 的既有 captures，不對舊 execution 補寫或重新執行；沒有足夠資料就拒絕。
- 前次用量保存到**新** execution 的 `prior-usage.json`，digest 綁 bootstrap 與原 ledger request。每次 admission 累加實際 tokens、native member 次數與原 allocation，跨 execution session ID/file 不可重用。缺 history／篡改／超額／超 restart cap 不開新派工。唯一缺 session 可計零的歷史是 ledger 證明 RESERVED 直接取消（revision 1、無 pane/Worker/events、具新 controller metadata）；其他缺 session 不補零。
- 新 bootstrap 綁本次 L0 instance UUID。L0 launch/review 要原 instance；重建同 session/PID 也不能繼承 dispatch。正常 close 保存 controller-ended 標記，Worker 即使看見同 PID 仍活著也拒絕新 admission，reservation 保留供 drain/reconcile。L0 有本次 v3 open reservations 時禁止 switch/fork；允許切換後重新初始化，Worker 自身禁止 switch/fork。這是公開 session lifecycle／process／epoch fencing，**不是 TTL heartbeat lease或健康度保證**。
- 結果 seal 後公開 `ctx.shutdown()`，L0 review 要 Worker process 已退出、Worker roles 全 terminal，再由既有 raw-usage reader於等待前後重驗。production adapter source 現已接入這個 predicate，不再用 fixture 的 no-op assertion；未 reload、未核 live registry／native producer／真 session 切換時序，readiness 仍維持 direct-only。

驗證：`goal-team-evidence/task-runtime-budget.md/.log`；204 runtime、23 host、39 parser PASS，39 source hashes 在 host/parser 驗證前後一致。真 Git/SQLite/FS、公開 SessionManager 和實際 Worker extension callbacks；native producer、Herdr、provider 時序與 counters 仍是 fixtures，零模型／無 Goal mutation／非獨審。保留原失敗；主 LSP 10 檔 clean，scoped cache 另有 extension EOF 外 stale，非全 repo clean。

此階段當時尚缺 final acceptance 再計量／freshness；第 24 節已接通已套用 target 的 source 路徑。缺 summary usage 仍 unknown；reported counters 不等 provider billing，checkpoint 不會中止已在執行的 provider／child，也不保證執行中精確 token ceiling。真 native/Goal E2E、matched A/B、官方升級仍是既定 required 驗收，未延期或宣稱通過。

## 24. 已套用 target 的 final acceptance／Goal readback／cleanup — source 接線

- 沿既有 `HostAcceptance.accept`，只對具新 metered L0 bootstrap、`approved-integration`、已完成 target apply 的 v3 路徑啟用。沿用 apply 的 host-check criteria ceiling；verify-only、其他 evidence kinds、缺既存 plan/seal/proof 仍拒絕，不把 patch-only 或舊 v3 追認成 target 已交付。v1/v2 保留原 strict-native 分支。
- `runChecks` 在已有 apply receipt 時先核真 apply proof，再對 target 跑 `host-final-check-*`；不拿 pre-apply checks 當 final，也不覆寫舊 receipt。check 後再次核完整 target/workspace，exit-zero 越界／hidden writes 仍失敗，重複只 readback、不重跑副作用。
- Final proof 重用 `readAppliedReviewCandidate`、`verifyIntegrationApply`、`integrationReviewBinding`、terminal raw-usage reader：核完整 sealed review/writer captures、target/index/ref、原 candidate manifest與evidence、各 final check、Worker OS exit及全部 native/review 成本；重新套用 cumulative actual/spawn/allocation guard。保存 boot/bootstrap/event-census digests。native `required`／`review-required` 原值不改。
- 新 `teams-task-acceptance/2` 分列 `candidateSourceDigest` 與真正 `sourceDigest`（已交付 target），並綁 `finalEvidence`。原 execution 的 candidate source 不改寫。Ledger 在 VALIDATING transaction 內再次核 owner/session/epoch、result/candidate及 unresolved runs；partial／fenced 保存現場，不自動重建或接受。
- 重複 accept 只完整重驗已有 acceptance，不再次驗收或 dispatch。Goal 完成前也重驗同一 proof；公開 `tool_call` 明確 await 並把拒絕轉成 `block:true`，不依賴 extension throw 來阻止 Goal 寫入。這是 evidence readback，不是重建 L0 的新派工 grant。
- matching Goal tool result 到達後先記 `goalCommitState=committed`，再驗 freshness／cleanup；後置失敗保留已發生的外部結果與 reservation，不假裝 Goal 沒有寫入。Worker已退出、pane idle/cwd吻合後，保存 accepted-pane intent→close reply→owner recheck，再 release。尚未 idle 不消耗 intent；未知 close outcome 不重播。新 hook async 結果由既有 consumers await；沒有新工具／dependency／儲存 migration。

證據 `goal-team-evidence/task-runtime-final-acceptance.md/.log`：full run 209/210 通過；唯一失敗是 legacy host fixture未 await新async callback，補兩處await後該case 1/1通過，hash證明其他39檔中的38檔未變，重用209份有效證據，**不是宣稱第二次完整210/210 run**。23 host／39 parser PASS，最後前後source hashes一致；8修改檔primary clean，lens scoped cache4檔無issue，非全repo scan。

以上是實際 HostAcceptance／Goal hook consumers＋真 Git/SQLite/FS的零模型路徑；native producer、review報告、Goal回覆、Herdr與Worker exit情境仍有fixtures。沒有真Goal mutation、live native/Herdr/model/E2E或獨審，沒有reload／部署／升級／修改既有execution。D3/D4/D5/D7與V1–V5仍不得整體關閉；verify-only最終交付仍blocked，不偷偷改為apply。下一步沿既有驗收條件核缺口，live/model/官方升級須先取得對應授權，readiness維持direct-only。

## 25. Verify-only 最終 patch 交付 — source 接線

- 沿既有 verify-only policy，交付封存的 `integration/review.patch`，**不表示 target 已套用**。沒有新增 apply 權限；發現 target-operation journal 即拒絕。既有 apply 路徑／AcceptanceReceipt/2 不變。
- Patch-only 使用明確的 `teams-task-acceptance/3`，不混用原本代表 applied target 的 /2。`finalEvidence.delivery` 明列 verified-patch、targetModified:false、targetRoot、sourceRoot（staged repo）、baseCommit/tree、patchRef/SHA。Ledger依契約 mode 核 receipt schema，原 execution 的 candidate digest仍保留。Tool回覆直接提供patch路徑並說明target unchanged。
- 重用 sealed review/writer、完整 staged rehearsal、Git clean/base、原 workspace result與 terminal cumulative usage readers；不自動seal或補證據。Host checks重用已在staged repo執行並封存的同一批checks，不重跑target或追加重複驗證收據。Final proof綁 staged source及原patch bytes；Goal前後同一validator完整重驗，patch/schema/delivery篡改拒絕並保留reservation。
- 沿用 host-check criteria ceiling，不以新schema當通用放行。使用者後續確認：沒有目前必要性的功能取消；現有 Todo E2E criteria 都是 host-check，未指定非host-check種類，因此取消「增加其他證據種類」待辦，不增加框架／契約欄位。未知種類保持拒絕，不以擴充能力作為本次交付條件。Root/Goal/cleanup consumers已用實際extension callbacks驗證，native/review/Goal/Herdr仍fixtures，非live驗收。

沿用 `goal-team-evidence/task-runtime-final-acceptance.md/.log`，最新 `VERIFY-ONLY SOURCE-BOUND FULL REGRESSION`：**223/223 runtime、23 host、39 parser PASS**，39 source SHA在整輪前後一致；4 primary LSP clean。Lens scoped cache另有acceptance的1warning＋2EOF外stale，与同源Node parser/primary不符，保留而不改source迎合，不稱全repo clean。原verify-only runChecks錯在target跑而失敗的RED保留；新回歸涵蓋durable patch／native temp cleanup、target/index不變、check不重跑、partial/tamper/late usage及Goal guard與公開工具的交付文字。

未新增模型、child、部署、reload、依賴、migration或微TODO，未操作既有execution／Goal／reservation。母項與V1–V5保持open；真native/Goal/Herdr/provider E2E、matched A/B及官方升級仍待對應授權，不以223個fixture測試代替交付。

## 26. 原專案 Goal metadata 與交付檔案分開比對

使用者明確核准限定排除官方`.pi/goals/`，未授權模型、真Goal建立、reload／部署或升級。查核官方pi-goal-x文件確認其在專案內持久化Goal；舊E2E runner使用projection，沒有驗到真Goal更新會觸發D6 scope拒絕。

- 只在新v3的sourceRoot完整workspace快照排除`.pi/goals`。其他`.pi`檔案、目錄權限、prefix lookalike和其他明列worktree的同名目錄仍檢查；既有overlap gate拒Worker allowedWritePaths涵蓋Goal控制目錄。v1/v2行為不改，不追加任意路徑設定或新契約欄位。
- 同一排除接到v3 target apply的前置／fenced mutation／receipt／rollback readback。Staged checkout快照預設仍不排除Goal路徑。比較Git checkout時，只省略沒有其他內容的`.pi`容器目錄節點（Git不保存空目錄）；其mode仍受D6檢查。其他`.pi`內容從不省略，不以gitignore全面豁免產品檔案。
- 舊baseline的exclusion inventory不吻合仍拒絕，不補寫既有execution。排除目錄內的變動不再由workspace gate偵測；這不是任意shell寫入防護或OS sandbox，不把native Goal readback當作任意檔案寫入者的證明。

沿既有final-acceptance.md/.log保存：scope純probe／回歸RED；第一版scope修正後verify-only通過、applied-target因完整Git baseline仍含Goal資料而RED；接完實際consumer後focused通過。完整回歸226/227，唯一失敗為舊test預期exclusions尚未加入`.pi/goals`；只更新該assert後重測1/1，SHA核實其餘38/39 source未變、重用226個PASS，**非第二次完整227/227 run**。23 host、39 parser PASS，最後前後SHA一致；6修改檔primary clean，scoped lens仍有workspace-scope 1warning＋1EOF外stale，與同源Node/primary不符，非全repo診斷通過。

測試使用真Git/FS/mailbox與HostAcceptance／Goal guard consumers、合成Goal metadata/native/Herdr，無真Goal或模型。原定真E2E仍須使用既有Pi host公開工具，不能直接重跑非Git／projection的舊runner當驗收；本session未提供team_task工具，不自行reload或擴充架構。母項／V1–V5繼續open，已取消的「其他證據種類」不再列回必做。

## 27. 通用需求入口與 L0／Worker 交接（2026-09-14）

本輪使用者更正目標：完成通用 agent teams flow，不是為通過 G1 預製兩份答案。既有 Task runtime 已接執行／驗收；缺的是模型可見的需求→spec操作指引，另有 Worker 讀錯 scope 欄位、遺失 contextRefs 的實際交接缺陷。

- [L0 操作規範](extensions/teams-orchestrator/SPEC.md) 是一般需求的準備／執行／驗收規範，透過現有 `team_task_dispatch` description 與 Pi 原生 promptGuidelines 提供；不是新 tool／controller／schema compiler。L0用原生read/write產生spec，extension不靠keyword分支或內建答案規劃工作。
- 原始需求、每個成果、依賴、checks与交付模式必須相符；不拆同一產物的criteria來湊平行Worker，不把verify-only patch當已安裝整合。整體交付還要核完整原需求與合併後入口，不能只數receipt。
- Worker prompt改從實際 `workspace.sourcePaths` 取範圍，並傳遞sourceRoot、allowedWritePaths與原有contextRefs（URI/SHA）。原本錯讀不存在的`scope.sourcePaths`且忽略refs，迫使測試把所有檔案路徑硬塞objective；這不是通用cold-start交接。沿既有contract/mailbox和6KiB上限修正，沒有新payload欄位或擴權。
- Task runtime保留原單Task累計usage／role admission；跨Task／campaign總帳目前仍由L0依可用證據核對。上一輪E2E entrypoint的history＋aggregate修正保留，但不宣稱已成為所有使用者要求的全域硬額度。
- G1專用App＋guide產生器／guide checker撤出執行樹，原bytes保存在`goal-team-evidence/task-runtime-request-flow-20260914/withdrawn-g1/`。既有browser/receipts與失敗紀錄保留；新需求驗收不得以預先寫好的Task specs、產品patch或固定答案代替L0。
- 本輪可證：一般工具註冊可見操作規範、既有完整schema未改、實際prepare→mailbox→Worker prompt保留非Todo objective/scope/refs，既有執行/驗收回歸不退化。這不是LLM語意規劃、真產品交付或unattended readiness證據；尚未reload／啟動新模型或Goal。下一次經授權的驗收從使用者原始需求與乾淨基線開始，保存L0自己產生的spec及逐需求結果。

## 28. Task 共用預算與角色軟預留（2026-09-14）

這是通用機制，不是提高 G1 的固定 implementer/reviewer 配額。新 v3 `prepare` 封存 `policy.tokenBudgetMode:"shared"`；舊封存契約沒有此欄位時仍按硬 member cap，明列 `member-hard` 可保留相容行為，不能用新規則追認舊失敗。

- Task ceiling 不變；Worker、所有 leaf、最終 review 的 input/output/cache 實耗共同扣帳，prior execution 真實成本不可 reset。角色 `max_tokens`／review `maxTokens` 是初始累計估算與預留，不是單次輸出上限。超過估算本身不再拒絕候選。
- 沿既有 RuntimeLedger 的 transaction/owner epoch，schema 3 僅於 executions 加 `budget_pool_json`。`可用 = ceiling − prior actual − current actual − 各 member holds`。下一請求只從未被預留的餘額補足 headroom；settle 保存 actual、留下尚未消耗的原估算，finish 釋放未用 hold。平行呼叫原子競爭同一餘額，沒有新 controller、服務、總帳或 top-up 工具。
- Worker／leaf／source-bound reviewer 共用公開 Pi hooks。文字請求按序列化 context bytes＋模型最大輸出保守預留；圖片／無 context 用模型 window；compaction 預留 native 兩段摘要空間。實耗用公開 SessionManager 的 input/output/cache counters 結算；必須有該次新的 assistant/summary 報告，不能拿舊累計值推定零成本。
- 無法計量、未完成 request、身分改變／reload、owner fencing／原 L0 退出、deadline／cancel，仍阻止後續模型請求；已發生的成本保留。真超支不 clamp，不以事後增額改寫成功。Native ceiling 與 Task acceptance 一起採新語義，raw session／source／lifecycle／receipt checks 不刪除；final acceptance 再核完整 pool 與獨立計量一致。
- 既有 14 個 team profiles 僅新增 `extensions/teams-budget/index.mjs` 這個 budget-only 入口，共用原計量函式而不載入 Worker tools。Native in-process role 不一定有 depth env、可能繼承父 Task 目錄，所以不能用 depth 猜它是不是 Worker。只有明確 binding 才啟用計量；沒有 binding 的普通角色完全 inert。模型、工具 allowlist、角色選擇與權限不變；專案覆寫角色仍沿原 scope resolution，缺 hook 時拒絕啟動，不偷偷改用另一個 profile。
- 這是 reported-usage admission，不是 tokenizer、provider 即時 billing firewall 或新增 retry。保守 headroom 可能在仍有賬面餘額時拒絕；在途、工具內嵌/provider 內部重試的消耗不能由它即時硬停。Pi 原生已配置的有界 retry 保留；Task redispatch 仍禁。L0/campaign 的跨 Task 總額與歷史 anchor 仍依既有規則核對，不是全域共享池。

本輪只做本地 source、disposable Git/SQLite 與實際 Pi SDK 的離線 fake-provider 驗證，沒有真模型／Herdr／G1／Goal／reload／部署，也未開啟或遷移正式 ledger。下一次新版 writable runtime 啟動會交易式升級 schema 2→3；新版只讀 reader 同時支援 2/3，不修改舊契約。切換前須先處理既有活躍／unknown executions，避免混版本 Worker；不藉此接管或補写 r2/r4 receipts。驗證結果、來源 SHA、完整限制見 [shared-budget evidence](goal-team-evidence/task-runtime-shared-budget-20260914/README.md)。

## 30. Agent／runtime／checker 責任邊界修復（2026-09-22，離線已驗）

本輪依使用者授權先更新設計再修 source；main-only，不啟新 Goal／Task／模型／live G1、不改 sealed execution 或提高權限、預算，不 commit/push。第 29 節為先前結果，不代表本節已驗收。

- **Agent owns semantics**：L0 保留原始需求中的精確介面字面值、行為、scope 與 evidence mapping；Worker 向 leaf 傳遞同一需求與實際 candidate。移除測試輸入的固定角色鏈、任意 objective/criterion 字數與重複 review 指令；只保留既有 6 KiB prompt gate。模型負責完整工作及 review 的資源規劃，runtime 不靠 Todo selector／關鍵字決定規劃正確性。
- **Runtime owns facts**：純輸入拒絕、正常 check process 非零退出、signal/timeout/spawn/source/owner/usage 故障分開。非零退出只證明 check 未通過，不能直接宣稱產品 bug 或 assertion failure；在 source/owner/staged-tree 仍一致且 receipt 完整時，透過既有 tool details 綁 tool/call/input/execution 交接 check/receipt/log 路徑及 digest。保留 failed integration 與禁止重播／驗收；observer 不立即切斷 L0 診斷／pause／cleanup，但不能把它轉為 PASS。未知／runtime fault 仍立即 drain。診斷不是修 sealed artifact 的授權。
- **Review**：沿 public preflight 揭露 resolved IDs、required internal tools（含 structured_output）與 ceiling 差異；不 hardcode profile 工具、不豁免 internal tool、不擴權。plan 提供當時的 role/review spawn 與 allocation 診斷，start 仍重新驗證並拒絕耗盡，避免把 plan 當預留或審批。
- **Checker owns observable behavior**：空列表仍須指定 empty element 可見；有項目時隱藏或移除皆合法。計算帶 identity 的外層 Todo rows，不把 row 子控件的同名 attribute 算多筆；驗證 checkbox/delete 屬於 row。失敗也保存 bounded DOM／phase／browser errors，不只 timeout。撤回「初始 HTML 必須含 empty」的新增限制：r16 原錯誤是在新增後，不是初始 race；r17 原內容副本已實證只有 1 row、舊 selector 卻匹配 3 個帶 data-todo-id 的元素。
- **Recovery/accounting**：不以新 Goal/workspace 重設 repair 次數／campaign history。唯讀重新核對 r12–r17 的 parent（同 anchor 只計一次）、各 L0 與完整 closed native usage，保存追加的更正證據，原漏帳 reports 不覆寫。unknown 不補零。不建立全域 campaign ledger。
- **Finish line**：既有 candidate 的差異實驗＋可執行 regression 驗 checker 正／負例；公開 stage→tool result→observer seam 驗 completed failure 能診斷但不能接受／重播、runtime/unknown 仍停；review diagnostics 不改 ceiling；計量去重且缺失 fail closed；相關／完整回歸、scoped LSP、lens。離線 PASS 不代表模型需求交接或 live readiness PASS；之後再取得一次 fresh G1 授權。

### 30.1 實作與驗證結果

- `check-failure.mjs` 的完成失敗事實由 stage source/owner/terminal 檢查後產生；原 integration failure/intent 保留。公開 stage tool 與 observer fake-RPC seam 測得可診斷、不可 false-complete、不可重播；signal/mutation/unknown 仍停。
- `integration-review.mjs` 把 required internal tools 納入相同 ceiling 並揭露差額；`review-runs.mjs` 的 allocationDiagnostics 是 plan 時快照，不是 token 實耗、live grant 或預留。
- `browser-todo-check.mjs` 在原 r16/r17 內容副本通過；r16 afterCreate.emptyPresent=false、r17 identityMatches=3/rows=1，兩個原誤判已可區分。原 candidate／failed receipts／Goals 不修改，不追認 acceptance。
- 完整 runtime suite 407 PASS、0 FAIL、1 opt-in browser skip；該 browser suite 另以真 Edge 實跑 9/9（合法動態 empty／nested identity，及 missing/stuck empty、no-add、no-persistence 負例）。不是模型交接或 G1 PASS。
- r12–r17 原生完整計量與 durable ledger 唯讀重核：全部 CANCELLED/reservation closed/Goal commit not_requested；L0＋native 6,818,463 tokens，加單一 parent snapshot 共 28,372,521（含 cache，其後用量另計）。舊 campaign 缺證據與 reservations 不動。

新需求模板為 `task-runtime/e2e/g1-request.txt`，歷史 r12–r17 request/launcher 只作證據，不再複製其固定提示或空 history。機械 source/consumer 修復已驗；Agent 能否保留原需求並完成新 live 仍待另行授權驗證。詳見 [本輪證據與限制](goal-team-evidence/task-runtime-boundaries-20260922/README.md)。

## 29. 執行事實、可修正輸入與完整歷史（2026-09-22）

使用者已授權更新設計並修正。**Prompt／skill 決定如何完成；runtime 如實執行、保存狀態並守住已授權邊界。** 本輪 main-only，不啟 child、不改模型／權限／預算、不操作舊 Goal/execution、不 reload、不啟新 live E2E、不 commit/push。R6–R11 原始失敗不覆寫；R7 是 Task deadline 到期，R9/R10 正式 browser checks 已 PASS，不沿用已撤回的 wrapper 假成功說法。

### 29.1 工具與 observer

- 在既有 tool result `details` 交接操作事實，不新增 controller／ledger 狀態／retry service。只有發生於具名純輸入驗證邊界的拒絕，才標示為可修正輸入；包括 spec 格式／prompt 容量，以及 review wave 的未登記輸入。保留原錯誤與階段，不能把任意 exception、磁碟失敗、權限／source／usage gate 標成輸入錯誤。
- 不用錯誤訊息白名單判斷副作用。公開 parameter-schema 拒絕沿用 Pi validator；工具內部以 host 產生的結構化事實交接，observer 必須綁同一 tool call/input。沒有可信證據時仍 stop/drain，不能根據模型宣稱已恢復重播。
- Dispatch 開始呼叫僅是 attempted，不代表已分配或已啟動。`prepare` 可能已 claim controller，即使未 reserve 也不能宣稱完全零副作用；拒絕回覆須區別這些範圍。原 identity/reservation/source/authority checks 不取消。
- 一般 read/bash 等工具錯誤保留在 faults，不以單一永久 latch 否決後來的 Goal 結果，也不以任意後續成功消除未知副作用。observer 不推斷任意工具語意；L0 依原始效果／授權處理，未分類的 Task 工具故障與 provider/extension/RPC 故障仍由 host 機械性停止。`fullE2EPassed` 不因此自動變 true。
- Collect 分開「本次等待視窗結束」與「Task deadline」。前者正常回傳 execution／candidate／Worker 狀態，可續等同一 execution；後者、Worker 無結果退出、launch unknown 仍失敗並保留 reservation。不延長 deadline、不接受未退出 Worker、不自動重派。

### 29.2 契約與 prompt 交接

- Worker 必須看見每個 criterion 的 `requiredEvidenceKinds`，以及已封存 contract 的精確路徑；不靠猜測或臨時 objective 字數規則。保留 6 KiB 限制，容量驗證仍在 reserve 前；精簡重複 runtime 指引而非刪除使用者要求。
- v3 現行 final acceptance 只支援有 host-check binding 的 criteria，獨立 source-bound review 仍 required。揭露此能力限制及缺失的 check mapping，不自動改寫 criteria、默默換 evidence kinds、放寬 gate或新增「所有任務永遠只能 host-check」規範。**source-review-only 驗收不在本輪範圍**，沿第 25 節既有決定。
- Review 工具權限以既有 native public preflight 的解析後 inventory 為準；回報 expected／effective／excess 差異，不手抄 profile selectors、不 hardcode 角色工具、不擴權、不放寬 ID regex。Ceiling mismatch 是未啟動的能力診斷，不是自動重試權；已封存 policy 不可修改，只能在原授權中選擇相容方案，否則交回 blocker。
- Stage 回覆明示已跑 checks 與 receipts，verify-only 不要求 target apply。能力失敗不建議切換 mode。角色選擇、candidate artifact 指派、正確 cwd、語意覆蓋與依賴留給 L0／Worker／skill；不加入固定角色鏈、單 implementer、禁止 verifier 等規則。

### 29.3 歷史計量

- 重用 `measureClosedExecutionUsage`、既有 ledger/mailbox/native lifecycle 與 session hashes，在原 live owner 的終止／drain 入口封存完整 Task 計量。包含最後一個 leaf/review、失敗／取消和 cache，不從下一次 role admission 前的快照猜最終用量。對未進 stage 的已完成角色，也重用 `captureNativeTerminal` 保存 SHA-bound 終態 bytes，避免 native 暫存清理後只剩 scalar usage；歷史唯讀 reader 不補寫這些證據。
- E2E history 以明列 execution 的完整 native inventory 核對來源；L0 仍負責 campaign membership，不掃描 session home、另造全域 ledger或把未列入的 execution 視為不存在。既有 raw snapshot history 保持可讀，但不宣稱它單獨證明 inventory 完整。
- 清理終態與用量完整性分開呈現。無法完整計量時保存 unknown／原因，不阻礙必要 drain、不補零、不讓新一輪把未知用量當剩餘額度。舊 owner 已退出的資料只做唯讀核對，不能冒用其身分封存新 receipt。
- Task 實耗包含 prior execution 時，campaign 彙整需按原生 session identity 去重並檢查來源一致，不把 prior actual 與原 Task reservation 重算。仍保留原 cumulative anchor、unknown-usage 與 aggregate reservation 規則。

### 29.4 驗證與完成界線

以現有 fixtures 測真 consumer seam：spec 拒絕→同 loop 修正→一次 launch；正常 collect 視窗結束→同 execution 成功；Task deadline／未知 launch／source 篡改仍阻擋；review preflight 不擴權／不耗 launch intent；已完成 checks 不重跑；history 包含最後角色且缺失／重複／篡改拒絕。使用非 Todo criterion／不同 roles，避免 app 或角色特判。修改後 scoped LSP、相關回歸、必要 full suite 與 lens diagnostics，保留 source-bound 證據。

本輪 source 修正與離線驗證完成：完整 runtime suite **398/398**、18 檔 primary LSP 0 errors；takeover successor reconcile regression 通過，execution owner/epoch 與 contract identity 保持不變。Pi 公開 `tool_result` hook 保留拒絕的 error flag 與 details，已用真 Agent loop＋離線 fake provider 驗 consumer seam；未啟模型。補驗兩種 host-exit 事件順序均保留 failure／unresolved cleanup，未修改停止規則。

唯讀核對 R6–R10：R9/R10 完整計量並找出原 history 各漏一個 leaf；R6–R8 reader 所需的部分 native 暫存終態已不存在，保持 unknown，未冒用舊 owner 補封存。依使用者授權修復 takeover→reconcile seam 後，逐一準備 proof 並推進 4 個舊 controller 至 epoch 2；三筆 process/pane 或 role proof 不完整而保留 reservation，一筆因 workspace 遺失 fail closed。未關閉整個 campaign 歷史缺口、舊 reservation、live G1／完整 request-to-outcome 或 readiness；pi-gateway config 與既有 archive diagnostics 亦未處理。證據：[執行事實修復](goal-team-evidence/task-runtime-execution-facts-20260922/README.md)、[舊帳處置](goal-team-evidence/task-runtime-execution-facts-20260922/old-account-close-attempt.json)。

## 31. r18 後的啟動交接、Agent 規劃與 runtime 邊界修正（v1.22，待實作）

### 31.1 授權、證據與更正

本次使用者要求更新設計並逐一建立 TODO，**不是實作、reload、權限／模型／預算變更或新 live 授權**。main-only；既有 dirty work、Goals、execution、sealed artifacts、正式 ledger 均不動。下列十項是待辦，不因文件完成就算功能完成。

直接證據以 [r18 原始 request](goal-team-evidence/task-runtime-g1-request-driven-20260922-r18/request.txt)、[實際啟動及 RPC observation](goal-team-evidence/task-runtime-g1-request-driven-20260922-r18/live/rpc-observation.json)、其 `sessionFile` 所指原始 session、[launcher](goal-team-evidence/task-runtime-g1-request-driven-20260922-r18/run-request-driven-g1.mjs) 為準；對照 [r17 request](goal-team-evidence/task-runtime-g1-request-driven-20260922-r17/request.txt)。r18 README/accounting 中下列錯誤尚待 R31-A 追加更正，不作權威結論：

- 啟動參數有 `--no-skills`、`--no-context-files`；L0 未讀 team-flow，但確實讀了當時的 Orchestrator SPEC。不能稱「完整 skill 已載入但 Agent 不遵守」，也不能稱完全沒有指引。
- r18 移除 r17 的明確 fresh Goal 授權與預算數字，改稱 separately supplied；launcher 的 host admission 有資料，但傳入模型的仍只有原 request。`get_goal` 回無 Goal 後轉 raw subagent，是可觀察偏離；缺交接、模式歧義是已證缺口，不能由單次 trace 證明模型內部唯一原因。r17 曾在相同關閉 skill 設定下進入 Task，故不把關閉 skill 當充分因果證明。
- L0 約第九分鐘回覆 blocker 並 `agent_settled`；observer 在 `goal:null` 時仍等到 deadline。deadline 不是持續規劃三十分鐘的證據。Task drain 空 inventory 不能證明直接 subagent 全部已收尾。
- L0 手動 browser worktree 命令在切 cwd 前 `git apply`，曾誤寫原 target，之後清乾淨；不得稱全程未改 target。無 Task execution／AcceptanceReceipt，r18 仍 NOT PASSED。
- 原生 `acceptance:false` 是合法 API；只有相關 acceptance report 設定要求 `outputSchema`。r18 後追加的「false deprecated／所有 subagent 必須 schema＋acceptance 物件」須撤回；Task required evidence 仍不可因此關閉。
- r18 純 L0 assistant 用量 **293,387**，implementer **163,702**，reviewer **89,443**，去重共 **546,532**。strict L0 reader／RPC aggregate 已含兩筆 tool-result child usage，再加 child 會重算；799,677 與 839,677 均非正確去重值。此值不是 campaign 最新總量、provider billing 或舊 unknown 結清證明。

### 31.2 設計責任：完整環境，不增加語意 gate

| 層 | 應負責 | 不應負責 |
| --- | --- | --- |
| 使用者／啟動端 | 交接真實模式、Goal 授權、交付要求、現行資源／來源、適用能力與規範 | 替 Agent 寫答案 spec、固定 Task／角色鏈；從 env 旗標創造授權 |
| Agent／skill | 理解需求、成果／依賴、角色與完整成本、證據選擇、診斷與修訂計畫 | 猜授權、預算、receipt identity 或遺漏的上下文；用換路掩蓋 blocker |
| Runtime／host | 執行已授權操作；owner/scope/budget/source/terminal/evidence 事實及有效性 | 用 Todo/G1 keyword、固定角色／順序判斷規劃好壞；代替 Agent 決定修什麼 |
| 驗收／評估 | 原始需求、實際成果、有效證據、效率與恢復能力 | 只數工具／角色／PASS；把 fixtures、一次成功或 audit skip 當 readiness |

不新增 planner controller、plan registry、workflow engine、全域 campaign ledger 或逐步語意 gate。必要機械欄位／receipt／hash 優先由既有 owner 回傳，不把平台機械操作包裝成 Agent 的規劃責任。保留既有 6 KiB prompt、source freshness、required review、owner、usage、scope 與 acceptance 邊界。小工作仍可 direct；模式未指定仍由 Agent 判斷，指定模式缺能力不能靜默 fallback。

### 31.3 逐項修正與驗收

以下代碼與 native TODO 一對一；各 TODO 亦包含如何修正、依賴及證據要求。原母項 `TODO-a955d56c` 保留，不改其 owner／狀態。

#### R31-A — 證據更正與計量去重（TODO-cb47c13d）

- **修改位置／做法：** r18 evidence 追加 correction 與 README 指向；查 `task-runtime/e2e/usage.mjs`、`task-usage.mjs` 和實際彙整 consumer。用 native message/run/session identity、來源 SHA 對帳 parent tool-result 與 child corpus，不以 scalar 相等猜重複。保留原錯誤 JSON、失敗與正式 ledger；僅確認 consumer 有缺陷才修改該層，不全面重造計量。
- **驗收：** 三份原 session 與 RPC aggregate 一致；已內嵌／未內嵌／部分重疊、failed/cache、缺失／不符來源案例均可區分。不能猜扣未知成本。parent 最新 snapshot、campaign membership 與 r18 本次值分列。
- **依賴：** 無；供 B/I/J 使用。報告更正不得冒稱 runtime 已修或 campaign 已結案。

#### R31-B — 模式／授權／預算交接（TODO-552919e5）

- **修改位置／做法：** `run-todo-flow.mjs` 的 public launch／prompt seam、`g1-request.txt`、`E2E-INPUTS.md` 及未來 launcher 準備流程；不回填歷史 requests。從同一已核 host admission 資料產生精簡 context：批准模式、Goal 建立／續用權、交付模式、anchor/ceiling、actual/unknown/holds、可配置上限、來源 ref/SHA/時間與 deadline。模型可讀的來源不可只藏在 host JSON；不交完整私密 parent transcript。
- **驗收：** 經實際公開 host/model-request seam 捕获模型可見內容，核與 admission 一致；fresh Goal 已授權、未授權、現有 Goal 續用、普通不建 Goal、missing history／stale snapshot 全覆蓋。不是只 assert prompt 檔案含某字串。env 的 canary/auto-confirm 不能代替批准。
- **依賴：** A；與 C 同步口徑。Task/role 數、依賴與配額仍由 Agent 規劃。

#### R31-C — 精選 skill 送達與規範一致（TODO-e43e3aec）

- **修改位置／做法：** `publicCommand`、team-flow/member、`GOAL-TEAMS.md`、Orchestrator SPEC、tool description/promptGuidelines、E2E request。沿 Pi 公開 resource/skill 入口明列本模式必要內容；可保留不載入無關全域 context，不一口氣開所有 skills。必要責任集中一份當前規範，其他文件路由引用，歷史 helper 與新操作隔離。
- **撤回：** false deprecated／所有 subagent 強制 schema＋acceptance 物件的錯誤概括；依原生 API 與任務 required policy 區分。G1 特例留 E2E，不注入通用 SPEC。保留 `request-flow.test.mjs` 的非 Todo/G1 通用性要求，而不是刪測試迎合過度規則。
- **驗收：** 實際模型可見規範及來源／版本可核對，skill 檔名被 discovery 不等內容已送達；覆蓋缺失、衝突、普通 handoff、Task、leaf 不帶 Goal 控制及 acceptance 正反例。不強制 read 次數、固定工具序列，不改模型 routing。
- **依賴：** 與 B 協同，不互設循環完成依賴。

#### R31-D — 按模式與 owner 整理工具介面（TODO-b9d4800b）

- **修改位置／做法：** 查 L0 tool registry、Orchestrator initialize/preflight/review RPC、Worker/native role 入口。Task 模式 L0 負責成果 dispatch/collect/stage/review/accept，Worker 負責 task-local role launch；ordinary handoff 保留直接 subagent。先列能力對照，再選最小的公開工具曝光／描述調整，不能刪 native 註冊而破壞 host RPC。
- **驗收：** 前後 effective inventory 與真正 consumer 測 L0、Worker、ordinary handoff、review transport。缺能力回具體 blocker，不新 install/fallback。工具隱藏不是 OS sandbox，shell 副作用仍依既有授權與作用範圍，不宣稱完全封死旁路。
- **依賴：** B/C。若涉及權限/profile/全域配置或架構變更，先提交精確差異取得 owner 批准；此設計不是該執行批准。不以每次 tool call 新增拒絕 gate 代替角色介面整理。

**現況與 2026-09-23 owner 已批准的限定實作（非 live 授權）：** 現行 `publicCommand` 同時載入 Orchestrator 與 pi-subagents；Task L0 的模型工具清單仍含可直接啟 raw writer/reviewer 的 `subagent`，而 `team_task_dispatch` 也提供同一成果的 Task 執行入口。`extensions/teams-orchestrator/index.mjs` 的 source-bound review 使用 `pi.events` 上的 `SubagentsRpcClient`，`Worker` 的 `team_role_spawn` 亦走原生 RPC；刪 pi-subagents extension 會破壞內部 preflight/review，不能這樣修。Pi 官方公開 `pi.setActiveTools()` 可調整**模型可見工具**，並不移除 extension RPC bus。已僅當受信任的 request-driven admission 核定 `mode=task-pi` 時，由 launcher 合成 `TEAMS_E2E_L0_MODE`；extension 在 `session_start` 核 session owner/Task capability 後、首次模型請求前**從 active tool names 移除 `subagent`**，保留 extension 載入與內部 RPC；Worker 的 `team_role_spawn` 不變。ordinary/direct、未指定模式的 L0 active tools 不變；缺工具／RPC 時回 exact blocker，不開第二條 writer 路徑。以公開 inventory／review preflight 消費端測 Task L0、ordinary、Worker、read-only review，確保實際 internal `structured_output` inventory 仍合 sealed ceiling。這是模式限定的 tool visibility／permission 變更，**不是 OS sandbox 或 shell 防旁路**；owner 已批准，但目前單元與 fake-RPC 只證工具選擇及 admission env，尚未證真 Pi 模型首次請求的 effective inventory。若 native `setActiveTools`/review seam 不相容，停止，呈證據重新決策，不能改成每步關鍵字 gate。

#### R31-E — 成果規劃與實際交接（TODO-874a8f73）

- **修改位置／做法：** 既有 Goal/task 描述、Task spec/contextRefs、Worker prompt 與 native leaf handoff。由 Agent 簡述需求→成果→依賴→checks→implementation/final-review 資源；查 producer/consumer 真正保留 selectors/keys/routes、行為、scope、版本與 required evidence。僅修已證丟失，不建新 plan schema／registry。
- **操作分工：** host 回傳已知 identity、hash、精確 receipt/log/cwd；L0 不重造候選 browser worktree，使用 Task stage 的 relocation/check seam。普通 direct 工作不被這個 Task 分工一律禁止。保留動態角色與不重複 review 的選擇。
- **驗收：** 非 Todo／單一 cohesive 成果／相依成果／合法少角色方案；原要求跨三層可追溯，完整 review 成本未漏且 rendered Worker prompt ≤6 KiB。不用 runtime keyword 判語意、不預製 spec/patch。真規劃能力另外在 I 驗。
- **依賴：** B/C/D。

#### R31-F — settled 結束與精確收尾（TODO-5ac6e636）

- **修改位置／做法：** `run-todo-flow.mjs` 的 `agent_settled`、final stats、stop/drain。用公開 session／queue／continuation 與已知 run inventory 分清：本回合 settled、仍有合法續跑、真正結束但缺交付、未知 child。無 Goal 且已結束者取 final usage、記未完成事實並安全收尾，不空等 deadline，不靠 prose 或任意短 timeout 猜狀態。
- **驗收：** r18 事件時序、no-Goal final、create_goal 後正常續跑、queued follow-up、active child、provider retry、check failure、unknown launch 與事件順序變化；不能錯殺合法等待、force release 或用舊 usage sample 當終態。Task rows=[] 不替 raw child terminal 作證，native proof 不足保持 unknown。
- **依賴：** 無；用量口徑沿 A。這是 observer 正確性，不是 Agent 規劃 gate。

#### R31-G — 有界修復設計／公開能力查核（TODO-5383c3ba）

- **修改位置／做法：** 讀 Task/native public revision/report-repair 能力與 integration/review/acceptance 封存點；列「已支援、只有 schema、缺 consumer」。區分 draft/input、report-only、已知 candidate defect、unknown 外部副作用。`request_report_repair` 名稱存在不等有可呼叫路徑。
- **交付設計：** Agent 決定修什麼；原 failure/sealed bytes 不變；新 candidate 如需版本化，明確原 Task/campaign lineage、owner、共享 budget/repair 計數與 source/evidence 失效規則。只重驗受影響且失效的證據，不用舊 failed receipt 接受新 source，不重開 terminal execution、不以新 Goal 清帳。unknown 先 reconcile；不支援就回精確 blocker。
- **驗收：** 精確 API/consumer／相容性／crash-partial 處理方案與成功恢復、report-only 不重派 writer、drift/unknown/owner/超限負例。先證實最小既有機制能否承擔，再提出必要變更，不能預設新 controller/ledger。
- **依賴：** A/B/C/F。此項完成僅是設計，架構/API/權限變更需 owner 確認；不操作舊 execution。

**現行公開能力查核（2026-09-23，待審批，不視為 H 已實作）：**

| 情況 | 已支援的 consumer 與安全邊界 | 缺口／處置 |
| --- | --- | --- |
| 尚未派工的 draft/schema 或 bound pre-dispatch 拒絕 | `team_task_dispatch`→`TaskOrchestrator.prepare` 在 reservation 前驗證；原 L0 可改自己的 draft，仍核原需求、6 KiB、owner／scope／budget | 不需要 revision API，且不編寫 sealed artifact；已預備但效果未知不得自行重派。 |
| Leaf 同次 native run 的 report 格式更正 | role handoff 既有 `structured_output`／native acceptance，僅在仍可用且被批准的 run 上回報，禁止 writer/check 重新執行；`team-member` 寫明其限度 | `contracts.mjs` 僅允許 `request_report_repair` control **type**，`teams-worker`／`teams-orchestrator` 沒有完整對外修報 handler。封存 Worker result 後的 L0 主導 report-only 修補並無 public path；名稱／schema 不等可呼叫能力。 |
| 已 sealed candidate 的已知行為缺陷／completed host check 非零 | `integration.mjs:stageIntegration` 保存 check receipt/log 和 `failure.json`；L0 可唯讀 diagnose／pause／cancel。`worker-runtime.mjs:sealResult` 從 RUNNING→QUIESCENT，old `resultRevision` 與 candidate bytes 保留 | `failure.json` 使原 stage 不可重試；`RESULT_READY` 沒有重進 RUNNING／換來源再 stage 的公開轉移。原目標不能由 L0 `git apply` 修。要完成需核准新增修訂入口並重驗新候選。 |
| terminal/unknown | `ledger.mjs` ACCEPTED/REJECTED/FAILED/CANCELLED 為 terminal；已存在 reconcile/cancel 與 source/owner/usage reader | unknown 或尚有 open reservation 不能修訂；不得 reopening、force-release 或從空用量開始。 |

**最小實作提案（H 之前需 owner 對確切 API/權限方案批准）：** 保持舊 execution/result/check/failure、review candidate、Task/Goal records 為 immutable。由相同活 L0 以公開 **Task 修訂 intent** 指定舊 execution ID、Goal/task identity、舊 contract/result/source/check-failure 的精確 digest 與欲修的行為；host 核 terminal＋reservation 已關、Worker/native run 全終止、原 target/base仍乾淨、owner/epoch及 scope/實耗，CAS 鎖住 revision，再開**同 Goal-X task 下有 lineage 的新 Task execution**，而非重開 terminal 或新 Goal。沿既有 `TaskOrchestrator.prepare` 的 `priorExecutionId`、closed `priorUsage`、Task pool carry-over 和 `maxProcessRestarts` 原子預留接線，**現行 prepare 只讀最新 prior execution 的 `measureClosedExecutionUsage`：該 reader 的 totals 僅當次 sources，並不包含再前一版；若將來放寬 revision 數，直接重用會漏掉更早實耗。但當前 v3 `maxProcessRestarts` 驗證只允許 `0..1`，且 history gate 限至兩個 executions，因此不能把「第三版漏帳」冒稱現行可達的漏洞。** 目前有界候選修訂嚴格只允許一筆舊 execution 和一輪 repair（repair ordinal 1），原始 closed Worker/leaf/review 用量必須可測並注入新 Task pool；任何提高 revision cap 的變更須先改為完整歷史去重 reader 並另行批准。這個一輪 candidate repair 計數獨立於同一 execution 內的 per-role product repair allowance，不將 process restart cap 誤稱其替代。初始 patch 只能以舊 stage 已核來源作**只讀參考**，Agent 在新受控 writer worktree 提出修正；舊 staged repo `failure.json` 不移動／不重播。新 execution 用自己的 patch、check、review、AcceptanceReceipt；**目前實作對 candidate revision 一律重新執行新 stage/check、重新獨審，不引用舊 failed check 或 review。** 若未來要重用未變收據，先證明完整 source/contract/check/owner binding，不能因名稱相同直接帶入。report-only 則先證 native 原 run 可恢復才同 run 修報；若 Task 已 sealed，需另議只修報內容且不改來源的明確 public revision consumer，絕不可偽造新 implementation。

**2026-09-23 owner 已批准限定實作（非新 live 授權）：** `team_task_revise({previous_execution_id,spec_path,expected_previous_result_digest,failure_receipt_ref,failure_receipt_sha256,repair_reason})` 僅由原 live L0 呼叫。現有 `TaskOrchestrator.prepare` 新增明確 `repairOf` 分支；只接受同 Goal/task、單調 `taskRevision`、原 scope/policy/criteria/contextRefs、相同 check IDs/criterion ownership 的 v3 shared Task。失敗類型先限定為已完成非零、無 signal/error/副作用且整合 failure intent 相符的 stage host-check；已關閉 Worker/leaf/review 的 exact usage 承接新 Task pool。新 receipt 綁 previous contract/result/source/基線/check log/失敗收據和新 normalized spec/request；Worker prompt 指向精確舊候選與 staged source refs，舊 execution 不修改。新 candidate 必重新 stage/check、獨立 source-bound review、accept/readback；已用 disposable Git/SQLite 與合成 native-format writer/reviewer 走通原 check 失敗→新 Task/source-bound check verified→新獨審 sealed→AcceptanceReceipt/3，old failed bytes/receipt 保留，old20+new30=50 只計一次；final Goal tool reply 由 fixture 模擬，**非**真 Goal-X 或模型修復成功。`task-runtime/test/integration.test.mjs` 另驗 signaled/半寫/owner/drift/錯 SHA/超 scope/第二輪及 direct dispatch 繞過被拒。一般 v3 process restart 仍在，但必須 same scope/policy/ceiling/checks；若舊 stage `failure.json` 存在，不能從普通 dispatch 繞過新 repair intent。

對 sealed report-only，native run 不能恢復時仍需另議**不重啟 writer**的報告修訂 consumer；此 API 要求 integration failed-check receipt，不能以 report-only 或 unknown 效果冒充。現有一般 `prepare` 的舊 bounded process-restart 路徑仍在，尚非以 tool visibility 實現的安全 sandbox；新 API 不替那條路徑宣稱額外語意授權。沒有舊 execution 實際被重派或重開。

實際記錄順序沿現有 `prepare`：先驗 failure/source/usage 和 Task prompt → ledger.reserve CAS → `Mailbox.create` → immutable contract/prior-usage/baseline/repair-intent/bootstrap → `launch`。reserve 後若在 receipt/bootstrap 寫入中 crash，新 reservation 為**未明／需 owner reconcile**，絕不自動重送 revision call；沒有另造交易 controller 或原地改 sealed artifact。後續若要求自動恢復 half-published 意圖，需要獨立證據與授權。任何步驟中斷，依 intent 與 durable ledger/source 唯讀 reconcile，不能因未拿到回應就再發一次。新舊執行同 campaign/同 Task 成本與修復次數延續；半完成寫入保持 UNKNOWN／預留而不掃除。正常可恢復正例要由**原失敗行為**經修正通過相同成功情境，並完成新的 source-bound review／receipt；負例含 report-only 誤重派 writer、source drift、舊失敗 receipt 被重用、超額、owner 變更、partial journal、unknown/signal。此設計中僅 completed nonzero staged-check candidate 分支已獲 owner 限定批准並開始實作；不宣稱 report-only 或 unknown 分支有可用 API，H 仍需修後成功及 source-bound review/receipt 回歸才算完成。與 D 的工具可見性分開核准，不能藉修訂修改模型／權限／預算。

#### R31-H sealed report-only 修訂方案（2026-09-23，owner 已核准**限定離線實作**；非 live 授權）

**已證缺口及選擇：** `contracts.mjs` 只容許 `request_report_repair` control type；`WorkerRuntime.processControls` 沒有該 handler，而 `teams-worker` 的 `team_task_result` 封存 r1 後 `ctx.shutdown()`。原 Worker 不再可恢復；pi-subagents 公開 `resume` 會產新 run，無原 Task result/role/candidate 的完整綁定，不能保證不派 writer。直接把 r1 改 bytes 或以 L0 補稱 Worker 作者均不合法。若 owner 要求**已封結果且獨審指出 report-only 問題後**仍能修報，推薦使用現有同 Task `maxProcessRestarts ≤1`／prior-usage 的新 execution，而不是復活舊 execution 或新增 controller。這**不是**目前已批准的 failed-check candidate API；只修未改產品 source/patch 的報告問題。無獨審封存失敗及可重驗候選的例子不硬造修報；尚未 sealed 的輸入/schema拒絕仍沿原 Worker loop 更正。

- **公開 API 草案：** `team_task_revise_report({previous_execution_id, spec_path, expected_previous_result_digest, review_failure_ref, review_failure_sha256, report_reason})`。原活 L0 自行擬同 Task `taskRevision+1` spec，host 不幫 Agent 寫改正答案。`review_failure_ref` 必須是前 execution 真獨審已封存的 BLOCKED 報告，且其 review request/subject、source、old result、old staged successful checks 可核，不接受 L0 自稱的 reviewer prose 或任意檔案。舊 execution 已 terminal、reservation closed、acceptance absent、target 未 apply；owner/session/epoch、Goal/task、scope/base/policy/criteria/check vector/contextRefs、source snapshot與原結果 SHA 全相同。只限 v3 shared、verify-only 與 **history 僅一筆**；同一 Task 的 candidate repair 已用掉 `maxProcessRestarts=1` 時拒絕，不能藉新模式升 ceiling、reset 額度或造第三版。
- **流程／狀態差異：** `TaskOrchestrator.prepareReportRevision` 先驗上述舊證、測完整 closed usage、以 `prepare(spec,{reportOf})` 用原 ceiling／owner reserve 新 execution，封存新 `report-revision-intent`（舊契約、r1、native writer capture、staged patch/tree、成功 checks、review failure 各 SHA）。新 Task Worker 只修報告，不改產品來源；現行離線實作更嚴格，`RoleController` **拒絕任何新 role**（不僅 mutation/check），若將來確需獨立 read-only 協助，須補相應新 run/usage/evidence reader，不能以本路徑偷偷開通。Worker 寫自己的 r1/來源快照，**不冒稱舊 native writer 是新 run**。Host 的 `stageReportRevision` 只讀重驗原完整 native writer/role terminal/usage、captured patch、來源、原 checks 的 input/log/receipt，再在新隔離 repo 套**同一已封 patch**並核 tree/scope/target 未變；綁 origin receipts 產生新的 lineage receipt，不執行原 writer 或重播原 host check。任何跨 execution proof 缺失／外部副作用未知／原 check 不可按完整 source/command binding 安全重用就 fail closed；不開通用『直接信任舊 check』路徑。
- **獨審／驗收：** 新 revision 有**全新** review admission/wave/seal，舊 BLOCKED review 留在舊 execution、不可變 PASS。新 review request 明示 origin writer+host check hashes、report-only 差異與 source/tree 相同；`integrationReviewBinding`/`HostAcceptance` 僅此模式可重核 origin native writer 證據，不跳過 writer requirement、不得接受未證明的 required evidence 或舊 failed review。最終 AcceptanceReceipt/3 必須綁新結果、新 review 與 origin provenance，Goal-X 仍只 readback 新 acceptance。新 Worker/reviewer/parent 用量加舊完整實耗，接受時再核，不能將新報告拿來偷偷改 source／checks／policy；新 Task 若無原始成功行為證據，報告修正不能冒稱產品成功。
- **故障與回歸門檻：** reserve 後 half-published 仍保留新 reservation 待原 owner reconcile，未知效果不重播；舊 sealed r1/review/失敗不覆寫。離線正例須從真 blocked review 的**報告缺陷**恢復，證實**無新 native writer run、patch/tree 未變**，新獨審與 receipt；負例含偽 BLOCKED／產品缺陷誤判、非法證據提升、identity/source/old capture/check tamper、review replay、owner/cap/usage/第二修訂、部分 journal、side effect unknown 與 target apply。改動面為 Orchestrator/Worker role admission、專用 integration/review/acceptance lineage reader、公開 tool schema 與對應 fixtures；不改 ledger schema、通用 Task 註冊或舊 receipt bytes。**這是跨封存 writer provenance 的 material API/authority 變更，沒有本方案的明確批准不得實作。**

**限定實作與證據邊界（2026-09-23）：** owner 選擇精確方案後明確批准**僅離線**實作，非真模型／新 G1 授權。`team_task_revise_report`、`report-lineage.mjs`、`readCompletedReviewWave`、`stageReportRevision` 與 Worker／review／acceptance 接線已在隔離 Git/SQLite＋合成 native-format 報告走通：舊獨審 BLOCKED（含顯式 blocker finding）→舊 execution 已關→同 Task 新 Worker 只修報告、零新 role／零 host check 重跑→相同 patch/tree 與原 writer/check SHA→獨立新 PASS 並逐 finding 解釋→AcceptanceReceipt/3 與新 acceptance 的合成 Goal matching gate／重讀。舊 BLOCKED bytes 不改，舊無 acceptance，舊實耗加新實耗；old incomplete/unknown review、半發佈 candidate、SHA/source/scope/ceiling drift 均拒。**目前只支援前次恰一個已完成 BLOCKED wave**，多 wave/鎖未明先停止；這是能力界限，不是放寬原始 reviewer gate。所有 native review/Worker 為合成證據，未有真模型自主修報或同 CLI+Herdr 結果；原正式 ledger、Goals、campaign 四筆 open reservations 未動。以上離線驗證須以最終 source 與 log readback 為準；不把此段當 R31-I/J live 驗收。

#### R31-H — 核准後實作修復能力（TODO-94da5e92）

- **修改位置／做法：** 僅依 G 核准後的既有 Task/native consumer 方案實作；精確檔案由 G 的能力查核決定，不預造無公開支援的接口。Agent 提修復，runtime 檢核 owner/source/usage/repair limits 並執行，不自動選方案或重試。舊失敗與 immutable bytes 保留，新的 candidate/證據綁自己的 source，Task/campaign 成本延續。
- **驗收：** 原已知失敗→局部修正→原成功行為恢復→新 source-bound checks/review/receipt 的完整 consumer seam；report-only 無 writer 重做，無 unknown replay／budget reset，crash/partial/owner/drift/超限拒絕正確。不能只加防呆拒絕就稱修復能力完成。
- **依賴：** G 完成、必要 owner 批准，以及 D/E/F 整合。未批准保持 open/blocked；live 修復另驗，不冒稱 fixture 是模型恢復能力。

#### R31-I — 分層驗證而非碰運氣重試（TODO-db0596e1）

- **修改位置／做法：** 既有 request-flow/e2e-control/e2e-admission/integration 測試、`E2E-INPUTS.md` 與 E2E matrix。第一層零模型公開 seam 驗 context/skills/工具/授權/預算/settled；第二層經另行授權的真模型規劃案例；第三層完整交付由 J 承接。不建新 eval 平台。
- **評估：** 非 Todo 單成果、相依成果、缺授權／能力、合法實作替代與 repair decision；事前固定案例、評規、版本、attempt 上限與 budget，不規定唯一角色數／工具序列。記需求涵蓋、完整 review 資源、scope、人工介入、重複工作、tokens/cache、耗時／空等、首次成功與恢復；保存全部失敗，不即興重試。
- **驗收：** 區分規範送達、Agent 規劃、實際交付與穩定性；一次 PASS 不代替後者。scoped LSP、相關／必要完整回歸及 lens，結果綁 final source。真模型未批准／未跑仍未完成，不能只因離線子項 PASS 關閉。
- **依賴：** A–F 對應實作；可先驗已就緒部分，repair 評估另需 G/H；不把部分結果包成整體。

#### R31-J — 新版 G1 與逐項完成核對（TODO-2ea851ba）

- **前置：** I 對應環境／規劃證據及一次新的明確 live 授權。r18 授權已消耗，不從 TODO 或「繼續」推定第二輪。核當下 source、實際 context/skill/tool 版本、campaign membership、parent 新快照、r12–r18 去重來源與尚存 unknown；不把舊 snapshot 當當下餘額。
- **執行／驗收：** L0 從原始需求建立真正 Goal/task/spec，自定成果/依賴/roles，經 public dispatch→collect→stage/check→source-bound review→seal→AcceptanceReceipt→Goal/task readback→drain；不預製答案，不手動繞 Task stage。原需求、target 狀態、run terminal、source/evidence freshness、全部去重成本可讀回；failure 不自動下一輪。
- **完成界線：** 逐一 readback A–I，附實作檔案、驗證範圍、證據與剩餘阻擋。H 尚未批准／驗證时，可由 owner 明確限定只驗正常交付路徑，但不能因此關閉 repair 或宣稱全 R31/readiness 完成。舊 campaign recovery 不順便處理；一次 G1 PASS 不代表穩定性或所有需求已驗。

### 31.4 執行順序、狀態與防遺漏

1. A 更正事實；B/C 對齊環境與規範。F 可獨立修生命週期，但由同一 writer 序列修改共享檔案。
2. B/C → D → E；G 在其依賴具備後完成可實作設計，所需批准後才 H。不因批准等待停住其他已授權工作。
3. I 逐層收證據，不用更嚴的 runtime workflow 約束來製造規劃 PASS；J 最後在新授權下執行。這是修復工作的依賴，不是產品 Agent 的固定角色／工具 DAG。
4. 每项開工前 `todo claim`，核當前 source／文件；完成時記修改位置、原失敗與恢復證據、source digest、命令／結果、未驗範圍，才更新 native TODO 與 Markdown 索引。未批准／缺證據保持 open/blocked，不能用 sibling 的 PASS 代替。
5. 最終按本節 A–J 逐項 readback；文件、程式、零模型、真模型規劃、完整 E2E 分別標示，不把「已寫設計」勾成「已修復」。十個 TODO 均已建立；A–I 已有不同程度的設計或零模型實作，本輪未啟新模型/Goal/live G1。依 native TODO 及最終 source 證據逐項 readback，不以局部實作自動關項。

### 31.5 前瞻性新 G1 的來源缺席交接（2026-09-24；不倒填舊 J）

在唯一獲准的獨立 live `306fee16-d443-4f38-b4da-b86fe3bc156f`，L0 選擇 `sourcePaths:["app"]`、`allowedWritePaths:["app"]`；乾淨空白 Git base 並無 `app/`，實作者的 managed worktree patch 已完成但未寫回 target。舊 `host-evidence.snapshot` 對 source path 直接 `realpathSync`／`lstatSync`，使 Worker 的 `team_task_result` 在建立 source manifest 前兩次 ENOENT；沒有 result/host stage/review/Receipt，L0 collect 等到 deadline 才 drain。這是設計文件未明說「預計新增的 evidence root 可不存在」與既有 reader 不能表達 absence 的共同契約缺口；agent 的選擇觸發該缺口，不能用手動 materialize patch、弱化 criteria 或臆測 reviewer PASS 掩蓋。r18 等先前失敗另有獨立成因，不把本案稱為它們的唯一原因。

本輪限於原生邊界修復：沿用單一 source snapshot reader，對明列、相對且不經 symlink／credential 的尚不存在來源記錄確定性的 `kind:"absent"`；source digest 在後續 sourceRoot、候選 stage、host/acceptance 讀回仍逐次比對，出現新目錄（即使 Git status 仍 clean）亦使舊 result 失效。若來源讀取真故障，Worker 沿既有 durable failed event 及 owner collect 及時交接，保留 reservation 直到原 owner cancel/reconcile，不把報告格式更正變成 fatal，也不重派。真 Git＋合成 native handoff 的 regression 證明缺席目錄→writer patch→ready candidate→verify-only host check 可恢復，並驗 source 漂移／symlink／credential 負例；這仍**不是**修後真 Pi CLI／Herdr／Edge G1 PASS。前瞻性新案 `TODO-dc40e174` 及舊 R31-J 在新的 live 授權／readback 前都不得標完成。

## 32. Review-origin product revision（本地實作；live 未驗證）

使用者先要求設計、後另行授權本地實作與離線驗證 L0 最終獨立 review 發現產品缺陷後的修訂流程。完整方案見 [Review-origin product revision 設計](TASK-PI-REVIEW-PRODUCT-REVISION-DESIGN.md)。本地驗證不授權 live Worker／新 E2E、修改既有 sealed artifacts／正式 ledger／Goal 或 target apply。

推薦同 Goal／同 Task、taskRevision + 1／新 execution：事前 opt-in 且在原 scope、累計額度與期限內，L0 可主動診斷並派一輪新修訂 Worker；新實作者從原 base 重建完整舊候選，輸出原 base→完整修正版 patch，重新檢查與獨審全部需求及全部舊 findings，再以新 AcceptanceReceipt 完成同 Task。舊 BLOCKED 證據保留；approved-integration 仍需新精確計畫的逐筆確認。此能力現以原 `team_task_revise` 的 `origin:"blocked-review"` 分支接線；可與既有 failed-check／report-only 路徑區分。離線 disposable Git／SQLite 與合成 native-format 證據已測到新候選的 verify-only Receipt/3 與 approved-integration Receipt/2、雙舊 wave、費用／期限及拒絕案例；尚未以真 Pi 模型／公開工具 live E2E 驗證，亦不追認任何舊 Task。
