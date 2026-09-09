# Team 交接與效率修正 — 2026-09-06

## 結論與驗收範圍

主 agent 單獨完成設定／本機 helper／操作契約修改與離線驗證；零模型呼叫、零
subagent launch。未修改／聚焦／恢復 Goal，未修改 goal-task-step.js、hold/wake
套件來源或既有 concurrency/spawn/timeout fallback 上限。未自動 reload。
本次完成的是契約／預檢／回歸與設定一致性，不是 live 模型品質或效率 benchmark。

| 原定需求 | 實際觀察與證據 | 判定 |
| --- | --- | --- |
| schema 為唯一格式來源 | 14 profiles 不再固定要求額外 memoryCandidates；三個 writer 的原生 parser 解析 report:on。原問題先 RED，见 red-handoff.log；43 案例 handoff.json 綠 | met（契約／離線） |
| 無模型的派工前相容性检查 | 實際 CLI handoff-contract.mjs 讀 cli-request.json，輸出 cli-prepared.json；timeout 保留 234567；非法 JSON 非零退出；無 work artifact。check-handoff-contract 驗 parent-only／缺 shell／缺隔離資源／未知欄位／模型 scope／schema drift 拒絕 | met（指定 helper，不是全域 hook） |
| 回報錯誤不重做工作 | gate RED 顯示 replay 多派 2 次，修後 54 案例 PASS，含舊 receipt／throw／persistence failure；Goal disposable writer 已寫檔後遇 malformed/timeout，再同 key 與新 attempt 都只執行一次、內容 hash 不變 | met（真 helper＋mock runs） |
| schema 合格不自認成果成功 | validateSubmission 只回 valid/invalid＋主 agent 驗證下一步，假路徑案例不產生 verified/pass；空 evidence 的 met 拒絕。實際來源／證據內容／入口仍由 main/host 查驗 | met（責任分離；不宣稱自動辨識假證據） |
| 設定節省無效角色／模型成本 | main Sol high、planner Sol high、implementer Luna high、advisor Astra medium；既有其他角色不變。兩 cwd 全 config PASS，24 active extensions，不含 loop/control/workflow/brainstorm/gateway/remote-pi | met（有效 resource loader，未 live 模型） |
| 任務化 timeout／風險 gate | team-flow／AGENTS／operating docs 已取消固定角色鏈，要求 main 每次選 timeout；不縮短 fallback 或安全 ceilings。格式修復與 implementation retry 分離 | met（操作政策） |

## 驗證

所有下列命令由 main 在無 writer 並行的狀態執行，cwd=/home/timmypai，均 exit 0，
除明列負例。Native workflow validate 是管理動作，不啟動 child。

- `node ~/.pi/agent/teams/check-handoff-contract.mjs`：43 cases，`handoff.json`。
- `node ~/.pi/agent/teams/check-team-outcomes.mjs`：54 cases，`gate.json`。
- `PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=off node ~/.pi/agent/teams/check-config.mjs <cwd>`：home／Grafana 完整 PASS，`config-home.json`、`config-grafana.json`，無放寬禁止 extension 規則。
- `node ~/.pi/agent/teams/check-goal-team.mjs <cwd>`：home／Grafana 各 53 cases，`goal-home.json`、`goal-grafana.json`。原有 50 cases 保留；新增兩個已落盤成果不重播案例及 protected hash 檢查。
- Patch `apply.mjs --check`：COMPATIBLE/post；`--verify`：26 cases PASS，native success/failure 各 wake 1、bridge wake 0、held checkpoint 0；`hold-patch-check.json`、`hold-verify.json`。
- `node ~/.pi/agent/teams/handoff-contract.mjs cli-request.json`：真 CLI 有效輸出；輸入 `/dev/null` 負例 exit 1、無 stdout，`cli-invalid.stderr`。
- Native `subagent(action=validate, workflowScriptPath=.../gate-candidate.js)`：`ok:true, errors:[]`。
- Primary LSP：6 JS/MJS 檔全 clean；session lens errors 0。Auxiliary opengrep coverage 有 unavailable 警告，不聲稱完整安全掃描。

## 根因與取捨

1. 多份角色 prompt 固定列 memoryCandidates，而 Goal／gate schema additionalProperties:false；已移除互相矛盾的格式指令。
2. gate-candidate 原本每次初始化清 teamGate，報告失敗後重呼叫會重做驗證。現在先保存 intent，完成 verifier 即保留 receipt，任何現存／legacy receipt 都只回 reconcile。
3. 普通交接以新 handoff-contract.mjs 共用 schema 建立與原生驗證；helper 沒有 runs/dispatch/resume/exec 功能。Goal 與候選 gate 保留專用 schema，未引入新工作排程或狀態管理系統。
4. Main/host 已知 identity、來源指紋不再要求普通報告回填；原有 Goal 七欄契約為相容性保留。

## 限制與後續

- `report:on` 原生 runtime 強制要求 sibling acceptanceReport；但「最多一次 report-only repair」仍是主 agent 操作規則，非全域不可繞過攔截。
- pi-subagents@0.64.0 `subagent-prompt-runtime.ts` structured_output handler 錯誤會 throw，成功才 terminate；沒有格式專用 retry 次數設定。Native foreground/background terminal paths 把缺報告標失敗；另有 startup/provider retry。未修改它們，不能宣稱完全阻止同 child 的格式重試浪費。
- 選用普通 helper 前需先跑有效 role/config 預檢並審核 scope；request 內 resource／sourceState 是 parent supplied，不是 OS isolation／來源證明。模型 scope 原生強制仍在 controller；helper 不新增工具權限。
- state get/set 不是 CAS；Goal／gate replay fixture 不代表跨 session exactly-once。清 gate 前須先保存並 reconcile native/process/source；不能為排版清 receipt。
- 未做 live Goal/model/TUI E2E、獨立 child review（user main-only）、效能／token benchmark。下一個真實任務才觀察總 token／交付時間／返工；不人造派工測試。
- 使用者 `/reload` 以重新載入 extensions/profiles/skills；main 新預設模型適用新 session，現有 session 不保證自動切模型。未停止 gateway/mesh daemon、其他 sessions 或既有 runs。

## 檔案、回復與回顧

主要入口：`~/.pi/agent/teams/HANDOFF-PRACTICE.md`、`handoff-contract.mjs`、
`gate-candidate.js`。實際來源指紋見 `source-manifest.json`；既有檔 diff 見
`tracked-changes.diff`；changed-files.json 列修改前後 hash。

備份 `/home/timmypai/.pi/backups/team-handoff-20260906-115903/manifest.json`。
回復前逐檔比較目前 hash 與 source-manifest，保留後續變更；只回復此次列出的
變更檔。新增的 handoff-contract.mjs/check-handoff-contract.mjs/HANDOFF-PRACTICE.md
需與對應 callers/docs 一起回復，不整包覆蓋 ~/.pi，不碰 credentials/Goals。

保留不動的 goal-task-step SHA：
`8a7301fce7c29ef0eb21376f185795618ec0cb56adcf8e6633b476e43cef668c`。

有界回顧：schema 問題應先查角色提示與 native envelope 是否衝突；交接錯誤不能
觸發重做已存在成果；測量的是合格交付總成本，不把較短 timeout 当作效率提升。
