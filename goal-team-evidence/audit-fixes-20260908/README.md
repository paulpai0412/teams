# Agent teams audit fixes — 2026-09-08

**TODO-50ccf1d3：離線實作與機械驗證完成；整體運作驗收仍 PARTIAL。**
主代理單獨實作；沒有模型 child、live Goal/mission 修改、依賴安裝、角色／模型／工具／
權限變更或部署。Gateway 設定未改。來源：上輪 rigorous-audit-20260908 的六個反例。

## 修正

| 項目 | 實作／驗收 |
|---|---|
| F2 恢復與完成不一致 | host-evidence 的 `goalStepSettled` 供 recovery producer 與 host/runtime final acceptance 共用。要求 requestDigest-bound terminal recovery，接受 recovery.childRunId；throw/final-save failure 不須把原 runId/status/outcomes 改成成功。只有 runId、只有清 marker、foreign request/child 或缺 proof 均拒絕。 |
| F1 host 否決不計修復 | 同 task/role 的每一前序 step（包括 reported）需 parent disposition。continue=0 repairs；retry=1；captured product pass 被 host/review 否決時另需 parent 指定非空 rejection artifact/hash。第四次修復拒絕；四次真正成功的切片可繼續且 repairs=0。 |
| F3 report-only 交接 | 維持不授予新 launch；錯誤明確要求 main 完成本地報告處理後再作 continue，才能做真正的新工作。這是澄清／改善收尾，不放寬報告問題不可重跑 writer 的規則。 |
| F4 晚拒絕 | Goal 共同 normalization 早驗 taskId/phase；public preparation 在 readiness、保存與 setup 前拒絕。 |
| F5 readiness 不對等 | 把既有 selected-role check 移到 prepareHandoff；ordinary 與 Goal 共用一次，Goal 不再重跑一份。保留 shell/classification、角色模型與缺 skill 的 fail-closed。 |
| 文件漂移 | 同步五份 team 操作文件與 team-flow，明確「helper 已預檢，不另重跑」；過期 skills 快照標示已取代、舊配置區標示歷史；修正 advisor 15 分鐘／其餘13角色30分鐘的 fallback 敘述。 |

沒有新增 controller、task store、schema framework、角色或命令 runner。Native workflow sandbox
不能 import host modules，因此 step admission 保留有界欄位檢查；producer→consumer 回歸
核對其與共用 settlement 的相容性。Child reported、terminal settled、parent accepted 仍分開。

## 操作變更與邊界

- 原先成功後手動清 active marker，改用既有 `goal-recovery.mjs` 準備的零 child
  state script。正常繼續使用 continue，不需要編造失敗理由，不消耗 repair 額度。
- `rejection` 是 parent 核對 host failure／獨立 review finding 後指定的絕對檔案路徑。
  非空 regular file 的 bytes 會被 hash，credential／symlink／過大檔案拒絕。
  **存在一個檔案不是語意否決的證明**；主代理仍負責判斷，不能製造假 rejection
  把報告格式失敗變成產品修復。成功 safety receipt 仍依原 scope 驗 freshness。
- 已有有效 host receipt 可直接 verify/reuse。沒有增加每步 verifier child 或重跑全套測試。
- Recovery 保留原失敗與 unknown；final acceptance 還要檢查當前全部 criteria、必要
  evidence 與 source。歷史 terminal settlement 不要求用新 source 重跑歷史命令。
- Report-only 只限制執行授權，不代表產品接受；是否可以最終交付仍看 parent 的完整
  criteria/evidence。若要下一步執行，需在報告處理完後作 explicit continue。
- 原生 state 為可信 parent-owned 本機資料，不是 WORM／簽章／跨 session CAS。
  preparation→apply 非原子，必須遵守既有單 owner 與 fresh source/native 核對。
- 這是 supported Goal helper／registered evidence gate 的防線，不攔截 direct native
  calls、任意 parent state edits，亦不能自動判斷語意或替使用者授權。

## 相容性／生效

已同步已安裝 `pi-goal-x/extensions/goal-team-evidence.mjs`，與 host-evidence bytes 完全一致。
套件版本不變；**runtime consumer 需新 session/reload**，本輪未偷偷重啟現有 session。
Helpers 下次呼叫即讀新來源。

既有歷史不改写：缺 requestDigest-bound recovery 的 reported/blocked/dispatching 紀錄，
現在需透過 recovery 明確核對，不能只清 marker。合法 saved packets 可讀；缺原 scope、
缺 native identity 或舊 count-ledger 仍保持 blocked，不能猜補歷史／重置額度。
這是收緊的安全相容性要求，不宣稱所有 legacy missions 已自動遷移或可直接完成。

## 驗證

- `all-tests.log`：**40 node:test PASS**：12 新行為回歸＋28 既有案例的當前副本。
  其中三份 legacy consumer fixtures 補上新 parent disposition/request binding，
  report-only assertion 改成新可操作錯誤；不覆寫原 historical tests/outputs。
