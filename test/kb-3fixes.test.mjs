/**
 * kb-3fixes.test.mjs —— dsh-knowledge 三项改动的**真跑**验证。
 *
 *   ① 无库时 kb_search / kb_list：返回形状与内容**逐字不变**（与改动前的源码对比），
 *      但展示文案里含可执行建议（带建议的 project / projectPath）。
 *   ② kb_prune(project=…)：只清目标项目、没动当前项目；不传 project 与改动前逐字一致；
 *      解析不到的项目名 → 如实报错、不静默退回当前项目。
 *   ③ 改名：默认不改名 + 有信号；确认搬运后库真到新路径且条数不变；
 *      目标已存在且非空 → 拒绝覆盖、如实报错、不留半成品。
 *   ④ 上述三条都验「解析不到的项目名」这一路。
 *
 * ## 为什么能算证据
 * 跑的是**真源码**：把 `lib/{index,kb-store,kb-config}.js` 复制进临时镜像
 * （只把内部相对 import 的 `.js` 改成 `.mjs` —— 无 package.json 的目录里 ESM 拒绝
 * 加载 `.js`，那是模块解析问题，不改语义），再从镜像 import，从 `apply(ctx)` 截获
 * **真正注册的工具与路由**。镜像与源码逐字符等价（改回 .js 后必须完全相同，
 * 且改写次数 == 源码里相对 import 条数）。
 *
 * 同一份脚本跑两遍：`SRC_BEFORE`（改动前的快照）与 `SRC_LIB`（改动后），
 * 「逐字一致」这条是拿**两份真源码的返回值**直接比出来的，不是我说的一致。
 *
 * ## render 的调用方式与 DSH 一致
 * `dsh-tools` 里是 `tool.execute(exec.arguments, exec)` 与
 * `tool.output.render(exec.arguments, value)`，且 value 是 `snapshotJsonValue`
 * 出来的**快照**、args 是**同一个对象**。这里照抄这个形态调 render。
 * 另外用真 DSH 的 `validateJsonSchemaValue` 校验每次返回值（schema 不合会当场报出来）。
 *
 * ## 隔离
 * 数据目录走 `DSH_KNOWLEDGE_DATA`（没设就自建临时目录，退出时清理），项目目录也在临时目录里。
 * **绝不引用**任何真实数据目录。
 *
 * ## 从干净检出就能跑
 * 被测源码由 `import.meta.url` 反推（`../lib`），改动前快照在同目录的 `_before-3fixes/`。
 * 除了可选的环境变量之外，**不需要任何前置条件**。
 *
 * 用法：node test/kb-3fixes.test.mjs
 *   （要借官方 react / 官方包的测试才需要 DSH_APP_DIR；本脚本只可选地借
 *    `dsh-tools` 的 JSON Schema 校验器，拿不到会**如实标出「这一栏不算证据」**。）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inspector from "node:inspector";
import { pathToFileURL } from "node:url";
import { officialFile, outFile, printSkip, srcDir } from "./_harness.mjs";

/** 本插件 `lib/` —— 被测源码。 */
const SRC_LIB = srcDir;
/**
 * 改动前的快照（随测试一起交付，`kb-3fixes` 的「逐字一致」判据要靠它）。
 *
 * 它同时是**本测试的对照组来源**：`DSH_KNOWLEDGE_SRC=<某份 lib 目录>` 可以把
 * 「被测源码」整个换成另一份（例如这份改动前快照）——
 * 用来证明「必备工具集合断言**会失败**」，而不是把「跑绿了」当证据。
 */
const SRC_BEFORE = path.join(path.dirname(srcDir), "test", "_before-3fixes");
const SRC_UNDER_TEST = process.env.DSH_KNOWLEDGE_SRC ? path.resolve(process.env.DSH_KNOWLEDGE_SRC) : SRC_LIB;
const CLIENT_NOW = fs.existsSync(path.join(SRC_UNDER_TEST, "client.js"))
  ? path.join(SRC_UNDER_TEST, "client.js")
  : null;
const TRANSCRIPT = outFile("kb-3fixes-output.txt");

// ── stdout 原样落盘（报告与文件同源）─────────────────────────────
const session = new inspector.Session();
session.connect();
const posted = [];
session.on("Runtime.consoleAPICalled", (e) => {
  posted.push(
    (e.params.args ?? [])
      .map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (typeof a.description === "string") return a.description;
        return a.type;
      })
      .join(" ") + "\n",
  );
});
session.post("Runtime.enable");
process.on("exit", () => {
  try {
    fs.writeFileSync(TRANSCRIPT, posted.join(""), "utf8");
  } catch {
    /* 落盘失败不该让验证结论改变 */
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

// ── 真 DSH 的返回值校验器（拿不到就如实说，不假装校验过）──────────
const DSH_JSON_SCHEMA = officialFile("dsh-tools", "lib", "types", "json-schema.js");
let validateJsonSchemaValue = null;
let validatorNote = "";
if (DSH_JSON_SCHEMA === null) {
  validatorNote =
    "!! 拿不到真 DSH 校验器（没设 DSH_APP_DIR、也没能从 process.execPath 反推出来）" +
    "—— 本报告的 schema 校验一栏**不算证据**";
} else {
  try {
    const js = await import(pathToFileURL(DSH_JSON_SCHEMA).href);
    validateJsonSchemaValue = js.validateJsonSchemaValue;
    validatorNote = `已加载真 DSH 校验器：${DSH_JSON_SCHEMA}`;
  } catch (error) {
    validatorNote = `!! 拿不到真 DSH 校验器（${error?.code ?? ""} ${error?.message ?? error}）—— 本报告的 schema 校验一栏**不算证据**`;
  }
}

const SOURCES = ["index.js", "kb-store.js", "kb-config.js"];
const backToJs = (t) => t.replace(/from "\.\/([a-z-]+)\.mjs"/g, 'from "./$1.js"');
const firstDiff = (a, b) => {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) return { line: i + 1, src: la[i], mir: lb[i] };
  }
  return null;
};
const filesUnder = (root, prefix = "") => {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...filesUnder(path.join(root, e.name), `${prefix}${e.name}/`));
    else out.push(`${prefix}${e.name}`);
  }
  return out.sort();
};

