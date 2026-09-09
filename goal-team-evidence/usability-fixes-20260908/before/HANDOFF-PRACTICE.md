# 交接契約與局部恢復

目標是降低「合格交付」的總 token／時間，不是讓每次呼叫最便宜。
2026-09-08 執行修訂見 [EFFICIENCY-CONTRACT.md](EFFICIENCY-CONTRACT.md)：
Goal 新派工必填 work 職責／固定 criteria／checks；能力矛盾先拒絕，
同 task/role 換 phase 不重置 admission 計數，報告問題不重做產品。
本文件補充 team-flow；不新增 controller，不以報告格式作產品驗收。

來源 freeze、host 收據／局部失效、Goal 可選 evidence reference、較少手抄的派工準備，見 [EVIDENCE-PRACTICE.md](EVIDENCE-PRACTICE.md)。先完成 formatter，再驗證／封存；host 機械新鮮度不取代 main 的語意驗收或 required review。

過程中的切片審查另見 [CHECKPOINT-REVIEW-DESIGN.md](CHECKPOINT-REVIEW-DESIGN.md)
（設計／TODO，尚未實作）。它沿用本文件的 schema 與 report-only recovery；
checkpoint identity/hash 由 main/host 綁定，不增加 child 必填輸出欄位，也不把
終止型 structured_output 當成活躍 writer 的非終止 checkpoint 通道。

## 派工前：主 agent 執行，零模型

先決定成果、真實入口、非目標、寫入權限，以及派工相對直接完成的收益。
小任務直接做。需要機器消費的普通結果使用 `team-handoff/1`；純查閱可用
短 Markdown，不為排版啟動修復代理。Goal step／candidate gate 保留各自既有
專用 schema，不能把普通 schema 塞進它們的消費者。

派工前在目標 cwd 執行 `check-config.mjs --roles-only --roles=team.debugger,team.reviewer <cwd>`（角色清單換成實際選用者），檢查有效 profiles、skills、MCP selectors／工具與模型 scopes；配置、角色選擇或 cwd 改變後重查。省略 `--roles` 的 `--roles-only` 仍是全角色健檢，完整健檢仍用 `check-config.mjs <cwd>`。選用範圍的成功不得宣稱全域健康；輸出的 uncheckedRoles 明列未檢角色。共用安全設定及 discovery diagnostics 仍會阻擋；選用角色缺 skill／工具／模型仍 fail closed，不自動換角色或擴權。
2026-09-08：role 檢查會一次彙總所有選用角色的失敗；FAIL receipt 的 `roles` 是
通過項、`failures` 是阻塞項，不因列出成功角色就允許失敗角色啟動。缺 skills
不自動安裝、刪除要求或換成其他角色；完整環境 readiness 仍須按任務檢查。
所有 checks 標示 `parent-only`、`child-safe` 或 `isolated-only`。
前者留在 main/host；後者先由主 agent 配好隔離資源，再交給有 shell 的角色。
這是能力／操作預檢，不是 sandbox 或對任意命令的安全證明。

普通結構化交接先產生 request JSON（主 agent 寫，不由 child 決定），例如：

```json
{
  "agent": "team.implementer",
  "cwd": "/absolute/approved/project",
  "task": "限定範圍、可改檔案、非目標、真實入口、停止條件與工作要求",
  "criteria": ["實際使用情境應達成的可觀察結果"],
  "sourceState": "主 agent 實際取得的起始來源指紋，含 dirty/untracked",
  "output": "handoffs/change.md",
  "timeoutMs": 1200000,
  "checks": [{ "command": "node check.mjs", "location": "child-safe" }]
}
```

上面的 timeout 僅為語法範例；主 agent 依該任務工作量與測試耗時選擇，沒有
固定 10／15 分鐘政策。`isolated-only` check 另需 `resource` 描述已配置資源。
可選 `model` 為現有 role scope 允許的精確 provider/model:thinking；不擴權。

```bash
node ~/.pi/agent/teams/handoff-contract.mjs request.json > prepared.json
```

CLI 只讀 request、解析有效角色、檢查 timeout／output／check 能力、用原生
validator 編譯 envelope，輸出 `{contract, args}`；不執行 command 或啟動 child。
把 `args` 原樣交 native `subagent` 或 stable-key `runs.run`，保留 `contract`
於現有任務證據中。不要手工再抄一份 schema。派工前仍須主 agent 核對 source、
實際安全範圍與有效 overrides；此 helper 不是全域 admission hook。

## 唯一格式來源

- 普通 schema 只含 summary、criterionResults、residualRisks；一次一個 criterion。
  普通 request 可附 work（kind/criteria/checks），須與原 criteria/checks 相符；
  Goal 新派工也要求固定逐項 criterionResults，舊 saved packet 保留舊讀取格式。
  不要求模型重複 run ID、cwd、來源 hash；它們由主 agent/native receipt 管理。
- `outputSchema` 是 `structured_output.value` 的唯一欄位定義。角色的 Markdown
  欄位清單僅是沒有 schema 時的 fallback，不能額外塞入 memoryCandidates。
