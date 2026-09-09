# Astra agent teams：操作模型與盤點結果

> 2026-09-05，全域重建。**不使用開發中的 harness-x。**
> 這是以 pi-subagents 原生控制器＋角色設定＋主 agent 操作契約組成的團隊，
> 不是 OS sandbox、不可竄改稽核系統，也不是會自行擴權的自治部署平台。
> 本次依使用者要求由主 agent 單獨建置及驗證，沒有執行新團隊的模型 E2E。

## 開始使用

重新啟動 Pi，使預設模型與 extensions 一致生效；既有其他 session 不會被強制停止。
同機其他仍載入舊 MCP 設定的 sessions 也應在方便時 reload/restart：共享 MCP
metadata cache 可能被舊設定寫回，讓新 child 的嚴格 direct-tool 預檢暫時失敗。
遇到這種情況先在新 session 執行 `/mcp reconnect codebase-memory-mcp` 再重查，
不要修改 cache hash 或放寬 allowlist 來繞過。
先執行 `/subagents-doctor`，確認 executable profiles 為 `team.*`。
`/team 任務目標` 交給主 agent 做動態分工；`/team-audit` 要求先檢查設定。
自然語言也可以，例如「規劃並實作登入修復，完成驗證與 review，不部署」。
`/team` 是主 agent prompt，不會跳過規劃、授權或硬性工具限制。
需要 persistent goal／task dashboard 時，以 `/goal` 明確提出目標並要求 team 執行；
流程見 [GOAL-TEAMS.md](GOAL-TEAMS.md)。Goal-x 管任務，主 agent 管交接，
pi-subagents 管 child；普通 `/team` 不自動建立 goal。

```bash
PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-config.mjs
```

這個檢查不呼叫 LLM、不啟動 subagent；檢查實際 parser、資源載入、skill/MCP
解析與 gate 正反例。成功不代表模型品質、真實 E2E 或部署驗收已通過。

2026-09-07 修訂：派工可用 `check-config.mjs --roles-only --roles=team.debugger,team.reviewer <cwd>`（換成本次選用角色）；不因未選角色缺 skill 阻擋派工，但不代表全角色健康。省略 `--roles` 仍檢查全部角色，共用安全設定／discovery 錯誤及選用角色缺能力仍阻擋。開始實作前確認本次驗收環境；降級 main-only 不取消必要 review／E2E，缺證據只能交付 partial。細則見 HANDOFF-PRACTICE.md、OUTCOME-PRACTICE.md；不新增固定角色流程或自動安裝。

## 角色與責任

**2026-09-06 交付成本修訂：以下目前政策取代舊驗證快照。**
Subagents 僅使用 `openai-codex`；預設 Luna medium，main 預設 Sol high。
先減少重複工作與 context，再按難度選 thinking；不聲稱有成本 benchmark。
Planner 可按任務升 Sol xhigh，implementer 可升 Luna max，不再全面固定最高級。

| 模型 | Thinking | 角色 |
| --- | --- | --- |
| gpt-5.6-luna | low | verifier、curator |
| gpt-5.6-luna | medium | researcher、e2e、docs、qa |
| gpt-5.6-luna | high | implementer、release、debugger |
| gpt-5.6-sol | high | planner |
| gpt-5.6-terra | high | challenger、reviewer、security |
| gpt-6-astra | medium | **team.advisor，僅必要時** |

四個模型均在本機 registry 註冊；這是工作負載／資源分級政策，尚無本次模型
benchmark 支持「最便宜／最佳」的說法。沒有自動 fallback；不得因一般任務
失敗就把整個工作移交 Astra。主 agent 先檢查原始錯誤與既有分析。

只有一般分析仍無法釐清的重大決策／根因，才可請 advisor：先記錄問題、
Luna/Terra 證據、必要性及預期決策，向使用者說明，預設一次、最多三項重點，
任何 follow-up 另說明理由。它不寫程式、不取得 shell，也不是必跑 review gate。
原生工具可能把 advisor 列為 proactive skill 建議；該建議不構成必要性，主 agent
不得因此自動呼叫 Astra。
逐角色 strict modelScope 阻擋一般角色的 explicit/inherited Astra override 與
非 openai-codex 模型；「何時必要」由主 agent 契約判斷，不是假裝存在自動裁決器。
新的／覆寫的 project profiles 仍需重審模型與權限，不自動沿用顧問例外。

工具集合：

