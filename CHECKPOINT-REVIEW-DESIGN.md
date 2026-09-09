# Checkpoint review：在昂貴擴展前校正方向

> 狀態：設計與 TODO 已建立，**尚未實作／啟用 checkpoint 協定**。
> 本輪只更新文件與待辦；沒有 child/model 執行，沒有修改 runtime、角色設定、
> budgets、Goal 或既有 hold/wake 修補。實作順序見下表。

## 決策：先做切片交付，不做常駐監工

採「有意義的 implementation 切片 → 固定快照 → 必要的方向審查 → 差量續作」，
而不是每幾分鐘啟動 verifier/reviewer。小任務預設不使用 checkpoint。

**目前一個 session 最多一個 active async top-level run**，見
`../extensions/subagent/config.json` 的 maxActiveAsyncRunsPerSession=1。
因此不能在 writer 正活躍時，假裝主 agent 能任意另開 reviewer workflow。
V1 先讓 writer 完成預定切片、原生 run 確認 terminal 並釋放 admission，才開下一步。
這是整體實作完成之前的早期 review，**不是同時監視活躍 writer**。

真正 writer/reviewer 並行屬後續 V2：須證明同一 native workflow 內的事件接收、
固定快照、main 仲裁與 steer 可行，且有可量測收益；本次不實作、不提高上限、
不新增 polling/controller。不能用互相等待的兩個 top-level runs 代替。

## 什麼任務適用

| 任務 | 預設 | Checkpoint 問題 |
| --- | --- | --- |
| 範圍明確的小修正 | none，完成後驗證 | 不額外開 review |
| 跨模組功能、後續大量依賴 | milestone，一個高價值切片 | 最小端到端流程／介面是否支持原始需求？ |
| 已有根因證據、修復範圍大 | milestone | 第一個修復切片是否處理共同根因，而非單一路徑？ |
| 安全／資料一致性／不可逆設計 | 必要時先設計審查 | 在昂貴擴展或外部效果之前確認不變量 |

Main 在原 task contract 寫明：為何 checkpoint 值得成本、觸發切片、所問問題、
整體 criteria、切片 criteria、刻意未完成項、允許的下一段工作。
例：整體是「登入失效可安全恢復」，切片先只交付 refresh/error path；
review 問「是否涵蓋所有 callers」，尚未完成 UI 文案不列為本次缺陷。
不能把整體尚未通過的測試說成 pass；切片完成不會完成整個 task。

## 責任與原生能力

| 工作 | 執行者 | 原則 |
| --- | --- | --- |
| 小範圍單元測試/typecheck | writer 或 main/host | 能以命令回答就不另開模型 |
| 有歧義的需求/介面判斷 | main；必要時 fresh reviewer | 一次快照、一個具體問題 |
| 複雜測試選擇/失敗判讀 | 有收益才派 verifier | 有 shell 不等於唯讀；資源須隔離 |
| 審查建議的接受/拒絕 | main | reviewer 不直接指揮 writer，不自增工作範圍 |
| 最終需求與真實入口驗收 | main/host＋風險所需 review | checkpoint 不是最終通行證 |

沿用 pi-subagents 的 status/receipt、children.list、resume 與 supervisor。
`structured_output` 會 terminate，**不拿它提交非終止的進度事件**。
非預期需求衝突可用 native contact_supervisor 向 main 問決策；這不是 review
派工請求，也不能讓 writer 阻塞等待一個因 admission 限制無法啟動的 reviewer。
若需要 early review，main 先讓切片安全結束／核對終態；必要時收回到主 agent。
單純 pause 或 supervisor 等待不視為已釋放 admission，必須看原生實際狀態。

## V1 執行順序

1. Main 決定 none/milestone 與 scoped criteria，依工作/測試耗時設定 timeout。
   一次只有一個 writer；每個切片不是重跑整個需求。
2. Writer 完成該切片，透過既有 handoff schema 回覆成果/限制/證據；沒有完成
   assigned slice 就如實 blocked/indeterminate，不為 checkpoint 偽造成功。
3. Main 確認 exact native run terminal，且相關背景寫入程序停止。保存成果與
   原始 report。若格式錯誤，沿用 [HANDOFF-PRACTICE.md](HANDOFF-PRACTICE.md)
   只修報告；不能啟動新 writer 補交 checkpoint。
4. Main/host 取得穩定來源快照與 receipt，先做能直接回答問題的必要 checks。
   Main 已能判定就不派 reviewer；否則在既有 mission 開一次 fresh review。
5. Reviewer 只讀該固定快照、criteria、已執行 checks 與指定問題。回報 findings
   和證據，不要求檢查刻意未完成的範圍，也不把作者自測當獨立驗證。
6. Main 逐項 adopt/defer/reject/needs_user 並記理由。阻塞依賴切片的真實缺陷
   先處理；非阻塞建議批次交下一切片；額外產品/權限決策仍交使用者。
