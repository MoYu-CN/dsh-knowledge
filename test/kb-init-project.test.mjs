/**
 * kb-init-project.test.mjs —— 「kb_init 能建指定项目 / 全新项目」的真跑验证。
 *
 * ## 为什么不是手写一份 kb_init 逻辑来测
 * 那样测的是我抄的那份，不是插件里跑的那份。
 * 所以这里把**真实源码** `lib/index.js` 复制进临时镜像目录
 * （只把内部相对 import 的 `.js` 改成 `.mjs` —— ESM 在无 package.json 的目录里
 * 拒绝加载 `.js`，那是模块解析问题，不改语义），再从镜像 `import`。
 * 镜像拷贝**逐行校验**（把 `.mjs` 说明符改回 `.js` 后必须与源码逐字符相同，
 * 且改写次数等于源码里相对 import 的条数 —— 只比 sha256 会恒不等，那是假失败）。
 * 拿到的 `kb_init` / `kb_add` 就是插件真正注册的那两个 execute 函数。
 *
 * ## 隔离
 * 全程只写 `DSH_KNOWLEDGE_DATA` 指向的临时数据目录 + 临时项目目录，
 * **绝不碰真实数据目录**。进程结束时把临时根整个删掉。
 *
 * ## 原始输出也落盘
 * 脚本用 `inspector` 会话把 stdout **原样**再写一份到
 * `DSH_TEST_OUT_DIR` 指向的目录（没设就是系统临时目录）里，
 * 文件名 `kb-init-project.test.out.txt`（不截断、不改编码）。
 * ⚠ **不往仓库里写** —— 否则跑一次测试就会在 `git status` 里多出一个输出文件。
 *
 * ## 从干净检出就能跑
 * 插件位置由 `import.meta.url` 反推（`_harness.mjs` 的 `srcDir`）。
 * **不需要任何环境变量。**
 *
 * 用法：node test/kb-init-project.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import inspector from "node:inspector";
import { pathToFileURL } from "node:url";
import { outFile, srcDir } from "./_harness.mjs";

const SRC_ROOT = path.resolve(srcDir, "..");
const TRANSCRIPT = outFile("kb-init-project.test.out.txt");

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
const flushTranscript = () => {
  try {
    fs.writeFileSync(TRANSCRIPT, posted.join(""), "utf8");
  } catch {
    /* 落盘失败不该让验证本身的结论改变 */
  }
};
process.on("exit", flushTranscript);

// 崩溃也要留痕（否则输出半截、看不出死在哪 —— 这正是报告里要避免的假象）
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

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const SOURCES = ["index.js", "kb-store.js", "kb-config.js"];
const relImports = (t) => [...t.matchAll(/from "\.\/[a-z-]+\.js"/g)].length;
const backToJs = (t) => t.replace(/from "\.\/([a-z-]+)\.mjs"/g, 'from "./$1.js"');
const firstDiff = (a, b) => {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) return { line: i + 1, src: la[i], mir: lb[i] };
  }
  return null;
};
const listFiles = (root) => {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return out.sort();
};

/**
 * 起一份**真插件**实例（各自独立镜像 + 独立数据目录 + 独立缓存）。
 *
 * ⚠ 为什么 baseDir 那节要单独起一份：插件在 `apply()` 时就把 `<数据目录>/config.json`
 *   读进内存（`new ConfigStore(dataDir); configStore.load()`），
 *   之后再写盘它也不认。而 `kb-config.js` 的 `ConfigStore` 在同一个模块实例里被共享，
 *   所以「先写 config 再 apply」只能靠**另建一个镜像目录**（模块缓存按键路径隔离）。
 *
 * @param {object} o `{ tag, scratch, baseDir }`。
 * @returns {Promise<object>} 一份可用的测试环境。
 */
