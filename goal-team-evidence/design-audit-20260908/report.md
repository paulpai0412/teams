# Agent teams × Goal-x × pi-subagents：以更快交付正確成果為中心的設計檢視

日期：2026-09-08。範圍：現行全域 team 契約、角色 discovery/skills、Goal helper、handoff/gate helper、已安裝的 Goal completion/hold 及 subagents mission state 實作、既有整合證據。

本轮 main-only；沒有啟動模型 child、修改設定／角色／正式程式、操作任何 Goal 或發布部署。只新增本報告、離線探針及來源指紋。沒有做全套第三方 source 安全稽核或 live TUI/model E2E。以下調整均為建議，尚未核准實作。

## 結論

現有三方分工值得保留：Goal-x 管目標／成果 task／使用者 focus；main 管意圖、派工、授權與驗收；pi-subagents 是唯一 child controller，mission/receipts 管執行恢復。不要再加 controller、任務資料庫或必跑角色鏈。

主要改善方向不是更多規則或更贵模型，而是減少模型處理機械協調的工作、消除卡住與重做路徑，並在真實任務量測 time-to-accepted。這是設計判斷，不是已量得各項延遲占比。

## 本輪實際查驗

- 已安裝 pi-goal-x 0.30.5、pi-subagents 0.64.0。
- hold/wake patch `apply.mjs --check`：COMPATIBLE/post；只證明磁碟來源相符，未證明目前 parent 已載入该版本。
- `check-goal-team.mjs /home/timmypai`：53 cases PASS，mock runs/state；無 live child。
- `check-goal-hold-wake.mjs`：26 cases PASS，真實 installed classes/notifier＋隔離 session/status fixtures。
- 選用 debugger/implementer/verifier/reviewer 的角色預檢 PASS，見 selected-roles.json；不是全域健康證明。
- 原生 agent list 列出 14 個 executable profiles，但完整 role check 在 docs 先失敗。另以原生 discoverAgents/resolveSkills 逐角色收集，發現下列四個角色有未解析 skill；不可把 executable 標籤當作 launch-ready：

| Role | 未解析的必要 skill |
| --- | --- |
| team.docs | docs-generator |
| team.e2e | browser-automation |
| team.release | supply-chain-security |
| team.security | code-audit、llm-security、supply-chain-security |

其餘角色本輪 skill resolution 無 missing，不表示其環境、登入、browser executable 或真實任務均可用。2026-09-07 的 skill-catalog.json 也沒有上述五個 skill 名稱；尚未做整個 filesystem 搜尋，不能斷言所有安裝目錄都沒有它們。

## 優先調整項目

### P1-1：修 completion observation 失敗後的 stale hold

來源：`pi-goal-x/extensions/goal-team-hold.ts` 的 onNativeCompletion / shouldHold；`goal-events.ts` 的 reconcileTeamHold。

已用真实 class＋隔離狀態檔重現：先建立有效 active binding → completion event 到達時狀態檔暫不可讀 → 檔案恢復並明確為 complete → inspectGoalTeamRunStatus 回 terminal，但 shouldHold 仍 true。onNativeCompletion 遇 unknown 保留 binding，而一般 reconcile 只檢查 Goal/task/context，没有重新核對 run status。完整 reload recovery 或 context 失效不在本探針內；這不是聲稱已見到真實 production 卡住。

最小方向：在既有 native 通知後的 parent reconciliation／相關生命週期轉折，做一次 exact targeted status reconciliation；confirmed terminal 釋放 hold，unknown 明確回報 reconcile_required，不能當完成、不能自動重派。不要用永久 polling、放寬 owner identity 或新增第二 wake notifier。

驗收：status 暫缺／事件順序／重複通知後不永久等待、不誤釋放其他 run；native notifier 仍唯一 wake，未知執行不重播。

### P1-2：縮小 mission state，而不是放大容量上限

來源：`teams/goal-task-step.js:27-36,70-75`；`pi-subagents/src/missions/workflow-state.ts:13,249-254`。

現行每個 goal-step record 保存完整 task/request/report，且文件要求保留所有旧 step。原生 mission state 上限為 256 KiB。探針使用真 helper＋真 state store＋fake child results，8 KiB task packet，28 steps 成功，第 29 step 寫入超限（267747 bytes），留下 `goal-step.t29.review.1` active marker。

最小方向：state 留 stable key、request digest、native run/receipt/artifact reference 和 reconcile 狀態；完整 packet/report 放既有 artifacts。保留歷史索引與必要 durable evidence，不丟失去重事實。派工前檢查可保存 intent，避免先寫 active marker 才發現容量不足。不先把 256 KiB 任意改大。

驗收：多 step 長任務仍能 dispatch/reconcile；容量或保存失敗發生在 child 啟動前；舊 key 不重派、報告格式失敗不重做。

### P1-3：把 launch-ready 與 inventory 分開，一次報全缺口

來源：`teams/check-config.mjs`、四個有 missing skill 的 team profiles；原生 `pi-subagents/preflight`。

保留 selected-role admission；完整 health 一次彙總全部角色問題，不在第一個 assertion 就讓其他缺口不可見。優先查既有可用指引、解析路徑或經審查的角色需求，新增／替換 skill 需使用者核准。不得為通過而取消 security/E2E 等已列 REQUIRED 的證據。

普通 launch 可優先評估重用原生 `resolveSubagentLaunchContract`，减少自行重建私有 parser/loader；本地 checker 留團隊政策差額。此 public preflight 不會證明 browser/login 或任意命令安全，仍需 task-relevant readiness。

