# E2E 準備與累計預算入口

**定位：預製 spec 的 protocol 回歸入口，不是一般使用者需求入口。** `run-todo-flow.mjs` 接受現成spec，故不能用它的成功證明L0自主拆解需求。一般flow見 [L0 SPEC](../../extensions/teams-orchestrator/SPEC.md)：由現有L0接收原始需求、產生spec、走公開工具，不需要這個runner或另建監督parent。本入口保留已證必要的測試計量修正；不新增controller、parallel API或通用budget gate。

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
    ]
  }
}
```

數字／路徑／anchor 是格式示例，不能作授權或直接啟動。`maxTokens` 必須是現有 owner 核准的累計 ceiling。舊 `TEAMS_E2E_POLICY_FILE`、`TEAMS_E2E_MAX_TOKENS`、`TEAMS_E2E_PARENT_ENTRY_ID` 不再是 CLI 預算來源；缺新輸入即拒絕，不能 fallback 至單一 policy。

- 從每份實際 spec 的 `policy.maxTaskTokens` 相加，不從 prompt、單一 policy 或使用者另填的 reservation scalar 取數。要求 fresh `goalId=pending`、revision 1、不同 taskId、相同 sourceRoot；這是準備檢查，不代替 runtime 完整 contract validator。
- `budget.parent.file` 必須對應目前 `PI_SESSION_FILE`。同一 parent session 換 G1/G2/G3 時保留原計量 anchor；不能改成新的「開始測試」訊息而丟掉先前用量。
- 歷史列出已終止的其他 parent/L0/Worker/leaf/review session 原始快照，包括失敗、取消、compaction／cache 用量。每個 session ID 只能一次；拒絕當前 parent 被重複列入、重複副本、缺失或 SHA 不符的來源。舊 parent 可指定其最初授權 anchor；其餘 session 全量計量。
- **歷史清單完整性仍須由準備者核對既有 execution/native inventory。** 程式無法從被刻意省略的清單推知不存在於輸入中的 runs。`history:[]` 只適用真正沒有歷史 session 的新 campaign；這次已有大量歷史的 campaign 不適用。不得把存活 session 當 closed snapshot，不得用 AcceptanceReceipt totals 加上同一 session 再重算。
- 啟動前與執行中沿用同一公式：`history actual + current parent actual + L0 actual + sum(Task ceilings)`。Task ceiling 是涵蓋 Worker/leaf/review 的完整預留，執行時不再加 Task actual，避免重複計費；最終總結以各 Task 真實 session 用量替換其預留。`reportedTokens` 含 history/parent/L0、尚不含本次 Task 實耗，仍是 lower bound。
- `admission.json`／`rpc-observation.json` 保存輸入 hash、各 spec/hash/ceiling 與歷史分項；不新增另一份 token ledger。

在輸入／歷史核對及當輪 live 授權完成後，沿同一公開 CLI 設定 `TEAMS_E2E_WORKSPACE`、`TEAMS_E2E_INPUT_FILE`、`TEAMS_E2E_PROMPT_FILE`、`TEAMS_E2E_DEADLINE_MS`、既有 subagents extension，以及明確核准的 canary／Goal confirmation 開關，再指定全新 `live` 目錄。模型沿 `models.json`，不新增 budget 或更換執行協定。

## Request-driven 驗收取代 G1 答案準備

先前的App＋guide產生器與專用checker已撤出執行樹，原bytes和路徑對照保存在 `goal-team-evidence/task-runtime-request-flow-20260914/withdrawn-g1/`。原始G1、C3收據仍是各自執行／驗收的證據，不追認需求規劃能力。

下一次通用flow驗收只提供使用者要求、真實source、必要環境／檢查與已核准policy/budget，**不提供答案patch、Task specs、固定Task數或角色鏈**。L0在一般入口自己判斷direct/Task Pi、寫spec並dispatch；觀察其原始需求涵蓋、依賴／scope、總計量與實际整合結果。工具／schema回歸不能替代這項模型行為驗證。不能把舊runner的『只改goalId、使用這些sealed specs』提示套到新需求。

## 證據與停止政策

本protocol測試中，L0使用tools回傳的exact receipt/log檔案路徑；若外部parent主持測試，歸檔／accounting可留到L0結束後，避免在測試內重複複製execution trees。這不是通用架構要求：一般L0自己負責最終證據與計量，不另派一個parent，也不以歸檔README代替成果驗收。

沒有更改原 observer 的 error/retry/stop 語義：schema-rejected Task input 可原 loop 更正；schema-valid Task error 立即 stop/drain；一般 tool error 在 `agent_settled` 後分類 `tool-failure`；原生有界 retry 仍可用。不將讀錯路徑等同 runtime crash，也不承諾新的模型永不誤讀檔案。Auditor disabled 仍記 skip。

離線驗證：

```sh
node --test task-runtime/test/e2e-admission.test.mjs \
  task-runtime/test/e2e-control.test.mjs task-runtime/test/request-flow.test.mjs
```

另在 `roles.test.mjs` 用非Todo objective與實際contract/mailbox驗證Worker取得L0提供的scope／contextRefs，不需要C3 archive才能跑此case。這仍是離線交接證據，不證明LLM能自主生成正確spec；當前campaign歷史inventory reconciliation仍須在下一次獲准live前完成。