async function launch({ tag, scratch, baseDir }) {
  const src = { root: scratch, dataDir: path.join(scratch, "data"), workDir: path.join(scratch, "work") };
  fs.mkdirSync(src.dataDir, { recursive: true });
  fs.mkdirSync(src.workDir, { recursive: true });
  const mirror = path.join(scratch, "plugin");
  fs.mkdirSync(path.join(mirror, "lib"), { recursive: true });
  let rewrites = 0;
  for (const name of SOURCES) {
    const text = fs.readFileSync(path.join(SRC_ROOT, "lib", name), "utf8");
    const out = text.replace(/from "\.\/([a-z-]+)\.js"/g, (_m, base) => {
      rewrites += 1;
      return `from "./${base}.mjs"`;
    });
    fs.writeFileSync(path.join(mirror, "lib", name.replace(/\.js$/, ".mjs")), out, "utf8");
  }
  const perFile = SOURCES.map((n) => {
    const a = fs.readFileSync(path.join(SRC_ROOT, "lib", n), "utf8");
    const b = fs.readFileSync(path.join(mirror, "lib", n.replace(/\.js$/, ".mjs")), "utf8");
    return { n, src: a, mir: b, same: a === backToJs(b), specifiers: relImports(a) };
  });
  const identical =
    perFile.every((x) => x.same) && rewrites === perFile.reduce((s, x) => s + x.specifiers, 0);
  const diffLine = perFile.map((x) => ({ n: x.n, d: firstDiff(x.src, backToJs(x.mir)) })).find((x) => x.d !== null);

  // config.json 必须在 apply() 之前落盘（用镜像里的真 ConfigStore 写，格式由它保证）
  const preCfg = await import(pathToFileURL(path.join(mirror, "lib", "kb-config.mjs")).href);
  const realConfig = new preCfg.ConfigStore(src.dataDir);
  await realConfig.save({ baseDir, volumePerBook: 10 });

  process.env.DSH_KNOWLEDGE_DATA = src.dataDir;
  const mod = await import(pathToFileURL(path.join(mirror, "lib", "index.mjs")).href);
  const store = await import(pathToFileURL(path.join(mirror, "lib", "kb-store.mjs")).href);

  const tools = new Map();
  const ctx = {
    // 只把 tools 服务喂进去（截获真实注册），其余服务留缺 → 软探测降级
    get: (key) => (key === "tools" ? { register: (def) => tools.set(def.name, def) } : null),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: { register: () => {}, tapIndex: () => {} },
  };
  mod.apply(ctx);
  for (const [n, def] of tools) if (typeof def.execute !== "function") throw new Error(`工具 ${n} 没有 execute`);

  const call = (name, args, cwd = src.workDir) => tools.get(name).execute(args, { cwd });
  const configStore = { get: () => realConfig.get() };
  const registryOf = () => {
    const f = path.join(src.dataDir, "projects.json");
    if (!fs.existsSync(f)) return { projects: [], registry: [] };
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return { projects: j.projects ?? [], registry: j.registry ?? [] };
  };

  /**
   * `kbFor` 的忠实移植（只为验证「缓存失效」这一条）。
   * 源码里 kbFor / cache / projectNameOf 都是 apply() 的闭包，外部 import 不到。
   * 移植按源码逐行对齐；**移植的不算证据**这一点已在报告里写明。
   */
  const cache = new Map();
  const kbFor = (projectRoot, explicitName = "") => {
    if (typeof projectRoot !== "string" || projectRoot.trim() === "") return null;
    const key = path.resolve(projectRoot.trim());
    const name =
      explicitName !== ""
        ? store.safeDirName(explicitName)
        : registryOf().registry.find((e) => path.resolve(e.path) === key)?.name ?? "";
    const cached = cache.get(key);
    if (cached !== undefined && cached.projectName === name) return cached;
    if (cached !== undefined) cache.delete(key);
    const kb = store.KnowledgeBase.locate(key, configStore.get(), name);
    if (kb === null) return null;
    kb.applyConfig(configStore.get());
    kb.load();
    cache.set(key, kb);
    return kb;
  };

  return { tag, ...src, mirror, identical, diffLine, rewrites, mod, store, realConfig, tools, call, configStore, registryOf, cache, kbFor };
}

// ══════════════════════════════════════════════════════════════
// 主实例（baseDir 为空 = 默认布局：库在项目目录里）
// ══════════════════════════════════════════════════════════════
const scratchA = fs.mkdtempSync(path.join(os.tmpdir(), "kbtest-"));
const A = await launch({ tag: "A", scratch: scratchA, baseDir: "" });

