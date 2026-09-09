# Goal 任務清單 × Team 執行

> **首版是主 agent 協調契約＋原生 workflow helper，不是新排程器。**
> pi-goal-x 保存成果任務；pi-subagents 是唯一 child controller。
> 不會把每次 `/team` 自動變成 persistent goal，不改寫或接管既有 goals。

## 使用方式

在新／已 reload 的 Pi 會話中明確提出：

```text
/goal 修復登入逾時問題。使用 agent teams：必要時先 debugger，
按需修復，以主 agent/host 驗證真實入口，高風險加獨立 review，不部署。
```

由主 agent／planner 規劃成果與驗收條件，確認後以 goal-x 保存 task list。
如已有 goal，使用 `/goal-focus` 選取；不要另建同一目標。
`set_goal_tasks` 的確認會結束當前 turn，等續跑後才派工。

普通 `/team` 仍可不使用 goal；Sisyphus 僅在使用者指定時啟用，依確認的順序執行。
Task 是成果，不是一個 agent：例如「修復登入」可歷經 debugger、implementer、
verifier、reviewer。首版同一 goal 僅一個 current task／一個 active step。

## 設定與預檢

- 新增真正全域預設：`~/.pi/agent/pi-goal-x-settings.json`。
- 移除 home `.pi/settings.json` 中僅針對 goal-x 的舊停用覆寫，其他 packages 保持。
- 目前已對 home 與 Grafana 專案的 `.pi/pi-goal-x-settings.json` 明確設定：
  `disabled: true`（**只停用 goal auditor，不停用 goal extension**）、
  `disableTasks: false`、`disableContracts: false`、`autoSelectSingleGoal: false`、
  `auditorProjectResources: false`、`oracle.enabled: false`、`oracle.projectResources: false`。
- 保留原本 model/provider/thinking 欄位，因 auditor 停用而不使用；不改其他 team 模型。
- **新專案需預檢與授權設定：**已安裝版 completion 路徑直接呼叫
  `loadGoalSettingsFileConfig(cwd)`，只讀 project layer。全域 `disabled: true`
  不足以保證該路徑停用 auditor；必須在該專案明列 `disabled: true`。
  不直接修改 goal files、不偷偷切換使用者現有 per-goal 選擇；不合規就先停下。
- Child 不載入 goal-x、不取得 goal tools，也不得透過 shell 改 `.pi/goals/`。
  保持明列 extensions 與 `defaultExtensions: []`，禁止 per-run 擴權或繼承 goal runtime。
- 不啟用 subagents mission 的 `goal:true`、watchdog、schedule 或其他續跑器。
  Goal 的 token 顯示不是所有 subagent 成本的總帳；沿用 team wave／session 上限。

```bash
PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-config.mjs --roles-only "$PWD"
PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-goal-team.mjs "$PWD"
node ~/.pi/agent/teams/check-goal-hold-wake.mjs
```

第二個檢查驗證目前設定／工具註冊與實際 helper 的 mock replay/failure 行為；
第三個檢查直接載入已安裝的 hold/runtime/events 入口，使用隔離的原生 status fixture
量測等待與釋放；它不啟動模型 child，也不取代真實任務的 receipt 驗收。
不表示模型 E2E、TUI pause/resume 或跨進程原子派工已驗證。
證據：`validation-goal-team-{grafana,home}.json`、
`validation-goal-roles-{grafana,home}.json`。完整全域檢查另存
`validation-goal-global.log` 是舊快照（當時 loop 啟用而失敗）。2026-09-06
已依使用者核准停用 loop/control 等替代入口；最新檢查見
`goal-team-evidence/handoff-efficiency-20260906/`，不以舊快照代表目前狀態。

## 主 agent 的最小執行協定

1. **讀取而非猜測。** `get_goal` 取得 focused goal、task、驗收條件與狀態。
   已暫停、blocked、已完成或 budget-limited：不派新工。每個 goal 僅一個 owner
   session；換 session 必須確認原 owner 與所有舊 runs 不再執行。
