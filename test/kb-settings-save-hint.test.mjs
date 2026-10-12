/**
 * kb-settings-save-hint.test.mjs —— 设置页的**保存提示**（缺口 3）的真跑验证。
 *
 * ## 这一份测的是什么
 * 四个插件的设置页保存方式不一致：`dsh-agent-profiles` 是「改了要点保存」+「有未保存改动」，
 * 而本插件这一页**没有保存按钮**（输入框离开焦点即存、开关/分段按钮点下去就存）。
 * 用户带着「找保存按钮」的心智进来，会以为没存上。所以这一页必须：
 *   ① **在会改配置的地方**把保存方式写出来（`settings.saveHint`，中英双语）；
 *   ② 真有没落盘的值时给出「有未保存改动」（`settings.dirtyHint`）—— 改完存下了就撤掉。
 *
 * ## 怎么算证据（不是静态 includes）
 * 跑的是**真的 `lib/client.js`**：喂一个够用的假 react（createElement/useState/useEffect/
 * useCallback + 真会重渲染的最小 hook 运行时）与假 ctx（locale / slots / effect），
 * 挂载 `settings.section` 那个组件，看**渲染出来的文字**里有没有这两句；
 * 再模拟「在数字框里打字（未离开焦点）」→「离开焦点（保存）」两次交互，看提示的加减。
 * `globalThis.fetch` 被换成桩：`GET /__kb/config` 回一份配置，`POST /__kb/config` 记一笔并回成功。
 *
 * ⚠ 假 react 只实现本 bundle 用到的那几个 API，**不是** React 的等价替身；
 *   它证明「这段组件按 DSH 的调用形态能跑通并产出这些文案」，
 *   不证明真实 React 下的视觉呈现（那要浏览器控制，跑不了 —— 如实写在这里）。
 *
 * ## 对照组（判据能失败）
 * `DSH_KNOWLEDGE_SAVE_HINT_SABOTAGE=1` 会在**内存里**把渲染处那两个键名改掉
 * （源文件不动），此时本测试的 ①② 断言**必须变红**：
 * ```powershell
 * $env:DSH_KNOWLEDGE_SAVE_HINT_SABOTAGE="1"; node test/kb-settings-save-hint.test.mjs   # 必须 FAIL
 * ```
 * 改不到（键名漂移）时脚本直接报错退出 2 —— 不许「没改成也算过」。
 *
 * ## 从干净检出就能跑
 * 插件位置由 `import.meta.url` 反推（`_harness.mjs` 的 `srcDir`），
 * **不需要任何环境变量、不碰任何数据目录**（客户端半只发 fetch，被桩接住了）。
 *
 * 用法：node test/kb-settings-save-hint.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { srcDir } from "./_harness.mjs";

const SABOTAGE = process.env.DSH_KNOWLEDGE_SAVE_HINT_SABOTAGE === "1";

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

/* ── 取源码：对照组在**内存里**改渲染处的键名，磁盘上的文件不动 ────────── */
const clientFile = path.join(srcDir, "client.js");
let clientSrc = fs.readFileSync(clientFile, "utf8");
if (SABOTAGE) {
  const before = clientSrc;
  for (const key of ["settings.saveHint", "settings.dirtyHint"]) {
    const needle = `tr("${key}")`;
    const count = clientSrc.split(needle).length - 1;
    if (count !== 1) {
      console.log(`REFUSE: 对照组改不动 —— 源里 ${needle} 出现 ${count} 次（应为 1 次），键名可能漂移了`);
      process.exit(2);
    }
    clientSrc = clientSrc.replace(needle, 'tr("settings.__sabotaged__")');
  }
  if (clientSrc === before) {
    console.log("REFUSE: 对照组改不动 —— 替换后源码没有变化");
    process.exit(2);
  }
  console.log(`⚠ 对照组：已在内存里把渲染处的两个键名改掉（源文件未动）`);
}

