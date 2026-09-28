# Review-origin product revision 設計

狀態：**本地 runtime 已有 review-origin 分支與 disposable Git／SQLite 測試。已授權的 r1–r7 live 嘗試均未完成合法 BLOCKED→E1 acceptance；r3 首輪 PASS 是分支未覆蓋。2026-09-26 的介面修正新增真正註冊 handler／原生零模型 Agent loop／實際事件 observer 回歸；這不是 live PASS，也沒有 r8 授權。** 本文件記錄設計與目前介面，不增加 Task、套用、預算或部署權限。

本文件回答：L0 的最終獨立 review 發現真實產品缺陷時，如何由新 Task Pi 修正、整合完整成果，並完成原 Task，而不是重開舊 Worker、另造無關 Task 或反覆重跑整個 Goal。

## 1. 核心決策

採用 **同一 Goal、同一成果 Task、taskRevision + 1、新 execution／Worker**。它是「原成果的候選修訂」，不是額外的 Goal blocking task。

```text
L0 / Goal G / Task T
  ├─ E0 / revision n
  │    writer → 完整候選 C0 → staged checks PASS
  │                          → 獨立 review BLOCKED
  │    保存證據 → cancel/drain → CLOSED，無 AcceptanceReceipt
  │
  └─ E1 / revision n+1（新 Task Pi，承接 E0 的成本與失敗來源）
       讀原需求、C0、findings → 新實作者重建 C0 → 修復 → 完整候選 C1
       → 新 stage/checks → 新獨立 review（全需求＋舊 findings）
       → verify-only receipt，或新 plan／逐筆批准／apply／target checks
       → E1 AcceptanceReceipt → 同一 Task T complete → Goal readback
```

設計完成標準：identity、啟動權、來源繼承、整合、重新驗收、用量／期限及中斷處置均有明確 consumer；不把「在 prompt 加一句請修正」稱為修復流程。

### 非目標

- 不復活 E0，不修改 E0 的 BLOCKED review、result、patch、check 或 receipt。
- 不自動新建 Goal/task ID，不把 E1 的收據掛到不同 Task。
- 不自動 apply、commit、移動 ref、部署或重新授予過期確認。
- 不處理已套用／部分套用目標、未知副作用、owner 接管後續派或無限多輪修復。
- 不新增 planner/controller、工作流服務、全域帳本或獨立修復 queue；不改模型路由。

## 2. 設計時的能力與真正缺口（歷史基準）

| 現有 module／interface | 已有能力 | 本設計需要補的部分 |
| --- | --- | --- |
| `task-revision.mjs:candidateRepairIntent` | 同 Task 新 execution，只接已完成非零的 staged host check；舊用量延續 | 加入 **review-origin product** 來源，不能把 review 報告偽裝成 failed-check receipt |
| `report-lineage.mjs:reportRevisionIntent` | verify-only、單一完整 BLOCKED wave、新 Worker 只修報告／不得派 roles | 不能拿此分支修改產品，也不能借用其「沿用舊 writer/check」驗收方式 |
| `orchestrator.mjs:prepare`／`ledger.mjs:reserve` | taskRevision、priorExecutionId、closed usage、同 Task 預留互斥 | 對新分支綁定完整 review inventory、事前授權、舊候選及有效期限 |
| `role-wave.mjs:prepareRoleWave` | writer 在 managed worktree、native handoff 以 Task base 為根產生 patch | 修復 writer 必須拿到完整 C0；不能假設另一個 worktree 自動含舊候選 |
| `review-runs.mjs:readCompletedReviewWave` | 從 durable captures 核對已完成的原生 review | 枚舉全部舊 waves，不准只選較容易處理的 finding 或忽略未知 run |
| `integration-review.mjs:integrationReviewSchema` | report-only 有 `priorResolutions` | 新增產品修訂語意：C1 可不同，舊 findings 均需新來源／新測試佐證 |
| `goal-guard.mjs:createGoalGuard` | 同 goalId/taskId 的最新 accepted execution 才可完成 Task | 沿用此規則；不需要另一個 Task-to-repairTask 對照表 |