2. **先綁定 mission。** 用 `mission.list/show` 找已存在的對應；僅第一次用
   `mission.create`，objective 記 goal ID 與 cwd。用原生 mission 的 state 保存
   `teamGoalBinding: {goalId,cwd}`；不得使用 `mission.goal:true`。
   這是執行對應，不另複製一份 task list；goal-x 才是 task 狀態來源。
3. **先恢復，再派工。** 每次續跑先查 mission 的 `teamGoalActiveStep`、
   `goal-step.*` records 與原生 linked runs/status/terminal receipt。
   active／unknown／missing receipt 不表示可重送；已回傳的 report 也不是完成證明。
4. **啟動一個 step。** 主 agent 先 `update_goal_task(status="start")`，再重新
   查 goal/source，透過 mission-attached workflow 的 `state.set` 寫入下表資料。
   Task 的底層 status 仍為 pending，start 只設定 currentTaskId。
5. **呼叫 helper。** 使用相同 `missionId`、精確 `cwd`、
   `workflowScriptPath: ~/.pi/agent/teams/goal-task-step.js`（工具內使用 absolute path）、
   `async:true`、`context:fresh`、主 agent 依該 task 選擇的 `timeoutMs`、
   `globalConcurrencyLimit:1`、
   `maxSubagentSpawnsPerRun:1`，並加入下列 top-level binding。每次 helper 只執行
   一個角色，不自動接下個 step。`sessionId` 由 runtime 從目前 session 取得，不由
   model 猜測；若呼叫端選擇提供，必須精確相符。

   ```json
   {
     "extensionBindings": {
       "pi-goal-x.team-hold/1": {
         "goalId": "<get_goal 的 goal id>",
         "taskId": "<目前 currentTaskId>",
         "cwd": "<精確絕對 cwd>"
       }
     }
   }
   ```

6. **接收並驗收。** native completion 通知後，主 agent 讀精確 run receipt、
   output 與實際 source；完成 main/host 機械驗證及按風險所需 review/security/E2E。
   格式錯誤依 [HANDOFF-PRACTICE.md](HANDOFF-PRACTICE.md) 只修交接，
   不清 marker 後增加 implementation attempt 重做。
   僅在確認該 step 已終止且副作用已釐清後，以 mission-attached `state.set`
   清除 `teamGoalActiveStep`（設 null），保留所有 `goal-step.*` 舊紀錄。
   新 phase／有理由的新 attempt 使用新 key，不覆蓋舊 request 來掩蓋失敗。
7. **更新成果。** 整個 task 的 REQUIRED evidence 全部有效才由主 agent
   `update_goal_task(status="complete", evidence=...)`。短 evidence 寫 durable report
   位置與來源指紋，完整證據留在使用者核准的 evidence directory。
   還有子 task 時先完成子項。失敗不跳過，禁止 child 自行完成 task。
8. **收尾。** 主 agent 重新比對 goal 的全部 criteria、最終 source、各 gate、
   殘餘風險與未決 runs；保存證據，再 `update_goal(status="complete")`，
   確認真正 completion 結果／歸檔後關閉 mission。Goal 記錄 `audit_skipped` 是
   刻意停用內建 auditor，不能宣稱 goal 內建 audit 通過；team review 證據另外列明。

### `teamGoalRequest` 欄位

由主 agent 以 `state.set("teamGoalRequest", request)` 保存 JSON；不是 child 輸入權限。

| 欄位 | 來源／限制 |
| --- | --- |
| goalId、taskId | `get_goal` 的真實 identity；taskId 為短 slug |
| goalStatus、taskStatus | 剛讀取的 `active`／`pending`；不是人工把 paused 改成 active |
| phase、attempt | 如 `diagnose`／`implement`／`verify`／`review`，attempt 1..3 |
| agent | 已檢查的普通 `team.*` 角色；advisor 另走必要性核准，不走此 helper |
| cwd、sourceState | 唯一綁定 cwd 與實際 commit＋dirty diff／artifact digest |
| task | 完整 cold-start packet：目標／非目標、allowed files/actions、criteria、驗證命令、證據路徑、stop rules；debugger 必含 scratch 範圍 |