驗收：未派模型前就清楚知道可用角色與缺環境；selected 成功不冒充全域成功。

### P1-4：讓 Goal completion 與 team 證據接得上

來源：`pi-goal-x/extensions/goal-completion.ts:37-46,62,158-185`；`goal-policy.ts:93-98`；`goal-settings.ts:628-631`。

completion 目前直接讀 project settings；全域 disabled 不能單獨保證此分支跳過 auditor。auditor 停用後也不會讀 teamGate/native receipt。pending task 只有 blockCompletion=true 才會擋住 Goal completion。現行 team 合格判定主要仍靠 main 操作契約，不是全域硬 gate。

最小方向：統一 completion 使用有效 settings resolver，尊重明確 project/per-goal 使用者選擇；新 team-backed task list 明設 block_completion:true（不偷偷更改舊 Goal）。對已明確綁定 team 的完成操作，加入狹義、零模型檢查：未 reconcile run、必要證據缺失、來源過期不得 complete。沿用原生 receipt 與 main 的驗收決策，不要求再跑一個 auditor，也不宣稱程式能判斷語意真偽。

驗收：新專案不意外啟動第二模型 auditor；未完成 tasks／執行未明／來源不符／缺 REQUIRED 證據不能因一個 complete 呼叫結案。

### P2-1：縮短 handoff 介面，保留動態路由

現行 main 須協調 teamGoalBinding、teamGoalRequest、teamGoalActiveStep、goal-step records、extensionBindings 與 native receipts。Goal helper 只支援一角色新 launch；沒有原生 retained resume 或有界 fanout 分支。hold 又綁定特定 helper 的絕對路徑。因此普通 handoff、Goal step、candidate gate 是三種需分別記住的用法。

先整合已有 helper 的 request 準備／receipt reconciliation，讓機械欄位由 host 派生；main 只提供真正需要判斷的 outcome、scope、role、checks。不強行合併不同 consumer 的 schema，不要求模型回填已知 identity/hash。若真實任務顯示有收益，再讓同一 Goal task 執行一個 bounded wave（內部使用原生 runs.all 或 retained resume）；仍一個 top-level active run、一個 writer、一個 owner，不提高現有 ceilings。這是按證據擴充，不是先造通用 workflow engine。

### P2-2：減少重複驗證與 context，保留會抓錯的檢查

- 小而清楚：main 直接修＋一個 regression；不為流程派 planner/verifier/reviewer。
- 一般 delegated change：一個 writer → main/host 精準機械驗證；有 shared/lifecycle/high-risk 才加 fresh review，依風險加 security/E2E。
- 困難 bug：debugger 用於重現與因果證據，之後 writer 消費同一 repro；不要各角色重新摸索整個 repo。
- Main 驗證來源與原始 log，不等於無條件再跑 writer/verifier 已經執行的每條命令。只有 source/config/environment/測試輸入仍適用的 host evidence 可重用；無法確認就重驗，child 自稱測過不算。
- checkpoint review 保持 none/milestone；昂貴擴展前一個有價值切片即可。不先實作常駐監工或活躍 writer 旁另開 top-level reviewer。
- 常用指引只留現行契約；歷史快照移到 evidence。OPERATING-MODEL 同時寫 profile 15 與 30 分鐘，實際本輪 profiles 為 1800000ms；應統一，避免 main/child 反覆解讀過時規則。

驗收：必要測試與獨立證據不減少；模型 round trips、重讀與格式返工减少。未知收益不可宣稱已加速。

### P2-3：用真實交付作比較，不先調整模型或擴大併發

以後續經授權的真實任務收原生 receipts：需求確認到合格交付耗時、main+child tokens（未知值保留 unknown，不重複加總 aggregate 與 child）、首次符合需求、返工原因（意圖／實作／環境／格式／恢復）、錯誤完成及重複執行次數。

先看少量任務的逐案差異，再累積足夠可比較樣本看分布；單次 canary 不證明一般性加速。不因角色數多、mock PASS、多跑 review 就說品質更高。現有模型分級先不動；ordinary profiles scope 仍照使用者政策，沒有新 provider 或自動 Astra fallback。

## 建議執行順序

1. 先修 stale hold／state 成長與角色 readiness，補對應回歸。
2. 統一 Goal settings/completion 入口，保留最小結案檢查；跨 extension lifecycle 變更需獨立 review，真實 canary 另經授權。
3. 在一個真實任務試精簡交接與精準驗證，量出 coordination/repair 成本。
4. 再決定是否值得做 checkpoint 支援、Goal wave 或少量 model 升級；沒有收益就不做。

## 證據與限制

- `probe.mjs`：可重跑的隔離故障／容量測試；只在自建 temp 目錄寫 fixture，finally 清理。成功退出表示重現現存缺口，不是產品 PASS。
- `probes.jsonl`：本輪探針原始結果。
- `selected-roles.json`：四個選用角色的現行預檢結果。
- `source.sha256`：受檢關鍵 source identity；將來修正後必須另跑，不能沿用本輪證據。
- 本輪 lens mode=all 初次為 cache-empty，之後 JSON 工具 unavailable；未做 source 修改，不把診斷空集合當專案／安全驗證。
- 單 owner／跨 session admission 仍是操作契約；不主張 exactly-once 或 OS sandbox。沒有本輪 live TUI/pause/resume/child canary，也沒有獨立 reviewer/security 完成報告。

回顧：比繼續加角色更優先的，是先讓異常可恢復、state 有界、派工能力真實可用，再把 host 能決定的機械資訊從模型交接中拿走。