- Writer 的 `acceptanceReport` 是 **value 的 sibling**，沿用原生 acceptance
  prompt／欄位，不放進 value；三個 writer profiles 都使用 `report: on`。
  未指定 outputSchema 時，依原生要求回覆 acceptance-report 區塊。
- `validateSubmission(prepared, submission)` 使用同一 schema 與原生 acceptance
  parser，可檢查保存的 raw structured tool arguments。`valid` 只表示可讀，
  **不表示證據存在、語意正確、source 一致或任務通過**。
- Native workflow result 的 structuredOutput 已是 value；native acceptance
  status／report 要從原生 receipt 取得，不可猜測欄位或自行補成 checked。

## 格式失敗不等於工作失敗

先確認程序停止、source 不再被修改，保存 native receipt／raw report／成果。
缺檔、過期來源、假證據、不符合需求分開處理，不靠換 verdict 修成 PASS。

| 問題                         | 下一步                                                                  |
| ---------------------------- | ----------------------------------------------------------------------- |
| schema／acceptance 回報錯誤  | 主 agent 讀精確 validation error 與既有成果，只修交接；不得重派 writer  |
| timeout／throw／程序狀態不明 | 查 native status、process proof、來源與 durable artifacts；不能先 retry |
| 缺少真正測試                 | main/host 補必要驗證，不重做實作                                        |
| 成果不符 criteria            | 保存已有正確部分，針對有證據的缺口修復                                  |
| 權限／環境缺失               | 回報阻塞，不新增工具、降低 gate 或升級模型繞過                          |

格式修復優先 main；只能從實際資料補 controller 已知欄位，不能編造 observations。
若确實需要模型解释，最多一次 fresh、無 shell/edit/write 的既有適用角色，
只讀最少必要 artifacts／精確 errors，不能 resume 保留寫權限的 writer。
第二次仍無法交接由 main 處理／回報阻塞，禁止同任務循環重做。
這是主 agent 政策，不宣稱在所有原生工具呼叫上都有硬性攔截。

## 重播與原生 retry 的範圍

`goal-task-step.js` v2 使用 `goal-request.mjs` 準備的 saved-packet digest/reference，
不把每一步完整 request/report 累積到 mission state；先保存 compact intent，成功後
才寫 active marker 並派工。舊 v1 歷史仍只 reconcile；新 attempt 不能越過未
reconcile 的 active step。格式失敗不能被當作 implementation retry。詳見 GOAL-TEAMS.md。
`gate-candidate.js` 現在先保存 request intent，再執行驗證；失敗保存 artifacts，
review 開始前保存 verification。再次執行只回 reconcile，不重跑命令。
主 agent 完成 native/source reconciliation 並保存舊證據後，才可清除舊 teamGate
以接納**真正改變的 candidate 或有原因的補驗**，不能為修格式清除它。
單一主 agent 操作；state get/set 不是跨 session CAS 或 exactly-once。

pi-subagents 0.64.0 的 structured_output handler 對錯誤 submission 丟出 validation
error，成功才 terminate；沒有格式專用 retry 次數設定。模型可能在同一 turn
再次呼叫工具。foreground/background terminal paths 會將缺報告標為失敗；
另有 startup／provider retry，不能把它們算成外層一次修復的硬成本上限。
本次不 patch 原生 runner；主 agent 用任務 timeout／必要的 tool budget 和原生
activity 通知止損，不開 polling daemon。若真實任務仍反覆耗在 submission，
先保存重複工具錯誤證據，再提狹義 runtime 修補，不預先造新框架。

## 驗收與檢查位置

開始實作前先做與本次成果相關的零模型環境檢查：例如 UI 工作確認 browser executable、可用登入方式、目標 URL／代表性 fixture 及 readback 能力；測試工作確認 runner／依賴。只查可用性，不讀取或輸出憑證，不自動安裝或啟動有外部副作用的工具。不是每個任務都要 browser。

若必需環境缺失，先記錄具體缺口、仍可交付的範圍及最終驗收限制，再進行可安全獨立完成的部分；不可到結尾才把 build／SSR 冒充使用者入口驗證。來源可修但無法驗收時交付 partial，不必為此無限等待或重跑。

全角色健檢因未選角色失敗時可執行選用角色預檢；選用角色或共用安全檢查失敗時不可繞過。改 main-only 前重新確認主代理能力及允許範圍、告知缺少的獨立證據；required review／E2E 不得自行改成 N/A。必要證據仍缺則維持 partial／indeterminate。

主 agent 核對 exact terminal run、實際最終來源（含 dirty/untracked）、原始
commands/cwd/exit/logs 及每項真實入口觀察。報告的來源 attestation 或路徑字串
不是 host 證據。高風險加獨立 review/security；一般任務不為流程固定開 verifier。
修改後只失效真正受影響的證據。未執行必要真人／入口測試就明列缺驗，不 complete。

Parent-only 回歸：`check-handoff-contract.mjs`、`check-team-outcomes.mjs`、
`check-goal-team.mjs`、`check-config.mjs`。Goal replay check 的 writer artifact
測試使用自建 temp 目錄；其餘 runs/state 為 fixture，零模型／child，不能宣稱
live TUI/Goal/model E2E 或已測得開發加速。