- **R**：read、grep、find、ls；不等於 OS 層讀取路徑隔離。
- **L**：symbol_search、project_report、module_report、read_symbol、read_enclosing。
- **G**：Codebase Memory 的 8 個明列直接工具：list_projects、index_status、
  search_graph、trace_path、get_code_snippet、get_architecture、search_code、detect_changes。
- **V**：lsp_diagnostics、lens_diagnostics；可啟動分析程序，不當成純檔案閱讀。
- **W**：edit、write；允許路徑仍由任務契約約束，這裡沒有 OS path sandbox。
- **X**：bash，具有 OS 執行能力，僅供受信任程式與授權測試。
- **Web**：web_search、fetch_content、get_search_content、source_check。

| Role | Thinking | 責任與輸出 | Tools | 預設專業 skills（另加 team-member） |
| --- | --- | --- | --- | --- |
| 主 agent | high | 意圖、計畫核准、分工、風險／成本、仲裁、整合、最終驗收及對使用者負責 | 全域工具；goal/task、subagent 控制、todo、memory、MCP 均由它管理 | team-flow、pi-subagents，其他按任務載入 |
| team.planner | high | brainstorm、方案比較、非目標、依賴、驗收與回滾設計 | R L G | codebase-design、karpathy-guidelines、codebase-memory |
| team.challenger | high | 反證、盲點、刪除不必要設計、可證偽實驗 | R L G | ponytail-review、scientific-critical-thinking |
| team.researcher | medium | 官方文件／來源查證、版本、信心與缺口 | R Web | research |
| team.debugger | high | 按需重現、假設實驗、根因證據與修復／回歸建議；不修改 source/tests/config | R L G V X | diagnosing-bugs、codebase-memory |
| team.implementer | high | 單一 writer、根因修復、最小實作、回歸檢查 | R L G V W X | karpathy-guidelines、ponytail、tdd、diagnosing-bugs、codebase-memory |
| team.verifier | low | 獨立執行測試／typecheck／build、完整 log 與來源狀態 | R L V X | diagnosing-bugs |
| team.reviewer | high | fresh Standards／Spec／正確性／測試與簡潔性審查 | R L G | code-review、ponytail-review、codebase-memory |
| team.e2e | medium | 真實使用流程、錯誤復原、screenshots／traces、環境清理 | R L V X | browser-automation、diagnosing-bugs |
| team.docs | medium | 使用文件、API／操作／遷移文件、實際限制 | R L W | docs-generator |
| team.release | high | CI/CD 設定、供應鏈、promotion／rollback／health-check packet | R L W | supply-chain-security |
| team.qa | medium | 驗收情境、探索 charter、可重現缺陷分級、檢查 E2E 是否符合意圖 | R L | qa |
| team.security | high | threat model、auth/input/secrets/agent/CI/supply-chain 靜態審查 | R L G | code-audit、llm-security、supply-chain-security、codebase-memory |
| team.curator | low | 證據回顧、memory 去重／失效、可測試的流程改善提案 | R | team-member |

另有 **team.advisor（Astra medium，R L，team-member／codebase-design）**：僅重大
未解決問題的唯讀諮詢；不參與常態 wave。Timeout 由主 agent 依任務設定；
profile 15 分鐘只是既有 fallback，fresh context。

原生 `contact_supervisor` 為精確 child → parent 的協調通道，runtime 視需求注入。
所有 child 都禁止再分工、使用 generic mcp/mcpScript、共享全域 memory 工具、
跨 session mesh、雲端操作與 git publication 工具。實際工具清單以各 profile 為準。

debugger/verifier/e2e **不是 OS read-only**：它們沒有 edit/write，但 shell／測試能寫檔。
reviewer/security/challenger 才是沒有 shell/edit/write 的分析角色。
release 沒有 shell／deploy MCP：它準備 CI/CD，不直接拿 production 權限。
實際部署由主 agent 在使用者明確核准後，透過保護環境的 CI 或經審查的專案
限定部署工具執行。尚未指定 repo／雲端／環境，本次不新增任何 credential、
production pipeline 或假部署。QA 不會因載入 qa skill 就自行公開 issue。

## 成果導向交付（2026-09-05 強化）