async function launch({ tag, srcDir, scratch, baseDir }) {
  const dataDir = path.join(scratch, "data");
  const workDir = path.join(scratch, "work");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const mirrorDir = path.join(scratch, "plugin");
  fs.mkdirSync(path.join(mirrorDir, "lib"), { recursive: true });
  let rewrites = 0;
  for (const n of SOURCES) {
    const text = fs.readFileSync(path.join(srcDir, n), "utf8");
    const out = text.replace(/from "\.\/([a-z-]+)\.js"/g, (_m, b) => {
      rewrites += 1;
      return `from "./${b}.mjs"`;
    });
    fs.writeFileSync(path.join(mirrorDir, "lib", n.replace(/\.js$/, ".mjs")), out, "utf8");
  }
  let identical = true;
  let specifiers = 0;
  let diff = null;
  for (const n of SOURCES) {
    const a = fs.readFileSync(path.join(srcDir, n), "utf8");
    const b = fs.readFileSync(path.join(mirrorDir, "lib", n.replace(/\.js$/, ".mjs")), "utf8");
    if (a !== backToJs(b)) {
      identical = false;
      diff = { n, d: firstDiff(a, backToJs(b)) };
    }
    specifiers += [...a.matchAll(/from "\.\/[a-z-]+\.js"/g)].length;
  }
  identical = identical && rewrites === specifiers;

  // config.json 必须在 apply() 之前落盘（apply 里 ConfigStore.load() 一次）
  const pre = await import(pathToFileURL(path.join(mirrorDir, "lib", "kb-config.mjs")).href);
  const realConfig = new pre.ConfigStore(dataDir);
  await realConfig.save({ baseDir, volumePerBook: 10 });

  const savedEnv = process.env.DSH_KNOWLEDGE_DATA;
  process.env.DSH_KNOWLEDGE_DATA = dataDir;
  const mod = await import(pathToFileURL(path.join(mirrorDir, "lib", "index.mjs")).href);
  const store = await import(pathToFileURL(path.join(mirrorDir, "lib", "kb-store.mjs")).href);
  const tools = new Map();
  const routes = new Map();
  const ctx = {
    get: (k) => (k === "tools" ? { register: (d) => tools.set(d.name, d) } : null),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: { register: (r) => routes.set(r.path, r), tapIndex: () => {} },
  };
  mod.apply(ctx);
  if (savedEnv === undefined) delete process.env.DSH_KNOWLEDGE_DATA;
  else process.env.DSH_KNOWLEDGE_DATA = savedEnv;

  /** 调工具：与 DSH 同形态（execute(args, exec) → render(args, value 的快照)）。 */
  const call = async (name, args, cwd = workDir) => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`没有注册工具 ${name}`);
    const value = await tool.execute(args, { cwd });
    const snapshot = JSON.parse(JSON.stringify(value));
    const content = tool.output.render(args, snapshot);
    const violations = validateJsonSchemaValue === null ? ["<校验器不可用>"] : validateJsonSchemaValue(tool.output.schema, snapshot, "value");
    return {
      value,
      snapshot,
      text: (content ?? []).map((c) => c?.text ?? "").join(""),
      violations,
    };
  };
  /** 退化路径：render 收到的是**另一个** args 对象（等价实现换了对象时）。 */
  const renderWithCopiedArgs = (name, args, snapshot) =>
    (tools.get(name).output.render({ ...args }, snapshot) ?? []).map((c) => c?.text ?? "").join("");

  const route = async (p, { method = "POST", body, query } = {}) => {
    const r = routes.get(p);
    if (r === undefined) throw new Error(`没有注册路由 ${p}`);
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
      url: query === undefined ? p : `${p}?${query}`,
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
      /* 非 JSON 就留 null */
    }
    return { status: out.status, json, raw: out.body };
  };

  const registryOf = () => {
    const f = path.join(dataDir, "projects.json");
    if (!fs.existsSync(f)) return { projects: [], registry: [] };
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return { projects: j.projects ?? [], registry: j.registry ?? [] };
  };

  return {
    tag, srcDir, scratch, dataDir, workDir, mirrorDir, registryPath: path.join(dataDir, "projects.json"),
    identical, diff, rewrites, specifiers, mod, store, realConfig, tools, routes, call, renderWithCopiedArgs, route, registryOf,
  };
}

const entry = (title, domain) => ({
  kind: "避错",
  domain,
  title,
  trigger: `${title} 的触发条件`,
  steps: ["动作一", "动作二"],
  why: `${title} 的依据`,
  symptoms: `${title} 的违规症状`,
});

// ══════════════════════════════════════════════════════════════
// 起两份真插件：BEFORE（改动前快照）与 NOW（改动后源码）
// ══════════════════════════════════════════════════════════════
const scratchBefore = fs.mkdtempSync(path.join(os.tmpdir(), "kbfix-before-"));
const scratchNow = fs.mkdtempSync(path.join(os.tmpdir(), "kbfix-now-"));
const BEFORE = await launch({ tag: "BEFORE", srcDir: SRC_BEFORE, scratch: scratchBefore, baseDir: path.join(scratchBefore, "kbroot") });
const NOW = await launch({ tag: "NOW", srcDir: SRC_UNDER_TEST, scratch: scratchNow, baseDir: path.join(scratchNow, "kbroot") });

head("0. 被测的是真源码吗 / 环境");
console.log(`   改动后源码 : ${SRC_UNDER_TEST}`);
console.log(`   改动前快照 : ${SRC_BEFORE}`);
console.log(`   BEFORE 镜像 : ${BEFORE.mirrorDir}\\lib  等价=${BEFORE.identical}（改写 ${BEFORE.rewrites} 处 / 源码相对 import ${BEFORE.specifiers} 条）`);
console.log(`   NOW    镜像 : ${NOW.mirrorDir}\\lib  等价=${NOW.identical}（改写 ${NOW.rewrites} 处 / 源码相对 import ${NOW.specifiers} 条）`);
console.log(`   ${validatorNote}`);
console.log(`   BEFORE 数据目录 : ${BEFORE.dataDir}（baseDir=${path.join(scratchBefore, "kbroot")}）`);
console.log(`   NOW    数据目录 : ${NOW.dataDir}（baseDir=${path.join(scratchNow, "kbroot")}）`);
console.log("   真实数据目录全程没有被本测试引用（数据目录一律走 DSH_KNOWLEDGE_DATA 或自建临时目录）");
assert("BEFORE 镜像与快照逐字符等价", BEFORE.identical, JSON.stringify(BEFORE.diff));
assert("NOW 镜像与源码逐字符等价", NOW.identical, JSON.stringify(NOW.diff));
console.log(`   截获的工具 : ${[...NOW.tools.keys()].join(", ")}`);
console.log(`   截获的路由 : ${[...NOW.routes.keys()].join(", ")}`);

