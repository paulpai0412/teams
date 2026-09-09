import { createJiti } from '/home/timmypai/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs';
const jiti = createJiti(import.meta.url);
const mod = await jiti.import('/home/timmypai/.pi/agent/npm/node_modules/pi-goal-x/extensions/goal-runtime.ts');
console.log(typeof mod.GoalRuntime);
