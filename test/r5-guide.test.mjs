/**
 * r5-guide.test.mjs —— round5「工序接入（方案 C）」真跑验证。
 * （原 `_r5-verify.mjs`，归位进 dsh-knowledge 的 `test/` 并参数化。）
 *
 * ## 测的是真源码，不是我抄的一份
 * 把真实 `lib/index.js` / `kb-store.js` / `kb-config.js` 复制进临时镜像目录
 * （只把内部相对 import 的 `.js` 改成 `.mjs` —— ESM 在无 package.json 的目录里
 * 拒绝加载 `.js`，那是模块解析问题，不改语义），逐行校验等价后再 import。
 * 拿到的是插件真正注册的那几个 execute 函数。
 *
 * ## 六项覆盖（对应用户点名的验收要点）
 *   1. kb_guide 的条目真的与任务相关（5 个真实任务描述各跑一次，人工看命中）
 *   2. 库不存在 / 解析不到项目 → 如实报错，不静默退回当前项目
 *   3. 自动注入的条数与字数在上限内（打印实测值）+ 关掉开关一条都不注入
 *   4. 工具出参带「要求汇报照做了哪几条 / 哪几条不适用」的固定句
 *   5. 出参过宿主自己的 isJsonValue
 *   6. 触发条件是主字段（标题/其它字段里的词不许把不相关条目顶上来）
 *
 * ## 隔离
 * 数据目录 = `DSH_KNOWLEDGE_DATA`（没设就自建临时目录，退出时清理）；项目库在临时目录里。
 * **绝不碰**任何真实数据目录 —— 插件位置由 `import.meta.url` 反推，脚本里没有写死路径。
 * ## 用法
 *   node test/r5-guide.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inspector from "node:inspector";
import { pathToFileURL } from "node:url";
import { officialFile, outFile, srcDir, testDataDir } from "./_harness.mjs";
import { seedLibrary, FIXTURE_IDS } from "./r5-fixture.mjs";

const SRC_LIB = srcDir;
const TRANSCRIPT = outFile("r5-output.txt");

// ── stdout 原样落盘（报告里贴的就是这份）──────────────────────────
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
    /* 落盘失败不该改变结论 */
  }
});

