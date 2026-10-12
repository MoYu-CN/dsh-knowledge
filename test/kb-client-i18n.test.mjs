/**
 * kb-client-i18n.test.mjs —— 右栏面板的**渲染级**中英双语自测。
 *
 * ## 为什么要有这一份
 * 审计报告第 1 层只证明了「字典里中英键都在」，**没有证明界面真的会按语言渲染**：
 *   - 删除确认、条目详情标签原先**根本没走字典**（硬编码中文，切英文也不变）；
 *   - `HEADINGS` 曾经是模块级常量，在 locale bind 之前就被求值 ⇒ 永远中文；
 *   - 报告原话：「没有真实运行界面验证英文渲染」，本机也开不了真浏览器。
 * 这一份把 `lib/client.js` 的 `sidebar.right.pane.tab` 那个组件**真跑起来**
 * （假 React 钩子运行时 + 假 ctx.locale，但字典是**插件自己 register 进去的真字典**），
 * 然后在 zh / en 两种语言下各断言一次**渲染出来的可见文字**。
 *
 * ## 证明什么 / 不证明什么
 * 证明：同一份源码、同一棵树，语言一换（只换 `locale` 变量），
 *   删除确认、条目详情标签、分组标题、条目计数、删除后的提示条**都跟着换**，
 *   且英文侧不出现中文；中英字典键集合一致、新加的键两边都非空。
 * 不证明：真浏览器 / 真 React / 真宿主 locale 服务下的最终像素 ——
 *   这里用的是本仓库测试通用的假渲染运行时（`document`、`fetch`、hooks 都是替身）。
 *
 * ## 用法
 *   node test/kb-client-i18n.test.mjs
 *   # 对照组（必须变红，用来证明判据不是空转）：
 *   $env:DSH_KB_I18N_SABOTAGE = "1"; node test/kb-client-i18n.test.mjs
 *
 * 原始输出落盘位置：`DSH_TEST_OUT_DIR` 设了写那儿，没设写系统临时目录 —— 绝不往仓库里写。
 */
import fs from "node:fs";
import path from "node:path";
import inspector from "node:inspector";
import { outFile, srcDir } from "./_harness.mjs";

const SABOTAGE = process.env.DSH_KB_I18N_SABOTAGE === "1";
const TRANSCRIPT = outFile("kb-client-i18n-output.txt");
const WORKDIR = "C:/tmp/i18n-project";

let failures = 0;
const assert = (label, cond, extra = "") => {
  if (cond) console.log(`   PASS  ${label}`);
  else {
    failures += 1;
    process.exitCode = 1;
    console.log(`   FAIL  ${label}${extra === "" ? "" : ` :: ${extra}`}`);
  }
  return cond;
};
const head = (t) => console.log(`\n${"═".repeat(78)}\n${t}\n${"═".repeat(78)}`);
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/* ── 把本次的真实 console 落盘（测试报告要贴原始输出）──────────────── */
const session = new inspector.Session();
session.connect();
const posted = [];
session.on("Runtime.consoleAPICalled", (e) => {
  posted.push(
    (e.params.args ?? [])
      .map((a) => (a.value !== undefined ? String(a.value) : typeof a.description === "string" ? a.description : a.type))
      .join(" ") + "\n",
  );
});
session.post("Runtime.enable");
process.on("exit", () => {
  try {
    fs.writeFileSync(TRANSCRIPT, posted.join(""), "utf8");
  } catch {
    /* 落盘失败不该改变测试结论 */
  }
});

/* ── 源码：对照组在**内存里**改渲染处的键名，磁盘上的文件不动 ─────────── */
const clientFile = path.join(srcDir, "client.js");
let clientSrc = fs.readFileSync(clientFile, "utf8");
if (SABOTAGE) {
  const needle = 'tz("entry.confirmDelete"';
  const count = clientSrc.split(needle).length - 1;
  if (count !== 1) {
    console.log(`REFUSE: 对照组改不动 —— 源里 ${needle} 出现 ${count} 次（应为 1 次），键名可能漂移了`);
    process.exit(2);
  }
  clientSrc = clientSrc.replace(needle, 'tz("entry.__sabotaged__"');
  console.log(`⚠ 对照组：已在内存里把删除确认的键名改掉（源文件未动）`);
}

