# E2E 準備與累計預算入口

**定位：公開 RPC E2E 入口，不是另一個產品 controller。** `run-todo-flow.mjs` 預設的 prepared-spec 模式只測 protocol，不能證明 L0 自主拆解；經獨立批准的 `request-driven` 模式才從原始要求開始，由 L0 寫真正 spec 並走既有公開工具。一般互動工作仍照 [L0 SPEC](../../extensions/teams-orchestrator/SPEC.md)，不依賴此 runner。這次新增的是同一入口的授權／上下文交接，不是新全域 campaign ledger 或 universal token gate。

## 共用輸入（單／多 Task）

`run-todo-flow.mjs` 現在要求 `TEAMS_E2E_INPUT_FILE` 指向一份 JSON：

```json
{
  "specPaths": ["/absolute/fresh-source/.git/spec-a.json", "/absolute/fresh-source/.git/spec-b.json"],
  "budget": {
    "maxTokens": 1000000000,
    "parent": {
      "file": "/absolute/current-parent-session.jsonl",
      "authorizationEntryId": "original-campaign-anchor"
    },
    "history": [
      {"file": "/absolute/closed-worker-session.jsonl", "sha256": "exact-sha256"},
      {"file": "/absolute/closed-parent-session.jsonl", "sha256": "exact-sha256", "authorizationEntryId": "original-anchor-in-that-session"}
    ],
    "executions": [
      {"runtimeRoot": "/absolute/task-runtime-root", "executionId": "actual-closed-execution-uuid"}
    ]
  }
}
```

數字／路徑／anchor 是格式示例，不能作授權或直接啟動。`maxTokens` 必須是現有 owner 核准的累計 ceiling。舊 `TEAMS_E2E_POLICY_FILE`、`TEAMS_E2E_MAX_TOKENS`、`TEAMS_E2E_PARENT_ENTRY_ID` 不再是 CLI 預算來源；缺新輸入即拒絕，不能 fallback 至單一 policy。

### 需求驅動輸入（須另有本次 live 授權，請勿直接複製示例）

沿同一 `TEAMS_E2E_INPUT_FILE`，將上例的 `specPaths` **移除**，保留已核准的 `budget`，並加入：

```json
{
  "mode": "request-driven",
  "requestFile": "/absolute/source-of-original-requirements.txt",
  "planningTaskCeiling": 1000000,
  "budget": { "maxTokens": 1000000000, "parent": { "file": "/absolute/current-parent.jsonl", "authorizationEntryId": "actual-owner-entry-id" }, "history": [], "executions": [] },
  "authorization": {
    "mode": "task-pi", "goalAction": "create", "delivery": "verify-only",
    "parentSessionFile": "/absolute/current-parent.jsonl", "parentAuthorizationEntryId": "actual-owner-entry-id",
    "unknownUsage": 0, "openReservations": 0,
    "historyProvenance": { "file": "/absolute/verified-campaign-inventory.json", "sha256": "the-exact-64-hex-byte-digest" },
    "deadlineMs": 1800000
  }
}
```

範例中的空 history／executions、零 unknown／open 和數字**不是對現有 campaign 的事實或授權**。公開 RPC runner 只接受有限的正整數 deadline，現有上限為 **5,400,000 ms（90 分鐘）**；上例30分鐘仍僅是格式示例。延長需當次 owner 核准、同一個 `authorization.deadlineMs`／進程期限，並保留 owner drain／kill grace；Task spec 自己的期限也須在封存前按可用時間規劃。這不是無限執行或免除 campaign／Task token ceiling。準備者需先調查並核定完整 membership、old/current parent、open reservations 和 source 狀態，再以實際快照 SHA 填入；已知缺口仍是 unknown，不可填零求放行。`authorization` 是受信賴啟動者對 owner 決定的 attestation，runtime 只能核 user entry 身分、列出的 session、snapshot bytes、數字及原需求／git base 一致，**無法從 inventory JSON 自動證明未列出的 execution 不存在**。`PI_GOAL_AUTO_CONFIRM=1`／canary 環境旗標也不會自動產生此授權。若本次是現有 Goal，需另經既有 `resumeUndispatched` 條件與實際 Goal 身分，不得套 fresh request CLI 的 `goalAction:create`。

