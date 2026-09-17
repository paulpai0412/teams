# Agent Teams Request-to-Outcome E2E Matrix v2.2

日期：2026-09-14。沿用檔名以保留既有連結。
狀態：通用需求入口／Worker context交接已修source，request-driven模型行為尚未live驗證。首次G1仍不接受為完整PASS，保留有效子證據；G2/G3未執行。撤回App＋guide預製答案路線。

## 1. 決策：case 是驗證項目，不是一個 case 就重跑一次

首要目標是 **使用者需求 → L0 理解／產生 Task specs → 實際執行／必要整合 → 對照原始需求交付**；Goal僅在明確授權時使用。不能用人工預製spec/patch的成功代替前半段。

### 通用flow的必驗主線

1. 輸入只有真實使用者要求、source基線、必要環境與已核准限制／預算，不提供Task specs、答案patch、固定Task數或角色鏈。沿 [L0 SPEC](extensions/teams-orchestrator/SPEC.md) 的一般入口，不套用run-todo-flow的sealed-spec提示。
2. 留下L0自己生成的成果拆分／criteria／checks／scope／contextRefs和依賴理由；核對原始需求完整涵蓋。能direct的工作不為湊Worker拆分；有依賴就串行，真正獨立且有收益才平行。
3. 檢查輸入語意傳入真Worker／leaf，候選不靠測試答案代寫；核原檢查與必要新regression、獨立review、正確delivery mode、acceptance/readback與cleanup。
4. 若需要多產物共同工作，驗最終組合的實際入口；分別accepted不等於整體可用。保存原始要求→最終觀察的對照及全部實耗／人工介入，不能靠新增較容易的文件Task代替欠缺的功能。
5. 新功能與既有系統修復／相依整合有不同規劃風險；選與實際需求相符的代表性任務，不把單一成功案例宣稱覆蓋所有領域。缺失的required證據仍阻擋通用flow驗收。

以下G1/G2/G3僅是相容protocol檢查的合併方式，不再是主線或固定三輪／五Workers的完成目標。主線若自然產生相同有效證據就重用，缺哪個控制情境才考慮經授權補測；不為湊group去改需求。失敗不自動重跑。

| 執行 group | 合併的舊項目 | 新鮮 live 配置 | 預期結果 |
| --- | --- | --- | --- |
| G1 平行成果閉環 | C5、C5-W2 正例、C6；D5/D6/D7 的成功路徑 | 1 Goal、2 blocking Tasks、2 個平行 L1 Workers | 各 Receipt/3、一次雙 Task batch completion/readback、Goal complete、全部清理 |
| G2 核准套用閉環 | C4；D3/D4 與 apply 後 D5/D7 | 1 Goal、1 blocking Task、1 Worker | disposable target apply、Receipt/2、Task/Goal complete、全部清理 |
| G3 平行取消閉環 | C5-W2 負例、C7 的正常取消路徑 | 1 Goal、2 blocking Tasks、2 個平行 L1 Workers，僅做最小受控工作 | cancel A 不影響 B，再 cancel B；Goal 不完成、兩邊終態與清理可核對 |

每輪順帶採集實際版本／effective settings／capabilities／usage／native terminal，不再為相同版本另跑一個完整能力 canary。這些只是 C9 的可重用子項，不等於官方升級通過。

## 2. 既有證據：保留、不重跑、不擴大宣稱

- C0 browser host、C1 unchanged-superset reuse：保留既有結論；不是 matched A/B。
- C2 與 C3 r17：已有單 Task verify-only outcome、host browser、獨審、Receipt/3、Goal/Task readback 與 cleanup。r17 auditor 是 `audit_skipped: disabled`，不宣稱 auditor pass。
- 平行 control seam：公開 tool callbacks＋兩個真 Node WorkerRuntime processes 的回歸，證實同時 RUNNING、不同身份、cancel A 不影響 B、completion guard 與清理。相關 83/83 PASS，見 [證據](goal-team-evidence/task-runtime-parallel-workers-20260914/README.md)。不是兩個真 Pi／模型 Workers 的 outcome。
- 已有 schema／runtime-error／budget／deadline／unknown／重複 dispatch／stale source 等 deterministic 回歸。未變 source 且證據有效，就引用原 command/log/hash；只因換成新 matrix 不重跑全套。
- 多 Worker 是既有能力：L0 依序 dispatch A、B，握手即返回；先不 collect A，讓兩個獨立 Worker sessions 重疊。不要誤把同一 pi-subagents session 的 workflow 限制當成 L0 單 Worker 上限。