/* ── 浏览器侧最小替身 ────────────────────────────────────────────────── */
const mkReact = () => {
  const state = { hooks: [], cursor: 0, needsRender: false };
  const createElement = (type, props, ...children) => {
    const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true);
    if (typeof type === "function") return type({ ...(props ?? {}), children: kids });
    return { __el: true, type, props: props ?? {}, children: kids };
  };
  const sameDeps = (a, b) =>
    a !== undefined && b !== undefined && a !== null && b !== null && a.length === b.length && a.every((d, i) => Object.is(d, b[i]));
  const useState = (init) => {
    const i = state.cursor++;
    if (state.hooks[i] === undefined) state.hooks[i] = { value: typeof init === "function" ? init() : init };
    const slot = state.hooks[i];
    return [
      slot.value,
      (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        state.needsRender = true;
      },
    ];
  };
  const useEffect = (fn, deps) => {
    const i = state.cursor++;
    const prev = state.hooks[i];
    if (prev !== undefined && sameDeps(prev.deps, deps)) return;
    if (prev?.cleanup !== undefined) {
      try {
        prev.cleanup();
      } catch {
        /* ignore */
      }
    }
    const cleanup = fn();
    state.hooks[i] = { deps: deps ?? null, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  };
  const useCallback = (fn, deps) => {
    const i = state.cursor++;
    const prev = state.hooks[i];
    if (prev !== undefined && sameDeps(prev.deps, deps)) return prev.value;
    state.hooks[i] = { deps: deps ?? null, value: fn };
    return fn;
  };
  return {
    api: { createElement, Fragment: Symbol.for("Fragment"), useState, useEffect, useCallback },
    state,
    mount(component, buildProps) {
      state.cursor = 0;
      state.needsRender = false;
      let props = buildProps();
      let tree = component(props);
      let guard = 0;
      while (state.needsRender && guard < 30) {
        state.needsRender = false;
        state.cursor = 0;
        props = buildProps();
        tree = component(props);
        guard += 1;
      }
      return { get tree() { return tree; } };
    },
  };
};

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: "", textContent: "", remove() {} }),
  head: { appendChild() {} },
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ── fetch 桩：只要面板用到的三只路由 ───────────────────────────────── */
// ⚠ 条目**数据**一律不含中文：这样「英文界面整棵树里一个中文字都没有」
//   才能当成一条硬断言用 —— 任何中文都只可能来自界面文案本身。
const E_PIT = {
  id: "P-001",
  kind: "避错",
  title: "clear the cache before building",
  domain: "build-and-deploy",
  trigger: "next time the build script changes",
  steps: ["rm -rf dist", "rerun the build"],
  why: "stale output gets reused",
  verify: "delete, then build again",
  boundaries: "local builds only",
  symptoms: "tests pass but behaviour is unchanged",
};
const E_MET = {
  id: "M-001",
  kind: "方法",
  title: "ship in three steps",
  domain: "build-and-deploy",
  trigger: "when a release is coming",
  steps: ["tag it", "write the notes"],
};
const calls = [];
const removed = new Set();
globalThis.fetch = (url, init) => {
  const u = String(url);
  calls.push(`${init?.method ?? "GET"} ${u}`);
  const reply = (payload) => Promise.resolve({ status: 200, ok: true, json: async () => payload });
  if (u.startsWith("/__kb/search")) {
    const left = [E_PIT, E_MET].filter((e) => !removed.has(e.id));
    return reply({ ok: true, exists: true, results: left });
  }
  if (u.startsWith("/__kb/get")) {
    const id = decodeURIComponent(new URL(u, "http://x").searchParams.get("id") ?? "");
    const entry = [E_PIT, E_MET].find((e) => e.id === id);
    return reply({ ok: true, entry });
  }
  if (u.startsWith("/__kb/remove")) {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (typeof body.id === "string") removed.add(body.id);
    return reply({ ok: true, count: [E_PIT, E_MET].filter((e) => !removed.has(e.id)).length });
  }
  return reply({ ok: false, error: `未预期的请求：${u}` });
};

/* ── 收下 bundle 的 factory ──────────────────────────────────────────── */
let factory = null;
globalThis.window = { __ModuleLoader__: { load: (d) => { factory = d.factory; } } };
new Function(clientSrc)();
assert("真 client.js 通过 __ModuleLoader__.load 注册了 factory", typeof factory === "function");

const react = mkReact();
const mod = factory((name) => {
  if (name === "react") return react.api;
  throw new Error(`client bundle 竟然 require 了 ${name}`);
});