// ── 工具集合断言（**故意不写死数字**）─────────────────────────────
//
// 这里原来写的是 `NOW.tools.size === 7`，加了 `kb_guide` 之后就成了过期基线：
// 数字一变就得改测试，而改测试的成本会让人倾向于**顺手把断言放宽**（甚至删掉）。
// 所以改成**集合断言**：
//   · `REQUIRED_TOOLS` 是「必须有」的完整集合（含 kb_guide，共 8 个）—— 少一个就红；
//   · 多出来的工具**不算失败**，但会打印出来（新加工具时看得见，不必改测试）。
// 这样它既能抓到「工具被漏注册」，又不会因为插件正常增加工具而永久红。
const REQUIRED_TOOLS = ["kb_search", "kb_add", "kb_list", "kb_get", "kb_guide", "kb_remove", "kb_prune", "kb_init"];
{
  const got = [...NOW.tools.keys()];
  const missing = REQUIRED_TOOLS.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !REQUIRED_TOOLS.includes(n));
  assert(
    `必备工具全部注册到了（应有 ${REQUIRED_TOOLS.length} 个：${REQUIRED_TOOLS.join(", ")}）`,
    missing.length === 0,
    `缺 ${JSON.stringify(missing)}；实际注册了 ${got.length} 个：${got.join(", ")}`,
  );
  console.log(`   （多出来的工具：${extra.length === 0 ? "（无）" : extra.join(", ")} —— 多不算失败，仅提示）`);
}
assert("关键路由都注册到了", ["/__kb/distill", "/__kb/projects", "/__kb/list"].every((p) => NOW.routes.has(p)));

// ══════════════════════════════════════════════════════════════
// ① 无库时的建议 + 返回形状不变
// ══════════════════════════════════════════════════════════════
head("1. 无库时 kb_list / kb_search：返回形状不变、展示文案含可执行建议");

const scenarios1 = [];
for (const env of [BEFORE, NOW]) {
  const p0 = path.join(env.scratch, "proj-p0");
  fs.mkdirSync(p0, { recursive: true });
  // 一个「登记过但还没建库」的项目：走真路由登记（不建库）
  const p1 = path.join(env.scratch, "proj-p1");
  fs.mkdirSync(p1, { recursive: true });
  const reg = await env.route("/__kb/projects", { body: { name: "无库项目", path: p1, cwd: p0 } });
  const a = await env.call("kb_list", {}, p0);
  const b = await env.call("kb_search", { query: "关键词" }, p0);
  const c = await env.call("kb_list", { project: "无库项目" }, p0);
  const d = await env.call("kb_list", { project: "没有这个项目" }, p0);
  const e = await env.call("kb_search", { query: "关键词", project: p1 }, p0);
  // 一个**存在但没登记**的目录：建议走路径形态（buildInitCall 的 else 分支）
  const p2 = path.join(env.scratch, "proj-p2");
  fs.mkdirSync(p2, { recursive: true });
  const f = await env.call("kb_list", { project: p2 }, p0);
  scenarios1.push({ env, p0, p1, p2, reg, a, b, c, d, e, f });
}
const [s1Before, s1Now] = scenarios1;
for (const s of scenarios1) {
  console.log(`\n   ── ${s.env.tag} ──`);
  console.log(`   登记路由 : status=${s.reg.status} body=${s.reg.raw}`);
  console.log(`   kb_list {}          value=${JSON.stringify(s.a.value)}`);
  console.log(`                       render=${JSON.stringify(s.a.text)}`);
  console.log(`   kb_search {query}   value=${JSON.stringify(s.b.value)}`);
  console.log(`                       render=${JSON.stringify(s.b.text)}`);
  console.log(`   kb_list 登记名       value=${JSON.stringify(s.c.value)}`);
  console.log(`                       render=${JSON.stringify(s.c.text)}`);
  console.log(`   kb_list 解析不到     value=${JSON.stringify(s.d.value)}`);
  console.log(`                       render=${JSON.stringify(s.d.text)}`);
  console.log(`   kb_search 传路径     value=${JSON.stringify(s.e.value)}`);
  console.log(`                       render=${JSON.stringify(s.e.text)}`);
  console.log(`   kb_list 未登记目录   value=${JSON.stringify(s.f.value)}`);
  console.log(`                       render=${JSON.stringify(s.f.text)}`);
  console.log(`   schema 违规 : ${JSON.stringify(s.a.violations)} / ${JSON.stringify(s.b.violations)} / ${JSON.stringify(s.c.violations)} / ${JSON.stringify(s.d.violations)} / ${JSON.stringify(s.e.violations)} / ${JSON.stringify(s.f.violations)}`);
}

