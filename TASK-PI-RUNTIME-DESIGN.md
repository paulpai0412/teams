# Outcome-first Task Pi Agent Teams Runtime

版本：1.19（2026-09-14，Task 共用 token pool／角色軟預留；通用 request-driven live 驗收仍未完成）  
狀態：實作中；未通過 live canary 前不得宣稱 unattended-ready

第 15–26 節保留當時階段快照；scope 排除仍依第 26 節，通用 flow 見第 27 節，共用預算及本輪驗證界線見第 28 節。G1 等預製 spec/patch 測試不是需求規劃能力的驗收。

**2026-09-14 agent 執行／repair／再審政策修訂（不改 runtime 狀態機）**：新 C3 採 [C3-POLICY.md](task-runtime/e2e/C3-POLICY.md) 與既有入口可讀取的 [c3-prompt.txt](task-runtime/e2e/c3-prompt.txt)。主 agent／Worker 可提出有界 repair／再審請求；依原始證據區分產品、驗證工具、報告與非致命診斷。只修需要修的部分，修後由 auditor 再審；請求不等於 resume／重派／驗收權。Worker 不控制 Goal，terminal execution 不重開，舊失敗與收據不覆寫。新準備的契約須與政策一致，舊 sealed 零修復契約不變。`request_report_repair` 目前僅有 schema 宣告，不代表下述 mailbox report-repair 設計已實作；本次不新增 API 或 controller。

## 1. 決策摘要

本設計不把多 Agent 當成預設。執行模式只有：

```text
executionMode = direct | task-pi
default = direct
```

主 Agent 能在單一上下文內可靠完成的工作直接做。只有當 Task 的診斷輸出、執行時間、恢復需求或工作區隔離收益明顯高於新 session cold start 與重讀成本時，才選 `task-pi`。選擇 Task Pi 前，主 Agent必須記錄一段具體收益理由；說不出理由就使用 direct。

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