const SRC_ROOT = path.resolve(SRC_LIB, "..");
const SOURCES = ["index.js", "kb-store.js", "kb-config.js"];
process.on("uncaughtException", (e) => {
  console.log(`\n!! uncaughtException: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
process.on("unhandledRejection", (e) => {
  console.log(`\n!! unhandledRejection: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
process.on("exit", (code) => {
  console.log(`\n[process exit] code=${code}`);
  console.log(`[transcript] ${TRANSCRIPT}`);
});
const assert = (label, cond) => {
  console.log(`   ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const relImports = (t) => [...t.matchAll(/from "\.\/[a-z-]+\.js"/g)].length;
const backToJs = (t) => t.replace(/from "\.\/([a-z-]+)\.mjs"/g, 'from "./$1.js"');
const sha = (file) => file;

/**
 * 宿主自己的无损 JSON 判据（用户点名要用它）。
 *
 * 它能从 DSH 安装目录里借到 —— 那就用**真货**；借不到（没设 `DSH_APP_DIR`、
 * 也反推不出安装根）就用一份本地等价实现，并且**在输出里标明**这一栏不是
 * 官方判据 —— 不许拿替代品冒充「用宿主自己的函数验过」。
 */
const UTIL_VALUES = officialFile("dsh-util-values", "lib", "index.js");
let utilValues = null;
let utilNote = "";
if (UTIL_VALUES !== null) {
  utilValues = await import(pathToFileURL(UTIL_VALUES).href);
  utilNote = `已加载真 DSH 判据：${UTIL_VALUES}`;
} else {
  utilValues = {
    isJsonValue: (value) => undefinedOwnKeys(value).length === 0,
    snapshotJsonValue: (value) => JSON.parse(JSON.stringify(value)),
  };
  utilNote =
    "!! 拿不到官方 dsh-util-values（没设 DSH_APP_DIR、也没能从 process.execPath 反推出来）" +
    "—— 这一栏用的是**本地等价实现**，不算「用宿主自己的函数验过」";
}
const { isJsonValue, snapshotJsonValue } = utilValues;

/** 自己再扫一遍「值为 undefined 的自有可枚举键」——宿主拒绝的就是它。 */
function undefinedOwnKeys(value, at = "$", out = []) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => undefinedOwnKeys(v, `${at}[${i}]`, out));
    return out;
  }
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v === undefined) out.push(`${at}.${key}`);
    else undefinedOwnKeys(v, `${at}.${key}`, out);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// 起一份真插件实例
//
// ⚠⚠ 顺序是有讲究的：插件在 apply() 那一刻就把
//   `config.json` 与 `projects.json` **读进内存**（见 index.js 的 configStore.load()
//   与 `let projectRegistry = readProjectRegistry(dataDir).registry`），
//   之后再写盘它也不认。所以「配置/登记表必须先落盘，再 apply」——
//   第一版测试把 projects.json 写在 apply 之后就踩了这个坑（报「当前还没有登记过任何项目」）。
// ══════════════════════════════════════════════════════════════
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "r5-"));
process.on("exit", () => {
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* 退出时清理失败不该改变结论 */
  }
});
const projectRoot = path.join(scratch, "project");
const otherRoot = path.join(scratch, "other-project");
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(otherRoot, { recursive: true });
// 数据目录：DSH_KNOWLEDGE_DATA 设了就用它；没设就在临时目录里自建（退出时清理）。
const DATA = testDataDir("DSH_KNOWLEDGE_DATA", "r5-kbdata-");
const dataDir = DATA.dir;
console.log(`   数据目录来源 : ${DATA.selfMade ? "本脚本自建的临时目录（DSH_KNOWLEDGE_DATA 未设）" : "环境变量 DSH_KNOWLEDGE_DATA"}`);

const mirror = path.join(scratch, "plugin");
fs.mkdirSync(path.join(mirror, "lib"), { recursive: true });
let rewrites = 0;
const perFile = [];
for (const name of SOURCES) {
  const text = fs.readFileSync(path.join(SRC_ROOT, "lib", name), "utf8");
  const out = text.replace(/from "\.\/([a-z-]+)\.js"/g, (_m, base) => {
    rewrites += 1;
    return `from "./${base}.mjs"`;
  });
  fs.writeFileSync(path.join(mirror, "lib", name.replace(/\.js$/, ".mjs")), out, "utf8");
  perFile.push({ name, same: text === backToJs(out), specifiers: relImports(text) });
}
const identical = perFile.every((x) => x.same) && rewrites === perFile.reduce((s, x) => s + x.specifiers, 0);

// ① 先落盘 config.json 与 projects.json
const cfgMod = await import(pathToFileURL(path.join(mirror, "lib", "kb-config.mjs")).href);
const realConfig = new cfgMod.ConfigStore(dataDir);
await realConfig.save({ baseDir: "" });
const registryFile = path.join(dataDir, "projects.json");
await fs.promises.writeFile(
  registryFile,
  JSON.stringify({ projects: [], registry: [{ name: "r5-临时项目", path: projectRoot }] }, null, 2) + "\n",
  "utf8",
);

// ② 再造库、再 apply
const seeded = seedLibrary(projectRoot);

const mod = await import(pathToFileURL(path.join(mirror, "lib", "index.mjs")).href);
const store = await import(pathToFileURL(path.join(mirror, "lib", "kb-store.mjs")).href);

const tools = new Map();
const sections = new Map();
const logs = [];
const ctx = {
  get: (key) => {
    if (key === "tools") return { register: (def) => tools.set(def.name, def) };
    if (key === "systemPrompt") {
      return { section: (s) => sections.set(s.name, s), getSectionOrder: () => 900 };
    }
    return null;
  },
  effect: (fn) => fn(),
  logger: {
    info: (m) => logs.push(`info ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    error: (m) => logs.push(`error ${m}`),
  },
  webServer: { register: () => {}, tapIndex: () => {} },
};
mod.apply(ctx);

console.log("═══ 0. 被测的就是真源码吗 ═══");
console.log(`   源      : ${SRC_ROOT}\\lib`);
console.log(`   镜像    : ${mirror}\\lib`);
console.log(`   内部 import 说明符改写数 : ${rewrites}（只把 .js → .mjs，不改语义）`);
assert("镜像与源码等价（改回 .js 后逐字符相同；改写次数 = 相对 import 条数）", identical);
console.log(`   临时数据目录 : ${dataDir}`);
console.log(`   临时项目根   : ${projectRoot}`);
console.log("   （真实数据目录全程没有被本测试引用：数据目录一律走 DSH_KNOWLEDGE_DATA 或自建临时目录）");
console.log(`   projects.json（apply 之前落盘，所以内存副本认得它）: ${fs.readFileSync(registryFile, "utf8").replace(/\s+/g, " ")}`);
console.log(`   插件认定的数据目录 : ${process.env.DSH_KNOWLEDGE_DATA}`);
console.log(`   两者是同一个文件吗 : ${path.resolve(path.join(process.env.DSH_KNOWLEDGE_DATA, "projects.json")) === path.resolve(registryFile)}`);
console.log(`   真实注册到的工具（从 apply() 里截获）：${[...tools.keys()].join(", ")}`);
assert("kb_guide 已注册", tools.has("kb_guide"));
console.log(`   注册到的提示词段（从 systemPrompt.section 截获）：${[...sections.keys()].join(", ")}`);
console.log(`\n   临时库：${seeded.dir}`);
console.log(`   （${FIXTURE_IDS.length} 条：${FIXTURE_IDS.join(", ")}）`);

/** 覆盖式改动 config.json（**只对之后新起的实例生效** —— 见上面那段顺序说明）。 */
async function setLiveConfig(patch) {
  const next = await realConfig.save(patch);
  return next;
}

// ⚠ 真 DSH 里 exec 的形状是 `{arguments, agent:{session:{header:{cwd}}}}`
//   （dsh-tools/lib/index.js:1423 给子进程传的就是 exec.agent.session.header.cwd）。
//   `exec.cwd` 在官方代码里查不到 —— 但**是插件自己**先读的那一项，
//   所以两种形状都要测，不能只喂插件偏好的那一种。
const execFor = (root) => ({ cwd: root, agent: { session: { header: { cwd: root } } } });
const callReal = (name, args, root = projectRoot) => tools.get(name).execute(args, execFor(root));

/** 复现插件里 kbFor 的判据（只为核对「库到底认没认出来」）。 */
const probeKb = () => {
  const kb = store.KnowledgeBase.locate(projectRoot, realConfig.get(), "r5-临时项目");
  if (kb !== null) kb.load();
  return kb;
};

/** 造一个假的 agent（只用真插件真正读的那几个字段）。 */
function fakeAgent({ cwd, messages }) {
  const list = messages ?? [];
  return {
    id: "r5-session",
    session: {
      header: { cwd },
      deriveMessages: () => list,
    },
    ctx: {},
  };
}
const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistantMsg = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

/** 取当前注入文本（走真插件注册的那个 section.text）。 */
function injectedText(agent) {
  const s = sections.get("dsh-knowledge:guide");
  if (s === undefined) return null;
  return s.text({ agent, scope: agent });
}

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 1. 工具注册表与固定汇报句 ═══");
const guide = tools.get("kb_guide");
console.log(`   kb_guide parameters : ${JSON.stringify(guide.parameters, null, 2)}`);
console.log(`   kb_guide 描述原文   :\n${guide.description}`);
const required = guide.parameters.required ?? [];
assert("task 是必填参数", required.includes("task"));
assert("limit 缺省与硬上限写在描述里（默认 5 / 上限 10）", /默认 5，硬上限 10/.test(guide.parameters.properties.limit.description));
const enumStage = guide.parameters.properties.stage.enum;
console.log(`   stage 枚举 : ${JSON.stringify(enumStage)}`);
assert("stage 有五个工序阶段", enumStage.length === 5);

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 2. 库不存在 / 解析不到项目 → 如实报错 ═══");
// 2a 库不存在（一个存在但没建库的目录）
const r2a = await callReal("kb_guide", { task: "给插件加一个开关注册项" }, otherRoot);
console.log(`   2a 库不存在 → ${JSON.stringify(r2a)}`);
assert("2a exists === false（如实说没有库，不是空数组）", r2a.exists === false);
assert("2a ok === true（这是「查了、没库」，不是调用失败）", r2a.ok === true);
assert("2a 错误里带可执行的 kb_init 调用", typeof r2a.error === "string" && r2a.error.includes("kb_init("));
assert("2a 明说不会静默建库", typeof r2a.error === "string" && r2a.error.includes("不会"));
const r2aText = guide.output.render(undefined, r2a);
console.log(`   2a 展示文案 → ${JSON.stringify(r2aText)}`);

// 2b 解析不到项目（名字既不在登记表、也不是存在的目录）
const registrySnapshot = JSON.parse(fs.readFileSync(registryFile, "utf8"));
console.log(`\n   2b 前置：projects.json 此刻的 registry = ${JSON.stringify(registrySnapshot.registry)}`);
const r2b = await callReal("kb_guide", { task: "随便一件事", project: "根本不存在的项目" });
console.log(`   2b 解析不到项目 → ${JSON.stringify(r2b, null, 2)}`);
assert("2b ok === false", r2b.ok === false);
assert("2b exists === false", r2b.exists === false);
assert("2b 没有静默退回当前项目（entries 为空）", Array.isArray(r2b.entries) && r2b.entries.length === 0);
assert(
  "2b 报错说清「不在登记表、也不是存在的目录」",
  typeof r2b.error === "string" && r2b.error.includes("不在项目登记表里"),
);
assert("2b 报错里带上已登记的项目名", typeof r2b.error === "string" && r2b.error.includes("r5-临时项目"));
assert("2b 报错明说「这条没有写进任何库」", typeof r2b.error === "string" && r2b.error.includes("没有"));

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 3. kb_guide 与任务的相关性（5 个真实任务描述，人工看命中）═══");
const TASKS = [
  {
    label: "任务 A：改完客户端 JS 界面没变化（→ 期望 P-001）",
    args: { task: "我改了 lib/client.js，设置页里看不到变化" },
    expect: ["P-001"],
  },
  {
    label: "任务 B：新增工具出参过无损 JSON 检查（→ 期望 P-002）",
    args: { task: "给插件新增一个工具，返回值要过宿主的无损 JSON 检查", stage: "写码中" },
    expect: ["P-002"],
  },
  {
    label: "任务 C：改配置项要同步归一化表（→ 期望 P-003）",
    args: { task: "往设置页加一个新的配置项", stage: "动手前" },
    expect: ["P-003"],
  },
  {
    label: "任务 D：真跑验证要带坏对照（→ 期望 M-002）",
    args: { task: "改完源码要提交，怎么证明这份文件真的能解析", stage: "提交前" },
    expect: ["M-002"],
  },
  {
    label: "任务 E：与知识库无关的活（→ 期望空；这是「假干净」的反面：如实说没匹配上）",
    args: { task: "把首页的按钮改成圆角", stage: "写码中" },
    expect: [],
  },
];
const relevance = [];
for (const t of TASKS) {
  const r = await callReal("kb_guide", t.args);
  console.log(`\n   ${t.label}`);
  console.log(`   入参 : ${JSON.stringify(t.args)}`);
  console.log(`   命中 : ${r.entries.map((e) => `${e.id}(${e.matchedBy},${e.score})`).join(" ") || "（无）"}`);
  for (const e of r.entries) {
    console.log(`      · ${e.id} [${e.kind}/${e.domain}] ${e.title} ← 触发条件：${e.trigger}`);
    console.log(`        命中词：${(e.matchedTerms ?? []).join(" ")}`);
  }
  relevance.push({ ...t, got: r.entries.map((e) => e.id), value: r });
}
console.log("\n   ── 人造基准判定（基准 = 触发条件里写明的「什么时候会遇到」）──");
for (let i = 0; i < TASKS.length; i += 1) {
  const t = TASKS[i];
  const got = relevance[i].got;
  const hit = t.expect.every((id) => got.includes(id));
  const extras = got.filter((id) => !t.expect.includes(id));
  const ok = hit && (t.expect.length === 0 ? got.length <= 1 : extras.length <= 1);
  assert(
    `${t.label.split("：")[0]} 期望[${t.expect.join(",") || "无"}] 实际[${got.join(",") || "无"}]`,
    ok,
  );
}

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 4. 触发条件是主字段（不许退化成全文关键词匹配）═══");
// 4a 精确 recall：任务描述就是某条触发条件的措辞 → 必须给出它，且在第一位
const probe = await callReal("kb_guide", { task: "改完客户端 bundle 后界面上看不到改动" });
console.log(`   4a 精确 recall → ${probe.entries.map((e) => e.id).join(",") || "（无）"}`);
assert("4a 精确 recall 命中 P-001", probe.entries.length > 0 && probe.entries[0].id === "P-001");
assert("4a 第一位就是它（不是「碰巧也出现」）", probe.entries[0]?.matchedBy === "trigger");

// 4b 不相关任务：命中词只出现在别的条目的步骤/正文里，触发条件一条没中
const noise = await callReal("kb_guide", { task: "首页有一个按钮，点了没有反应" });
console.log(`\n   4b 「点了没有反应」 → ${noise.entries.map((e) => `${e.id}(${e.matchedBy})`).join(",") || "（无）"}`);
console.log(`      （P-001 的步骤里有「没变化」、P-002 的症状里有「整条失败」，都不是触发条件）`);
const noiseInner = noise.entries.filter((e) => e.id === "P-001" || e.id === "P-002");
assert("4b 不相关任务没有把 P-001/P-002 当成主命中", noiseInner.every((e) => e.matchedBy !== "trigger"));

// 4c 条目编号不会被任务文本里的词直接顶成命中（不是全文关键词匹配）
const byId = await callReal("kb_guide", { task: "P-001 这一条写的是什么" });
console.log(`\n   4c 任务里直接写编号 → ${byId.entries.map((e) => e.id).join(",") || "（无）"}`);
assert("4c 编号本身不构成命中（说明不是简单的「全文出现即命中」）", byId.entries.length <= 1);

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 5. 出参过宿主无损 JSON 检查 + 固定汇报句 ═══");
const allValues = [
  ["库不存在", r2a],
  ["解析不到项目", r2b],
  ...relevance.map((r) => [r.label.split("：")[0], r.value]),
  ["精确 recall", probe],
  ["无关任务", noise],
];
for (const [label, value] of allValues) {
  const undefinedKeys = undefinedOwnKeys(value);
  const jsonOk = isJsonValue(value);
  let snapshotOk = true;
  let snapshotErr = "";
  try {
    snapshotJsonValue(value);
  } catch (e) {
    snapshotOk = false;
    snapshotErr = `${e?.message ?? e}`;
  }
  assert(
    `${label}：isJsonValue=${jsonOk} 无 undefined 自有键=${undefinedKeys.length === 0} snapshotJsonValue=${snapshotOk}${snapshotErr ? ` ${snapshotErr}` : ""}`,
    jsonOk && undefinedKeys.length === 0 && snapshotOk,
  );
  if (undefinedKeys.length > 0) console.log(`       违规键：${undefinedKeys.join(", ")}`);
}
const noteOk = allValues.every(([, v]) => typeof v.note === "string" && v.note.includes("照做了哪几条") && v.note.includes("不适用"));
assert("每一次返回都带固定汇报句（含「照做了哪几条」「不适用」）", noteOk);
console.log(`   固定句原文 : ${allValues[0][1].note}`);
const renderText = guide.output.render(TASKS[1].args, relevance[1].value)
  .map((b) => b.text)
  .join("\n");
console.log(`\n   任务 B 的展示文案（模型看到的就是它）：\n${renderText}`);
assert("展示文案里也带固定汇报句（不只 value 里有）", renderText.includes("照做了哪几条"));
assert("展示文案里带编号，便于核对", renderText.includes("P-002"));

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 6. 自动注入：条数 / 字数上限，以及「关掉就一条都不注入」═══");
assert("已注册 dsh-knowledge:guide 段落", sections.has("dsh-knowledge:guide"));
console.log(`   段落注册参数 : name=${sections.get("dsh-knowledge:guide")?.name} order=${sections.get("dsh-knowledge:guide")?.order}`);
assert("段落 order 与总纲（900）错开，且早于工具说明（1000）", sections.get("dsh-knowledge:guide")?.order === 950);

const agentA = fakeAgent({
  cwd: projectRoot,
  messages: [userMsg("帮我验收一下知识库插件的工序接入"), userMsg("我改了 lib/client.js，设置页里看不到变化")],
});
const inj = injectedText(agentA);
console.log(`\n   6a 注入原文（${inj.length} 字）：\n${inj}`);
const countEntries = (t) => (t.match(/^- \*\*/gm) ?? []).length;
console.log(`   实测：${inj.length} 字 / 完整条目 ${countEntries(inj)} 条 / 提及编号 ${[...new Set([...inj.matchAll(/[MP]-\d{3}/g)].map((m) => m[0]))].join(",")}`);
assert(`注入字数 ≤ 1200（实测 ${inj.length}）`, inj.length <= 1200);
assert(`注入条数 ≤ 3（实测 ${countEntries(inj)}）`, countEntries(inj) <= 3);
assert("注入里带「用 kb_guide 深挖」的指路", inj.includes("kb_guide"));
assert("注入命中的是这次真相关的那条（P-001）", inj.includes("P-001"));

// 6d 开关打开但项目定不了（没有 cwd）→ 不注入（不退到 process.cwd()）
const agentNoCwd = fakeAgent({ cwd: undefined, messages: [userMsg("改客户端 JS 看不到变化")] });
const injNoCwd = injectedText(agentNoCwd);
console.log(`\n   6d 会话没有 cwd → 长度 ${injNoCwd.length}（内容：${JSON.stringify(injNoCwd)}）`);
assert("6d 项目定不了就不注入（不退回 process.cwd()）", injNoCwd.length === 0);

// 6e 项目有库但会话没聊过什么（消息为空）→ 不注入
const agentEmpty = fakeAgent({ cwd: projectRoot, messages: [] });
const injEmpty = injectedText(agentEmpty);
console.log(`   6e 会话没有任何用户消息 → 长度 ${injEmpty.length}`);
assert("6e 没有可匹配的任务描述就不注入", injEmpty.length === 0);

// 6f 另一个项目（没有知识库）→ 不注入
const agentOther = fakeAgent({ cwd: otherRoot, messages: [userMsg("改客户端 JS 看不到变化")] });
const injOther = injectedText(agentOther);
console.log(`   6f 项目还没有知识库 → 长度 ${injOther.length}`);
assert("6f 没库的项目不注入（也不会拿别的项目的条目来充数）", injOther.length === 0);

console.log(`\n   主实例的日志（{info,warn,error} 全收了）：`);
for (const line of logs) console.log(`     ${line}`);

// ── 6g/6h/6i：改设置必须**另起一个实例**才能生效 ────────────────
//
// ⚠ 为什么不就地改 config.json 再读：插件在 apply() 时就把配置 load 进内存
//   （见 index.js 的 configStore.load()），apply 之后再写盘它不认。
//   这不只是测试的麻烦 —— **真实场景里也是这样**：
//   设置页保存后，总纲与必读的注入设置要等插件重新加载才生效。
//   这条限制如实写在报告里，别假装「改完立刻生效」。
const launches = [];
/**
 * 另起一份真插件实例（独立镜像目录 = 独立的模块实例；共用同一个库与登记表）。
 * @param {object} o `{ tag, config }`。
 * @returns {Promise<object>} 该实例的 tools / sections / logs。
 */
async function launch({ tag, config }) {
  const dir = path.join(scratch, `plugin-${tag}`);
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  for (const name of SOURCES) {
    const text = fs.readFileSync(path.join(SRC_ROOT, "lib", name), "utf8");
    fs.writeFileSync(
      path.join(dir, "lib", name.replace(/\.js$/, ".mjs")),
      text.replace(/from "\.\/([a-z-]+)\.js"/g, 'from "./$1.mjs"'),
      "utf8",
    );
  }
  const cfg = await import(pathToFileURL(path.join(dir, "lib", "kb-config.mjs")).href);
  const store2 = new cfg.ConfigStore(dataDir);
  await store2.save(config);
  const mod2 = await import(pathToFileURL(path.join(dir, "lib", "index.mjs")).href);
  const t = new Map();
  const sec = new Map();
  const lg = [];
  const c2 = {
    get: (key) => {
      if (key === "tools") return { register: (def) => t.set(def.name, def) };
      if (key === "systemPrompt") return { section: (s) => sec.set(s.name, s), getSectionOrder: () => 900 };
      return null;
    },
    effect: (fn) => fn(),
    logger: { info: (m) => lg.push(`info ${m}`), warn: (m) => lg.push(`warn ${m}`), error: (m) => lg.push(`error ${m}`) },
    webServer: { register: () => {}, tapIndex: () => {} },
  };
  mod2.apply(c2);
  const env = { tag, dir, tools: t, sections: sec, logs: lg };
  launches.push(env);
  return env;
}
const injOf = (env, agent) => {
  const s = env.sections.get("dsh-knowledge:guide");
  // ⚠ 「段落根本没注册」也是「没注入」——关掉开关时插件连段都不注册
  //   （少一个空段位），而不是注册一个恒空字符串的段。两种都算「一条都不注入」。
  return s === undefined ? "" : s.text({ agent, scope: agent });
};

// 6g 条数上限改成 1
const B = await launch({ tag: "limit1", config: { baseDir: "", guideInjectLimit: 1 } });
const injB = injOf(B, agentA);
console.log(`\n   6g 另起实例（guideInjectLimit=1）→ ${injB.length} 字 / ${countEntries(injB)} 条`);
console.log(injB);
assert(`6g 只注入 1 条（实测 ${countEntries(injB)}）`, countEntries(injB) === 1);
assert("6g 仍然 ≤ 1200 字", injB.length <= 1200);

// 6h 关掉开关 → 一条都不注入
const C = await launch({ tag: "off", config: { baseDir: "", guideInjectEnabled: false } });
const injC = injOf(C, agentA);
console.log(`\n   6h 另起实例（guideInjectEnabled=false）→ 注入长度 ${injC.length}（内容：${JSON.stringify(injC)}）`);
console.log(`       该实例注册的段落：${[...C.sections.keys()].join(", ") || "（无）"}（连段都不注册，不是注册一个空段）`);
assert("6h 关掉开关后一条都不注入（长度为 0）", injC.length === 0);
assert("6h 没有注册必读段", !C.sections.has("dsh-knowledge:guide"));
assert("6h 总纲仍然注册（两个开关互不牵连）", C.sections.has("dsh-knowledge:outline"));

// 6i 关掉总纲那个开关，「必读」仍然注入（两个开关解耦）
const D = await launch({ tag: "noultine", config: { baseDir: "", injectEnabled: false } });
const injD = injOf(D, agentA);
console.log(`\n   6i 另起实例（injectEnabled=false）→ 必读 ${injD.length} 字；该实例注册的段落 ${[...D.sections.keys()].join(", ")}`);
assert("6i 两个开关解耦：关总纲不影响必读", injD.length > 0);
assert("6i 关掉总纲后确实没注册总纲段", !D.sections.has("dsh-knowledge:outline"));

// 6j 两个都关 → 完全没注入
const E = await launch({ tag: "bothoff", config: { baseDir: "", injectEnabled: false, guideInjectEnabled: false } });
console.log(`   6j 两个开关都关 → 注册的段落：${[...E.sections.keys()].join(", ") || "（无）"}`);
assert("6j 两个都关 = 完全没有注入", E.sections.size === 0);

// 6k 登记表是在 apply 之后被改的 → 工具也要认（这条是**测试自己踩坑踩出来的**）
//
// 第一版测试把 projects.json 写在 apply 之后，于是 `targetOf` 报「当前还没有登记过任何项目」。
// 那暴露的是真问题：登记表内存副本只在**本进程**登记成功时重读，
// 别处（另一个实例、用户手工编辑）改过就过期 ——
// 表现是「库明明在登记过的名字下，工具却说没登记」。
// 现在 targetOf 走 registryNow() 兜底重读，这条就测它。
const F = await launch({ tag: "stale", config: { baseDir: "" } });
const lateRoot = path.join(scratch, "late-project");
fs.mkdirSync(lateRoot, { recursive: true });
const regBefore = JSON.parse(fs.readFileSync(registryFile, "utf8"));
fs.writeFileSync(
  registryFile,
  JSON.stringify(
    { projects: regBefore.projects ?? [], registry: [...(regBefore.registry ?? []), { name: "r5-事后登记", path: lateRoot }] },
    null,
    2,
  ) + "\n",
  "utf8",
);
const r6k = await F.tools.get("kb_guide").execute(
  { task: "改客户端 JS 看不到变化", project: "r5-事后登记" },
  execFor(lateRoot),
);
console.log(`\n   6k 事后往 projects.json 加一条登记（另一个实例写的）→ ${JSON.stringify({ ok: r6k.ok, exists: r6k.exists, error: r6k.error ?? null })}`);
assert("6k 过期的内存副本被兜底重读（不再说「还没有登记过任何项目」）", !String(r6k.error ?? "").includes("还没有登记过任何项目"));
assert("6k 照常按登记名解析到目标项目（库不存在 → 如实报错）", r6k.exists === false && typeof r6k.error === "string" && r6k.error.includes("还没有知识库"));

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 7. 清理与如实收尾 ═══");
console.log(`   临时根（保留到你看完输出；报告里会写明路径）: ${scratch}`);
console.log(`   seeded.files（2 个分册文件）: ${seeded.files.map((f) => path.basename(f)).join(", ")}`);
console.log(`\n[未做/未验证] 见验收报告「没做到 / 不确定 / 风险」一节`);