console.log("");
for (const [label, field] of [["kb_list {}", "a"], ["kb_search {query}", "b"], ["kb_list 登记名", "c"], ["kb_list 解析不到", "d"], ["kb_search 传路径", "e"], ["kb_list 未登记目录", "f"]]) {
  const before = JSON.stringify(s1Before[field].value);
  const now = JSON.stringify(s1Now[field].value);
  assert(`「${label}」返回 value 与改动前逐字一致`, before === now, `before=${before} now=${now}`);
}
assert("kb_list 无库的 value 就是 {ok:true,exists:false,entries:[]}", JSON.stringify(s1Now.a.value) === '{"ok":true,"exists":false,"entries":[]}', JSON.stringify(s1Now.a.value));
assert("kb_search 无库的 value 就是 {ok:true,exists:false,results:[]}", JSON.stringify(s1Now.b.value) === '{"ok":true,"exists":false,"results":[]}', JSON.stringify(s1Now.b.value));
assert("改动前的展示文案里**没有**任何 kb_init 建议", !s1Before.a.text.includes("kb_init") && !s1Before.b.text.includes("kb_init") && !s1Before.c.text.includes("kb_init"));
assert("改动后 kb_list 无库文案含可执行建议（kb_init）", s1Now.a.text.includes("kb_init"));
assert("改动后 kb_search 无库文案含可执行建议（kb_init）", s1Now.b.text.includes("kb_init"));
assert("无 project 时建议里带的是**本次会话项目**的路径（不是写死「当前项目」）", s1Now.a.text.includes(`kb_init(projectPath="${s1Now.p0}")`), s1Now.a.text);
assert("按登记名查时建议是 kb_init(project=\"无库项目\")", s1Now.c.text.includes('kb_init(project="无库项目")'), s1Now.c.text);
assert("传的是「已登记项目的路径」时，建议用登记名（能解析就只给名字）", s1Now.e.text.includes('kb_init(project="无库项目")'), s1Now.e.text);
assert("传的是「存在但没登记的目录」时，建议带 projectPath", s1Now.f.text.includes(`kb_init(projectPath="${s1Now.p2}")`), s1Now.f.text);
assert("解析不到项目时**不**给「建库」建议（那是两回事）", s1Now.d.text.includes("未列出：") && !s1Now.d.text.includes("kb_init"), s1Now.d.text);
const copiedArgs = s1Now.env.renderWithCopiedArgs("kb_list", {}, s1Now.a.snapshot);
console.log(`   退化路径（render 拿到另一个 args 对象）: ${JSON.stringify(copiedArgs)}`);
assert("args 对象对不上时只给调用形状（不会说错项目）", copiedArgs.includes('kb_init(project="…", projectPath="…")') && !copiedArgs.includes(s1Now.p0), copiedArgs);
{
  // 交叉检查：先做一次「没有库」的调用，再做一次「有库」的调用，
  // 确认 WeakMap 记的目标只作用在它自己那次调用上。
  const pz = path.join(s1Now.env.scratch, "proj-x");
  fs.mkdirSync(pz, { recursive: true });
  await s1Now.env.call("kb_init", { project: "交叉项目", projectPath: pz });
  const withLib = await s1Now.env.call("kb_list", { project: "交叉项目" });
  const again = await s1Now.env.renderWithCopiedArgs("kb_list", {}, s1Now.a.snapshot);
  assert("有库的调用不产生建议文案", withLib.value.exists === true && !withLib.text.includes("kb_init"), withLib.text);
  assert("之后退化路径仍只给调用形状", again.includes('kb_init(project="…", projectPath="…")'), again);
}
assert("返回值都过真 DSH 的 output.schema 校验（0 违规）",
  [s1Now.a, s1Now.b, s1Now.c, s1Now.d, s1Now.e, s1Now.f].every((r) => r.violations.length === 0),
  JSON.stringify([s1Now.a.violations, s1Now.b.violations, s1Now.c.violations, s1Now.d.violations, s1Now.e.violations, s1Now.f.violations]));

// ══════════════════════════════════════════════════════════════
// ② kb_prune(project=…)
// ══════════════════════════════════════════════════════════════
head("2. kb_prune(project=…)：只清目标项目；不传 project 与改动前逐字一致");

const pruneEnv = [];
for (const env of [BEFORE, NOW]) {
  const pc = env.workDir; // 当前会话项目
  const pz = path.join(env.scratch, "proj-z");
  fs.mkdirSync(pz, { recursive: true });
  await env.call("kb_init", {}, pc); // 当前项目建库
  await env.call("kb_add", { ...entry("当前项目-1", "领域A") }, pc);
  await env.call("kb_add", { ...entry("当前项目-2", "领域A") }, pc);
  await env.call("kb_add", { ...entry("当前项目-3", "领域A") }, pc);
  await env.call("kb_init", { project: "乙库", projectPath: pz });
  await env.call("kb_add", { project: "乙库", ...entry("乙库-1", "领域B") });
  await env.call("kb_add", { project: "乙库", ...entry("乙库-2", "领域B") });
  await env.call("kb_add", { project: "乙库", ...entry("乙库-3", "领域B") });
  const cnt = async (project) => (await env.call("kb_list", project === null ? {} : { project }, pc)).value.entries;
  const before = { pc: (await cnt(null)).map((e) => e.id), z: (await cnt("乙库")).map((e) => e.id) };
  const noProject = await env.call("kb_prune", { keep: 1 }, pc);
  const afterNoProject = { pc: (await cnt(null)).map((e) => e.id), z: (await cnt("乙库")).map((e) => e.id) };
  const byName = await env.call("kb_prune", { keep: 1, project: "乙库" }, pc);
  const afterName = { pc: (await cnt(null)).map((e) => e.id), z: (await cnt("乙库")).map((e) => e.id) };
  // 再给乙库加两条，然后用**路径**形态清
  await env.call("kb_add", { project: "乙库", ...entry("乙库-4", "领域B") });
  await env.call("kb_add", { project: "乙库", ...entry("乙库-5", "领域B") });
  const byPath = await env.call("kb_prune", { keep: 2, project: pz }, pc);
  const afterPath = { pc: (await cnt(null)).map((e) => e.id), z: (await cnt("乙库")).map((e) => e.id) };
  const unknown = await env.call("kb_prune", { keep: 0, project: "没有这个项目" }, pc);
  const afterUnknown = { pc: (await cnt(null)).map((e) => e.id), z: (await cnt("乙库")).map((e) => e.id) };
  pruneEnv.push({ env, pc, pz, before, noProject, afterNoProject, byName, afterName, byPath, afterPath, unknown, afterUnknown });
}
const [pBefore, pNow] = pruneEnv;
for (const p of pruneEnv) {
  console.log(`\n   ── ${p.env.tag} ──`);
  console.log(`   初始        当前项目=${JSON.stringify(p.before.pc)} 乙库=${JSON.stringify(p.before.z)}`);
  console.log(`   kb_prune({keep:1})               → value=${JSON.stringify(p.noProject.value)}`);
  console.log(`               清理后          当前项目=${JSON.stringify(p.afterNoProject.pc)} 乙库=${JSON.stringify(p.afterNoProject.z)}`);
  console.log(`   kb_prune({keep:1,project:"乙库"}) → value=${JSON.stringify(p.byName.value)}`);
  console.log(`               清理后          当前项目=${JSON.stringify(p.afterName.pc)} 乙库=${JSON.stringify(p.afterName.z)}`);
  console.log(`   kb_prune({keep:2,project:路径})  → value=${JSON.stringify(p.byPath.value)}`);
  console.log(`               清理后          当前项目=${JSON.stringify(p.afterPath.pc)} 乙库=${JSON.stringify(p.afterPath.z)}`);
  console.log(`   kb_prune({keep:0,project:"没有这个项目"}) → value=${JSON.stringify(p.unknown.value)}`);
  console.log(`               清理后          当前项目=${JSON.stringify(p.afterUnknown.pc)} 乙库=${JSON.stringify(p.afterUnknown.z)}`);
  console.log(`   schema 违规 : ${JSON.stringify(p.noProject.violations)} / ${JSON.stringify(p.byName.violations)} / ${JSON.stringify(p.byPath.violations)} / ${JSON.stringify(p.unknown.violations)}`);
}
console.log("");
assert("不传 project 的 kb_prune 返回值与改动前逐字一致",
  JSON.stringify(pBefore.noProject.value) === JSON.stringify(pNow.noProject.value),
  `before=${JSON.stringify(pBefore.noProject.value)} now=${JSON.stringify(pNow.noProject.value)}`);