兩項不能誤稱為既有保證：現行 Worker/controller deadline 是 `execution.createdAt + policy.deadlineMs`，不天然是跨 execution 的總期限；role worktree 也沒有本設計可直接宣稱可用的「host 預植候選」公開 hook。

## 3. 啟動權：L0 可自主，但不是見 BLOCKED 就自動重跑

### 3.1 事前封存授權

提議新 v3 spec 的 `policy` 增加一個選用欄位：

```json
{ "reviewProductRevision": "within-scope-once" }
```

- 僅在使用者原始授權涵蓋同成果有界修復時由 L0 設定；欄位不是模型自行創造權限的證據。
- 缺席代表此新路徑 **未啟用**。不向舊 sealed contracts 補欄位、不改舊 request digest；既有 candidate/report-only 修訂語意不受影響。
- 同時需要原 policy 容許一次新 execution（`maxProcessRestarts:1`）、相關產品修復額度、足夠累計 Task tokens／role spawns 與剩餘時間。此旗標不另送一份額度。
- 第一版與現有 candidate/report-only/process-restart **共用至多一次後繼 execution 的上限**；不是每種修訂各一次。已有兩筆 execution 即不可再進此路徑。
- 已封存但未授權的 Task 不可藉修改 policy 進此路徑；需要使用者對後續工作的另行決策，本版不設事後 top-up 或補授權 shortcut。

滿足以上條件時，L0 可在同一 live session 內主動診斷、選擇必要 regression、關閉舊 execution 並呼叫修訂 interface，**不必每個 in-scope bug 再問一次**。runtime 只核機械條件，不替 L0 判斷修什麼，也不在 review callback 裡自動啟 Worker。

缺乏授權、使用者明確 pause/stop/cancel、要改需求／來源／權限／模型／預算，或證據無法辨認時回到使用者。L0 的「為修訂而 drain 舊 execution」與使用者撤銷任務不能混為一談；不得靠 revision 自動解除使用者的暫停。只有既有授權的續作才可走公開 Goal 更新；不寫 Goal 檔案。

### 3.2 L0 診斷責任

L0 以原要求、review finding、精確候選與必要的有界重現，分類為：

1. **產品缺陷**：進此設計；要求因果修復與原成功行為恢復。
2. **報告不足／review 誤讀**：依既有 report-only 能力或人工釐清；不製造產品修改來換 PASS。
3. **需求／scope 改變、缺外部能力、unknown effects**：停止，請求決策或 reconciliation。

Reviewer 的 BLOCKED 是觸發診斷的證據，不是「已證明一定要改 code」的自動授權。新增分支不能替代這項判斷。

## 4. 公開 interface：擴充既有修訂入口

建議擴充 `team_task_revise`，以參數聯集區分來源，不另造第三個重複的修訂工具：

```json
{
  "origin": "blocked-review",
  "previous_execution_id": "<E0>",
  "additional_checks": [],
  "expected_previous_result_digest": "<E0 result digest>",
  "review_failure_ref": "<E0 integration/reviews/<wave>/complete.json>",
  "review_failure_sha256": "<該檔案原始 bytes SHA-256>",
  "repair_reason": "<具體產品缺陷、對應原需求及修復目的>"
}
```

`additional_checks` 使用原 Task 的 check object 格式，可為 `[]`。Host 從 E0 機械複製不可變欄位及舊 checks，只增加 taskRevision 與附加 checks；L0 不需重新生成整份契約。舊 `spec_path` 輸入仍可用，但與 `additional_checks` 互斥，immutable drift 會在預留前以綁定本次 tool/call/input 的 draft rejection 回覆；source、owner、usage 或未知 effects 仍是停止條件。

此參數聯集現已接入本地 `team_task_revise`；需重新載入擴充後才可能由 Pi host 使用。離線 fixture 通過不等於 live 工具已驗證。