Helper 先寫 `teamGoalActiveStep` 與 `goal-step.<taskId>.<phase>.<attempt>` intent，
才執行 `runs.run`，之後記原生 child run ID、artifact references 與 structured report。
原生 mission linked runs 補上 top-level workflow run ID，terminal
`workflow-receipt.json` 保留 stable key 對應。相同 step key 再呼叫只回傳舊 record；
contract 不同就拒絕。保留 active marker，直到主 agent 明確 reconcile。

## 續跑、暫停與異常

| 狀況 | 主 agent 下一步 |
| --- | --- |
| child 執行中 | 不重送、不改相同 checkout；必要時回應 supervisor，等待 native 通知 |
| goal auto-continue 提早喚醒 | 若 checkpoint 已在 run identity 確認前排入，先讀綁定與 existing run，不新開同 task；確認 hold 後不會再產生新 checkpoint；不可用重複 launch／sleep 解決等待 |
| parent 重啟／compact | runtime 只從目前 session branch 的完整 binding 恢復，做一次 public targeted status RPC 並比對 bounded `status.json`；active 才 hold，terminal／unknown／missing／identity mismatch 即釋放給主 agent reconciliation。舊 intent 沒 receipt 視為 unknown |
| launch timeout／throw／保存失敗 | intent 保留；核對 mission linked runs 與真實副作用，不能猜「沒啟動」後重送 |
| schema／acceptanceReport 錯誤 | 保存成果，只修交接；七欄 value 不加 memoryCandidates，acceptanceReport 是 native sibling。格式錯誤不構成重派 writer 理由 |
| child reported pass | 只是 step report，source／驗收證據仍由主 agent 查證；不自動 complete task |
| goal 被 pause／unfocus／clear | 不派後續 step；原 child 不一定停止，主 agent 對精確 run 使用原生 stop/interrupt 並確認終態；不冒稱已取消副作用 |
| paused goal 收到 child 通知 | 可以收證據與處理安全收尾，不自行 resume goal 或開新工；等使用者 `/goal-resume` |
| failed／stopped／unknown | 保持 task 未完成；原生確定 resumable 才以原 run 續跑，紀錄新 run lineage；否則主 agent 決定有界新 attempt |

### Event-driven hold/wake 與已知限制

- `pi-goal-x.team-hold/1` 只在 top-level async helper 的 `tool_call` 建立 provisional
  hold；同一 `tool_result` 的 `runId`／`asyncDir` 必須再由 bounded native
  `status.json` 證明 session、cwd、toolCallId、completionOwnerId 與 active state，
  才寫入 Goal-owned session entry。等待中 Goal 保持 active、使用者仍可輸入；
  GoalRuntime 僅抑制該精確 Goal/task 的 checkpoint，不 pause Goal。
- 原生 `subagent:async-complete` 只有在 event 宣告 terminal state，且重新開啟的
  native `status.json` 也以相同 owner identity 證明 terminal 時，才釋放精確 binding；
  identity-only replay 或 active-status completion 不會釋放。`pi-subagents` notifier 已
  送出唯一 wake，bridge 不再送 message、不派 child、不 complete Goal/task，也不自動
  清 `teamGoalActiveStep`。pause／stop／unfocus／task change 會讓 binding 永久失效；
  之後 resume 不會復活舊 hold。
- run identity 確認前已排入的 checkpoint 無法撤回，可能造成一次 reconciliation
  turn；確認後的 fixture 量測為 checkpoint 0、每個 success／failure run 各 native
  wake 1、bridge wake 0。檢查載入真實 `pi-subagents` notifier，但 session/status/event
  bus 仍是 deterministic local fixtures，沒有啟動模型 child。status/RPC 缺失或未知
  一律 fail-open 給主 agent reconciliation，不把 marker 當活性證明。
- `state.get`＋`state.set` 不是 CAS／跨 session 鎖；同一 goal／mission 單一 owner 是
  操作契約。不能聲稱 exactly-once、跨 session 防競爭或 pause 與 launch 原子互斥。
- Helper 讀的是 parent snapshot，不會直接讀 goal files／verify git；主 agent 每次
  發動及完成更新前必須重讀 goal/source。Goal 暫停不會撤銷已啟動的外部效果。
- Runtime 稽核仍用原生 receipts；mission JSON 與 goal markdown 不是不可竄改證據。