assert("不传 project 只清当前项目（乙库 3 条未动）",
  pNow.afterNoProject.pc.length === 1 && pNow.afterNoProject.z.length === 3,
  JSON.stringify(pNow.afterNoProject));
assert("kb_prune(project=\"乙库\") 清了乙库（3→1）", pNow.byName.value.ok === true && pNow.afterName.z.length === 1, JSON.stringify(pNow.byName.value));
assert("kb_prune(project=\"乙库\") **没动**当前项目（仍 1 条）", pNow.afterName.pc.length === 1, JSON.stringify(pNow.afterName.pc));
assert("kb_prune(project=<路径>) 同样只作用于那个项目（乙库 3→2，当前项目不变）",
  pNow.byPath.value.ok === true && pNow.afterPath.z.length === 2 && pNow.afterPath.pc.length === 1,
  JSON.stringify({ byPath: pNow.byPath.value, after: pNow.afterPath }));
assert("kb_prune 解析不到项目名 → ok:false 且如实报错",
  pNow.unknown.value.ok === false && String(pNow.unknown.value.error).includes("不在项目登记表里") && String(pNow.unknown.value.error).includes("已登记的项目名"),
  JSON.stringify(pNow.unknown.value));
assert("解析不到时**没有**退回当前项目（两边条数都没变）",
  JSON.stringify(pNow.afterUnknown) === JSON.stringify(pNow.afterPath),
  JSON.stringify(pNow.afterUnknown));
assert("解析不到时的展示文案是「未清理：…」而不是假的成功",
  pNow.unknown.text.startsWith("未清理："), pNow.unknown.text);
assert("kb_prune 返回值都过 schema 校验",
  [pNow.noProject, pNow.byName, pNow.byPath, pNow.unknown].every((r) => r.violations.length === 0),
  JSON.stringify([pNow.noProject.violations, pNow.byName.violations, pNow.byPath.violations, pNow.unknown.violations]));

// ══════════════════════════════════════════════════════════════
// ③ 改名：默认不改名 + 有提示；确认后先搬库再改名
// ══════════════════════════════════════════════════════════════
head("3. 改名：默认不改名（有信号）；确认搬运 → 库真到新路径且条数不变；目标非空 → 拒绝覆盖");

const NOWC = NOW;
const baseDirNow = path.join(scratchNow, "kbroot");
const currentProjectIdsBefore = (await NOWC.call("kb_list", {})).value.entries.map((e) => e.id);

// ── 3a 默认拦下 ─────────────────────────────────────────────
{
  const P = path.join(scratchNow, "projects", "rename-1");
  fs.mkdirSync(P, { recursive: true });
  const r1 = await NOWC.route("/__kb/projects", { body: { name: "旧甲", path: P, cwd: NOWC.workDir } });
  console.log(`\n   登记「旧甲」 : status=${r1.status} body=${r1.raw}`);
  assert("先登记一个新名字（没有改名风险）→ 200", r1.status === 200 && r1.json?.ok === true, r1.raw);
  const init = await NOWC.call("kb_init", { project: "旧甲" });
  await NOWC.call("kb_add", { project: "旧甲", ...entry("旧甲条目一", "甲领域") });
  await NOWC.call("kb_add", { project: "旧甲", ...entry("旧甲条目二", "甲领域") });
  const oldDir = path.join(baseDirNow, "旧甲");
  const newDir = path.join(baseDirNow, "新甲");
  const filesOld = filesUnder(oldDir);
  console.log(`   旧库 : ${oldDir}（${filesOld.length} 个文件）`);
  console.log(`   kb_init(project="旧甲") → dir=${init.value.dir} registered=${init.value.registered}`);

  const blocked = await NOWC.route("/__kb/projects", { body: { name: "新甲", path: P, cwd: NOWC.workDir } });
  console.log(`   改名「旧甲」→「新甲」（默认）: status=${blocked.status}`);
  console.log(`   body=${blocked.raw}`);
  assert("默认改名被拦下：409", blocked.status === 409, String(blocked.status));
  assert("回的是结构化信号 renameBlocked + oldName/oldDir/newDir",
    blocked.json?.renameBlocked === true && blocked.json.code === "RENAME_BLOCKED" &&
      blocked.json.oldName === "旧甲" && path.resolve(blocked.json.oldDir) === path.resolve(oldDir) &&
      path.resolve(blocked.json.newDir) === path.resolve(newDir),
    blocked.raw);
  assert("登记**没有**改名（仍登记为旧甲）", NOWC.registryOf().registry.find((e) => path.resolve(e.path) === path.resolve(P))?.name === "旧甲",
    JSON.stringify(NOWC.registryOf().registry));
  assert("原库还在、条数不变（2 条）", filesUnder(oldDir).join("|") === filesOld.join("|"), filesUnder(oldDir).join("|"));
  assert("新名字那个目录**没有被建出来**", !fs.existsSync(newDir));
  const still = await NOWC.call("kb_list", { project: "旧甲" });
  assert("按旧名字仍能读到那 2 条", still.value.exists === true && still.value.entries.length === 2, JSON.stringify(still.value.entries));

  // ── 3b 确认搬运 → 先搬库、再改名 ─────────────────────────
  const moved = await NOWC.route("/__kb/projects", { body: { name: "新甲", path: P, moveLibrary: true, cwd: NOWC.workDir } });
  console.log(`\n   确认搬运（moveLibrary:true）: status=${moved.status} body=${moved.raw}`);
  assert("确认后 200，并报出库从哪搬到哪（libraryMoved）",
    moved.status === 200 && path.resolve(moved.json?.libraryMoved?.newDir ?? "") === path.resolve(newDir) &&
      path.resolve(moved.json?.libraryMoved?.oldDir ?? "") === path.resolve(oldDir),
    moved.raw);
  assert("库真的到了新路径", fs.existsSync(newDir) && !fs.existsSync(oldDir));
  assert("搬运后**条数不变**（新库文件清单 == 旧库搬运前清单）", filesUnder(newDir).join("|") === filesOld.join("|"),
    `old=${filesOld.join("|")} new=${filesUnder(newDir).join("|")}`);
  assert("登记改成了新名字", NOWC.registryOf().registry.find((e) => path.resolve(e.path) === path.resolve(P))?.name === "新甲",
    JSON.stringify(NOWC.registryOf().registry));
  const after = await NOWC.call("kb_list", { project: "新甲" });
  console.log(`   kb_list(project="新甲") → ${JSON.stringify(after.value.entries?.map((e) => e.id))}`);
  assert("按新名字能读到 2 条，且编号不变", after.value.exists === true && JSON.stringify(after.value.entries.map((e) => e.id)) === '["P-001","P-002"]',
    JSON.stringify(after.value.entries?.map((e) => e.id)));
  assert("projects.json 的 projists 诊断清单也指向新路径（旧路径已不在清单里）",
    NOWC.registryOf().projects.includes(newDir) && !NOWC.registryOf().projects.includes(oldDir),
    JSON.stringify(NOWC.registryOf().projects));
  const again = await NOWC.route("/__kb/projects", { body: { name: "新甲", path: P, cwd: NOWC.workDir } });
  assert("同名重登记不再被拦（没有误报）", again.status === 200, again.raw);
}