- 舊參數組不帶 `origin` 時仍只表示 failed staged check；保持相容與原限制。
- `blocked-review` 必須帶 review 證據，拒絕混入 `failure_receipt_*`；`team_task_revise_report` 維持獨立的只修報告能力。
- 2026-09-26 另接入 `origin:"integration-conflict"`：使用原結果 digest 與 host 封存的 `integration/failure.json` ref/SHA，沿用 `additional_checks`／legacy `spec_path` 互斥表單。只接受 v3 shared 原契約已允許的一次修訂；L0 必須仍是原 live instance、E0 已完整關閉、來源／用量／效果可核對。此分支與其他修訂共用同一個 successor 額度，不允許 E2 或重設原期限。詳細公開契約見 SPEC 第 5 節。
- 輸入的 review ref 是精確錨點，不是允許忽略其他 waves 的 selector。Host 自行發現並驗證 E0 全 review inventory、sealed request／完整 patch、所有 finding 與 captures。
- 來源驗證與 lineage 沿既有修訂 seam 接入；本地實作將產品專屬驗證放在 `review-product-lineage.mjs`，保留 `task-revision.mjs` 的原 failed-check 語意。Orchestrator 負責 preflight／預留／launch；沒有另建 controller。
- 成功回覆沿用 execution／Worker binding，另回 `origin`、prior execution/result、完整舊 finding 索引、候選 artifact refs、累計用量與 effective deadline，讓 L0 不必手算或猜路徑。

### L0 診斷與 merge 的責任界線

已完成、可核對的隔離衝突及非零 check 是 L0 的診斷輸入，不應在 active Goal 的 `agent_settled` 被歷史 failure latch 立即結束。Runtime 只證明 Git 已終止、所有 lane 輸入個別合法、未更動 target，保留部分 index 與全部 captures；它不判斷語意衝突解法。L0 決定修復及派工，Writer 在新的 managed checkout 重建並修正，Reviewer 重新檢查全部貢獻與行為。舊 execution／證據仍不可改寫或接受。

衝突沒有完整 C0 tree，不能冒用 review-origin 的 C0→C1 lineage。新 `teams-candidate-repair-intent/3` 綁定完整 lane inventory、衝突 index、原結果／來源／用量與 deadline；短 reconstruction command 引用 sealed inventory，避免大量 patch refs 撐爆 16 KiB role task。新的單一 Writer 仍交付完整 B→C1，並涵蓋失敗後尚未套入的 lanes。最終 review subject 和 AcceptanceReceipt 保留 conflict lineage。

公開 result hook 必須把 typed check/conflict reply 明確投影成 Pi 的 `isError`，不可只依賴 execute 回傳物件上的欄位。Observer 保留這些 failures；只有真實 public accept 回覆、sealed receipt、ledger 與同 Task／owner successor 綁定能解除失敗，單純宣稱 Goal complete 不行。未知 effects、owner/source drift、未知 process／usage 仍停止與對帳，不以 catch-all 放行。舊已接受工作不追溯更改期限語意；歷史 E0 的只讀 deadline 計算也不能假設它永遠是最新 execution。

這些是本地實作／離線 seam 驗證，不代表已完成新 live E2E；r7 不重派，沒有 r8 授權。

### Host 繼承的新契約／相容 spec 的可變與不可變

- 不變：goalId、taskId、schema、objective、nonGoals、workspace/base/scope、criteria、policy、contextRefs、交付模式。
- 必變：taskRevision 恰加一；execution ID 由 host 產生。
- 舊 `checks` 必須完整保留且不改弱。優先在既有允許範圍新增可由原 trusted runner 執行的 regression。
- 必要時可**附加**涵蓋原 criterion 的 regression check，但 executable／作用範圍須在已授權的可信檢查能力內。不新增 credential/network/production 權限；缺此能力時 needs-user，不能用舊未涵蓋 bug 的 check PASS 取代。
- 新 finding/修復指派放 host-owned revision intent，不塞進 objective 或增加臨時 source contextRefs，避免為傳遞失敗原因改掉原成果契約。
- Worker 程序 prompt 引用完整 sealed contract，不再重複塞入 objective／criteria／contextRefs。Worker 先讀契約，將所需的精確介面與要求交給 leaf；revision intent 負責 repair 階段的來源／步驟。仍維持 6 KiB 上限，opted-in E0 預留前同時驗 E1 prompt 的可行性，不准等 E1 才要求縮短不可變欄位。

## 5. Admission、來源封存與生命週期

只接受原 live L0 instance／session／owner epoch，v3 shared Task，`verify-only` 或 **尚未開始 target 操作**的 `approved-integration`。