需求驅動模式不需 `TEAMS_E2E_PROMPT_FILE`，且拒絕提供 `specPaths`／答案 patch；從 hashed `requestFile` 送出原要求，附加 host 同一 admission snapshot 的 mode、Goal 建立權、delivery、source base、history refs/SHA、實耗／可用規劃額、unknown/holds 與期限。Pi 以 `--no-skills --skill ~/.pi/agent/skills/team-flow/SKILL.md` 精選載入，並把當前 skill/SPEC bytes＋SHA 實際附在首個 prompt，不只列文件名稱；其他全域 context/skill 不自動開啟。對 host 已核准 `mode=task-pi` 的 request-driven attempt，launcher 並合成 `TEAMS_E2E_L0_MODE=task-pi`：Orchestrator 在 `session_start` 用公開 `setActiveTools` 只隱藏模型可見 raw `subagent`，不卸載內部 RPC；環境傳入的 marker 不可由 caller 繼承冒充 admission。ordinary/direct 不設定 marker。這是可見工具選擇，非 shell/OS 安全邊界。`planningTaskCeiling` 是 observer 在總額中預留的**規劃額，非跨 Task dispatch 的硬限額**；Task runtime 仍個別守 sealed ceiling。L0 需使實際所有 Task ceilings 合計不超過這個規劃額；若需要 host 在每次動態 dispatch 前保證此全域不變量，須先批准獨立的機械 enforcement 方案，不可用上下文交接冒稱已保證。此 source-only/RPC fixture 不等於真模型收到、理解或遵循。

- 從每份實際 spec 的 `policy.maxTaskTokens` 相加，不從 prompt、單一 policy 或使用者另填的 reservation scalar 取數。要求 fresh `goalId=pending`、revision 1、不同 taskId、相同 sourceRoot；這是準備檢查，不代替 runtime 完整 contract validator。
- `budget.parent.file` 必須對應目前 `PI_SESSION_FILE`。同一 parent session 換 G1/G2/G3 時保留原計量 anchor；不能改成新的「開始測試」訊息而丟掉先前用量。長期 session 以 64 KiB chunks 讀取固定大小快照，仍核對完整 raw prefix digest／唯一授權 entry；只在記憶體保留 header 與完整計量 window。每筆 record 與完整 window 仍各受 64 MiB 上限，不截斷、重設 anchor 或忽略缺失成本。只有已有 verified prefix 的未終止 append suffix 可暫緩，完整 malformed record 一律拒絕。
- 歷史列出已終止的其他 parent/L0/Worker/leaf/review session 原始快照，包括失敗、取消、compaction／cache 用量。每個 session ID 只能一次；拒絕當前 parent 被重複列入、重複副本、缺失或 SHA 不符的來源。舊 parent 可指定其最初授權 anchor；其餘 session 全量計量。
- `budget.executions` 明列已關閉 Task executions。reader 唯讀開啟既有 ledger，不建立 controller、不寫舊資料；以完整 terminal/native inventory 計 Worker、每個 leaf、每個 final reviewer（含最後一個角色、失敗與 cache），不能拿 `role-usage-*` 中途快照當終態。raw history 若已有同一 session，SHA／counters 必須相同且只計一次；不同 executions 重用 native session identity 仍拒絕。open／unknown／缺原生證據不能計零。
- **campaign membership 仍由準備者核定。** 程式核對的是明列 executions 的完整 inventory，無法發現被完全省略的 execution、parent 或 L0。`executions` 缺省為空以保持舊入口可讀，但 raw-only history 不證明完整性。既有 campaign 不能用空 history/executions 重置費用。不要加 AcceptanceReceipt scalar 重算成本。
- 啟動前與執行中沿用同一公式：`history actual + current parent actual + L0 actual + sum(Task ceilings)`。Task ceiling 是涵蓋 Worker/leaf/review 的完整預留，執行時不再加 Task actual，避免重複計費；最終總結以各 Task 真實 session 用量替換其預留。原 live owner 在 drain/cancel/reconcile 保存 `closed-usage.json`；observer 唯讀核對 receipt 與完整 native inventory 後，將本次 Task 實耗加至 `reportedTokens`（不另加 reservation）。`taskUsage.status:unknown` 明列原因，cleanup 成功不代表計量完整。`reportedTokens` 仍不宣稱全域 billing 精確值，保持 lower-bound 標記。
- `admission.json`／`rpc-observation.json` 保存輸入 hash、各 spec/hash/ceiling 與歷史分項；不新增另一份 token ledger。