7. 需實作續作時，先用 native children.list 確認最新 retained writer resumable。
   可續接才 resume；否則新 bounded slice 只接手已存成果與剩餘工作，標明原因。
   新原生 run ID/lineage 由 controller 提供。Resume 保留原工具權限，只用於
   合法實作續作，**絕不用於純報告格式修復**。
8. 最終版本核對全部 criteria 與真實入口。重驗後續改動及依賴影響範圍；
   不能證明舊證據仍適用就重驗，不拼接不同來源的 PASS。

Goal-backed 任務仍只有 main 按 [GOAL-TEAMS.md](GOAL-TEAMS.md) 操作既有
step/task。checkpoint 不是新 Goal task，review 結果不自行 clear active marker、
resume Goal 或 complete task；新 phase 只能在舊 run/source 已 reconcile 後開始。
V1 不修改 goal-task-step.js 與 hold/wake sources。

## 固定快照與最小交接資料

優先重用 native/artifact 中已有且完整的快照/patch；不足才由 parent-only helper
補上。不強制 commit、不 push、不複製整個 home；來源、untracked 必要檔、測試
資源都按任務允許範圍收集，排除 secrets。只有 diff 而缺必要 context 不算完整。

取快照必須先 quiesce writer/相關程序，並檢查捕捉前後來源指紋一致；變動或缺檔
就不派 review。摘要 checksum 本身不能把活躍目錄變成 immutable snapshot。
後續只讀 snapshot；可執行 checks 使用獨立可寫 workspace/cache、核對輸入 digest，
不得在 writer 正在改寫的 checkout 上跑測試。Worktree 不是 OS sandbox。

下列是 **main/host 保存於既有 mission/artifacts 的 receipt 資料**，不是額外的
child outputSchema；不新增常駐狀態庫，也不要求模型猜 identity/hash：

| 資料 | 來源／用途 |
| --- | --- |
| checkpoint identity、writer run/lineage | main stable key＋native receipt，去重與恢復 |
| contract/criteria、question、excluded work | main 原 task contract，限定 review 範圍 |
| source/snapshot digest、artifact references | host 實際觀察，支持固定版本審查 |
| completed slice／remaining work、evidence | 既有 child handoff＋main 核對 |
| reviewer run/ref、findings | native receipt＋既有 schema，與 checkpoint 綁定 |
| disposition、理由、適用 source、下一步 | main 仲裁；使用者需決定時保留 pending |

先保存 admission intent 才派 reviewer；同 checkpoint key／重複通知只讀舊 receipt。
不同契約不得復用同 key。需要再看同切片，須有新證據／實質變更與新決策，不能
為格式錯誤換 key 偷重派。這是 single-owner 協定，不宣稱跨 session CAS。

## 失敗與過期建議

- Snapshot 不完整或過程中變動：拒絕 review admission，保留現有成果。
- Reviewer timeout／格式錯誤：保存 receipt，main 核對／局部修報告，不重做實作。
- Main 重啟：先讀既有 native run/receipt/source，不重送同 checkpoint。
- 建議對應的 source 已過期：不自動套用、不直接丟棄；main 判斷問題是否仍成立。
  阻塞缺陷未釐清前，不能因「過期」就放行依賴工作。
- 沒有可用的 resume：只續作剩餘 slice；未知/仍活躍 writer 必須先 reconcile。
- 過程 review 合格：只涵蓋那個快照與問題；最終驗收權不變。

## 實作 TODO 與驗收

待辦以 `/home/timmypai/.pi/todos/` 中的工具記錄為準；此表是設計索引，非新排程器。

| 順序／TODO | 修改範圍 | 完成條件 |
| --- | --- | --- |
| CP1 `TODO-2f35c2eb` | team-flow、team-member、相關三角色契約 | none 不加角色；milestone 有收益/切片 criteria；不加 schema 外欄位 |
| CP2 `TODO-7615cdb7`，依賴 CP1 | 既有 artifacts/mission 的最小 parent 快照與 receipt 支援 | 固定來源、必要 dirty/untracked 完整；不穩定/缺檔拒絕；重播不派工 |
| CP3 `TODO-8d988c2a`，依賴 CP2 | 原生切片 review→main 仲裁→差量續作整合 | 不同時開第二 top-level；stale/duplicate 不自動套用；不重做、不假 complete |
| CP4 `TODO-bf9ec111`，依賴 CP3 | 零模型 regression＋經另行授權的真任務 canary | 失敗/恢復全覆蓋；既有 handoff/gate/goal/hold/config 不退化；live 缺驗明列 |

CP2/CP3 先檢查原生能力；若不足需改第三方 runtime，停下回報最小缺口與新範圍，
不得私自增 extension/provider/權限或另寫 controller。安全 review/回歸依實際
修改風險安排；本次 main-only 不構成未來 live child 的授權。

實際收益看總 token、端到端時間、首次符合需求與具體避免的返工；不能取得的
usage 標 unknown。單次 canary 只提供觀察，不證明通用加速。無收益則維持 opt-in，
不加固定 checkpoint；沒有證據前不展開並行 V2。