console.log("═══ 0. 被测的就是真源码吗 ═══");
console.log(`   源    : ${SRC_ROOT}\\lib`);
console.log(`   镜像  : ${A.mirror}\\lib`);
console.log(`   index.js 源    sha256 : ${sha(path.join(SRC_ROOT, "lib", "index.js")).slice(0, 16)}…`);
console.log(`   index.js 镜像  sha256 : ${sha(path.join(A.mirror, "lib", "index.mjs")).slice(0, 16)}…`);
console.log(`   内部 import 说明符改写数 : ${A.rewrites}（只把 .js → .mjs，不改语义）`);
console.log("   ⚠ 两个 sha256 不同是**预期的**（说明符被改写），等价判据是「改回 .js 后逐字符相同」");
console.log(`   临时数据目录 : ${A.dataDir}`);
console.log("   （真实数据目录 ~/.dsh/.dsh-knowledge-data 与 C:\\知识库 全程没有被这个测试引用过）");
assert("镜像与源码等价（逐行；改写次数 = 相对 import 条数）", A.identical);
if (!A.identical && A.diffLine !== undefined) {
  console.log(`   第一处差异 ${A.diffLine.n}:${A.diffLine.d.line}`);
  console.log(`     源  : ${JSON.stringify(A.diffLine.d.src)}`);
  console.log(`     镜像: ${JSON.stringify(A.diffLine.d.mir)}`);
}
console.log(`\n   真实注册到的工具（从 apply() 里截获）：${[...A.tools.keys()].join(", ")}`);

const call = A.call;
const registryOf = A.registryOf;
const kbFor = A.kbFor;
const workDir = A.workDir;
const scratch = scratchA;

console.log("\n═══ 1. 全新项目名 + 路径 → kb_init 真建出目录与文件 ═══");
const NEW_NAME = "乙项目";
const NEW_ROOT = path.join(scratch, "projects", "yi-project"); // 父目录也不存在（验 mkdir -p）
const init1 = await call("kb_init", { project: NEW_NAME, projectPath: NEW_ROOT });
console.log(`   调用   : kb_init({ project: "${NEW_NAME}", projectPath: "${NEW_ROOT}" })`);
console.log(`   返回   : ${JSON.stringify(init1)}`);
const expectedDir = path.join(NEW_ROOT, "知识库");
assert("ok === true", init1.ok === true);
assert("项目目录被建出来（父目录原本不存在 ⇒ mkdir -p 生效）", fs.existsSync(NEW_ROOT));
assert(`库目录 = <项目根>/知识库（实际 ${init1.dir}）`, path.resolve(init1.dir) === path.resolve(expectedDir));
assert("返回的 dir 真的在磁盘上", fs.existsSync(init1.dir));
const files1 = listFiles(NEW_ROOT);
console.log(`   磁盘文件清单（${NEW_ROOT}）：`);
for (const f of files1) console.log(`     ${f}`);
assert("总纲存在", files1.includes("知识库/00-开始这里-总纲.md"));
assert("方法主体存在", files1.includes("知识库/方法/00-方法主体.md"));
assert("避错主体存在", files1.includes("知识库/避错/00-避错主体.md"));
assert("created 列出了新建项", Array.isArray(init1.created) && init1.created.length >= 3);
console.log(`   可核对信息 : project=${JSON.stringify(init1.project)} path=${init1.path} registered=${init1.registered} prefix=${JSON.stringify(init1.prefix)}`);
assert("project / path / registered / prefix 都对",
  init1.project === NEW_NAME && path.resolve(init1.path) === path.resolve(NEW_ROOT) && init1.registered === true && typeof init1.prefix === "string");

const reg1 = registryOf();
console.log(`   projects.json registry : ${JSON.stringify(reg1.registry)}`);
const entry1 = reg1.registry.find((e) => e.name === NEW_NAME);
assert("已登记进项目登记表（名字 + 路径都对）", entry1 !== undefined && path.resolve(entry1.path) === path.resolve(NEW_ROOT));