沿用現有角色與 controller，依 [OUTCOME-PRACTICE.md](OUTCOME-PRACTICE.md)
在既有 task contract 定義使用情境／可觀察成功／真實入口；驗證實際操作與
最終來源；交付逐項 met/not_met/indeterminate/needs_user 及原始證據。
主 agent 不得以 build、HTTP 200、截圖或 child pass 代替成果判定。
`gate-candidate.js` 增加逐 criterion 報告檢查，舊 summary-only 報告會 blocked。
這不是來源 hash 驗證器、語意真偽判定器或全域 completion hook；主 agent
仍需查證，所需使用者接受仍由使用者決定。未變更模型／工具／權限／預算。

## 動態 flow 與驗收

```text
使用者目標 → 主 agent contract / 風險 / authority
  ├─ 需要釐清：planner + researcher；重要取捨交 challenger
  ├─ QA 定義可觀察驗收；必要時 security 前置審查
  ├─ 困難 bug：按需 debugger 重現／驗證根因 → 主 agent 核准修復範圍
  └─ 主 agent 裁決 → 一個 writer / 一個隔離 checkout
       → main/host 機械驗證（可節省 context／並行才派 verifier）
       → 高風險加 fresh reviewer；按需 security / 真 E2E / QA / docs
       → 失敗：原始證據診斷 → 有界修正 → 新來源狀態重驗
       → 主 agent 驗收
       → 如需部署：另外核准 → protected CI → health / rollback
       → 保存 durable evidence → retrospective / memory → close mission
```

### Checkpoint review（設計待實作）

詳見 [CHECKPOINT-REVIEW-DESIGN.md](CHECKPOINT-REVIEW-DESIGN.md) 與 CP1–CP4 TODO。
採「有價值的切片交付 → 固定快照 → main/host 優先檢查 → 必要時 fresh review
→ main 仲裁 → 差量續作」，不新增常駐監工，不代替最終需求／入口驗收。
目前每 session 僅允許一個 active async top-level run；V1 必須先確認 writer
切片 run terminal 並釋放 admission，再開 review。不是在 writer 活躍時另開
第二個 workflow；真正並行 V2 暫緩，不擴大併發上限。小任務預設 none。
Checkpoint metadata 由 main/host 組裝，沿用既有 child schema；格式錯誤不重做。
本節是規劃狀態，尚未新增 runtime helper、修改角色或執行 live child。

### 按需診斷，不增加固定關卡

`team.debugger` 用於跨模組、間歇性／效能問題，或修復後仍同因失敗。
明確小 bug 由 main 直接處理；派工須有 context／並行／獨立判斷收益。
Team 基礎設施修復預設 main-only，除非使用者另准許 child。
主 agent 提供 source state、精確症狀、已有 evidence、允許的 probes、scratch
目錄與停止條件。Debugger 可在該目錄留下重現腳本／logs，不得透過 shell 改
repo source/tests/config；需要 instrumentation 時交主 agent 安排唯一 writer。
副作用實驗需隔離或與 writer 串行；這是操作契約，不是 OS sandbox。

交付含：已執行的重現命令與原始結果、已驗證／排除假設、帶 caller/file/line
的因果證據、剩餘不確定性、最小修復建議、能抓到原症狀的回歸檢查。
無法重現或缺因果證據就 blocked；`pass` 只代表診斷任務完成，不代表已修復。
主 agent → writer 重跑 repro 並修復 → main/host 驗證 → 風險所需獨立 review；
不自動升級 Astra，也不取代既有驗收關卡。

這不是要求每個任務固定跑所有角色。主 agent 按目標與風險選擇角色及依賴，
記錄 required／not-applicable 與理由。Advisor 不是常態關卡。可並行只讀調查；有副作用的 checks 要
隔離資料、port、browser session 與 cache。高風險案件不可只靠作者自測。
新 context 加上 Luna writer／Terra reviewer 分級提供不同審查視角，但仍屬同
provider；模型多樣性並不能取代可重現測試與主 agent 直接查證。

每个 handoff 含 cwd、ref/dirty diff identity、範圍、權限、criteria、commands、
證據位置與停止條件。來源 commit 之外仍要記錄未提交／未追蹤變動；單靠 SHA
無法代表 dirty checkout。修正後相關 gate 過期，主 agent 必須重新驗證。