## 3. G1：一次驗平行 Workers、多 Task Goal、batch 與安全更正

### 準備與流程

1. 若主線需求自然有兩個獨立成果，重用其同一fresh sourceRoot／Goal／兩Tasks的證據；Task specs由L0依需求產生。專門測protocol時可使用明標fixture，但不計需求規劃能力。取消固定App＋guide及產生器；保留既有 [protocol預算入口](task-runtime/e2e/E2E-INPUTS.md) 的計量用途，不把它當一般需求入口。
2. 將 C6 併在第一個 dispatch 前：只安排**一次已知無副作用的 public schema rejection**。例如缺少必填 dispatch 參數，保存原始 tool call/result 並核 execution／reservation／Worker 的新增量為零；現有 agent loop 用先前已驗的完整 spec/identity 修正後正常 dispatch。Validator 不負責產生新 identity，observer 不代送 replacement call。
3. Dispatch A 到 RUNNING 後立即 dispatch B，再 collect。原始時間戳、Worker PID/startTicks/session、native records 須證明兩個真正 L1 Pi Workers 的執行區間重疊；不是一個 Worker 裡兩個 leaf。
4. 兩 Task 採 verify-only，sourceRoot 保持原狀；mutation leaf 各用獨立 managed worktree。每 Task 的候選、mailbox、run refs、patch、checks、review、usage 各自綁定，不能交叉當成另一 Task 的證據。
5. L0 逐個 collect、stage、host check、所需 source-bound independent review、accept。L0 的 reviews／共享資源 checks 串行；沒有新增 native 併發上限。兩個 Workers 各自遵守本身 session 的 admission。
6. 兩份 Receipt/3 都持久化且新鮮後，使用真正 `update_goal_task(updates:[A complete,B complete])`。核對每項 authoritative evidence 注入與 native readback，不能拿兩次單項更新冒充 batch API 覆蓋。
7. 最後請求 Goal completion，核讀回、兩邊 reservation、Worker/native process、pane/worktree cleanup。Worker／leaf 可使用既有原生有界 retry，不能 Task redispatch 或重播未知副作用。

### 成功判定

- C6：原始拒絕＋zero-effect delta＋既有 loop 修正成功，全輪只有兩個 intended executions；不另跑一次完整 recovery E2E。
- C5-W2：兩個不同 Workers 確實並行，各自完成自己的成果；no duplicate writer／identity 混用。
- C5：兩份 accepted receipt、一次雙項 batch call、兩項 matching readback，再 Goal complete。
- D5/D6/D7：計量完整、原 sourceRoot 未改、各自 terminal/cleanup；不得以 A 成功代替 B。

為省 token，不在成功輪故意觸發 duplicate dispatch、未驗收 complete、stale source 或 schema-valid runtime error。這些已有離線負例；其中 schema-valid failure 會按既定 observer stop/drain，不能為測它而破壞整輪後又重跑。

## 4. G2：保留一次獨立 target apply，不重做能力 canary

1. 使用 fresh disposable sourceRoot（也是本次 target）、一個 Goal／blocking Task／Worker，沿既有核准 patch 與 candidate-only contract，`integrationMode=approved-integration`。
2. stage → designated host check → source-bound independent review → seal。只派確有必要的角色；不新增 planner/verifier/researcher 固定鏈。
3. 既有 public target prepare/inspect 產出 sealed plan，取得對**精確 disposable target、plan、action**的互動確認後才 apply。沿現行公開入口，不模擬確認、不因 canary 自動准許所有 UI requests。
4. 核對 apply journal／target before-after／review binding；執行原契約要求的 target final checks，再發 Receipt/2、完成 Task／Goal readback 與 cleanup。
5. 保留可在核准 disposable checkout 實際使用的產物、啟動方法與逐 criterion 證據；不是只有模型文字完成或一個 JSON receipt。無 commit/ref movement/push/deploy，無原始使用者 repo 寫入。