// ── 3c 目标已存在且非空 → 拒绝覆盖 ───────────────────────────
{
  const P = path.join(scratchNow, "projects", "rename-2");
  fs.mkdirSync(P, { recursive: true });
  await NOWC.route("/__kb/projects", { body: { name: "旧乙", path: P, cwd: NOWC.workDir } });
  await NOWC.call("kb_init", { project: "旧乙" });
  await NOWC.call("kb_add", { project: "旧乙", ...entry("旧乙条目一", "乙领域") });
  const oldDir = path.join(baseDirNow, "旧乙");
  const newDir = path.join(baseDirNow, "新乙");
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, "占位.txt"), "这个目录是用户自己的，不许被覆盖\n", "utf8");
  const filesOldBefore = filesUnder(oldDir);
  const refused = await NOWC.route("/__kb/projects", { body: { name: "新乙", path: P, moveLibrary: true, cwd: NOWC.workDir } });
  console.log(`\n   目标已存在且非空（${newDir}\\占位.txt）: status=${refused.status}`);
  console.log(`   body=${refused.raw}`);
  assert("拒绝覆盖：409 + RENAME_MOVE_FAILED", refused.status === 409 && refused.json?.code === "RENAME_MOVE_FAILED", refused.raw);
  assert("报错说清目标非空、且没覆盖任何东西",
    String(refused.json?.error).includes("目标目录已存在且不是空的") && String(refused.json?.error).includes("没有覆盖任何东西"), String(refused.json?.error));
  assert("登记仍是旧名字", NOWC.registryOf().registry.find((e) => path.resolve(e.path) === path.resolve(P))?.name === "旧乙");
  assert("原库一个文件都没动", filesUnder(oldDir).join("|") === filesOldBefore.join("|"), filesUnder(oldDir).join("|"));
  assert("目标目录里那 1 个文件还在、没被吞", filesUnder(newDir).join("|") === "占位.txt", filesUnder(newDir).join("|"));
  const list = await NOWC.call("kb_list", { project: "旧乙" });
  assert("按旧名字仍读到 1 条", list.value.exists === true && list.value.entries.length === 1);
}

// ── 3d 客户端那条路（/__kb/distill + newProject）──────────────
{
  const P = path.join(scratchNow, "projects", "rename-3");
  fs.mkdirSync(P, { recursive: true });
  await NOWC.route("/__kb/projects", { body: { name: "旧丙", path: P, cwd: NOWC.workDir } });
  await NOWC.call("kb_init", { project: "旧丙" });
  await NOWC.call("kb_add", { project: "旧丙", ...entry("旧丙条目一", "丙领域") });
  const oldDir = path.join(baseDirNow, "旧丙");
  const newDir = path.join(baseDirNow, "新丙");
  const first = await NOWC.route("/__kb/distill", { body: { cwd: P, newProject: { name: "新丙", path: P } } });
  console.log(`\n   沉淀对话框「新建项目」改名: status=${first.status}`);
  console.log(`   body=${first.raw}`);
  assert("客户端这条路也回 409 + renameBlocked（能显示提示与那个动作）",
    first.status === 409 && first.json?.renameBlocked === true && first.json.code === "RENAME_BLOCKED", first.raw);
  assert("拦下时**没有**改名、没有搬库", NOWC.registryOf().registry.find((e) => path.resolve(e.path) === path.resolve(P))?.name === "旧丙" && fs.existsSync(oldDir) && !fs.existsSync(newDir));
  const second = await NOWC.route("/__kb/distill", { body: { cwd: P, newProject: { name: "新丙", path: P, moveLibrary: true } } });
  console.log(`   用户确认后: status=${second.status}`);
  console.log(`   body=${second.raw.slice(0, 400)}${second.raw.length > 400 ? "…（截断显示）" : ""}`);
  assert("确认后 200、给了沉淀指令、并报出库搬到哪了",
    second.status === 200 && second.json?.ok === true && typeof second.json.instruction === "string" &&
      path.resolve(second.json.libraryMoved?.newDir ?? "") === path.resolve(newDir),
    second.raw.slice(0, 300));
  assert("库真的在新路径、条数不变（1 条）", fs.existsSync(newDir) && !fs.existsSync(oldDir) && (await NOWC.call("kb_list", { project: "新丙" })).value.entries.length === 1);
  assert("distill 返回里的 count 也是 1（搬运没丢条目）", second.json.count === 1, String(second.json.count));
}