在輸入／歷史核對及當輪 live 授權完成後，沿同一公開 CLI 設定 `TEAMS_E2E_WORKSPACE`、`TEAMS_E2E_INPUT_FILE`、`TEAMS_E2E_DEADLINE_MS`、既有 subagents extension，以及明確核准的 canary／Goal confirmation 開關，再指定全新 `live` 目錄；**只有** prepared-spec 模式還需要 `TEAMS_E2E_PROMPT_FILE`。模型沿 `models.json`，不新增 budget 或更換執行協定。

2026-09-22 r12–r17 更正：同一 `d1c0589a` campaign 六輪卻各用空 history，原報告不是 cumulative total。只讀更正與可供下一次核定的 `inputsForFuturePreparation` 見 `goal-team-evidence/task-runtime-boundaries-20260922/campaign-correction.json`：六份 L0 原始 SHA snapshots＋六個 closed executions；parent 僅沿原 anchor 計一次。**不複製舊 launcher 的 `input=[]`／`historicalExecutions:[]`，也不把這個快照當未來 parent 最終用量。** 新 campaign 的獨立授權不抹除同 campaign 的前次 attempt；舊 campaign immutable、unknown 保留。

## Request-driven 驗收取代 G1 答案準備

先前的App＋guide產生器與專用checker已撤出執行樹，原bytes和路徑對照保存在 `goal-team-evidence/task-runtime-request-flow-20260914/withdrawn-g1/`。原始G1、C3收據仍是各自執行／驗收的證據，不追認需求規劃能力。

下一次通用flow驗收只提供使用者要求、真實source、必要環境／檢查與已核准policy/budget，**不提供答案patch、Task specs、固定Task數或角色鏈**。在未指定模式的一般入口，由 L0 判斷 direct/ordinary/Task Pi；在已核准指定 Task Pi 的需求驅動 canary，由 L0 自行寫 spec 並走該模式的公開工具，缺能力就回 blocker 而非換路。觀察原要求涵蓋、依賴／scope、成本與真整合結果。工具／schema回歸不能替代模型行為驗證；不能把舊runner的『只改goalId、使用這些sealed specs』提示套到新需求。

新需求文字見 `g1-request.txt`；僅是需求／邊界，不是啟動授權或準備好的答案。r12–r17 的 historical requests/launchers 保留原樣，不再作模板。精確 selectors/storage key 必須跨 Task context/criteria 與 leaf handoff 保留；不要求 empty state 必須寫在初始 HTML，不固定 objective/criterion 的任意文字長度，仍遵守真正 6 KiB rendered Task prompt。完整工作與最終 source-bound review 的成本由 L0 規劃，不把 Worker review 當替代或固定要求重複 review。

## 證據與停止政策

本protocol測試中，L0使用tools回傳的exact receipt/log檔案路徑；若外部parent主持測試，歸檔／accounting可留到L0結束後，避免在測試內重複複製execution trees。這不是通用架構要求：一般L0自己負責最終證據與計量，不另派一個parent，也不以歸檔README代替成果驗收。

