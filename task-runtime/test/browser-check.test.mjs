import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { emptyStateVisible, todoCount } from "../e2e/todo-dom.mjs";

const evaluate = (expression, document) =>
    vm.runInNewContext(expression, { document });
test("empty state may be absent or hidden when nonempty, but neither passes an empty-list visibility assertion", () => {
    for (const element of [null, { checkVisibility: () => false }])
        assert.equal(
            evaluate(emptyStateVisible, { querySelector: () => element }),
            false,
        );
    assert.equal(
        evaluate(emptyStateVisible, {
            querySelector: () => ({ checkVisibility: () => true }),
        }),
        true,
    );
});
test("row counting excludes nested identity attributes, not additional outer rows", () => {
    const row = () => ({ parentElement: { closest: () => null } });
    const parent = row();
    const child = { parentElement: { closest: () => parent } };
    assert.equal(
        evaluate(todoCount, { querySelectorAll: () => [parent, child, child] }),
        1,
    );
    assert.equal(
        evaluate(todoCount, { querySelectorAll: () => [parent, child, row()] }),
        2,
    );
});

// Trusted disposable fixture, not a model candidate or an acceptance receipt.
function fixture(mode) {
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{max-width:36rem;margin:1rem}input{max-width:60%}:focus{outline:2px solid blue}[hidden]{display:none}</style></head><body>
<form id="todo-form"><label for="todo-input">Todo</label><input id="todo-input"><button>Add</button></form>
<button data-filter="all">All</button><button data-filter="active">Active</button><button data-filter="completed">Completed</button><p id="todo-count"></p><ul id="todo-list"></ul>
<script>
const mode=${JSON.stringify(mode)}, key='task-pi-todos-v1';
const list=document.querySelector('#todo-list'),form=document.querySelector('#todo-form'),input=document.querySelector('#todo-input');
let todos=[],filter='all';try{todos=JSON.parse(localStorage.getItem(key)||'[]')}catch{};
function render(){list.replaceChildren();document.querySelector('[data-testid=empty]')?.remove();
 const visible=todos.filter(t=>filter==='all'||(filter==='completed')===t.completed);
 if((!visible.length||mode==='stuck-empty')&&mode!=='missing-empty'){const empty=document.createElement('p');empty.dataset.testid='empty';empty.textContent='Empty';list.before(empty)}
 for(const todo of visible){const row=document.createElement('li');row.dataset.todoId=todo.id;
 const box=document.createElement('input');box.type='checkbox';box.checked=todo.completed;
 const text=document.createElement('span');text.textContent=todo.text;
 const del=document.createElement('button');del.dataset.action='delete';del.textContent='Delete';
 if(mode==='nested-id'){box.dataset.todoId=todo.id;del.dataset.todoId=todo.id}
 box.onchange=()=>{todo.completed=box.checked;save();render()};del.onclick=()=>{todos=todos.filter(t=>t!==todo);save();render()};
 row.append(box,text,del);list.append(row)}document.querySelector('#todo-count').textContent=todos.filter(t=>!t.completed).length;
}
function save(){if(mode!=='no-persistence')localStorage.setItem(key,JSON.stringify(todos))}
form.onsubmit=e=>{e.preventDefault();if(mode==='no-add')return;const text=input.value.trim();if(!text)return;todos.push({id:String(Date.now()),text,completed:false});save();render();input.value=''};
for(const button of document.querySelectorAll('[data-filter]'))button.onclick=()=>{filter=button.dataset.filter;render()};render();
</script></body></html>`;
}

test("real browser checker accepts alternate DOM implementations and rejects actual defects", {
    skip:
        process.env.TEAMS_BROWSER_REGRESSION === "1"
            ? false
            : "opt-in local Windows Edge/WSL check; no models",
    timeout: 120000,
}, async (t) => {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "todo-browser-regression-"),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const wrapper = fileURLToPath(
        new URL("../e2e/run-browser-check.sh", import.meta.url),
    );
    for (const mode of [
        "dynamic-empty",
        "nested-id",
        "missing-empty",
        "stuck-empty",
        "no-add",
        "no-persistence",
    ]) {
        await t.test(mode, () => {
            const cwd = path.join(root, mode);
            fs.mkdirSync(path.join(cwd, "app"), { recursive: true });
            fs.writeFileSync(path.join(cwd, "app/index.html"), fixture(mode));
            const evidence = path.join(root, `${mode}-evidence`);
            const run = spawnSync(wrapper, [cwd, evidence], {
                encoding: "utf8",
                timeout: 20000,
            });
            assert.equal(run.error, undefined, run.stderr);
            const report = JSON.parse(
                fs.readFileSync(path.join(evidence, "browser-report.json")),
            );
            const positive = ["dynamic-empty", "nested-id"].includes(mode);
            assert.equal(run.status, positive ? 0 : 1, run.stderr);
            assert.equal(report.status, positive ? "passed" : "failed");
            if (!positive) {
                assert.ok(report.phase && report.error && report.dom);
                assert.equal(
                    report.phase,
                    mode === "no-persistence"
                        ? "persistence"
                        : mode === "missing-empty"
                          ? "initial-empty"
                          : "create",
                );
            }
        });
    }
});