**不能省略的重驗**：staged source 與 applied target 是不同驗收位置。C4 要求的 after-apply final checks 不能因 patch hash 相同就用 staged checks 代替；有效的 sealed review 則由既有 applied-review reader 重新綁定，不無故派第二個 reviewer。

**為何不硬併 G1？** `prepareIntegrationApply` 要求 target HEAD/index/完整 workspace 對應 clean Git baseline；其他 Task 的 source/receipt freshness 也不能因 sibling apply 被跳過。混用同一 sourceRoot 的 verify-only 與 apply 再 batch complete，可能使另一份驗收失效；另造跨 sourceRoot Goal/controller mapping 更不是省測試。本設計不為省一輪改 runtime 或 evidence 契約。

G2 同時保存當次 fresh-load/capability/versions/settings 與 native handoff/readback 作 C9 子證據；不用再起一個同版本 Todo canary。

## 5. G3：兩個 Workers，一輪完成取消隔離與清理負例

1. 一個 fresh Goal、兩個 blocking Tasks；L0 派兩個真正 Worker，指定小型可信、可取消且不碰外部資料的工作。只執行足以驗證 admission/active-child drain 的必要 native work，不要求它們再產一個完整 Todo。
2. 在至少一個 Worker 的 native work 尚活躍時，由原 owner 取消 A。保留 cancellation intent、native stop/terminal、Worker process、pane close 與 reservation 證據。
3. 同時核 B 仍有自己的 RUNNING/active proof；A 的取消不可改 B 的身份、mailbox 或 reservation。本輪只驗取消隔離，不再讓B走browser/review/acceptance；成功outcome只引用確有有效收據的主線或G1，不假設尚未執行的G1已覆蓋。
4. 證實隔離後由 owner 取消 B，核兩邊 terminal、unresolved=0、reservation closed 與 pane/worktree cleanup。Goal/task 不 complete，依既有 owner-safe 流程 pause Goal。
5. 兩邊均無 AcceptanceReceipt；任何 required proof 未知則保留 reservation/checkpoint，不能以 timeout 或 pane 消失推斷成功。

取消不代表 Goal 已達成。G3 的 PASS 只表示**預期取消與安全收尾通過**，不能寫成 Goal-to-outcome 正例。

不為每種 crash／lost notification／close unknown／provider failure 再開模型輪。現有 fault fixtures 保留各自驗證範圍；若 live 偶發這些故障，先保存原始證據、照既有政策 reconcile，判斷是否真正覆蓋對應負例。沒有發生的情境不得追認已測；缺少的 required live proof 仍明列缺口。

## 6. 舊 case → 新覆蓋位置

| 原項目 | 新位置／是否新增完整模型輪 | 不冒充的範圍 |
| --- | --- | --- |
| C4 applied delivery | G2；保留一輪 | 非 verified patch receipt 改名 |
| C5 sequential batch | 併 G1；取消獨立串行雙 Task 輪 | G1 真双項 batch/readback 必須執行；既有 single 路徑引用 C3 |
| C5-W2 成功 | G1 | 必須是兩個 L1 Workers 的實際 overlap |
| C5-W2 取消隔離 | G3 | B 仍活躍不等於 B outcome accepted |
| C6 input correction | G1 dispatch 前一次 | runtime/unknown errors 不適用 |
| C7 cancel/drain | G3 | crash/unknown/provider 故障的 offline/live 證據分開 |
| C8 matched A/B | 條件式，只新增 direct arm，不預設重跑 Task Pi arm | 不能把 C0/C1 reuse 或兩 Worker G1 當 matched Task Pi arm |
| C9 upgrade/readiness | 共用 G1/G2 的相同 source/environment 證據；真正升級時才跑失效範圍 | fresh load 不等於 package pristine/升級；沒有宣稱 V5 完成 |

### C8 節省方式

先跑通 core，再比較，不為得到 Task Pi 較好的結論反覆測。若預計使用 G2 作 Task Pi arm，**G2 啟動前**先固定比較 spec、base、model routing、budget/deadline、checks、交付模式、計時起終点與人工確認耗時記法；G2 本身不能多加 repair／故障注入。

Direct arm 之後使用相同未變的 artifact/input/環境與同等成果驗收；不要求 direct 產生 Task Pi 專屬 receipt。G2 的準備、Worker、leaf、review、parent/L0/cache、人工介入全部算進 Task Pi 成本。模型／source／環境有實質漂移或 G2 不是有效匹配，就不作比較，另標待測，不默默補跑或用歷史 run 湊對。