`gate-candidate.js` 是可用的 verifier → fresh review 小流程。主 agent 先在
同一 mission 的 state 寫 `teamCandidate`，內容為 task、sourceState、criteria、
validationCommands、evidencePaths、timeoutMs、validationLocation，以及
isolated-only 時的 validationResource，再指定 workflowScriptPath 執行。
這是可選雙關流程，只有確實需要兩個角色才使用；不是小改動的固定入口。
先持久化 request，再派工；失敗／重播保留證據並回 reconcile，不再重跑驗證。
格式錯誤只能修報告，不可清掉 receipt 重派 writer。
現存 teamGate（含舊版 receipt）只回 reconcile；新 admission 才檢查 result.ok、structured verdict、來源綁定及
非空證據。失敗就不啟動下一關；結果不授予發布權。其他 gate 依任務另加。
它沒有親自 hash checkout；`sourceState` 為輸入與 child attestation，最終仍由
主 agent 重讀 source/evidence，不能把這個範例宣稱成不可繞過的全域驗收引擎。

## 交接格式、能力預檢與局部修復

見 [HANDOFF-PRACTICE.md](HANDOFF-PRACTICE.md)。普通結構化交接由
`handoff-contract.mjs` 產生唯一 team-handoff/1 schema 與 native args，使用原生
validator 做零模型預檢。所有角色遵循 outputSchema，沒有額外 memoryCandidates
要求；implementer/docs/release 都明列 native sibling acceptanceReport 必填。
Goal helper 保持原樣。格式有效、證據真實、成果合格是三個不同判斷。
不新增自動 repair controller；最多一次有必要的純報告修復、禁止 writer resume
排版。Native 同 child submission retry 沒有格式專用上限，不能聲稱完全硬防重試。
量測真實任務交付時間／總 token／首次符合需求與返工成本，不以人工派工測試冒充加速。

## 控制、稽核與復原

| 項目 | 已配置／政策 |
| --- | --- |
| 唯一 child controller | pi-subagents 0.64.0；不使用 workflow／brainstorm 等其他執行器。已存在的其他全域 extensions 不在此次整合中改寫 |
| concurrency | 一個 run 最多 3 child；每 session 最多 1 active async top-level run |
| budget | 每 wave 預設 8 admissions；每 parent session 32；不含模型 provider 重試的精確成本保證 |
| nesting | depth 1，所有 team profiles 無 subagent tool |
| deadline | 主 agent 每次依任務／測試耗時明設 timeout；profile 30 分鐘僅 fallback，async composite 亦需評估 |
| retry | 格式失敗不重做；timeout 先 reconcile；有因果證據才修復，最多三輪不是 retry 配額 |
| scheduler/watchdog | 關閉；不啟用 subagents mission.goal 續跑。僅使用者建立的 pi-goal-x goal 可續跑主 agent |
| goal/task layer | pi-goal-x；只有 main 更新 tasks。內建 auditor/oracle 停用，由 team gates＋main 驗收 |
| destructive controls | worktree discard／destructive cleanup／budget grant 需原生確認；無 UI 不降級 |
| live control | status／fleet／supervisor／steer／interrupt／stop；停止不是成功 |
| audit | mission、stable workflow keys、inputs/outputs/transcripts、status/events、terminal receipt、來源與外部 receipts |
| recovery | 先讀 mission/show、run 狀態、來源與 process proof；只續跑確定 resumable 的 child |
| retention | mission terminal 200 筆；run artifacts 仍有時間清理，重要證據需另存 durable archive |

**稽核限制：**本機 JSON/Markdown 可被同 OS 使用者改寫，並非 WORM 或簽章稽核。
mission 自動建立的 persistence warning 原生可降級；重要任務使用 explicit mission
並把 warning 當 blocker。只有在保存完整 durable artifacts 後才能關閉稽核工作。
高稽核需求應由專案使用 CI artifacts retention、protected branches 與 append-only
遠端存放，不能靠 prompt 宣稱達到法遵。進程終止不一定撤銷已發生的外部副作用。

## 哪些限制是真正強制的

- **runtime 強制**：明列 child tool/extension allowlist；未知工具 fail-before-turn；
  no-nesting；模型 allowlist `strict + enforce`、thinking ceiling；native write/edit
  permission rules；指定的 operational confirmation；MCP includeTools、approval。
- **可由可信設定改寫的限制**：project overrides、per-call concurrency/budget；
  不是不可變的 session capability ceiling。主 agent 必須檢查有效設定，不自行擴權。
- **操作契約，不是 sandbox**：allowed files、shell 命令範圍、不得讀 secrets、不得
  deploy、memory 只由 parent 寫、必須跑各種 gate。主 agent/OS/已信任 extensions
  仍可繞過；本次沒有安裝 pi-guard，也沒有聲稱 regex 可以隔離任意 shell。
