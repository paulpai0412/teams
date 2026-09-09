# R1：派工前保存失敗的安全收尾 — 2026-09-09

使用者「開始修正」後，main-only完成R1離線修正。R2讀檔強化不在本輪。
沒有模型child、live Goal/mission變更、實測、安裝、權限／設定調整。手測仍由使用者負責。

## 最小修復

- `goal-task-step.js` 把三個派工前state.set包在同一catch。只有此尚未進入runs.run的分支，才嘗試保存`status: unlaunched`，並重拋原始錯誤。
- 使用比dispatching更短的狀態且不額外塞error文本，讓已成功寫入intent的state在quota滿時仍可保存正面證明。原錯誤照常拋回native workflow，不冒充成功。
- `goal-recovery.mjs` 要求此正面標記、原request/mission綁定、terminal native workflow、明確steps陣列且無matching child、fresh host證據，才產生`recovery.noLaunch:true`。不能因missing status或steps為空就推定沒launch。
- host與已安裝runtime consumer、next-step admission都認識相同分支。原失敗狀態保留；正常已launch紀錄不能借noLaunch旗標過關；同key永不重派。
- 收尾可把尚未建立的active marker正規化為null，但既有「另一個active intent」仍先拒絕。continue/retry由parent決定，既存repair計數不退還／重置。
- 沿用既有資料格式、controller與native state，不新增runner、scheduler或依賴。

## 明確限制

若catch證明也存不下（例如持續I/O失敗）、catch前進程被殺，仍保持unknown/blocked。既有無正面標記的歷史dispatching不能自動猜補。容量滿時還需先安全處理容量才能存recovery；不能刪歷史或重置計數繞過。
此協定仍假設可信單parent與真實原生收據，非CAS、簽章或不可竄改證明。

## 驗證

- `red.log`：舊程式的兩個目標案例失敗；`green.log`：首次修正後兩案例成功。
- `final-tests.log`：47 tests PASS（7個新scenario＋原39個回歸＋新overlay測試）。
- 新scenario涵蓋budget/marker失敗、真正native state 256KiB配額失敗、marker提交後拋錯、證明保存二次失敗、已嘗試launch但零child收據、缺失/active/conflicting/stale證據及消費端假noLaunch。
- 正向走真prepareGoalRequest→workflow body→disposable native MissionWorkflowState→prepareGoalRecovery→sealAcceptance/goalEvidenceBlockReason；只有model runner/status是fixture。無live模型或Goal。
- `runtime-final.log`：相同7scenario切換已安裝runtime consumer PASS。
- `completion-final.log`：33個真正completion入口／disposable GoalService案例PASS，fake auditor。
- `goal-team.log`：54個既有Goal/team案例PASS。未無差別重跑全域健檢／其他無影響套件。
- 8檔primary LSP clean，session lens無blocking；native step及no-launch recovery workflow語法驗證均PASS（本輪tool紀錄）。
- `installed.log`：53檔chronological overlay核對PASS；`installed.test.mjs`只在隔離副本改一byte，正確拒絕。
- `final-source-check.json`：9 changed/new source/doc/test檔與postimages一致；14 profiles＋settings 15個hash不變。

## 生效／回復

已安裝mirror與host hash相同：`dbd847ae5dbd29b561e737cc7cee3cb5e62b015e51e2357c5a67d38888022a25`。
需新session/reload runtime；本輪未重啟現有session。普通helpers下一次讀新來源。
`GOAL-TEAMS.md`已補分支契約與當前checker位置。

`manifest.json`、before/、after/、changes.diff保留5個修改檔（4source＋1doc）及4個新增檢查檔。
回復前確定沒有相關active runs且每個target仍等於postSha256，再一致回復4source/mirror與doc；不要回復使用者設定或mission狀態。若已有unlaunched紀錄，舊consumer不支援，須先核對處置；不能抹掉歷史。
新check-installed只在既有chain加本層，不是installer。舊checker拒絕新hash是正常，不放寬。

## 證據管理疏失（如實保留）

首次回歸不慎直接執行舊`audit-fixes-20260908/legacy-recovery.test.mjs`，覆寫其產生的`recovery.workflow.txt`診斷fixture。原hash ledger、logs與test/source檔未改；詳見`historical-fixture-note.json`。舊路徑現在不能作原始exact syntax證據，不偽造還原。後續改成本目錄副本，生成只留本輪。這不影響source overlay核對，但歷史診斷artifact完整性有此缺口。
本目錄*.workflow.txt同樣只是已清理scratch的語法材料，不得拿去操作live mission。

## 驗收狀態／下一步

R1目標離線回歸通過；本次delta尚未經新的獨立review，先前review只適用前一版。
使用者手測尚未回報；R2防禦性讀檔強化及gateway政策仍待處理。TODO-50ccf1d3不整體結案。
教訓：由launch前的正面控制流程保存小證明，比用缺失收據猜測安全；error proof要能在quota失敗時容納；重跑歷史tests前檢查artifact寫入路徑並先用本輪副本。
