# Teams：以使用者成果驗收

這是現有 team-flow 的交付方法，不是新 controller、task store 或語意驗收引擎。
主 agent 負責判斷；pi-subagents 執行角色；只有明確使用 Goal 時才用 goal-x。

## 1. 開工前：成果定義

在既有 mission artifact／Goal task 的驗收內容中填寫以下短表，不另建任務系統。
小任務可直接寫在交接中，不必建立檔案。已有清楚需求就沿用，不重問。

| 項目 | 要寫什麼 |
| --- | --- |
| 使用情境／問題 | 誰在什麼情境無法完成什麼事；不是先指定技術解法 |
| 成功行為 | 用代表性輸入操作後，應看到的結果；不是「實作完成」 |
| 驗收入口 | 真實 CLI／API／UI／資料流程、輸入、環境及預期結果 |
| 邊界 | 這次不做什麼；有意義的錯誤／空資料等情境按風險選取 |
| 尚待決定 | 影響正確性、權限或產品方向的未知；主 agent 不擅自決定 |

例：不是「增加 cache」，而是「使用者在指定資料量下查詢時，等待時間符合已確認門檻，且更新資料後不回傳舊結果」。門檻未知就確認或先量測，不能捏造數字。
不強迫事前預測檔案、agent 拓撲或所有測試。高風險未知先做有界探索／可操作預覽；需求重大變更由使用者確認，保留原判斷及變更原因。

## 2. 驗證時：走真實入口

### 先確認能驗，再限定修復聲稱

在實作前確認所需入口與環境可用（細則見 HANDOFF-PRACTICE.md）；若沒有使用者的問題輸入／畫面，代表性 fixture 只能證明該情境，不能宣稱已重現或解決使用者的特定問題。明列哪些是已證明的根因、哪些只是候選改善。

完成宣告必須分開標示：來源／建置、已安裝版本、寫入結果、最終狀態與意圖比對、實際渲染／互動。只列本次適用的項目，不把它變成固定執行流程。前一層成功不能代替後一層：write 成功不等於說做一致，SSR 不等於可讀，prompt 指引不等於 runtime 強制。採用提示規範時明說其性質，不宣稱已實作驗收 gate。


主 agent 把同一成果及驗收情境帶入每次派工。實作者可改方案，不可自行降低成功條件。
主 agent／host（或確有收益時的 verifier／E2E）依授權執行實際入口並記錄：輸入、環境、預期、觀察、command/cwd/exit 或操作步驟、原始證據位置、來源狀態。
無法取得必要環境／資料／權限就記 indeterminate；不靠 mock 代替未完成的真實驗證。
單元／mock 測試仍有價值，但只能支持其實際範圍。無使用者入口的內部修改，用真實 caller／integration seam 驗證並說明適用性，不硬加 browser 關卡。

- CLI：實際執行交付命令並確認輸出與錯誤行為。
- API：確認結果與副作用；HTTP 200 本身不代表需求滿足。
- UI：完成使用者操作；截圖只是證據之一，不代表功能成功。
- 分析：核對資料範圍、單位、方法與結論；有圖不等於分析正確。

只執行已批准的可信命令／操作，不自行使用 production 資料或擴權。測試可能寫 fixture/cache，與 writer 隔離或串行。
主 agent 在驗證前及結案前，核對實際 commit、dirty diff、相關 untracked 產物與交付版本；修正後受影響證據失效。不能只比較 child 回報的同一個 sourceState 字串。
Reviewer 從來源與原始證據挑戰「這是否真的支持需求」，不只是附和 verifier；沒有親自執行，就說是查閱操作證據，不能宣稱自己重跑。

失敗先判斷是需求理解、實作、驗證情境或環境問題，再決定修復、補證據、diagnose 或詢問使用者。不新增固定角色順序；沿用既有有界修復規則。

## 3. 交付時：逐需求判定

在既有交付報告中列出：

| 需求／預期行為 | 真實入口／實際觀察 | 證據與來源版本 | 判定／缺口 |
| --- | --- | --- | --- |
| 逐項沿用已確認 criteria | 如實記錄，不用「已測試」代替 | 可查閱位置，不貼秘密 | met／not_met／indeterminate／needs_user |

- met：主 agent 查閱相關證據後，確認支持該項需求；不是 child 自評即可。
- not_met：觀察到不符合需求。
- indeterminate：未執行、缺環境、證據不足／過期，無法判斷。
- needs_user：偏好或產品接受度仍需使用者確認。保存其針對這個版本／範圍的實際決定；不能從沉默或允許執行推定接受。

若因工具／角色故障降級執行，保留原驗收條件與未完成的必要證據；降級只改執行方式，不降低成果標準。來源修改已完成而必要入口未驗時，只能交付部分成果。任何必要項目未 met，不把整體 Goal/task 標 complete。可以交付部分成果，但逐項保留缺口與下一步；不把可客觀驗證的工作全丟回使用者。
這是交付證據表，不是另一份 task registry，也不是發布授權。

## 現有 gate 的小幅強化

`gate-candidate.js` 是可選 verifier＋review 流程，不是每次修改必跑。
`teamCandidate` 除 task/sourceState/criteria/validationCommands/evidencePaths，
另需主 agent 選定 timeoutMs、validationLocation（child-safe 或 isolated-only）；
後者另需 validationResource。Parent-only checks 不交 child。
criteria 為唯一、非空的字串，應寫成上面的可觀察行為。
Helper 先保存 intent／驗證 receipt，重播只回 reconcile；不要因報告格式失敗
重做工作。不同消費者的 schema 與報告修復方式見 [HANDOFF-PRACTICE.md](HANDOFF-PRACTICE.md)。
Verifier 和 reviewer 的 structured output 現在另需 `criterionResults`，每項恰好一列：
`{criterion, status, entrypoint, observed, evidence}`。criterion 必須與输入原文相同；所有項目為 met、證據／觀察非空且原 gate 條件成立才 pass。
舊式只有總 verdict 的報告會 blocked；不要從舊報告自動補造逐项觀察。遇到 needs_user 時，由主 agent 取得對應決定後，以新驗收 step/source packet 重評；不能覆寫舊 stable key 或手動把 gate 改 pass。

**硬檢查只驗證報告完整性與一致性。** 不自行執行命令、hash checkout、驗證證據內容或裁定主觀滿意；無法阻止模型填寫形式完整但錯誤的報告。主 agent 仍需直接查證。此 helper 不是不可繞過的全域 completion hook。

無模型回歸（實際載入 helper，使用 fixture reports）：

```bash
node ~/.pi/agent/teams/check-team-outcomes.mjs
```

實際效果看使用者退回重做、交付後不可用、驗證缺口及無效修復是否減少，不看 agent 數或通過關卡數。本次沒有進行模型／真人 E2E，不宣稱 outcome 品質已提升。
