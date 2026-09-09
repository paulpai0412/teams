# Agent teams × Goal-x reliability repair — 2026-09-08

**狀態：第一批已落地，整體仍 PARTIAL；不是完整驗收或效率 benchmark。**

授權依據：使用者在 design-audit 後要求「開始修正」。本輪 main-only；零模型 child、
零模型 API call，未操作既有 Goal/mission、未調整模型/併發/權限、未安裝能力或 reload。

## 已落地

1. **stale hold**：completion observation 暫失敗後，在 parent boundary／明確 native
   status 結果後重查 exact binding。active 保持 hold；terminal 釋放；unknown 只
   解除 checkpoint 抑制，交 main reconciliation。不新增 notifier/wake，不清除
   mission active ownership，也不授權重派。await 後仍重查 context/owner identity。
2. **mission state**：`goal-request.mjs` parent-only CLI 讀保存的 packet，產生 SHA-256
   correlation/reference；`goal-task-step.js` v2 歷史只存 compact references/status。
   完整 packet/report 留在檔案和 native artifacts；先存 intent，再設 active marker，
   兩者成功才派工。真 store 容量拒絕時沒有 child 或 orphan marker。保留 v1 replay
   防重送，不自動搬動／刪掉舊 mission。Digest 不代表 sandbox 有能力驗證源檔。
3. **readiness**：`check-config.mjs` 一次彙總所有選用角色失敗；selected-role
   fail-closed 和共用安全檢查維持。沒有以刪 skill 要求掩蓋健康失敗。
4. **completion 的第一部分**：使用有效 merged settings，尊重 global、project
   override 與既有 per-goal skip 選擇；Goal/task completion 阻擋對應 native run
   active／unknown。已保存的 host exact terminal observation 可跨 artifacts 清理
   保留；unknown-release 不能冒充 terminal proof。新 team task list 操作契約明設
   `block_completion:true`，不修改既有 Goal/task 選擇。

## 實際安裝與回復

- `pi-goal-x@0.30.5`、`pi-subagents@0.64.0`；subagents source 未改。
- 新增 delta bundle：`../../patches/goal-team-reliability/`。底層依賴既有 hold-wake v1，
  版本／四個目標 hashes／未改的 base runtime hash 都需符合；不得強制越過 hash gate。
- 已套用到 `/home/timmypai/.pi/agent/npm/node_modules/pi-goal-x`；見 `applied.json`、
  `verified.json`，`--check` 為 `COMPATIBLE/post`。
- 最終 bundle ID 為 `pi-goal-x-0.30.5-goal-team-reliability-v2`；真安裝 backup：
  `2026-09-08T01-22-53-572Z-4db4f67e`。需要回復時使用：

  ```bash
  node ~/.pi/agent/teams/patches/goal-team-reliability/apply.mjs --revert 2026-09-08T01-22-53-572Z-4db4f67e
  ```

  初版新增 await 後的 pause/focus 競態由最終檢查抓到，先以原具名 backup 撤回，
  補上狀態重讀／focus 檢查與兩個回歸，再通過 package check 後重套。初版收據保留
  為 `initial-{applied,verified,reverted,patch-manifest}.json`，不當成最終來源證據。

- **未 reload**；磁碟 post 不代表現有 session 已載入。由使用者選擇 reload／新 session。
  Delta 套用後用新 bundle 檢查；舊 hold-wake wrapper 拒絕重疊的新檔案是正常 hash 保護。
- Team helper/docs 修改前副本在 `before/`；回復前按 final hashes 查有無後續變更，
  不整批還原其他設定或 Goal。新 CLI/helper 版本應一併回復，不能混搭。
- `.ts.txt` pre/postimage 是 byte snapshots，不是可獨立編譯的 modules；檢查實際
  完整 candidate/installed package，並以 manifest 驗證其內容，不以改副檔名免驗。

## 可重跑的機械證據

統一 prefix：`PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/`。