/* ── 浏览器侧最小替身 ────────────────────────────────────────────────── */
const mkReact = () => {
  const state = { hooks: [], cursor: 0, needsRender: false };
  /**
   * ⚠ 与真 React 一样，**函数组件在这里就要被调用**（就地渲染）——
   *   只把函数塞进 children 不调用，整棵树走到子组件就断了。
   *   真 React 也是在父组件渲染到这一步时调用子组件，所以钩子顺序一致。
   */
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
      while (state.needsRender && guard < 20) {
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

/* ── fetch 桩：GET 配置 / POST 保存（记下每次保存的 patch） ───────────── */
const CONFIG = { volumePerBook: 10, maxTotal: 0, autoPruneThreshold: 0, maxEntries: 0, autoPruneKeep: 0, maxEntryBytes: 4096, baseDir: "", injectEnabled: true, injectMaxChars: 4000, guideInjectEnabled: true, guideInjectLimit: 3, searchLimit: 8, defaultKind: "避错", defaultDomain: "" };
const saves = [];
globalThis.fetch = (url, init) => {
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
  const reply = (payload) => Promise.resolve({ status: 200, ok: true, json: async () => payload });
  if (method === "POST" && String(url).startsWith("/__kb/config")) {
    saves.push(body ?? {});
    return reply({ ok: true, config: { ...CONFIG, ...(body ?? {}) } });
  }
  if (String(url).startsWith("/__kb/config")) {
    return reply({ ok: true, config: CONFIG, defaults: CONFIG, count: 0, exists: false, picker: { canPick: false }, targetDir: "D:/kb" });
  }
  return reply({ ok: false, error: `未预期的请求：${method} ${url}` });
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

const dicts = {};
const components = new Map();
let locale = "zh";
const ctx = {
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
    inject: (_name, fn) => fn(),
    register: (options, component) => {
      components.set(options.name, { options, component });
      return component;
    },
  },
  get: () => null,
  logger: { error: (...a) => console.log("[client logger.error]", ...a) },
};
mod.apply(ctx);

/* ── 渲染设置页 ──────────────────────────────────────────────────────── */
const settings = components.get("settings.section");
if (settings === undefined) {
  console.log(`REFUSE: 没注册 settings.section 插槽（注册了：${[...components.keys()].join(", ")}）`);
  process.exit(2);
}

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

const t = (key) => {
  const d = dicts["dsh-knowledge"];
  const table = locale === "en" ? d?.en : d?.zh;
  return table?.[key] ?? key;
};
const buildProps = () => ({ t });
const render = async () => {
  react.mount(settings.component, buildProps);
  await flush(6);
  react.mount(settings.component, buildProps);
  await flush(2);
  return react.mount(settings.component, buildProps).tree;
};

head("1. 中文设置页：保存提示在、且初始没有「有未保存改动」");
locale = "zh";
let tree = await render();
let text = visibleText(tree);
console.log(`   渲染出的可见文字（前 200 字）：${JSON.stringify(text.slice(0, 200))}`);
assert("① 设置页渲染出来了（不是空树、不是只剩「读取配置…」）", text.includes("启用知识库沉淀") && text.includes("容量与上限"), JSON.stringify(text.slice(0, 120)));
assert("② 保存提示出现在页面里（中文，含「改完要点保存」）", text.includes("改完要点保存"), JSON.stringify(text.slice(0, 200)));
assert("③ 提示里说明了这一页没有保存按钮（不留「按钮在哪」的悬念）", text.includes("本页没有保存按钮"), text);
assert("④ 初始**没有**「有未保存改动」（没有未落盘的编辑）", !text.includes("有未保存改动"), text);

head("2. 在数字框里打字（还没离开焦点）→ 出现「有未保存改动」");
const numInput = walk(tree).find((n) => n.type === "input" && n.props?.type === "number");
assert("找到了数字输入框", numInput !== undefined, JSON.stringify(walk(tree).filter((n) => n.type === "input").map((n) => n.props?.type)));
if (numInput !== undefined) {
  numInput.props.onChange({ target: { value: String((numInput.props.defaultValue ?? "0") + 1) } });
  tree = await render();
  text = visibleText(tree);
  assert("⑤ 改了还没落盘 → 提示「有未保存改动」", text.includes("有未保存改动"), text.slice(0, 260));
  assert("⑥ 这一刻**还没有**发保存请求（离开焦点才存）", saves.length === 0, JSON.stringify(saves));

  head("3. 离开焦点（= 保存）→ 值落盘、提示撤掉");
  const input2 = walk(tree).find((n) => n.type === "input" && n.props?.type === "number");
  input2.props.onBlur({ target: { value: String((input2.props.defaultValue ?? "0") + 1) } });
  await flush(6);
  tree = await render();
  text = visibleText(tree);
  console.log(`   保存请求：${JSON.stringify(saves)}`);
  assert("⑦ 真发出了保存请求（POST /__kb/config）", saves.length === 1, JSON.stringify(saves));
  assert("⑧ 保存成功后「有未保存改动」撤掉了", !text.includes("有未保存改动"), text.slice(0, 260));
  assert("⑨ 保存提示本身还在（撤的是徽标，不是说明）", text.includes("改完要点保存"), text.slice(0, 260));
}

head("4. 英文界面同样有这两句（中英双语）");
locale = "en";
tree = await render();
text = visibleText(tree);
console.log(`   英文可见文字（前 200 字）：${JSON.stringify(text.slice(0, 200))}`);
assert("⑩ 英文保存提示在（Click save after editing）", text.includes("Click save after editing"), text.slice(0, 200));
assert("⑪ 英文也说明了没有保存按钮", text.includes("no save button on this page"), text);
const zhD = dicts["dsh-knowledge"]?.zh ?? {};
const enD = dicts["dsh-knowledge"]?.en ?? {};
assert("⑫ 两条新文案中英都在、都非空",
  ["settings.saveHint", "settings.dirtyHint"].every((k) => typeof zhD[k] === "string" && zhD[k] !== "" && typeof enD[k] === "string" && enD[k] !== ""),
  JSON.stringify({ zh: [zhD["settings.saveHint"], zhD["settings.dirtyHint"]], en: [enD["settings.saveHint"], enD["settings.dirtyHint"]] }));
locale = "zh";

head("汇总");
console.log(`   对照组模式     : ${SABOTAGE ? "开（渲染处的键名已被内存改写）" : "关（跑的是真源码）"}`);
console.log(`   被测 client.js : ${clientFile}`);
console.log(`   断言失败数     : ${failures}`);
console.log(`[process exit] code=${failures === 0 ? 0 : 1}`);