console.log("\n═══ 2. 建完**立刻** kb_add(project=…) → 成功，且条目真落到那个库 ═══");
const before2 = kbFor(NEW_ROOT, NEW_NAME);
assert("先手工把一本（空）库塞进 kbFor 的缓存，制造「缓存已陈旧」的前提", before2 !== null && A.cache.size > 0);
const add2 = await call("kb_add", {
  project: NEW_NAME,
  kind: "避错",
  domain: "测试领域",
  title: "建完立刻写入",
  trigger: "验证 kb_init 之后缓存不阻断写入",
  steps: ["调 kb_init", "立刻调 kb_add"],
  why: "缓存里可能留着旧结论",
  symptoms: "kb_add 报「还没有知识库」",
});
console.log(`   kb_add 返回 : ${JSON.stringify(add2)}`);
assert("kb_add ok === true", add2.ok === true);
assert(`分到 P-001（实际 ${add2.id}）`, add2.id === "P-001");
const book2 = path.join(expectedDir, "避错", "避错-001-测试领域.md");
assert(`条目落到 ${path.relative(scratch, book2)}`, fs.existsSync(book2));
const bookText = fs.existsSync(book2) ? fs.readFileSync(book2, "utf8") : "";
assert("分册正文含 `## P-001 建完立刻写入`", bookText.includes("## P-001 建完立刻写入"));
assert("分册正文四段齐全（触发条件/先做/为什么/违规症状）",
  // ⚠ 「违规症状」在 markdown 里的完整标签带括号：`**违规症状（怎么判断你没做）**：`
  //   （见 kb-store.js 的 HEADINGS），所以这里只匹配字段名。
  ["**触发条件**", "**先做**", "**为什么**", "违规症状"].every((k) => bookText.includes(k)));
console.log(`   分册命中字段 : ${["**触发条件**", "**先做**", "**为什么**", "违规症状"].map((k) => `${k}=${bookText.includes(k)}`).join(" ")}`);
const idx2 = fs.readFileSync(path.join(expectedDir, "避错", "00-避错主体.md"), "utf8");
assert("主体索引同步了 P-001", idx2.includes("P-001"));
const list2 = await call("kb_list", { project: NEW_NAME });
console.log(`   kb_list(project="${NEW_NAME}") : ${JSON.stringify(list2.entries)}`);
assert("kb_list 能列出它", list2.exists === true && list2.entries.some((e) => e.id === "P-001"));
assert("新库的条目没有写进当前会话项目", !fs.existsSync(path.join(workDir, "知识库")));

console.log("\n═══ 3. 解析不到的项目名 → 如实报错，且没有静默建到当前项目 ═══");
const filesBefore3 = listFiles(workDir);
const init3 = await call("kb_init", { project: "根本不存在的项目" });
console.log(`   kb_init({ project: "根本不存在的项目" }) 返回 :`);
console.log(String(JSON.stringify(init3, null, 2)).split("\n").map((l) => `   ${l}`).join("\n"));
assert("ok === false", init3.ok === false);
assert("报错说清「既没登记、也不是存在的目录」", String(init3.error).includes("不在项目登记表里"));
assert("报错给出建新项目的可执行写法", String(init3.error).includes('kb_init(project="新项目名", projectPath='));
assert("没有在当前会话项目里建出库", !fs.existsSync(path.join(workDir, "知识库")));
assert("工作目录文件清单前后一致（没有副作用）", JSON.stringify(listFiles(workDir)) === JSON.stringify(filesBefore3));
assert(`登记表没被写脏（registry 条数 ${registryOf().registry.length}）`, registryOf().registry.length === 1);
const add3 = await call("kb_add", {
  project: "根本不存在的项目", kind: "避错", domain: "x", title: "x",
  trigger: "x", steps: ["x"], why: "x", symptoms: "x",
});
console.log(`   kb_add(project="根本不存在的项目") 返回 : ${JSON.stringify(add3)}`);
assert("kb_add 对同一个名字也是如实报错（不是静默写当前项目）", add3.ok === false && typeof add3.error === "string" && !fs.existsSync(path.join(workDir, "知识库")));

console.log("\n═══ 4. 不传 project / projectPath → 与加参数之前逐字一致 ═══");
const init4 = await call("kb_init", {});
console.log(`   kb_init({}) 返回 : ${JSON.stringify(init4)}`);
assert("ok === true", init4.ok === true);
assert(`dir = <会话 cwd>/知识库（实际 ${init4.dir}）`, path.resolve(init4.dir) === path.resolve(workDir, "知识库"));
console.log(`   created（新建清单，老代码同序同文案）: ${JSON.stringify(init4.created)}`);
assert("created 内容是老三样",
  JSON.stringify(init4.created) === JSON.stringify(["方法/", "方法/00-方法主体.md", "避错/", "避错/00-避错主体.md", "00-开始这里-总纲.md"]));