// ── 3e kb_init 那条路：不改名、但如实报出来 ───────────────────
{
  const P = path.join(scratchNow, "projects", "rename-4");
  fs.mkdirSync(P, { recursive: true });
  await NOWC.route("/__kb/projects", { body: { name: "旧丁", path: P, cwd: NOWC.workDir } });
  await NOWC.call("kb_init", { project: "旧丁" });
  await NOWC.call("kb_add", { project: "旧丁", ...entry("旧丁条目一", "丁领域") });
  const oldDir = path.join(baseDirNow, "旧丁");
  const newDir = path.join(baseDirNow, "新丁");
  const init = await NOWC.call("kb_init", { project: "新丁", projectPath: P });
  console.log(`\n   kb_init(project="新丁", projectPath=<旧丁那个路径>) → ${JSON.stringify({ ok: init.value.ok, dir: init.value.dir, created: init.value.created, registered: init.value.registered, renameBlocked: init.value.renameBlocked, oldName: init.value.oldName, oldDir: init.value.oldDir, newDir: init.value.newDir })}`);
  console.log(`   render=${JSON.stringify(init.text)}`);
  assert("kb_init 不再默默改名：registered=false 且 renameBlocked=true",
    init.value.ok === true && init.value.registered === false && init.value.renameBlocked === true, JSON.stringify(init.value));
  assert("登记仍是旧丁，原库一个文件没动", NOWC.registryOf().registry.find((e) => path.resolve(e.path) === path.resolve(P))?.name === "旧丁" && (await NOWC.call("kb_list", { project: "旧丁" })).value.entries.length === 1);
  assert("kb_init 的展示文案把「没改名」说出来（中英双语）",
    init.text.includes("没有改名") && init.text.includes("Rename not applied"), init.text);
  assert("kb_init 返回值过 schema 校验", init.violations.length === 0, JSON.stringify(init.violations));

  // ── 缺口修复的回归断言：拦下时**不许在建骨架之后再回** ──────────
  // ⚠ 原来 kb_init 是「先建骨架、再登记」，所以被拦下时「新丁」名下已经躺着
  //   一份刚建出来的空骨架 —— 用户随后点「把原库搬过去」会被
  //   「目标已存在且非空」挡下，得先手工清掉那个目录。现在登记排在建骨架之前，
  //   拦下就一个文件都不建。
  assert("拦下时**没有**在新名字那个目录留下任何东西（不再有空骨架）",
    !fs.existsSync(newDir) && JSON.stringify(init.value.created) === "[]",
    `newDir 存在=${fs.existsSync(newDir)} created=${JSON.stringify(init.value.created)} filesUnder(newDir)=${JSON.stringify(filesUnder(newDir))}`);
  assert("拦下时的展示文案不再谎报「已存在」", !init.text.includes("（已存在，未改动）"), init.text);

  const followUp = await NOWC.route("/__kb/projects", { body: { name: "新丁", path: P, moveLibrary: true, cwd: NOWC.workDir } });
  console.log(`   随后尝试「搬过去」: status=${followUp.status} code=${followUp.json?.code}`);
  console.log(`   body=${String(followUp.raw).slice(0, 300)}`);
  assert("「搬过去」不再被空骨架挡下：确认后真的搬了（库到新路径、登记改新名、条数不变）",
    followUp.status === 200 &&
      NOWC.registryOf().registry.find((e) => path.resolve(e.path) === path.resolve(P))?.name === "新丁" &&
      fs.existsSync(newDir) && !fs.existsSync(oldDir) &&
      (await NOWC.call("kb_list", { project: "新丁" })).value.entries.length === 1,
    followUp.raw);
}

// ── 3f 改名这一路没有碰到当前会话项目 ────────────────────────
{
  const nowIds = (await NOWC.call("kb_list", {})).value.entries.map((e) => e.id);
  assert("当前会话项目的库在整段改名测试前后完全没变",
    JSON.stringify(nowIds) === JSON.stringify(currentProjectIdsBefore), `${JSON.stringify(currentProjectIdsBefore)} → ${JSON.stringify(nowIds)}`);
}

// ══════════════════════════════════════════════════════════════
// ④ 解析不到的项目名 —— 三条路都要如实报错、不静默退回
// ══════════════════════════════════════════════════════════════
head("4. 「解析不到的项目名」在三条路上都如实报错、不静默退回当前项目");
{
  const pc = NOWC.workDir;
  const idsBefore = (await NOWC.call("kb_list", {})).value.entries.map((e) => e.id);
  const dirsBefore = filesUnder(pc);

  const l4 = await NOWC.call("kb_list", { project: "彻底不存在的项目" }, pc);
  const s4 = await NOWC.call("kb_search", { query: "x", project: "彻底不存在的项目" }, pc);
  const p4 = await NOWC.call("kb_prune", { keep: 0, project: "彻底不存在的项目" }, pc);
  const g4 = await NOWC.call("kb_get", { id: "P-001", project: "彻底不存在的项目" }, pc);
  const c4 = await NOWC.route("/__kb/distill", { body: { cwd: pc, project: "彻底不存在的项目" } });
  console.log(`   kb_list   → ${JSON.stringify(l4.value)}`);
  console.log(`               render=${JSON.stringify(l4.text)}`);
  console.log(`   kb_search → ${JSON.stringify(s4.value)}`);
  console.log(`               render=${JSON.stringify(s4.text)}`);
  console.log(`   kb_prune  → ${JSON.stringify(p4.value)}`);
  console.log(`               render=${JSON.stringify(p4.text)}`);
  console.log(`   kb_get    → ${JSON.stringify(g4.value)}`);
  console.log(`   /__kb/distill → status=${c4.status} body=${c4.raw}`);
  for (const [label, r] of [["kb_list", l4], ["kb_search", s4], ["kb_prune", p4], ["kb_get", g4]]) {
    assert(`${label} 解析不到 → 报错里说清「不在登记表 / 不是存在的目录」`,
      String(r.value.error ?? "").includes("不在项目登记表里") || String(r.value.error ?? "").includes("找不到项目"),
      JSON.stringify(r.value));
    assert(`${label} 解析不到 → 返回值过 schema 校验`, r.violations.length === 0, JSON.stringify(r.violations));
  }
  assert("distill 路由对解析不到的项目回 400 UNKNOWN_PROJECT", c4.status === 400 && c4.json?.code === "UNKNOWN_PROJECT", c4.raw);
  const idsAfter = (await NOWC.call("kb_list", {})).value.entries.map((e) => e.id);
  assert("当前会话项目的条目编号前后一致（没被写脏）", JSON.stringify(idsBefore) === JSON.stringify(idsAfter), `${JSON.stringify(idsBefore)} → ${JSON.stringify(idsAfter)}`);
  assert("当前项目目录里没有多出任何库文件", JSON.stringify(filesUnder(pc)) === JSON.stringify(dirsBefore), JSON.stringify(filesUnder(pc)));
}