| Check | 結果 | 原始證據 |
| --- | --- | --- |
| check-goal-hold-wake.mjs | 30 PASS；held checkpoint 0、兩個不同 fixture run 各 native wake 1、bridge wake 0 | verified.json |
| check-goal-completion.mjs | 16 PASS；global/project/per-goal、pending task、active/unknown/terminal、foreign owner、durable observation、await 後 pause/focus 改變 | verified.json |
| check-goal-step-storage.mjs | 8 PASS；50 步 8 KiB packet＋8 KiB report，state **25,454 bytes**；含真 CLI與真容量拒絕 | storage-green.json |
| check-goal-team.mjs [cwd] | home / Grafana 各 54 PASS；native workflow syntax、v1 replay、failure | goal-home.json / goal-grafana.json |
| check-selected-role-preflight.mjs [cwd] | home / Grafana 各 11 PASS；這是 checker 行為，不是所有角色可用 | readiness-home.json / readiness-grafana.json |
| check-handoff-contract.mjs /home/timmypai | 43 PASS | handoff.json |
| check-team-outcomes.mjs | 54 PASS | outcomes.json |
| check-reliability-patch.mjs | 11 PASS；hash/version/base拒絕、apply/idempotence/verify、validation rollback、mixed-state revert、防重複消費回復 receipt | package-regression.json |
| check-config.mjs --roles-only /home/timmypai | **FAIL，4 roles 缺必要 skill** | role-health.json / role-health.stderr |

RED 記錄：`hold-red.log`、`storage-red.log`、`readiness-red.log`、`completion-red.log`、
`task-completion-red.log`、`task-await-race-red.log`（本批引入並修好的 await 邊界）。
第一次 completion harness 少了一個 fake UI ref，補齊後才
記錄真正「global disabled 卻進 auditor」的 RED；不把 harness error 當產品重現。

**Static checks：**已執行 actual installed 四個 TS targets 與三個 helper 的 primary LSP：
6 files clean，goal-events 有 3 個既存 `agent_settled`／implicit-any inferred warnings。
preimage 已有相同 handler；LSP 解析的 local SDK 為 0.75.5，而實際 Pi 為 0.84.4，
後者官方 extension docs 明列 agent_settled。沒有升級依賴來掩蓋此差異。
最後 task-tools 再檢另有原本第 12 行 pi-tui import 的 unresolved-module warning；
保留 runtime/fixture 與靜態依賴解析的區別，不能宣稱全套 TypeScript 編譯已通過。
selected-role check 另有超出 67 行檔案 EOF 的 LSP 1128 warning；`node --check` 與實際
11-case 執行皆通過，仍記錄為 inferred/stale 診斷限制，不宣稱完全 type-clean。
另試 standalone TS parser 時本地無可 resolve 的 typescript package，未安裝；不算 PASS。
`lens_diagnostics(mode=all)` 無 blocking errors，仍有測試 CLI console／正確 await
括號等 advisory；不是全專案掃描或「零 warnings」。

## 尚未完成／不能宣稱通過

- **完整 source freshness／REQUIRED product-evidence 結案 gate 尚未實作。** 現有
  Goal evidence 是 prose，run terminal 和 report schema 合法都不是產品合格。當前
  guard 僅核對本 session branch 的 native bindings；看不到未綁定／其他 session
  工作，未自動讀 mission.activeStep 或查 evidence 真偽。main 仍必須核對 retained
  intent、真實入口、來源、全部 required checks，再更新 Goal/task。
- 缺少 skills：docs→docs-generator；e2e→browser-automation；release→supply-chain-security；
  security→code-audit、llm-security、supply-chain-security。未裝／未換／未刪要求。
- **必要的獨立 lifecycle/security review 與 live child/TUI canary 尚缺。** infrastructure
  本輪沒有另外的 child 授權，故未啟動；main-only 不代表可以將它們改成 N/A。
- fixtures 證明 state 成長與邊界行為，不證明模型品質、live pause/resume、跨進程
  exactly-once，或實際 time-to-accepted 加速。

## 最小下一步與回顧

1. 先取得一個 fresh no-write reviewer 的授權，審查這批 exact source/receipts；修復
   review 發現後才跑經授權的 canary。Goal canary 的 focus/new Goal 仍由使用者決定。
2. 完整結案檢查先對齊最小 parent-owned host receipt：沿用既有 criteria/native
   receipts，明列 required checks 與 source scope/hash，再接到 completion；不要另建
   controller、task store 或從 prose 猜測「驗收通過」。未採此新契約前明列 partial。
3. 復盤：先用 native store／real entrypoint fixtures 證偽，比反覆模型交接便宜；
   state 存 references 保留去重歷史，不直接加大 256 KiB 上限；先查 runtime SDK
   與 LSP resolution 差異，避免將舊型別警告修成不相干的 runtime 改動。