### 必須同時成立

1. E0 有完整 ready candidate、成功 writer/native handoff、成功 staged checks、可重驗的整合 tree／workspace／patch；這些只證明舊候選與舊測試，不證產品沒有 review 所述缺陷。
2. 全部已登記 review waves 均完成且 captures／native 身分／用量可核；至少一 wave 是 BLOCKED 並含明確 blocker finding。任何未啟動但已登記 wave、running/unknown、缺完成證明、`needs-user` 或鎖未明均不進自動修復。
3. 沒有 stage failure、成功 review seal、review-candidate 半寫 intent、target-apply 目錄／journal、AcceptanceReceipt 或已完成 Task。第一版連不完整 target plan 都拒絕，避免混入 r3 類部分套用恢復。
4. 原 target 仍是原 base／clean index／完整 workspace baseline；也核 hidden、ignored、目錄與 mode，不只 sourcePaths 或 Git status。
5. L0 已讀完舊證據、保存診斷，透過既有 cancel/drain 使 E0 為 CANCELLED/FAILED、reservation closed、Worker/pane/roles/reviews 已終止，closed usage 可測。任一不明則 reconciliation，不派 E1。
6. 舊結果及全部原件在新 admission 前仍匹配；沒有已開始的後繼 execution；policy／上限／期限／原用量都足夠。

取消只關閉 execution，不刪除其 frozen candidate／review captures。Task T 持續 pending／completion-blocked，**不能先標完成再補修**。

### 持久化順序

沿用 `prepare → reserve → Mailbox/bootstrap → launch`：

1. Host 唯讀重核 E0 的原生證據，建立包含全 inventory 的 revision origin。
2. 計量 E0 全部實耗，檢查能力、prompt、source 和授權；預留前完成可判定的 input 檢查。
3. 在現有 ledger transaction/CAS 內核 expected predecessor、最新 taskRevision、無 active reservation、後繼次數後預留 E1；不能只依 transaction 外的 earlier read。
4. 只在 E1 寫 versioned `repair-intent`、原 usage、workspace baseline 與 bootstrap；E0 不新增補造 receipt。
5. 啟動新 Worker。Worker boot、role admission、stage、review、accept 均重核此 lineage；不要只在首次 dispatch 驗一次。

新增 review-origin intent 建議使用 `teams-candidate-repair-intent/2`，原 `/1` reader 保留。綁定 E0/E1 identity／request/result、原 base、C0 tree/完整 workspace、原 raw patch SHA、review request、**全 waves 的 plan/completion/capture digests**、finding indexes、closed usage、原授權與 effective deadline。直接引用 durable captures，不依賴已清除的 native 暫存目錄。

## 6. 最關鍵的整合策略：完整候選取代，不是再疊一份舊 patch

定義：`B` 為原 Task Git base，`C0` 為被 review 的完整候選，`C1` 為修正後完整候選。

```text
P0 = diff(B, C0)      舊完整 patch，只作有身分綁定的修復輸入
D  = diff(C0, C1)     修正差異，用於診斷／review，不能單獨交付
P1 = diff(B, C1)      新完整 patch，是唯一可 stage／交付／apply 的候選

正確：B + P1 = C1
錯誤：只把 D 套到 B；或先套 P0 又把完整 P1 套一次
```

### 6.1 新 writer 如何取得 C0