assert("没登记 ⇒ project 回空串、registered=false（老行为）", init4.project === "" && init4.registered === false);
const again4 = await call("kb_init", {});
assert("幂等：第二次 created 为空", again4.created.length === 0);
assert("老字段 ok/created/dir 一个不少（新字段是超集，不改老的）", ["ok", "created", "dir"].every((k) => Object.hasOwn(init4, k)));
const add4 = await call("kb_add", {
  kind: "避错", domain: "测试领域", title: "不传 project 的老路径",
  trigger: "t", steps: ["s"], why: "w", symptoms: "sym",
});
console.log(`   kb_add(不带 project) 返回 : ${JSON.stringify(add4)}`);
assert("不传 project 的 kb_add 仍写当前项目", add4.ok === true && fs.existsSync(path.join(workDir, "知识库", "避错", "避错-001-测试领域.md")));

console.log("\n═══ 5. NO_LIBRARY 报错里含可执行的下一步（原文照贴） ═══");
const GHOST_ROOT = path.join(scratch, "projects", "ghost"); // 存在、但没建过库的项目目录
fs.mkdirSync(GHOST_ROOT, { recursive: true });
const noLibArgs = { project: GHOST_ROOT, kind: "避错", domain: "d", title: "t", trigger: "t", steps: ["s"], why: "w", symptoms: "sym" };
const add5 = await call("kb_add", noLibArgs);
console.log("   ── kb_add 报错原文 ──");
console.log(String(add5.error).split("\n").map((l) => `   ${l}`).join("\n"));
assert("报错里有可执行的调用形状", String(add5.error).includes("kb_init(projectPath=") || String(add5.error).includes('kb_init(project="'));
assert("报错里带了建议值（项目路径）", String(add5.error).includes(GHOST_ROOT));
assert("报错里写明目标库会是哪个目录", String(add5.error).includes(path.join(GHOST_ROOT, "知识库")));
assert("报错里保留了「不会静默建库」这句", String(add5.error).includes("静默建库"));
assert("中英双语都在", String(add5.error).includes("Call kb_init") && String(add5.error).includes("no knowledge base yet"));

// 照报错里的建议再调一次 —— 建完必须立刻能写，否则这条建议是空头支票
const sugName = /project="([^"]*)"/.exec(String(add5.error));
const sugPath = /projectPath="([^"]*)"/.exec(String(add5.error));
const sugCall = { ...(sugName ? { project: sugName[1] } : {}), ...(sugPath ? { projectPath: sugPath[1] } : {}) };
console.log(`   照着报错里的建议调 : kb_init(${JSON.stringify(sugCall)})`);
const init5 = await call("kb_init", sugCall);
console.log(`   返回 : ${JSON.stringify(init5)}`);
assert("建议里的调用真的跑得通（ok === true）", init5.ok === true);
const add5b = await call("kb_add", noLibArgs);
console.log(`   建完立刻 kb_add : ${JSON.stringify(add5b)}`);
assert("照建议建完之后 kb_add 立刻成功", add5b.ok === true);

const GHOST2 = path.join(scratch, "projects", "ghost2");
fs.mkdirSync(GHOST2, { recursive: true });
const get5 = await call("kb_get", { id: "P-001", project: GHOST2 });
const rem5 = await call("kb_remove", { id: "P-001", project: GHOST2 });
console.log(`   kb_get   报错原文 : ${String(get5.error)}`);
console.log(`   kb_remove 报错原文 : ${String(rem5.error)}`);
assert("kb_get 的报错也带 kb_init 建议", String(get5.error).includes("kb_init("));
assert("kb_remove 的报错也带 kb_init 建议", String(rem5.error).includes("kb_init("));

console.log("\n═══ 6. 只给名字 / 只给路径 / 登记表不被写脏 ═══");
const seed = JSON.parse(fs.readFileSync(path.join(A.dataDir, "projects.json"), "utf8"));
seed.registry.push({ name: "甲项目", path: path.join(scratch, "projects", "jia") });
seed.registry.push({ name: "丙项目", path: path.join(scratch, "projects", "bing") });
fs.writeFileSync(path.join(A.dataDir, "projects.json"), JSON.stringify(seed, null, 2) + "\n", "utf8");

