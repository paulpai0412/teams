# Agent teams 嚴謹審查 — 2026-09-08

## 結論

**仍有缺口；不能判定整體執行可靠性／防重工已完成。**
角色分工與五個缺失 skills 的修補已有實質改善，但跨 helper 的生命週期與
最終驗收尚未一致。此次發現兩項優先修正的功能問題，另有預檢一致性、
報告恢復流程與文件／設定漂移。這是審查結果，不是修復完成宣告。

本輪 main-only；沒有呼叫模型 child、修改團隊程式／設定／角色、動 live
Goal/mission、部署、安裝或改模型權限。只新增本 evidence directory 的審查腳本／報告。
當前 cwd 是 `/home/timmypai/apps/vocab-agent`（非 git repository）；審查對象是
`~/.pi/agent/teams`、`~/.pi/agent/agents` 與必要的已安裝 runtime consumer。
Graph 未涵蓋這些路徑，因此採本地來源／pi-lens outline 與有界文字搜尋。

## 已證實問題

### F1 — P1：host 否決後的實作修復不計入三次上限

來源：`goal-task-step.js:109–132,250–258`。

- 計數只在前一筆同角色 record **不是 reported**，且 recovery.action=retry 時增加。
- 但 reported 只代表 child transport/result 與自評 pass；不是 host 或 parent 最終接受。
- 正常流程「writer 回報 pass → host 驗證 fail → 同需求局部修復」因此不會被計入。
- 反例走真 `prepareGoalDispatch`（每次真 source snapshot/readiness）、其 setupScript、
  真 step helper、stub runs.run，以及真 host 失敗命令：初次＋四次明列修復共
  **5 次 stub launch 全被放行，repairs=0**。每輪修改隔離 source bytes；沒有靠假來源
  digest 或直接修改 counter。沒有啟動模型 child。

影響：最常見的實作返工不受所宣稱的修復上限約束。Native wave/session 總預算仍在，
所以這不等於無限執行；但 task-level repair ceiling 沒有覆蓋成果驗收失敗。

最小改善：由 parent 的 host/review 否決證據決定「正常新切片或修復」，沿用既有
mission ledger；不能從 writer reported 推導成功切片。必須同時保留四次真正成功
切片可繼續的正例，避免恢復舊的「成功也扣額度」錯誤。

### F2 — P1：recovery 與 final acceptance 對 settled 狀態的判定互相矛盾

來源：`goal-recovery.mjs:25–64`、`host-evidence.mjs:434–468`。
已安裝 `pi-goal-x/extensions/goal-team-evidence.mjs` 與 host-evidence **SHA-256 相同**，
不是只存在於未部署範例的問題。

**F2a：合法恢復仍被卡住。**

1. runs.run throw 沒帶 runId，step 正確保存 blocked／unknown。
2. recovery 從 terminal native fixture 找到唯一 childRunId，驗證 fresh host receipt，
   action=continue 的 setup 成功，active marker 清除；不改寫歷史錯誤。
3. 最終 sealAcceptance 仍失敗：`unresolved retained step: goal-step.task.work.1`。

原因：recovery child identity 保存在 `record.recovery.childRunId`，但 missionSettled
只接受原 record.runId；不讀 recovery。對 dispatching 保存失敗紀錄也有相同消費者
相容性風險（本輪重現的是 blocked/no-runId）。它遍歷 mission 所有 goal-step 歷史，
所以單筆紀錄可持續妨礙後續 task 的驗收。重派新的成功 step 不會消除舊紀錄。

**F2b：反方向又過寬。**

blocked record 有原 runId、但完全沒有 recovery 時，僅清 active marker，
相同 final acceptance helper 就回 verified。這一步刻意模擬 parent 漏做 recovery；
不是遵循政策的合法操作，也不是惡意攻擊的 security bypass。
它證實 completion consumer 檢查的是「有 runId」，不是「完成 reconciliation」。

最小改善：dispatch/recovery/host/runtime completion 共用同一個 settled-record 判定，
接受有完整證據的 recovery，不修改原失敗成 pass；未恢復的 unknown/blocked 不得
因清 marker 就算 settled。保留這兩個相反方向的 producer→consumer 回歸。