- Host 從 E0 的 `integration/review.patch`、review request 與 rehearsal 核實 `P0`，提供不可變的 ref/SHA；不搬走或寫入 E0 repo。
- 新 writer 仍由原生 managed worktree 配置，base 為 `B`。**不把 target 改成 C0，不改 spec.baseCommit，不建 synthetic commit，也不假設 worktree 會繼承隔離修改。**
- 修復指派透過既有 native writer 的 shell／Git 能力，在其已核根目錄的 managed worktree 重建完整 `P0`，開始修改前核 Git tree 等於 `C0`、patch SHA 與允許路徑相符；不得先套完再切 cwd。
- 重建與 tree readback 的命令／結果必須出自新的 writer run 的原生工具紀錄，綁定 run/session、managed cwd、B、P0 SHA 與 observed C0 tree；不是 Worker 手填的 JSON。實作須接入現有 durable native captures 與 handoff reader，缺這項重建證據就不接受此修訂候選。這是 host/native evidence reader 的待實作部分，不能僅增加 prompt 就宣稱強制完成。
- Role 啟動前 host 核 frozen artifact，stage 時再驗完整原生 handoff 的 base、patch、scope；不以 Worker 宣稱「已讀舊 patch」取代來源證據。
- 這一步是**已知、可重建候選的資料繼承**，不是重播舊 writer、check、review 或 target apply。候選內的程式是待審資料；不執行舊目錄內任意 install/hook/cleanup。
- 不為此假造 pi-subagents 公開未提供的 `seedPatch`/before-worktree hook。第一版沿用 managed writer 與既有 Git operations；如果實際 leaf 工具權限／artifact 可見性無法做到，回能力 blocker，不改成 L0 手動拷貝到 target。

### 6.2 一份產品候選、一條修復 mutation lane

第一版限定新 execution **至多一條產品 mutation lane**負責完整 C1；Worker 可按需要派 read-only 診斷，角色不是固定 implementer/reviewer 套餐。這是此修訂分支的候選整合限制，不限制一般 Task 的多 writer 能力。

理由：現行 native lanes 都以 B 作 patch base。若多個 repair writers 各帶完整 P0，再讓 stage 合併它們，會重複引入 P0、造成同檔衝突或回退修正；第一版不加另一套 patch DAG／merge orchestrator。check 若會生成產品檔，必須在同一 mutation lane 的授權範圍內處理，不能偷加第二個 writer。

native handoff 應保存 `P1 = B→C1`，即使原 managed worktree 已被清理仍能重建。Host 不把 P0 與 P1 當成兩條 sibling 成果一起合併；沒有新 writer evidence 的候選不可借舊 writer PASS 驗收。

沿用現有來源語意：Worker result 的 `source` manifest 綁定**未修改的原 target**，不是把它改填成 C0 或 C1；真正的新產品由 P1 的 native handoff、stage 的 C1 tree／workspace/check 證據證明。revision intent 必須同時綁原 target baseline 與舊 staged C0，不能因 E0/E1 的 target sourceDigest 相同就誤認產品未改。

### 6.3 衝突與語意保全

- Stage 在新隔離 repo 從 B 僅套 P1，核完整 tree、raw binary patch、刪除／新增／rename／executable mode 與 scope，再執行測試。
- Git 可套用只代表結構相容。C1 仍須滿足全部原需求；新增功能／文件被誤刪、修 A 破 B 等由整體 tests 與新獨審判斷，不用「C1 檔數不少於 C0」這類脆弱規則。
- 新 review 同時可見 B→C1 的完整變更及 C0→C1 修復差異；後者是 host 從已核 trees 計算的 read-only 視圖，不是第二份交付 patch。
- sibling Task、使用者或外部程式若改變原 target/base/index/ignored state，停止；不 auto-rebase／force apply，也不重用舊 per-plan approval。

## 7. 新的檢查、獨立 review 與 acceptance

1. Worker 交新 result、完整新 native writer handoff 和 finding 修復對照；ready 不代表 accepted。
2. Host stage C1，**重新執行全部原 Task required checks**與新增 regression。舊成功 check 只留 provenance，不能證 C1。
3. 新 regression 須能區分舊缺陷與正確行為：如需 RED 證據，在新隔離測試環境重建 C0 執行，不能改舊 staged repo／舊收據；C1 必須 GREEN，並驗原成功路徑沒有回歸。無法安全重現時明列缺證，不能用 review prose 假冒 behavioral proof。
4. L0 在 Worker 與角色終態後啟動**全新、唯讀、fresh context**的 source-bound review；與新 writer 的 run/session 不同。可同 reviewer 角色／模型，不重用舊 report 作 PASS。
5. 新 review subject 綁 E1 lineage、C1、所有新 check receipts、原需求及 E0 **全部 findings**。Finding ID 由 host 固定為 `waveKey/reportKey:index` 並綁 completion digest，避免多 wave 名稱碰撞或模型改寫。
6. 每一舊 finding 均有 resolution：修正位置、因果解釋、新 regression／check 證據。可 reuse 既有 `priorResolutions` 思路，但明分 `revisionKind:product` 和 `report-only`，不能沿用「source unchanged」的 reviewer 指令。Runtime 驗 coverage／refs／digests，Reviewer 判斷修復是否有效。
7. 原 blocker 仍未解決、改寫報告掩蓋產品問題、缺 required evidence 或引入新 blocker，都不得 seal PASS。非 blocking finding 可附保留理由，但必須列出，不能被 selector 刪掉。
8. 第二次 BLOCKED／新 stage 失敗即按現行安全規則停下；第一版已消耗一次後繼 execution，不能在不同修訂 origin 間輪流重試。

