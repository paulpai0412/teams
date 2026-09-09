# 獨立靜態審查與主代理裁定

使用者選擇獨立審查；實測由使用者手動進行。本輪沒有修改產品/helper/runtime/config/test來源，沒有執行實測、掃描、利用或安裝。

## 結論

兩個 fresh、唯讀 Terra high reviewer 完成。未發現 P0/P1；不是保證不存在，也不是 live PASS。
Standards 未發現另一本次新增違規；F1–F5 的程式與針對性測試靜態上相符。
仍有一項有效 P2 恢復缺口待修，一項既有 P2 防禦性強化可另排；TODO-50ccf1d3不結案。

## 正確性／Spec：R1，P2，有效、待修

`goal-task-step.js:144–146` 先寫 dispatching record，再寫 budget、active marker；`runs.run` 在191行之後。
第一筆成功但後兩筆任一失敗，便有 durable intent、沒有 child launch。
同key重送只回reconcile；`goal-recovery.mjs:31–36`要求唯一terminal child，故此零child情況無法用支援的helper恢復。
`host-evidence.mjs:442–488`又要求所有歷史step有合法recovery，因此手動清marker也不能解決。

這是一般儲存錯誤的控制流程缺口，不是惡意parent偽造state。現有final-save regression只涵蓋launch之後的寫入失敗。

**修正reviewer的歸因：**原報告稱本次新增budget write擴大窗口，但baseline
`audit-fixes-20260908/before/23-goal-task-step.js:135–137`已有完全相同三筆await。
主代理直接比對確認，應記為**既有缺口，不是本次新增／擴大**。原報告保持原樣，裁定另列。

建議下一個最小修復：在現有recovery/settlement契約內明確處理「已證明未嘗試launch」的終態，不刪歷史、不改成產品成功。
**僅steps為空或找不到status不構成無launch證明**；設計時必須有精確workflow/request與可靠終止／launch邊界證據。
回歸應分別注入budget及marker寫入失敗、證明runs.run未被呼叫，並涵蓋unknown/missing native evidence仍拒絕。
這只是修復建議，本輪未實作或執行該回歸。

## Security：R2，P2，既有防禦性強化、非已證實child漏洞

`goal-recovery.mjs:9–15`先realpath/stat，再以pathname readFile，存在check/use競態。
此reader與修補前完全相同；新rejection evidenceDigest則已使用host的FD-based bounded reader。

主代理接受「reader不一致／存在競態窗口」的來源事實；**不將條件式攻擊敘述當已證實的受支援child漏洞**。
它需要其他principal可同時改寫parent-native證據，review沒有證實此權限或child-only路徑；任意直接改mission state也超出既定信任模型。
因此列為可排程的防禦性強化，不因它宣稱新P1或否定所有F1–F5修正。
建議沿用現有FD reader的邊界，避免重造讀檔框架；FD reader本身也不是WORM/不可竄改保證。
實際權限與競態利用未測，日後若發現child可寫證據的正常路徑，需重評嚴重度。

## 專案override信任邊界

安全review提出project-local設定有最高precedence。已明確答覆：必須由parent檢查／批准effective profiles、skills、prompts與extensions，才是可信control-plane。
Readiness成功不等於repository可信或使用者授權；任意不可信checkout需要另行批准的隔離、無憑證runner。
此為既有操作限制，本轮沒有把未知repository批准成可信。

## 證據與範圍

- `correctness.md`、`security.md`：未改寫的原始報告。
- `contract.md`、`source-pin.json`：精確baseline/candidate、權限與非目標。
- `preflight.json`：兩角色的selected-role readiness PASS，不代表全域health。
- `parent-checks.json`：審查後23檔hash仍與審查前一致；三寫入序列與reader的baseline核對。
- `native-status.json`、`native-workflow-receipt.json`：終態與原始交接連結。
- workflow `878636f9-7309-468b-8557-6912e5e16d17`；mission `87aaf033-d797-4962-9b5b-7fb8e60ff731`。
- correctness child `b17e0be8-ad75-42e3-ae67-9a673c3fdc1b`；security child `969a8f8a-f5d4-4340-9435-08437c0e7a9a`；兩envelopes ok=true/terminal completed僅表示審查執行完成。

没有為排版重派child或重跑writer。兩個獨立視角帶來一個有效恢復缺口，也包含一個需由main更正的歷史歸因；這正是不能只轉貼review verdict的原因。
獨立審查證據現在已補上，但未修缺口、使用者手測結果與gateway政策裁定仍待處理。不把審查mission完成當產品/整體TODO通過。