// ══════════════════════════════════════════════════════════════
// 5. 客户端那一半：**静态检查**（本会话没有浏览器控制，跑不了真界面）
// ══════════════════════════════════════════════════════════════
head("5. 客户端交互（③）—— 静态检查：i18n 词条齐、动作接得通、两条硬约束");
{
  // 对照组那份改前快照（`_before-3fixes/`）只带 index/kb-config/kb-store 三份，
  // **没有 client.js** —— 这一节无从查起。跳过要**明说**，不许静默跳过（否则看起来像通过）。
  if (CLIENT_NOW === null) {
    printSkip(`第 5 节静态检查：${SRC_UNDER_TEST} 下没有 client.js（这是「不算通过」，不是通过）`);
  } else {
    checkClientHalf();
  }
}

/** 第 5 节的实现：`CLIENT_NOW` 存在时才会被调用。 */
function checkClientHalf() {
  const clientSrc = fs.readFileSync(CLIENT_NOW, "utf8");
  const indexSrc = fs.readFileSync(path.join(SRC_UNDER_TEST, "index.js"), "utf8");
  /** 从 bundle 里把 `var zhCN = {…}` 这类字面量抠出来求值（只做花括号配对 + 跳字符串）。 */
  const dictOf = (src, name) => {
    const at = src.indexOf(`var ${name} = {`);
    if (at < 0) return null;
    const open = src.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '"' || ch === "'") {
        const q = ch;
        i += 1;
        while (i < src.length && src[i] !== q) {
          if (src[i] === "\\") i += 1;
          i += 1;
        }
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return new Function(`return ${src.slice(open, i + 1)};`)();
      }
    }
    return null;
  };
  const zh = dictOf(clientSrc, "zhCN");
  const en = dictOf(clientSrc, "enUS");
  assert("能从 bundle 里抠出 zhCN / enUS 两份字典", zh !== null && en !== null);
  const zhKeys = Object.keys(zh ?? {}).sort();
  const enKeys = Object.keys(en ?? {}).sort();
  console.log(`   词条数 : zh=${zhKeys.length} en=${enKeys.length}`);
  assert("中英词条一一对应（键集合完全相同）", JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `只在 zh: ${zhKeys.filter((k) => !enKeys.includes(k))} / 只在 en: ${enKeys.filter((k) => !zhKeys.includes(k))}`);
  const RENAME_KEYS = ["rename.blockedNotice", "rename.body", "rename.cancel", "rename.confirm", "rename.moved", "rename.moveFailedNotice", "rename.newDir", "rename.newName", "rename.oldDir", "rename.oldName", "rename.panelTitle"];
  console.log(`   ③ 的文案键 : ${RENAME_KEYS.join(", ")}`);
  assert("③ 的 11 条文案中英双语都齐（没有只在一边的）",
    RENAME_KEYS.every((k) => typeof zh?.[k] === "string" && zh[k] !== "" && typeof en?.[k] === "string" && en[k] !== ""),
    JSON.stringify(RENAME_KEYS.filter((k) => !zh?.[k] || !en?.[k])));
  assert("兜底文案（拿不到 t 时）也都在，且与字典一致性地为中文/英文",
    clientSrc.includes("把原库搬过去并改名") && clientSrc.includes("Move the library and rename"));
  assert("提示里带 oldName / oldDir / newDir 三个值（不是只说一句「失败了」）",
    clientSrc.includes("renamePending.oldName") && clientSrc.includes("renamePending.oldDir") && clientSrc.includes("renamePending.newDir"));
  assert("确认动作真的带 moveLibrary:true 重发同一条请求", clientSrc.includes("moveLibrary: true"));
  assert("客户端认得出 renameBlocked 并据此显示提示", clientSrc.includes("renameBlocked === true"));
  assert("搬运失败时保留 host 原话（含手工搬运提示）", clientSrc.includes("moveFailed ? String(b.error ?? \"\")"));
  assert("搬运成功后告诉用户库搬到哪了", clientSrc.includes("libraryMoved"));
  assert("改名提示面板真的挂进了渲染树（chooserNode 之后）", /chooserNode,\s*\n\s*renameNode,/.test(clientSrc));
  assert("硬约束：没有 dangerouslySetInnerHTML", !clientSrc.includes("dangerouslySetInnerHTML"));
  assert("硬约束：没有 require 任何 @deepseek-ai/* 包",
    !/require\(\s*["']@deepseek-ai\//.test(clientSrc) && !/require\(\s*["']@deepseek-ai\//.test(indexSrc));
}
head("汇总");
console.log(`   断言失败数 : ${failures}`);
console.log(`   临时目录   : ${scratchBefore}`);
console.log(`                ${scratchNow}`);
if (failures === 0) {
  fs.rmSync(scratchBefore, { recursive: true, force: true });
  fs.rmSync(scratchNow, { recursive: true, force: true });
  console.log("   （全部通过 → 临时目录已删除）");
} else {
  console.log("   （有失败 → 临时目录保留，便于复查）");
}
console.log(`   原始输出落盘 : ${TRANSCRIPT}`);
console.log(`[process exit] code=${process.exitCode ?? 0}`);