`verify-only`：新 stage＋新 review PASS 後生成 E1 的 AcceptanceReceipt/3，交付 P1，原 target 不改。

`approved-integration`：新 stage＋新 review PASS/seal 後生成 **C1 的新精確 plan**，另由使用者逐筆確認，才 apply；再做 applied-review readback、target final checks、AcceptanceReceipt/2。事前修復授權不包含 apply 批准。

AcceptanceReceipt 的 finalEvidence 應新增版本化 revision lineage digest，綁 E0 失敗來源、E1 新 writer/check/review 與新 source。不把 report-only 的 origin-writer substitution 搬到此路徑。沿既有 Goal guard 核最新 E1 accepted 收據，完成原 Task T；E0 仍 CANCELLED/FAILED、舊 BLOCKED 不變。

## 8. 計量、期限與資源

- Task pool 起點為 E0 完整 closed actual（Worker＋所有 leaf＋所有 review＋cache）；新 Worker/roles/check coordination/review 實耗再累加。L0／campaign 仍由既有跨 Task 計量負責，不能稱新的全域 hard cap。
- `maxTaskTokens`、maxRoleSpawns、product/report repair allowance 等不重置；舊角色及 final reviewer 消耗也算。授權時要留得下 **新 writer 與新 final review**，不能等失敗才擴大 sealed policy。
- 首版全 lineage 至多兩個 executions，維持現有完整歷史可核範圍。未來要多輪必先改成全歷史去重 accounting，不能直接調大 maxProcessRestarts。
- 新 intent 必須封存絕對 `deadlineAt = E0.createdAt + 原 policy.deadlineMs`，有已授權更早 outer deadline 時取較早者；新 execution 不重開完整時間窗。
- 目前 deadline readers 以各 execution.createdAt 計時，**實作須補接** E1 Worker/controller/review/check/apply 等操作的 effective deadline，子操作 timeout 取原值與剩餘時間較小者。只是 spec.deadlineMs 不變不能證明未延長期限。
- 沒時間／用量完成 required final checks 與 review，不可只交修好的 code 然後跳過驗收。正常人工作業的等待也計入原期限，除非另有明確批准的設計。

## 9. 失敗與重送規則

| 情況 | 處置 |
| --- | --- |
| 明確未預留的 schema／draft 錯誤 | L0 在原 loop 更正，仍不改變封存 policy |
| E0 review／native／usage 不完整或 unknown | 先 reconcile；不把缺失填零、不派 E1 |
| E1 reserve 後 mailbox/bootstrap 半寫或 RPC 結果不明 | 保留新 reservation／intent；核精確 execution，不盲重送修訂 |
| E1 重建 C0 不符、raw patch/hash/base/scope 漂移 | 停止並保存新 evidence；不改舊 artifact、不在 target 補 patch |
| Worker/provider crash、使用者取消／暫停、owner instance 結束 | 依既有 lifecycle drain；不自動換 owner、resume 或開第三版 |
| E1 又 BLOCKED 或 required check fail | 保留 E0/E1 兩份結果並回 L0／使用者，不無限迴圈 |
| 已有 target plan/partial apply/AcceptanceReceipt | 本 interface 拒絕；屬另案 recovery／變更，不借 repair 繞過 |

同一修訂 request 返回不明時不能以新 taskId／Goal／workspace 消除失敗或重置次數。查詢已知狀態不等於重啟操作。

## 10. 原定最小修改面（設計時規劃；本地實作已接線，live 未驗證）