- **未受信任程式**：不要在這個 host profile 執行。需要無 production credentials、
  network/path 限制的 container/CI runner。Docker socket 本身也不可給不可信 worker。
- native permission 的 `ask` 是 child-watchdog **模型裁決**，不是使用者確認；
  本次只使用 allow/deny，沒有把 ask 當人類核准。bash 不受 native permissions 管。

## Memory 與有界改善

1. 主 agent `pi-memory` 保留跨 session 偏好與決策、daily handoff；不向 child
   載入整份其他專案 memory，也不新增第二份全域記憶資料庫。
2. 每 role 的 project MEMORY 位於 `.pi/agent-memory/team-ROLE/MEMORY.md`，
   前 200 行可在 child 啟動時注入。parent 統一寫入，避免同角色多 run 覆寫。
3. 每次重要工作完成，主 agent 自動按 team-flow 做 retrospective，提出最多三條
   有證據的候選：事實、日期、project/run/ref、適用範圍、信心與失效條件。
4. 同樣錯誤反覆出現時，才用原生 project-local refine（它會另開 proposal child）
   產生小 overlay；測 before/after，保留 revision，失敗 rollback。
5. 任何 model、tools、permissions、budget、global policy／skill 變更必須再次取得
   使用者核准。進化不能刪 gate、提高自己的權限、把 memory 當命令或改模型權重。

這裡的「自動」是主 agent 完工契約＋現有 memory injection/handoff/refine 原生
能力，不是另寫永遠運作的 learning daemon。沒有背景訓練或自動 promotion 保證；
若主 agent 未執行 retrospective，必須記作未完成，不可聲稱已自我進化。

## 全域盤點與處置

| 發現 | 本次處置 |
| --- | --- |
| `~/.pi/agent/AGENTS.md` 不存在 | 新增精簡 main responsibility／authority／flow／memory contract |
| 預設模型仍為 GitHub Copilot Kimi K3 | 改為本機已註冊的 openai-codex/gpt-6-astra high |
| 4 個 user brainstorm profiles + 8 個 legacy `~/.agents/*.md` | 私有備份後退役；12 個常態 team profiles，另加 1 個按需 advisor |
| builtins/external CLI 仍可繞回一般 worker | `disableBuiltins: true`；不移除已安裝套件的程式碼 |
| workflow/brainstorm/goal/harness 多 controller | 全域停用；保留原碼、歴史與開發專案設定 |
| `~/.pi/settings.json` home 層還會禁用 subagents | 只移除該舊 disable delta；其他歷史排除保留 |
| pi-agent-extensions 全載入（含 loop、cross-session control） | allowlist 10 個 UI/ask/todo/handoff 輔助入口；加 `!**` 才真的排除其他項 |
| remote-pi／gateway 管理工具不是 team 必需 | 停用這兩個 package 的全域 extensions，不停止 daemon、不刪其資料 |
| 已安裝 skills 數量大，且含依賴其他 harness／自動 bootstrap 指示 | 主 catalog 精簡；保留完整安裝目錄與 skill-catalog.json；child 只選角色適用 skills |
| Git 套件的 karpathy skill 在 child resolver 未自動找到 | 對 planner/implementer 設 explicit skillPath |
| MCP directTools 只管展示、不等於 allowlist | 加 includeTools；index_repository 需確認；sampling/autoAuth 關閉，未知新 server 預設確認 |
| `toolPrefix: mcp` 與目前 subagents resolver 不一致 | 改用双方支援的 `server` prefix；以實際 MCP 連線刷新 metadata，不偽造 cache |
| 未固定核心套件版本 | 固定本次已安裝的 subagents/MCP/lens/memory/web/docparser/agent-extensions 等版本；升級另驗證 |

此為配置與關鍵 contract/source 盤點，不是對所有第三方 extension、所有 skill
腳本逐行安全稽核。`models.json`、auth.json、trust.json、gateway 服務、
專案程式碼皆未改寫；原有 memory 內容保留，另追加本輪決策與驗證日誌。
沒有掃描或操作任何 production 系統。

## 備份與回復