依設計第 29 節修正 observer：public schema 拒絕，或同一 tool/call/input 綁定的 `teams-input-rejection/1`，可由原 loop 在既有權限內修正；不是看錯誤訊息決定重試。未分類 Task 錯誤、未知效果、source/authority/usage/deadline gate 仍 stop/drain。一般工具錯誤保留 faults，由 L0 依效果處理，不再永久污染之後的 Goal 結果，也不據此宣稱 E2E PASS。`collection:waiting` 是正常等待視窗結束，不是 Task deadline。原生有界 retry 保留；沒有自動重派、擴權或模式 fallback。Auditor disabled 仍記 skip。

第 30 節另區分正常退出但未通過的 host check：只有 stage 核明 receipt、source、owner、staged tree 完整，才交接綁同 tool/call/input 的 `teams-completed-check-failure/1`。Observer 留診斷與 pause/cleanup 的機會，但本 attempt 固定失敗；不接受、不重播、不修改 sealed source、不自動下一輪。timeout/signal/spawn/source/owner/usage fault 或未綁定的 facts 仍立即停止。失敗 checker 輸出 bounded phase/DOM/browser errors，不以 stack 訊息判斷產品責任。

### RPC 傳輸與事後原生驗收（新 request-driven G1）

`run-todo-flow.mjs` 只產生 `live/rpc-observation.json`：`status: captured` 表示 L0 已退出、最終 usage 可讀、Goal 有終態且若有 Task 則 owner drain／Task usage 都已封閉；`status: incomplete` 表示至少一項未核實。Observer CLI 分別回 **2（已捕獲、待審核）／1（未完整捕獲）**，絕不因傳輸成功而回0；只有獨立事後審核通過才回0。Goal complete、browser exit 0 或 L0 敘述都不是 E2E PASS。觀察檔固定 `acceptance: not-assessed`，不再寫 `fullE2EPassed`。

L0 結束後，使用**新的**主審核輸出檔（已存在者一律拒絕覆寫），唯讀核原始需求 SHA、native closed usage、ledger ACCEPTED／0 open／owner released、AcceptanceReceipt 與 staged/target source、指定 Edge browser check 及 12 情境、獨立 PASS review、Goal archive／Task evidence／completion events；任一缺口 `blocked`、exit 1，不重新執行 Task／檢查，也不修改 Goal 或 ledger。本 checker 限本案 request-driven、verify-only 的 G1/browser 契約，不能將其他產品或 prepared-spec 路徑套用成 PASS。

```sh
node task-runtime/e2e/audit-rpc-attempt.mjs \
  "$RUN/live/rpc-observation.json" "$RUN/main-audit.json" "$RUNTIME_ROOT"
node task-runtime/e2e/report-runs.mjs "$EVIDENCE_ROOT"
```

`report-runs.mjs` 對新 RPC 格式重新計算審核，與 `main-audit.json` 不一致即拒絕；未審核只回 `not-assessed`，usage 不全只報下界。其 summary 的 `fullE2EPassed` 表示所選 runs **至少一個**完整 native audit PASS，不代表所有歷史 attempt、舊 campaign 用量／open reservations 或部署驗收已結清。這兩個事後命令會建立 audit、metrics／summary 檔；回讀舊 r7 時請用獨立副本，不覆寫原 `rpc-observation.json` 或當作重跑 live。r7 歷史觀察原樣維持 `blocked/false`，原生驗收事實與新的 reporter 格式不可倒填。

離線驗證：

```sh
node --test task-runtime/test/e2e-admission.test.mjs \
  task-runtime/test/e2e-control.test.mjs task-runtime/test/e2e-audit.test.mjs \
  task-runtime/test/request-flow.test.mjs
```

另在 `roles.test.mjs` 用非Todo objective與實際contract/mailbox驗證Worker取得L0提供的scope／contextRefs，不需要C3 archive才能跑此case。這仍是離線交接證據，不證明LLM能自主生成正確spec；當前campaign歷史inventory reconciliation仍須在下一次獲准live前完成。
