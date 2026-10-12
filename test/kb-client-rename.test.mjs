/**
 * kb-client-rename.test.mjs —— ③「改名」在**客户端**那一半的真跑验证。
 *
 * 做法：
 *  - 跑**真的** `lib/client.js`（`<script src>` 那种 lazy-CJS bundle）：
 *    给一个假的 `globalThis.window.__ModuleLoader__` 收下 factory，再喂一个够用的
 *    假 react（createElement/Fragment/useState/useEffect/useCallback + 一个真会重渲染的
 *    最小 hook 运行时）与假 ctx（locale / slots / effect / get("uiSession")）。
 *  - 跑**真的** `lib/index.js` 宿主半：临时镜像 + 临时数据目录 + 真路由 handler。
 *  - `globalThis.fetch` 被换成一个桥：客户端发出的请求**直接打到真路由**上。
 *    于是「点一下按钮 → 真的搬库」是端到端跑出来的，不是模拟的。
 *
 * ⚠ 假 react 只实现本 bundle 用到的那 5 个 API，**不是** React 的等价替身；
 *   它证明的是「这段组件代码按 DSH 的调用形态能跑通并产出这些文案」，
 *   不证明真实 React 下的视觉呈现（那个要浏览器控制，跑不了）。
 *
 * ## 从干净检出就能跑
 * 插件位置由 `import.meta.url` 反推（`_harness.mjs` 的 `srcDir`），数据目录与镜像
 * 都在系统临时目录里，退出时删除。**不需要任何环境变量。**
 * 原始输出落盘位置：`DSH_TEST_OUT_DIR` 设了写那儿，没设写系统临时目录 ——
 * **绝不往仓库里写**。
 *
 * 用法：node test/kb-client-rename.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inspector from "node:inspector";
import { pathToFileURL } from "node:url";
import { outFile, srcDir } from "./_harness.mjs";

const SRC = srcDir;
const TRANSCRIPT = outFile("kb-client-rename-output.txt");

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
    /* ignore */
  }
});
process.on("uncaughtException", (e) => {
  console.log(`\n!! uncaughtException: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
process.on("unhandledRejection", (e) => {
  console.log(`\n!! unhandledRejection: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
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

// ══════════════════════════════════════════════════════════════
// A. 宿主半（真 index.js + 真路由）
// ══════════════════════════════════════════════════════════════
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kbclient-"));
const dataDir = path.join(scratch, "data");
const baseDir = path.join(scratch, "kbroot");
const workDir = path.join(scratch, "work");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });
const mirrorDir = path.join(scratch, "plugin");
fs.mkdirSync(path.join(mirrorDir, "lib"), { recursive: true });
for (const n of ["index.js", "kb-store.js", "kb-config.js"]) {
  const text = fs.readFileSync(path.join(SRC, n), "utf8");
  fs.writeFileSync(
    path.join(mirrorDir, "lib", n.replace(/\.js$/, ".mjs")),
    text.replace(/from "\.\/([a-z-]+)\.js"/g, (_m, b) => `from "./${b}.mjs"`),
    "utf8",
  );
}
const pre = await import(pathToFileURL(path.join(mirrorDir, "lib", "kb-config.mjs")).href);
await new pre.ConfigStore(dataDir).save({ baseDir, volumePerBook: 10 });
process.env.DSH_KNOWLEDGE_DATA = dataDir;
const hostMod = await import(pathToFileURL(path.join(mirrorDir, "lib", "index.mjs")).href);
const tools = new Map();
const routes = new Map();
hostMod.apply({
  get: (k) => (k === "tools" ? { register: (d) => tools.set(d.name, d) } : null),
  effect: (fn) => fn(),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  webServer: { register: (r) => routes.set(r.path, r), tapIndex: () => {} },
});
console.log(`   宿主半镜像 : ${path.join(mirrorDir, "lib")}`);
console.log(`   数据目录   : ${dataDir}`);
console.log(`   baseDir    : ${baseDir}`);

const invoke = async (method, url, body) => {
  const u = new URL(url, "http://127.0.0.1:43120");
  const r = routes.get(u.pathname);
  if (r === undefined) return { status: 404, json: { ok: false, error: `no route ${u.pathname}` } };
  const out = { status: 0, body: "" };
  const res = {
    writeHead(s) {
      out.status = s;
      return this;
    },
    end(t) {
      if (t !== undefined && t !== null) out.body = String(t);
      return this;
    },
  };
  const text = body === undefined ? "" : JSON.stringify(body);
  const req = {
    method,
    url: u.pathname + u.search,
    headers: { host: "127.0.0.1:43120" },
    async *[Symbol.asyncIterator]() {
      if (text !== "") yield text;
    },
  };
  await r.handler(req, res);
  let json = null;
  try {
    json = JSON.parse(out.body);
  } catch {
    /* 非 JSON */
  }
  return { status: out.status, json };
};
const callTool = (name, args, cwd = workDir) => tools.get(name).execute(args, { cwd });
const registryOf = () => {
  const f = path.join(dataDir, "projects.json");
  if (!fs.existsSync(f)) return { projects: [], registry: [] };
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  return { projects: j.projects ?? [], registry: j.registry ?? [] };
};

// ══════════════════════════════════════════════════════════════
// B. 浏览器侧的最小替身（react / document / fetch / loader）
// ══════════════════════════════════════════════════════════════
const mkReact = () => {
  const state = { hooks: [], cursor: 0, needsRender: false };
  const createElement = (type, props, ...children) => ({
    __el: true,
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
  });
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
globalThis.fetch = (url, init) => {
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
  console.log(`   [fetch] ${method} ${url}`);
  return invoke(method, String(url), body).then((r) => ({
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    json: async () => r.json,
  }));
};

// 收下 factory
let factory = null;
globalThis.window = { __ModuleLoader__: { load: (d) => { factory = d.factory; } } };
const clientSrc = fs.readFileSync(path.join(SRC, "client.js"), "utf8");
new Function(clientSrc)();
assert("真 client.js 通过 __ModuleLoader__.load 注册了 factory", typeof factory === "function");

const react = mkReact();
const mod = factory((name) => {
  if (name === "react") return react.api;
  throw new Error(`client bundle 竟然 require 了 ${name}`);
});
assert("factory 返回 {inject, apply}", typeof mod?.apply === "function" && Array.isArray(mod?.inject));

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
  get: (key) =>
    key === "uiSession"
      ? { adapter: { current: { getSnapshot: () => ({ header: { cwd: workDir } }), subscribe: () => () => {} } } }
      : null,
  logger: { error: (...a) => console.log("[client logger.error]", ...a) },
};
mod.apply(ctx);
head("0. 客户端半跑起来了吗");
console.log(`   注册到的插槽 : ${[...components.keys()].join(", ")}`);
console.log(`   语言包 : zh=${Object.keys(dicts["dsh-knowledge"]?.zh ?? {}).length} en=${Object.keys(dicts["dsh-knowledge"]?.en ?? {}).length}`);
assert("四个插槽都注册了", components.size === 4, String(components.size));

// ── DOM 树小工具 ─────────────────────────────────────────────
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
const findButton = (tree, text) =>
  walk(tree).find((n) => n.type === "button" && visibleText(n).includes(text));
/** 选择器 / 提示面板那一行里的按钮（避免误点到头部那两个同名按钮）。 */
const rowButton = (tree, text) => {
  for (const n of walk(tree)) {
    const cls = typeof n.props?.className === "string" ? n.props.className : "";
    if (!cls.includes("kb-chooser-row")) continue;
    for (const c of n.children) {
      if (c?.__el === true && c.type === "button" && visibleText(c).includes(text)) return c;
    }
  }
  return undefined;
};
/** 「用户在这一屏看到什么」：提示面板的每行文字 + 面板里的按钮。 */
const panelLines = (tree) => {
  const lines = [];
  for (const n of walk(tree)) {
    const cls = typeof n.props?.className === "string" ? n.props.className : "";
    if (cls.includes("kb-chooser-hint")) lines.push(visibleText(n));
    else if (cls.includes("kb-chooser-row")) {
      for (const c of n.children) if (c?.__el === true && c.type === "button") lines.push(`[按钮] ${visibleText(c)}`);
    }
  }
  return lines;
};
/** 顶部那条 inline 提示（kb-head-notice）。 */
const noticeText = (tree) => {
  for (const n of walk(tree)) {
    const cls = typeof n.props?.className === "string" ? n.props.className : "";
    if (cls.includes("kb-head-notice")) return visibleText(n);
  }
  return "";
};

// ══════════════════════════════════════════════════════════════
// C. 场景：改名被拦 → 用户点「把原库搬过去」→ 真的搬了
// ══════════════════════════════════════════════════════════════
const prepare = async (projectPath, oldName) => {
  fs.mkdirSync(projectPath, { recursive: true });
  await invoke("POST", "/__kb/projects", { name: oldName, path: projectPath, cwd: workDir });
  await callTool("kb_init", { project: oldName });
  await callTool("kb_add", { project: oldName, kind: "避错", domain: "领域", title: `${oldName}-条目`, trigger: "t", steps: ["s"], why: "w", symptoms: "y" });
  return { oldDir: path.join(baseDir, oldName) };
};

const runClient = async (projectPath, oldName, newName, labels) => {
  const header = components.get("conversation.session.header.actions");
  const drafts = [];
  const inputActions = {
    setDraft: (t) => drafts.push(t),
    submit: () => drafts.push("<submit>"),
  };
  const buildProps = () => ({
    ...(header.options.inject?.() ?? {}),
    useInput: (sel) => sel({ draft: "" }),
    inputActions,
  });
  const view = react.mount(header.component, buildProps);
  const rerender = async () => {
    // 假 hook 运行时的状态活在 store 上：重挂一次就是一次重渲染
    react.mount(header.component, buildProps);
    await flush(3);
    return react.mount(header.component, buildProps).tree;
  };
  let tree = view.tree;
  // 1. 点头部的「沉淀」→ 拉项目清单
  findButton(tree, labels.open).props.onClick();
  await flush(4);
  tree = await rerender();
  // 2. 选「新建项目…」并填名字 / 路径
  walk(tree).find((n) => n.type === "select").props.onChange({ target: { value: "new" } });
  await flush(2);
  tree = await rerender();
  const inputs = walk(tree).filter((n) => n.type === "input");
  if (inputs.length < 2) throw new Error(`选择器里只渲染出 ${inputs.length} 个输入框，填不了名字/路径`);
  inputs[0].props.onChange({ target: { value: newName } });
  inputs[1].props.onChange({ target: { value: projectPath } });
  await flush(2);
  tree = await rerender();
  // 3. 点选择器那一行的确认（⚠ 不能用 findButton —— 头部那个按钮同名）
  rowButton(tree, labels.confirm).props.onClick();
  await flush(6);
  tree = await rerender();
  return { getTree: () => tree, rerender, drafts, inputActions };
};

head("1. 中文：改名被拦下的提示 + 「把原库搬过去」那个动作");
{
  const P = path.join(scratch, "projects", "rename-cn");
  const { oldDir } = await prepare(P, "旧中文");
  const newDir = path.join(baseDir, "新中文");
  const s = await runClient(P, "旧中文", "新中文", { open: "沉淀", confirm: "沉淀" });
  let tree = s.getTree();
  console.log("   用户看到的提示面板：");
  for (const line of panelLines(tree)) console.log(`     ${line.replace(/\s+/g, " ")}`);
  console.log(`   顶部提示条 : ${JSON.stringify(noticeText(tree))}`);
  const all = visibleText(tree);
  assert("提示面板出现（标题）", all.includes("这个路径已经登记过另一个名字"));
  assert("提示面板说明了为什么会看起来「库空了」", all.includes("库会指向一个空目录"));
  assert("提示面板明确说「这次没有改名」", all.includes("这次没有改名"));
  assert("面板里带原登记名与新名字", all.includes("原登记名：旧中文") && all.includes("要改成的名字：新中文"));
  assert("面板里带原库位置与新目录", all.includes(`原库位置：${oldDir}`) && all.includes(`改名后会指向：${newDir}`));
  assert("有「把原库搬过去并改名」这个可选动作", findButton(tree, "把原库搬过去并改名") !== undefined);
  assert("有「取消」按钮", findButton(tree, "取消") !== undefined);
  assert("顶部提示条说的是「改名没有执行」（不是假装成功）", all.includes("改名没有执行：登记与原库都保持不动"));
  assert("拦下时登记与原库都没动",
    registryOf().registry.find((e) => path.resolve(e.path) === path.resolve(P))?.name === "旧中文" &&
      fs.existsSync(oldDir) && !fs.existsSync(newDir),
    JSON.stringify(registryOf().registry));

  // 4. 点「把原库搬过去并改名」
  findButton(tree, "把原库搬过去并改名").props.onClick();
  await flush(8);
  tree = await s.rerender();
  const after = visibleText(tree);
  console.log(`   点确认后的顶部提示条 : ${JSON.stringify(noticeText(tree))}`);
  console.log(`   投给智能体的指令（前 160 字）: ${JSON.stringify(String(s.drafts[0] ?? "").slice(0, 160))}`);
  assert("库真的搬到了新路径、原路径已不在", fs.existsSync(newDir) && !fs.existsSync(oldDir));
  assert("条数不变（新库里有 1 条）", (await callTool("kb_list", { project: "新中文" }, workDir)).entries.length === 1);
  assert("登记改成了新名字", registryOf().registry.find((e) => path.resolve(e.path) === path.resolve(P))?.name === "新中文");
  assert("界面如实说「已把知识库搬到<新路径>」", after.includes(`已把知识库搬到${newDir}`), after.slice(0, 400));
  assert("改名提示面板已收起", !after.includes("这个路径已经登记过另一个名字"));
  assert("沉淀指令真的投出去了（不是空手）", typeof s.drafts[0] === "string" && s.drafts[0].length > 20);
}

head("2. 英文：同一套交互的英文文案");
{
  const P = path.join(scratch, "projects", "rename-en");
  const { oldDir } = await prepare(P, "OldEn");
  const newDir = path.join(baseDir, "NewEn");
  locale = "en";
  const s = await runClient(P, "OldEn", "NewEn", { open: "Distill", confirm: "Distill" });
  let tree = s.getTree();
  const all = visibleText(tree);
  console.log("   用户看到的英文提示面板：");
  for (const line of panelLines(tree)) console.log(`     ${line.replace(/\s+/g, " ")}`);
  console.log(`   英文顶部提示条 : ${JSON.stringify(noticeText(tree))}`);
  assert("英文提示面板出现", all.includes("This path is already registered under another name"));
  assert("英文文案说清为什么会看起来空了", all.includes("points it at an empty folder"));
  assert("英文文案带原登记名 / 新名字 / 两个目录",
    all.includes("Registered as：OldEn") && all.includes("New name：NewEn") && all.includes(`Library now at：${oldDir}`) && all.includes(`Would point at：${newDir}`));
  assert("英文的确认动作在", findButton(tree, "Move the library and rename") !== undefined);
  assert("英文的取消按钮在", findButton(tree, "Cancel") !== undefined);
  assert("英文提示条在", all.includes("Rename not applied"));
  findButton(tree, "Move the library and rename").props.onClick();
  await flush(8);
  tree = await s.rerender();
  assert("英文路径上确认后库也真的搬了、条数不变",
    fs.existsSync(newDir) && !fs.existsSync(oldDir) && (await callTool("kb_list", { project: "NewEn" }, workDir)).entries.length === 1);
  assert("英文界面说「Library moved to<新路径>」", visibleText(tree).includes(`Library moved to${newDir}`), visibleText(tree).slice(0, 300));
  locale = "zh";
}

head("3. 取消：什么都不改");
{
  const P = path.join(scratch, "projects", "rename-cancel");
  const { oldDir } = await prepare(P, "旧取消");
  const newDir = path.join(baseDir, "新取消");
  const s = await runClient(P, "旧取消", "新取消", { open: "沉淀", confirm: "沉淀" });
  let tree = s.getTree();
  assert("先确认提示面板在", visibleText(tree).includes("这个路径已经登记过另一个名字"));
  findButton(tree, "取消").props.onClick();
  await flush(4);
  tree = await s.rerender();
  const all = visibleText(tree);
  assert("点取消后面板收起", !all.includes("这个路径已经登记过另一个名字"));
  assert("点取消后顶部提示条也清掉了", !all.includes("改名没有执行"));
  assert("点取消后登记与原库一动不动",
    registryOf().registry.find((e) => path.resolve(e.path) === path.resolve(P))?.name === "旧取消" &&
      fs.existsSync(oldDir) && !fs.existsSync(newDir));
}

head("汇总");
console.log(`   断言失败数 : ${failures}`);
if (failures === 0) {
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("   （全部通过 → 临时目录已删除）");
} else {
  console.log(`   （有失败 → 临时目录保留：${scratch}）`);
}
console.log(`   原始输出落盘 : ${TRANSCRIPT}`);
console.log(`[process exit] code=${process.exitCode ?? 0}`);