| 責任 | 預計位置 |
| --- | --- |
| opt-in policy、參數聯集、精確結果欄位 | `contracts.mjs`、`task-tool-inputs.mjs`、`extensions/teams-orchestrator/index.mjs` |
| 全 review-origin reader、candidate lineage、預留前診斷 | `review-product-lineage.mjs` 經既有 Orchestrator revision seam 接入；`task-revision.mjs` 與 `report-lineage.mjs` 保持各模式限制 |
| latest-predecessor/CAS、usage／deadline 接線 | `orchestrator.mjs`、`ledger.mjs` 的既有 reserve、`worker-runtime.mjs`、相關 admission consumers |
| 只讀舊候選 refs、單 repair mutation lane、完整 native patch | `role-controller.mjs`、`role-wave.mjs`、既有 handoff／integration readers |
| 新 checks、產品 prior findings、fresh review、final receipt | `integration.mjs`、`integration-review.mjs`、`review-runs.mjs`、`integration-authority.mjs`、`acceptance.mjs` |
| L0 處理 BLOCKED 的操作準則及 observer 不誤殺合法修訂 | Orchestrator `SPEC.md`、E2E 已有 observation/classification 與 tests；不新增自動重試服務 |

不先擴所有舊修訂的支援矩陣。舊 failed-check 與 report-only 行為要保留回歸；本版新能力的權限／Interface 變更需要實作前確認。必要的共有 reader 應集中證據驗證，不抽空函式做形式上的層次。

## 11. 驗收案例與完成定義

### 離線：透過真實 public consumer seam

- 以 disposable Git／SQLite、完整 native-format 證據跑 **舊 staged checks PASS → 產品 review BLOCKED → E0 drain → 新 E1 writer 修正 → C1 stage/regression PASS → fresh review PASS → 新 Receipt → 同 Task Goal guard/readback**。
- 原 P0 有至少兩項功能，repair 只改其中一項；C1 必保有另一項。另用「只交 D」及「P0＋P1 重複套用」負例確認不能冒交完整成果：前者若 Git 仍可套用，必須由原需求測試／獨審攔下，不能聲稱 Git tree 形式檢查會理解功能遺漏。
- 新增／刪除／rename／binary／executable bit／nested directories，以及 `umask 077` 的 stage→plan→apply→readback；不靠移除 mode/digest 比對過關。
- 多 review waves 均被枚舉；修一項卻漏另一 blocker 必須拒絕。未完成／unknown／needs-user wave 不得省略。
- 原 required checks 未重跑、缺新 writer、舊 PASS review／receipt 重用、report-only 偷改產品、criteria/check 削弱、舊 P0 被改、target hidden drift、異 owner／epoch、超額／超時、第二後繼、race/partial-intent 均拒絕。
- 計量 old+new 恰一次；所有 old roles/review 次數保留；Task deadline 不因 E1 新 createdAt 延長；使用者 stop/pause 不被自動續作覆蓋。
- approved-integration 正例還需新精確確認、apply journal、applied-target checks／Receipt/2；沒有新確認不准寫 target。

### Live：必須另行授權

在全新 disposable Task 事前開啟這項修訂，設定一個能由實際 reviewer 辨認的產品缺陷情境；不得偽造 review BLOCKED、手填 PASS，亦不得令原 required check 故意回報虛假成功。保留首次真實結果：若 reviewer 沒發現，記未覆蓋，不重試洗白。

驗收要同時證明：L0 理解 finding 並自主選正確分支、新 Worker 取得完整舊候選、真 native writer 完成修復、原失敗及成功情境可區分、新獨立 review、同 Task 的新 AcceptanceReceipt／Goal completion、全部用量與 cleanup。verify-only 與 approved-integration 的實際覆蓋分列，未跑的模式不宣稱 live PASS。

### 本次設計交付結論

推薦以上一輪、opt-in、同 Task 新 execution 的方案。它修補的是 **review 發現產品缺陷後的候選繼承與重新驗收**，不是改 retry 次數或讓 L0 直接寫 target。實作／驗證現況以首段與原始收據為準；此文件不批准修改舊 executions，也不代表先前 G1/G2 正常交付已測到這條修復路徑。