### F3 — P2：report-only 完成後，正常下一切片的交接仍不順

來源：`goal-task-step.js:115–130`、`goal-recovery.mjs:18,51–64`。

反例：captured pass 但 execution failed → report-only recovery 成功 → 同 task/role
改做不同 C2（非重跑 C1），仍被拒絕，零 launch。

這不是建議放寬「報告問題不能重派 writer」。現有路徑可以再做一個明確 continue
recovery；問題是 report-only 尚不等於已完成報告處理，而文件缺少其後的明確收尾／
新工作轉移步驟，錯誤訊息也沒有說明此情況。屬流程摩擦／交接語義缺口，不同於 F1/F2
的硬錯誤，也不能說一定要重做實作才能解除。

最小改善：明定 report-only 的完成與 continue 決策何時作出、何者授權新 scope；
對「重放原工作」與「後續不同工作」各留一個檢查。不新增 controller 或 repair agent。

### F4 — P2：step identity 驗證太晚

來源：`goal-request.mjs:14–79,81–179` 對照 `goal-task-step.js:22–25`。

`taskId: "invalid task id"` 可以通過 public prepareGoalDispatch 與 setupScript，
到了 step helper 才報 `Invalid taskId`。尚未花 child token，但已有不必要的準備／
state setup。phase 也應與實際 consumer 保持同一份 identifier 規則。

最小改善：在既有 preparation 的共同 normalization 入口就拒絕，不另造 validator。

### F5 — P2／既知操作缺口：普通 handoff 與 Goal readiness 仍不對等

來源：`handoff-contract.mjs:29–235`、`goal-request.mjs:94–108`、
`HANDOFF-PRACTICE.md` 的額外 check-config 要求。

用隔離 project override 指定同一不存在 skill：普通 prepareHandoff 仍產生 args；
Goal prepareGoalDispatch 則拒絕。普通流程文件確實要求 parent 另跑 check-config，
因此不是宣稱其違反自身 API 承諾；但機械防線仍取決於 parent 記得選正確入口與
額外步驟，尚不能宣稱所有團隊派工都有一樣的 fail-before-launch 能力檢查。

最小改善：共用既有 readiness 結果／明確前置收據，不重複每次完整全域健檢；
無需新增能力註冊表，更不需補工具權限。

## 設定與文件狀態

### 完整健檢 FAIL，roles-only PASS

當前 cwd 下 14/14 role-contracts PASS（`roles.json`）；缺 skills 的旧阻塞確已解除。
完整 check-config 退出 1：

`unexpected active extension .../pi-gateway/index.ts`

實際 `~/.pi/agent/settings.json:66–70` 明確為 gateway 設 `extensions:["+index.ts"]`，
當前 session 也暴露 gateway 管理工具；不是舊文件中的猜測。
但本輪沒有查明其啟用的最新使用者授權／用途，**不能擅自判定為未授權啟用**。
需要使用者裁定是保留 gateway 並同步團隊政策／檢查，或恢復既定停用；本輪不更改。
完整檢查在此提早退出，後續 full-loader assertions／gate cases 未執行，不能算通過。

### 現行入口仍夾帶已失效敘述

`OPERATING-MODEL.md:46–51` 仍有「四角色缺 skills」段落，未就地清楚標示被
skills-ready 修補取代；目前已重跑證明四角色可解析。該檔 :112 的 profile 15 分鐘
敘述與 :221 的 30 分鐘敘述也不一致；實際 advisor 是 15 分鐘、其他 13 角色是
30 分鐘。不是所有角色都同一 fallback。

八份主要操作／交接文件合計 1,330 行，當中混合歷史快照與當前規則。
行數不是 token 成本證明，但已出現可指出位置的矛盾，會增加辨識／交接成本。
建議把已被取代的快照移到歷史證據，主入口只留當前狀態與連結，而非繼續追加規章。

## 五個使用者關切的判定