備份位置見 `backup-path.txt`，manifest 有原始路徑與 SHA-256；備份沒有 credentials。
回復前先停止自己的 team runs、確認沒有新設定要保留，再依 manifest 還原四份
設定及十二份舊 role files，移除新 `team.*` profiles、AGENTS.md 與新增的 team
skills/prompts；不要用整個 `~/.pi` 的 `rm -rf` 或還原舊 auth/memory。
新設定與舊設定不可混用；回復後重新啟動 Pi並重查實際 discovery。

## 本次驗證結果

### 2026-09-05：Goal task × team 整合

此決策取代先前「全面禁用 goal-x」：允許它作 parent 的目標／task／進度層，
不成為 child controller。操作／恢復／已知限制與可執行 checks 見
[GOAL-TEAMS.md](GOAL-TEAMS.md)。不改寫既有 goals，不改第三方核心。
`goal-task-step.js` 先持久化 intent 才執行單一角色；相同 key 不重送，
報告或失敗後均需主 agent reconcile native run receipt，不能自動完成 task。
`pi-goal-x@0.30.5` 的本機 hash-gated hold/wake patch 會在精確綁定的 active run
期間抑制 Goal checkpoint，並讓 `pi-subagents` native notifier 保持唯一 wake；細節、
重套／回復與 fixture 邊界見 [GOAL-TEAMS.md](GOAL-TEAMS.md)。它仍是 single-owner
協定，不宣稱跨 session exactly-once；run identity 確認前已排入的 checkpoint
可能造成一次 reconciliation turn。

### 2026-09-05：新增按需 debugger（先前驗證快照）

新增 `agents/team.debugger.md`（Luna high），只增加該角色的 strict modelScope，
沒有改動其他模型、controller、全域 extensions 或權限。同步主 agent／team-flow
路由及 implementer 交接契約。原生 discovery 已列出 14 個 executable profiles。

```bash
PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-config.mjs --roles-only /home/timmypai/apps/grafana
PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-config.mjs --roles-only /home/timmypai
```

兩 cwd 的 role-contract checks PASS，證據為 `validation-debugger-grafana.json`、
`validation-debugger-home.json`：驗證角色解析、模型正反例、skills/MCP selectors、
write/edit deny、工具不超過 implementer 去除 edit/write、fresh context 與 timeout。
沒有呼叫模型或啟動 child，不代表真實 debug 品質或 shell 隔離驗收。

**既有全域限制：**修改前完整檢查已因目前啟用 `pi-goal-x/extensions/goal.ts`
而失敗，與舊操作模型的停用預期不符。本次不更動它，也不放寬完整檢查；
`--roles-only` 明確不包含全域 extension loader 與 gate cases。
备份：`~/.pi/backups/team-debugger-20260905-212723`。回復需逐檔比對，僅撤回
本次 debugger 變更，不覆蓋後續設定。既有會話需 reload/restart 才讀到更新的指引。

### 先前 planner/implementer 與全域重建快照

最新 planner/implementer 修訂以 `check-config.mjs --models-only` 驗證模型路由，
thinking ceiling 已升至 max（原生為全域上限，其他角色預設 thinking 不變）。
輸出另存 `validation-model-routing.json`；不代表完整 extensions／E2E 驗證。
下列全域重建 PASS 為當時快照，後續 extensions/skills 設定已有其他變更，未在
本次模型修訂中還原或重新驗收，不能視為目前全域設定的通過證據。

- `validation.json`：translive cwd 的全域／有效設定檢查 PASS。
- `validation-home.json`：home cwd（含舊 home override）檢查 PASS。
- 模型路由修訂後，兩者各自確認 13 profiles、19 active extensions、32 main skills、10 個 gate
  正反例，以及零 child-agent、零模型呼叫；121 個 installed skills 保留在 catalog。
- Native `subagent(action=validate)` 接受 gate-candidate.js，沒有 syntax errors。
- 模型路由修訂後，Native `subagent(action=list)` 已確認 13 個 team.* profiles。
- 檢查器使用原生 model-scope evaluator，逐角色驗證 explicit/inherited 路由，
  阻擋非 openai-codex 模型與一般角色的 Astra override；不呼叫任何模型。
- LSP 對兩個 JavaScript 檔案無 diagnostics；這不是模型任務 E2E。
- 修正驗證發現的 package filter、permissions.rules、child skillPath、MCP prefix／
  metadata cache 問題；未修改第三方套件原始碼。

範圍之外：新團隊真實任務／模型能力 benchmark、browser app E2E、production
部署與外部 audit store。不能把本次設定／stub gate 測試當成這些項目的成功證據。