### C9 節省方式

目前組合先記實際載入、effective auditor 設定、公開能力與已執行的 native/Goal 證據，不為測試而升級。真升級仍須另行授權，執行 backup／pristine（或明列已核准例外）／peer-engine／離線／fresh load，再按受影響能力選 G1/G2/G3；不能把升級前 live hashes 當新版本證據。

Auditor 維持已配置狀態，disabled 記為 skip，不是 pass，也不為了表格全綠擅自啟用。完整 V5／unattended readiness 未驗部分照實保留。

## 7. 執行前一次確認與 accounting

僅對下一輪核尚缺前置，不每個 case 重做環境巡檢：

- 現行 public tool/schema/模型與可信 checks 可用，上一輪無未處理的 owner/process 狀態；必要 readiness 缺證據仍只可走明確授權的 canary，不改 admission gate。
- G1/G3 的 observer inventory/drain 涵蓋兩個 execution；**CLI 現已要求 `TEAMS_E2E_INPUT_FILE`，從完整 `specPaths` 加總每 Task ceiling**，不再讀單 policy 當 aggregate。固定 campaign 原 parent anchor／ceiling，歷史 session 以 hash＋identity 核實計量；啟動前／執行中都計 history＋parent＋L0＋全部 Task 預留。歷史 inventory 完整性仍須核對，不得把 empty history／缺失 session 當零，也不放大 leaf allocation。
- 一條 cumulative ledger：parent準備/稽核＋L0＋全部 Worker/leaf/review＋成功/失敗/修正/cache；兩 Task 預留相加，實耗與預留不重複計算，換 group 不重置歷史。
- Task ceiling、spawn cap、deadline、repair allowance依既有授權；新 shared 契約的 role `maxTokens` 是預留估算，舊 sealed/member-hard 才是角色硬額度，詳設計 §28。共用池不增加 Task/campaign 總額；計畫依原始需求而非固定 Worker 數，不更換模型。
- G2 的精確 target/plan 互動確認須能透過公開入口交給 owner。现有 observer 對未核准 UI request 會拒絕；此能力未確認前不派 Worker，不用跑到 apply 才發現入口不支援。
- 所有測試資料、port/profile/cache 與 worktrees 隔離；同一 checkout 不同時 writer/check/reviewer。只讓真正獨立的 Workers 並行，G1/G2/G3 不同時啟動。

前置不符先回報具體缺口，不自動修 dependency、換執行模式或啟動一串探針。

## 8. 證據重用與判定

沿既有 evidence directory／報告格式，不增加新 registry、report schema 或總控框架。**一個 group 一份摘要，原 case ID 只是摘要中的 coverage 欄位**；各 Task 原生收據仍獨立。相同檔案用路徑＋hash 引用，不複製多套 transcript，也不讓每個 reviewer 重讀所有歷史。

最小記錄：launch intent/authority、fresh Goal/Task/execution identity、source/patch state、必要 host/review/receipt、native readback/cleanup、分項與累計 usage、commands/logs 與 SHA manifest。

- 同一 source/environment、同一入口且 consumer 接受的有效證據可重用。
- 來源／criterion／環境變更，只重驗受影響部分；不能把一個 Task 的 receipt 冒充另一個。
- 每項標記 met/not_met/indeterminate/needs_user，附實際觀察與證據；少跑輪次不等於少驗 requirements。
- 正例失敗保存已完成工作及證據；下游相依步驟停止，先因果診斷，不為報告格式再派 writer，也不自動重跑整組。
- G1/G2/G3只支持各自protocol結論。即使全過，缺少第1節的request-driven規劃／整體交付證據仍不能宣稱通用flow通過；未驗升級、auditor、crash/provider recovery、效能或production readiness亦不得擴大宣稱。

**下一步：核齊現行campaign計量與入口載入，另獲live授權後，由原始使用者需求走通用flow；不再以重跑G1為優先。** 原terminal Goal/receipts不重開、不追認。本輪source/離線證據：[需求入口修正](goal-team-evidence/task-runtime-request-flow-20260914/README.md)；前次預算修正仍保留其限定範圍。