| 關切 | 本輪判定 |
|---|---|
| 分工不明確 | 核心角色已有清楚分界：reviewer=source/spec；QA=scenarios/evidence；e2e/verifier=執行；docs/release=限定 writer；main=驗收／授權。沒有證據應再增加角色。但成果否決由誰轉成 repair accounting 還沒接好（F1）。 |
| 交接不清楚 | schema 優先與 writer sibling acceptanceReport 已明列；recovery→completion 與 report-only→後續工作仍有缺口（F2/F3）。 |
| 工具不完整 | 所有 declared role skills/tools 設定通過。無 shell 的 QA/reviewer/security/docs/release 是刻意分權，不應一律補 shell。ordinary/Goal readiness 不同；沒有取得 live child 或任務環境全通過的證據。 |
| 執行不正確 | F2 的合法恢復被驗收拒絕已實證；F4 的晚拒絕造成多餘 setup；全域設定／政策不一致。 |
| 重工 | F1 證明典型 host-rejected repair 沒被計數。沒有實測 token/time 或首次合格率，不能聲稱修補已消除重工或加速。 |

已找到 agent-browser 命令與多個本機 Chromium cache 目錄；這只證明檔案／命令存在，
沒有啟動 browser、驗證相依性、登入、真 app journey，不能據此說 E2E 環境已驗收。
Graph 服務未索引 teams；有本地 source fallback，非阻止審查的缺工具。

## 驗證證據與邊界

- `probes.mjs` + `results.json`：6 個有斷言的離線反例情境（F2 有正反兩方向）。
  真 helper/API、真檔案 snapshot、真 host 子程序；native status/mission/state 為隔離
  fixture，runs.run 為 stub。這不是 live provider/TUI 複現或新的安全認證。
- `regression.log`：18 個既有 node:test PASS，沒有全套重跑冒充覆蓋面。
- `dispatch.log`：既有 public dispatch/native disposable state 檢查 12 cases PASS。
- `host.log`：既有 host evidence 23 cases PASS。
- `installed.log`：29 檔已知 overlays 完整性 PASS；不代表 upgrade installer 成功。
- `source-hashes.json`：本輪檢視的 helper／role／doc／相關配置與 runtime 精確來源 hashes。
- Primary LSP 對新 probes clean；session lens 無 blocking；JSON auxiliary analysis 不可用，
  JSON 以實際讀取／stdlib parse 檢查，不宣稱 JSON LSP 全乾淨。
- 未重跑會覆寫歷史 `recovery.workflow.txt` 的舊 recovery suite，改在本輪 owned
  scratch 測 producer→consumer，以免審查污染原交付證據。
- 無獨立 fresh reviewer、live Goal/TUI/provider failure/recovery canary 或真實交付成本
  量測。因此可確認上述程式缺口，不能確認整個 runtime 的所有行為。

重現：

```sh
node ~/.pi/agent/teams/goal-team-evidence/rigorous-audit-20260908/probes.mjs
PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-config.mjs --roles-only /home/timmypai/apps/vocab-agent
PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-config.mjs /home/timmypai/apps/vocab-agent
```

**probes 退出 0 代表成功捕捉當前缺口，不代表產品 PASS。** 修補後這些針對舊行為的
audit assertions 應改為 desired-behavior regression，而不是為維持綠燈保留錯誤行為。

## 建議順序（尚未執行）

1. 先修 F2 的 settled 判定，再修 F1 的 host/review 否決修復計數；保留原始歷史證據。
2. 整理 F3–F5 的同一條 preparation/reconciliation 路徑；刪除重複與過期操作敘述。
3. 經使用者裁定 gateway 政策後重跑 full health；在精確最終 source 做獨立 review
   與最小 live failure/recovery canary，再量測首次合格率、返工原因與 main+child tokens。

不建議先增加 agents、skills、controller、模型等級或一套新的 gate framework。

## 有界回顧

- Child pass、parent accepted、可以正常續作，是三個不同判定，不能共用一個 reported。
- 要測 producer→consumer：recovery 自己 PASS 不表示 completion 能消費其紀錄。
- 把預檢 PASS 的範圍說清楚；役別工具限制不等於工具缺失，設定健康不等於 live 交付品質。