- `reconciliation.test.mjs`：真 helper/API、native disposable mission state、實際
  host 程序與 evidence gate。runs.run/terminal native status 為 fixture，零 model。
  測 throw、final record save failure、foreign proof、四成功／三修復、report-only→continue。
- 同一測試可切換已安裝 runtime consumer；`runtime-consumer.log` 明列結果。
  `goalEvidenceBlockReason`（真正 Goal evidence 消費者）也被同一恢復案例觸發。
- **50 個已 reconcile 的成功切片：57,691 bytes**，低於原80KiB測試上限；1張host
  receipt 重用，沒有為每次 continue 重新執行命令。這不是 live token/time benchmark。
- 六個未改的原檢查：**194 cases PASS**（dispatch12、storage8、handoff43、outcomes54、
  host23、Goal/team54）；個別 `check-*.log`。舊storage的50-task fixture不代替上面的
  新50-slice reconciliation容量檢查。
- `completion-evidence.log`：**33 cases PASS**，真 completion entrypoints/native GoalService
  在 disposable Goal 檔案及 turn-buffer boundary 驗證；fake auditor，不動現有 Goal。
- `hold-wake.log`：**30 cases PASS**，原 hold/runtime/notifier fixtures；非 live TUI。
- `roles.json`：14角色 PASS；`protected-unchanged.json`：14 profiles＋main settings hashes 不變。
- `installed.log`：**49檔**已知 chronological overlays／來源核對 PASS。
  `installed.test.mjs` 於完整隔離副本修改一 byte，checker 正確拒絕；不 tamper live source。
- RED logs：f2a 真舊行為、f2b 不可變 preimage consumer、f1 admission／recovery、f4、f5。
  GREEN 與最終 logs 分開保留。F3 是 error guidance／既有 continue 收尾的澄清，沒有
  假稱原本不支援 continue。
- 17個JS/test檔案 Primary LSP clean、session lens 無blocking；step/recovery 的 native
  workflow syntax validate 均通過，記錄於本輪 session；
  JSON LSP 曾不可用，metadata 用 stdlib/實際checker解析，不宣稱 JSON LSP 清潔。

`recovery.workflow.txt` 只是隔離 fixture 產生的 syntax evidence，其來源目錄已清理；
**不得拿它對 live mission 執行**。真恢復須從當前 native/source 收據重新準備。

```sh
node --test ~/.pi/agent/teams/goal-team-evidence/audit-fixes-20260908/*.test.mjs
node ~/.pi/agent/teams/goal-team-evidence/audit-fixes-20260908/check-installed.mjs
```

## 未完成 gate

1. REQUIRED fresh independent review/security judgment 與 live Goal/TUI/provider recovery
   canary 尚未執行。本輪無 child；offline tests 不是獨立審查或 live 可靠性認證。
2. 完整 health 仍在 pi-gateway 啟用／既定停用政策不一致處 FAIL（`global.log`）。
   未查明最新授權／用途，不自行改設定，也不把失敗檢查改成 PASS。需使用者裁定。
3. 沒有真實 time-to-accepted、main+child token、首次合格率量測；不宣稱已測得加速。

因此 TODO 保持未結案，不能把 offline implementation completed 宣稱整個 teams 完全可靠。

## 備份／回復

`before-manifest.json` 保存修正前 scoped inputs，`manifest.json` 記錄 **23個 changed/new**
source/doc/test 檔案的 pre/post SHA-256；`before/`、`after/` 與 `changes.diff` 保留對應。
README與logs是驗證材料，不是此source manifest的一部分。

回復前先停止／核對自己的相關 runs。每一 target 必須仍等於 postSha256，否則停下來
核對後續變更。將6份source（含runtime mirror）與6份操作文件作一致組合回復，
不可只回復其中一個consumer；新evidence下的測試可保留作歷史，但不再代表回復後行為。
不重置Goal/mission/recovery歷史或設定。回復runtime後同樣需reload。

`check-installed.mjs` 沿用原 chronological checker，只延伸 skills-ready／audit-fixes
兩層manifest；原wrappers與舊證據不改。它是read-only continuity verifier，**不是**
新installer、upgrade或rollback transaction，也不授權跳過舊wrapper的hash mismatch。

## 有界回顧

- 優先測 recovery producer→真 acceptance consumer，不能分別 PASS 就當流程可用。
- Parent terminal reconciliation 已是必要步驟；把成果 disposition 放進既有收據，比
  依 child pass 猜測或另造 scheduler 更小，也能區分正常進展與返工。
- 保存舊測試／快照，在本輪副本修訂明確變更的契約，避免把改fixture或更新hash說成
  live能力改善；失效範圍與未完成gates要一起交接。