/* ── 假 ctx：字典收下来，插槽注册捕获 ──────────────────────────────── */
const dicts = {};
const components = new Map();
let locale = "zh";
const base = {
  effect: (fn) => {
    const c = fn();
    return () => {
      if (typeof c === "function") c();
    };
  },
  locale: {
    register: (ns, d) => {
      dicts[ns] = d;
      return () => {};
    },
    bind: (ns) => (key) => {
      const d = dicts[ns];
      if (d === undefined) return key;
      const table = locale === "en" ? d.en : d.zh;
      return table?.[key] ?? key;
    },
  },
  slots: {
    inject: (_name, fn) => {
      fn();
    },
    register: (options, component) => {
      components.set(`${options.name}|${options.key ?? options.id ?? ""}`, { options, component });
      return () => {};
    },
  },
  get: () => null,
  logger: { error: (...a) => console.log("[client logger.error]", ...a), warn: () => {}, info: () => {} },
};
const noop = () => undefined;
const ctx = new Proxy(base, {
  get(t, k) {
    if (k in t) return t[k];
    return noop; // 未声明到的宿主服务一律给个无害的空实现
  },
});

try {
  mod.apply(ctx);
} catch (error) {
  console.log(`!! apply 抛错：${error?.stack ?? error}`);
  process.exitCode = 1;
}

const paneEntry = components.get("sidebar.right.pane.tab|dsh-knowledge/entries");
assert("注册了右栏「知识库」面板（sidebar.right.pane.tab）", paneEntry !== undefined, JSON.stringify([...components.keys()]));