const init6 = await call("kb_init", { project: "丁项目", projectPath: path.join(scratch, "projects", "ding") });
const reg6 = registryOf();
console.log(`   registry 现在 : ${JSON.stringify(reg6.registry)}`);
console.log(`   projects 清单 : ${JSON.stringify(reg6.projects)}`);
assert("甲/丙两条老登记还在（registerProject 的读改写没抹掉它们）", ["甲项目", "丙项目"].every((n) => reg6.registry.some((e) => e.name === n)));
assert("丁项目已登记", reg6.registry.some((e) => e.name === "丁项目"));
assert("projects（库目录清单）里新旧都在", reg6.projects.length >= 3);

const init6b = await call("kb_init", { project: "丁项目" });
console.log(`   只给名字 kb_init({ project: "丁项目" }) : ok=${init6b.ok} dir=${init6b.dir} created=[${init6b.created.join(",")}]`);
assert("已登记的名字只给名字也能建（幂等命中同一个库）", init6b.ok === true && path.resolve(init6b.dir) === path.resolve(init6.dir));

const WU = path.join(scratch, "projects", "wu");
const init6c = await call("kb_init", { projectPath: WU });
console.log(`   只给路径 kb_init({ projectPath: "…\\wu" }) : ok=${init6c.ok} dir=${init6c.dir} registered=${init6c.registered}`);
assert("只给路径也能建（不登记：路径形态本来就不要求登记）", init6c.ok === true && fs.existsSync(init6c.dir) && init6c.registered === false);

// ══════════════════════════════════════════════════════════════
// 另一份实例：baseDir 非空（库在 <baseDir>/<项目名>，不在项目目录里）
// ══════════════════════════════════════════════════════════════
console.log("\n═══ 7. baseDir 布局 + 只给名字：库路径由「项目名」决定，缓存也得跟着失效 ═══");
const scratchB = fs.mkdtempSync(path.join(os.tmpdir(), "kbtest-base-"));
const BASE = path.join(scratchB, "basedir");
const B = await launch({ tag: "B", scratch: scratchB, baseDir: BASE });
console.log("   第二个实例（独立镜像 + 独立数据目录，config.json 在 apply() 前写好）：");
console.log(`     baseDir=${BASE}`);
console.log(`     镜像 ${B.mirror}`);
console.log(`     数据目录 ${B.dataDir}`);
assert("B 实例的镜像同样与源码等价", B.identical);

const BD_ROOT = path.join(scratchB, "projects", "bd-project");
const stale = B.kbFor(BD_ROOT, ""); // 空名字 → 库还没建 ⇒ null（缓存里没有它）
assert("空名字下这个项目还没有库（预期 null）", stale === null);
const init7 = await B.call("kb_init", { project: "戊项目", projectPath: BD_ROOT });
console.log(`   kb_init({ project: "戊项目", projectPath: "…\\bd-project" }) 返回 : ${JSON.stringify(init7)}`);
assert("库落在 <baseDir>/<项目名>", path.resolve(init7.dir) === path.resolve(path.join(BASE, "戊项目")));
assert("项目目录里**没有**多出一个「知识库」", !fs.existsSync(path.join(BD_ROOT, "知识库")));
assert("项目目录本身按 projectPath 建出来了", fs.existsSync(BD_ROOT));
const add7 = await B.call("kb_add", {
  project: "戊项目", kind: "方法", domain: "构建与部署", title: "baseDir 布局下写入",
  steps: ["建库", "写入"], verify: "条目落在 baseDir/戊项目", boundaries: "仅 baseDir 非空时",
});
console.log(`   kb_add(project="戊项目") : ${JSON.stringify(add7)}`);
assert("baseDir 布局下建完立刻写入成功（分到 M-001）", add7.ok === true && add7.id === "M-001");
assert("条目真的落在 baseDir/戊项目/方法 里",
  fs.existsSync(path.join(BASE, "戊项目", "方法", "方法-001-构建与部署.md")));
assert("来源标记 .origin.json 也写了（撞名保护）", fs.existsSync(path.join(BASE, "戊项目", ".origin.json")));
console.log(`   <baseDir>/戊项目 文件清单 : ${JSON.stringify(listFiles(path.join(BASE, "戊项目")))}`);

console.log("\n═══ 收尾 ═══");
fs.rmSync(scratchA, { recursive: true, force: true });
fs.rmSync(scratchB, { recursive: true, force: true });
console.log(`   两个临时根已删 : ${!fs.existsSync(scratchA) && !fs.existsSync(scratchB)}`);
console.log(`\nRESULT ${process.exitCode === 1 ? "FAIL（见上面 FAIL 行）" : "ALL PASS"}`);