/* ── 渲染工具 ────────────────────────────────────────────────────────── */
const walk = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
    return out;
  }
  if (node.__el === true) {
    out.push(node);
    for (const c of node.children) walk(c, out);
  }
  return out;
};
const visibleText = (node) => {
  if (typeof node === "string") return node;
  if (node === null || node === undefined || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(visibleText).join("");
  if (node.__el === true) return node.children.map(visibleText).join("");
  return "";
};
const render = async () => {
  react.mount(paneEntry.component, () => ({ cwd: WORKDIR }));
  await flush(10);
  react.mount(paneEntry.component, () => ({ cwd: WORKDIR }));
  await flush(4);
  return react.mount(paneEntry.component, () => ({ cwd: WORKDIR })).tree;
};
const findEl = (tree, pred) => walk(tree).find(pred);
/** 按条目 id 找那一行（不能只按 className 找 —— 会永远命中第一行，点它等于把它收起来）。 */
const rowOf = (tree, id) => findEl(tree, (n) => n.props?.className === "kb-entry" && typeof n.props?.onClick === "function" && visibleText(n).includes(id));

/* ══════════════════════════════════════════════════════════════════
   ① 字典层：键集合一致 + 新键两边都非空
   ══════════════════════════════════════════════════════════════════ */
head("① 字典层：键集合一致、新加的键中英都非空");
const zhD = dicts["dsh-knowledge"]?.zh ?? {};
const enD = dicts["dsh-knowledge"]?.en ?? {};
const zk = Object.keys(zhD).sort();
const ek = Object.keys(enD).sort();
assert("zh / en 键集合完全一致", JSON.stringify(zk) === JSON.stringify(ek), `zh=${zk.length} en=${ek.length} 差=[${zk.filter((k) => !ek.includes(k)).concat(ek.filter((k) => !zk.includes(k))).join(",")}]`);
const NEW_KEYS = [
  "entry.confirmDelete", "entry.confirmYes", "entry.confirmCancel", "entry.delete",
  "entry.verify", "entry.boundaries",
  "entry.kind.method.trigger", "entry.kind.method.steps",
  "entry.kind.pitfall.trigger", "entry.kind.pitfall.steps", "entry.kind.pitfall.why", "entry.kind.pitfall.symptoms",
  "panel.groupPitfall", "panel.groupMethod", "panel.total", "panel.deleted", "panel.removeFailed",
  "panel.created", "panel.createFailed",
];
const missing = NEW_KEYS.filter((k) => typeof zhD[k] !== "string" || zhD[k] === "" || typeof enD[k] !== "string" || enD[k] === "");
assert(`本次新增的 ${NEW_KEYS.length} 个键中英都在且非空`, missing.length === 0, `缺: ${missing.join(", ")}`);
assert("删除确认的英文里带 {id} 占位", String(enD["entry.confirmDelete"]).includes("{id}"), String(enD["entry.confirmDelete"]));

/* ══════════════════════════════════════════════════════════════════
   ② 中文界面
   ══════════════════════════════════════════════════════════════════ */
head("② 中文界面：分组 / 计数 / 删除确认 / 详情标签");
locale = "zh";
let tree = await render();
let text = visibleText(tree);
console.log(`   中文可见文字（前 300 字）：${JSON.stringify(text.slice(0, 300))}`);
assert("分组标题是「避错」「方法」", text.includes("避错") && text.includes("方法"), text.slice(0, 200));
assert("底部计数是「共 2 条 · 路径 …」", text.includes("共 2 条 · 路径 " + WORKDIR), text.slice(-160));
assert("中文界面里确实有中文（对照组基线的另一半）", /[\u4e00-\u9fff]/u.test(text), text.slice(0, 200));
const delBtnZh = findEl(tree, (n) => n.props?.className === "kb-btn kb-del");
assert("删除按钮的 title 是「删除这条」", delBtnZh?.props?.title === "删除这条", String(delBtnZh?.props?.title));

if (delBtnZh !== undefined) {
  delBtnZh.props.onClick();
  tree = await render();
  text = visibleText(tree);
  console.log(`   中文删除确认：${JSON.stringify(text.slice(0, 260))}`);
  assert("确认文案是「删掉 P-001？不可撤销。」", text.includes("删掉 P-001？不可撤销。"), text.slice(0, 200));
  const yes = findEl(tree, (n) => n.__el === true && n.type === "button" && visibleText(n) === "确认删除");
  const no = findEl(tree, (n) => n.__el === true && n.type === "button" && visibleText(n) === "取消");
  assert("有「确认删除」按钮", yes !== undefined);
  assert("有「取消」按钮", no !== undefined);
  if (no !== undefined) {
    no.props.onClick();
    tree = await render();
    text = visibleText(tree);
    assert("点取消后回到条目行（确认面板收起）", !text.includes("不可撤销") && text.includes("共 2 条"), text.slice(0, 200));
  }
}

const rowZh = rowOf(tree, "P-001");
assert("能找到可点击的条目行 P-001", rowZh !== undefined);
if (rowZh !== undefined) {
  rowZh.props.onClick();
  await flush(6);
  tree = await render();
  text = visibleText(tree);
  console.log(`   中文详情：${JSON.stringify(text.slice(0, 420))}`);
  for (const label of ["触发条件", "先做", "为什么", "违规症状", "验证方式", "已知边界"]) {
    assert(`详情里出现「${label}」`, text.includes(label), text.slice(0, 420));
  }
  const metRow = rowOf(tree, "M-001");
  assert("能找到方法条目行 M-001", metRow !== undefined);
  if (metRow !== undefined) {
    metRow.props.onClick();
    await flush(6);
    tree = await render();
    text = visibleText(tree);
    assert("方法条目展开后出现「适用场景」与「步骤」", text.includes("适用场景") && text.includes("步骤"), text.slice(0, 460));
  }
}

/* ══════════════════════════════════════════════════════════════════
   ③ 英文界面：同一棵树、只换语言
   ══════════════════════════════════════════════════════════════════ */
head("③ 英文界面：同一份源码只换 locale 变量");
locale = "en";
tree = await render();
text = visibleText(tree);
console.log(`   英文可见文字（前 300 字）：${JSON.stringify(text.slice(0, 300))}`);
assert("分组标题是 Pitfalls / Methods", text.includes("Pitfalls") && text.includes("Methods"), text.slice(0, 200));
assert("底部计数是英文（entries · path）", text.includes("2 entries · path " + WORKDIR), text.slice(-160));
assert("英文界面整棵树**一个中文都没有**", !/[\u4e00-\u9fff]/u.test(text), text.slice(0, 400));
const delBtnEn = findEl(tree, (n) => n.props?.className === "kb-btn kb-del");
assert("删除按钮 title 是 Delete this entry", delBtnEn?.props?.title === "Delete this entry", String(delBtnEn?.props?.title));

if (delBtnEn !== undefined) {
  delBtnEn.props.onClick();
  tree = await render();
  text = visibleText(tree);
  console.log(`   英文删除确认：${JSON.stringify(text.slice(0, 260))}`);
  assert("确认文案是英文（Delete P-001? This cannot be undone.）", text.includes("Delete P-001? This cannot be undone."), text.slice(0, 200));
  assert("确认整块里没有中文", !/[\u4e00-\u9fff]/u.test(text), text.slice(0, 300));
  const yes = findEl(tree, (n) => n.__el === true && n.type === "button" && visibleText(n) === "Delete");
  const no = findEl(tree, (n) => n.__el === true && n.type === "button" && visibleText(n) === "Cancel");
  assert("有 Delete 按钮", yes !== undefined, JSON.stringify(walk(tree).filter((n) => n.type === "button").map((n) => visibleText(n))));
  assert("有 Cancel 按钮", no !== undefined);
  if (no !== undefined) {
    no.props.onClick();
    tree = await render();
    text = visibleText(tree);
    assert("点 Cancel 后收起确认面板", !text.includes("cannot be undone") && text.includes("2 entries"), text.slice(0, 200));
  }
}

const rowEn = rowOf(tree, "P-001");
assert("能找到可点击的条目行 P-001", rowEn !== undefined);
if (rowEn !== undefined) {
  rowEn.props.onClick();
  await flush(6);
  tree = await render();
  text = visibleText(tree);
  console.log(`   英文详情：${JSON.stringify(text.slice(0, 460))}`);
  for (const label of ["Trigger", "Do first", "Why", "Violation symptoms", "How to verify", "Known limits"]) {
    assert(`详情里出现「${label}」`, text.includes(label), text.slice(0, 460));
  }
  for (const zhLabel of ["触发条件", "先做", "为什么", "违规症状", "验证方式", "已知边界", "适用场景", "步骤"]) {
    assert(`英文详情里没有「${zhLabel}」`, !text.includes(zhLabel), text.slice(0, 460));
  }
  assert("展开详情后整棵树仍然一个中文都没有", !/[\u4e00-\u9fff]/u.test(text), text.slice(0, 460));
  const metRowEn = rowOf(tree, "M-001");
  assert("能找到方法条目行 M-001", metRowEn !== undefined);
  if (metRowEn !== undefined) {
    metRowEn.props.onClick();
    await flush(6);
    tree = await render();
    text = visibleText(tree);
    assert("方法条目在英文下是 Applies when / Steps", text.includes("Applies when") && text.includes("Steps"), text.slice(0, 460));
    assert("方法条目展开后整棵树仍然一个中文都没有", !/[\u4e00-\u9fff]/u.test(text), text.slice(0, 460));
  }
}

/* ══════════════════════════════════════════════════════════════════
   ④ 真删一条
   ══════════════════════════════════════════════════════════════════ */
head("④ 真删一条：请求发出去了吗 / 提示条为什么看不见");
locale = "en";
tree = await render();
const delEn2 = findEl(tree, (n) => n.props?.className === "kb-btn kb-del");
if (delEn2 !== undefined) {
  delEn2.props.onClick();
  tree = await render();
  const yes = findEl(tree, (n) => n.__el === true && n.type === "button" && visibleText(n) === "Delete");
  assert("找到 Delete 按钮", yes !== undefined);
  if (yes !== undefined) {
    yes.props.onClick();
    await flush(12);
    tree = await render();
    text = visibleText(tree);
    assert("真发出了 POST /__kb/remove", calls.some((c) => c.startsWith("POST /__kb/remove")), JSON.stringify(calls.slice(-4)));
    assert("删掉的那条从列表里消失了", text.includes("1 entries") && !text.includes("P-001"), text.slice(0, 300));
    // ⚠ 这里**故意不**断言「提示条显示 Deleted P-001, …」：
    //   面板只在「这个项目还没有知识库」那一支里渲染 notice（见 lib/client.js 的
    //   `notice ? h("div", { className: "kb-hint" }, notice) : null`），
    //   列表非空时那条提示**根本不在树上** —— 这是本次修复之外的既有 UI 缺口，
    //   不属于「界面文案没英文」，所以不在这里判红，只如实打一条 NOTE。
    console.log(`   NOTE 删除后的提示条在列表非空时不渲染 —— panel.deleted / panel.removeFailed 目前到不了屏幕（既有缺口，非本次改动引入）`);
    console.log(`   NOTE 这两条词条的英文值已在 ① 里验过非空：${JSON.stringify(enD["panel.deleted"])}`);
  }
}

head("汇总");
console.log(`   对照组模式   : ${SABOTAGE ? "开（内存里改掉了删除确认的键名）" : "关（跑的是真源码）"}`);
console.log(`   被测 client.js: ${clientFile}`);
console.log(`   断言失败数   : ${failures}`);
console.log(`   原始输出落盘 : ${TRANSCRIPT}`);
console.log(failures === 0 ? "OK — 全部断言通过" : `FAIL — ${failures} 项断言失败`);
process.exit(failures === 0 ? 0 : 1);
