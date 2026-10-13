/**
 * kb-distill-cwd.test.mjs —— 「沉淀」按钮**项目识别**缺陷的修复验证（真跑）。
 *
 * ## 被测缺陷（2026-10 用户报的）
 * 点「沉淀」→ 选「由智能体自己决定」⇒ 投给智能体的指令写着
 *   「⚠ **当前没有任何候选项目**（没有登记过项目，当前会话项目也没有知识库）」
 * 而当前会话的项目**确实有库**（`kb_add` 一直写得进去）。
 *
 * ## 根因（两端各一半）
 * ① **客户端**：`currentCwd()` 唯一来源是 `uiSession.adapter.current.getSnapshot()`，
 *    而那是 **binding**（`{key, ctx, hooks, keyedHooks, props}`）——
 *    既没有 `header` 也没有顶层 `cwd` ⇒ **恒返回空串**。
 * ② **宿主**：`/__kb/distill` 只信请求体里的 `cwd`；为空时
 *    `projectCandidates("")` 里只剩「手工登记过的项目」（登记表通常为空）
 *    ⇒ 候选清单为空 ⇒ 指令说「没有候选项目」。
 *
 * ## 修法（本测试验证的对象）
 * 客户端改走根级 `sessions` 标准源，并**把 `sessionId` 一起发出去**；
 * 宿主用 `sessionId` 在自己手里（`ctx.get("sessions").get(id).header.cwd`）
 * 解析项目根 —— 客户端算不出来**不等于**「没有项目」。
 *
 * ## 为什么能算证据
 * 跑的是**真源码**：把 `lib/{index,kb-store,kb-config}.js` 复制进临时镜像
 * （只把内部相对 import 的 `.js` 改成 `.mjs` —— 无 package.json 的目录里 ESM 拒绝
 * 加载 `.js`，那是模块解析问题，不改语义），再从镜像 import，从 `apply(ctx)`
 * 截获**真正注册的路由**，用真 `handler(req, res)` 发请求、读**真的响应体**。
 *
 * ## 判据不是空转的（三重对照）
 * - `_before-3fixes/`（改动前的真源码快照）⇒ **必须**复现误报；
 * - `_sabotage-*`（把本次修复**拆掉**的当前源码）⇒ **必须**变红；
 * - cwd 正常时，改动前后两条指令**必须逐字一致**（没顺手改坏别的东西）。
 *
 * ## 隔离
 * 数据目录走 `DSH_KNOWLEDGE_DATA`（没设就自建临时目录，退出时清理），
 * 项目目录、知识库 baseDir 全在临时目录里。
 * **绝不引用** `C:\DSH\DSH Desktop\.dsh-knowledge-data` 或 `C:\知识库\DSHwork`。
 *
 * 用法：
 *   node test/kb-distill-cwd.test.mjs
 *   （产物写到 `DSH_TEST_OUT_DIR`；没设就写系统临时目录 —— 绝不往仓库里写）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inspector from "node:inspector";
import { pathToFileURL } from "node:url";
import { outFile, pluginRoot, srcDir } from "./_harness.mjs";

/** 改动前的真源码快照（对照组①）。 */
const SRC_BEFORE = path.join(pluginRoot, "test", "_before-3fixes");
/** 被测源码 = 本插件的 `lib/`。 */
const SRC_NOW = srcDir;

const SOURCES = ["index.js", "kb-store.js", "kb-config.js"];
const backToJs = (t) => t.replace(/from "\.\/([a-z-]+)\.mjs"/g, 'from "./$1.js"');
const TRANSCRIPT = outFile("kb-distill-cwd-output.txt");

// ── stdout 原样落盘（报告与文件同源；⚠ process.exit 会和刷写竞争，靠 exit 钩子兜住）──
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
    /* 落盘失败不该改变验证结论 */
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
const firstDiff = (a, b) => {
  const la = String(a).split("\n");
  const lb = String(b).split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) return { line: i + 1, a: la[i], b: lb[i] };
  }
  return null;
};

/**
 * 起一份真插件。
 *
 * @param options - `{tag, srcDir, rewrite}`；`rewrite` 可对每个源文件做文本改写（拆修复用）。
 * @returns 句柄：镜像等价性、截获到的路由、发请求的 `route()`。
 */
async function launch({ tag, srcDir: src, rewrite = null }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kbdistill-${tag}-`));
  const dataDir = path.join(scratch, "data");
  const baseDir = path.join(scratch, "kbroot");
  // 会话的项目根（= 「当前项目」）
  const sessionRoot = path.join(scratch, "sessionproject");
  // 一个**别处**的目录：用来证明「cwd 正常时以请求里的 cwd 为准」
  const otherRoot = path.join(scratch, "otherproject");
  // 登记表里的项目（证明「手工登记」那条路没被改坏）
  const registeredRoot = path.join(scratch, "registered");
  for (const d of [dataDir, baseDir, sessionRoot, otherRoot, registeredRoot]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const mirrorDir = path.join(scratch, "plugin");
  fs.mkdirSync(path.join(mirrorDir, "lib"), { recursive: true });
  let rewrites = 0;
  let rewroteCount = 0;
  for (const n of SOURCES) {
    let text = fs.readFileSync(path.join(src, n), "utf8");
    if (rewrite !== null) {
      const after = rewrite(n, text);
      if (after !== text) {
        rewroteCount += 1;
        text = after;
      }
    }
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
    const a = fs.readFileSync(path.join(src, n), "utf8");
    const b = fs.readFileSync(path.join(mirrorDir, "lib", n.replace(/\.js$/, ".mjs")), "utf8");
    // 拆修复的那一份不参与「逐字符等价」判断（它本来就被人为改过）
    if (rewrite !== null && rewrite(n, a) !== a) continue;
    if (a !== backToJs(b)) {
      identical = false;
      diff = { n, d: firstDiff(a, backToJs(b)) };
    }
    specifiers += [...a.matchAll(/from "\.\/[a-z-]+\.js"/g)].length;
  }
  identical = identical && rewrites === specifiers;

  // config.json 必须在 apply() 之前落盘（apply 里 ConfigStore.load() 一次）
  const pre = await import(pathToFileURL(path.join(mirrorDir, "lib", "kb-config.mjs")).href);
  await new pre.ConfigStore(dataDir).save({ baseDir });

  // 登记表：一个**手工登记**的项目（用来证明「登记那条路没坏」）
  fs.writeFileSync(
    path.join(dataDir, "projects.json"),
    JSON.stringify(
      { projects: [], registry: [{ name: "registered", path: registeredRoot }] },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const savedEnv = process.env.DSH_KNOWLEDGE_DATA;
  process.env.DSH_KNOWLEDGE_DATA = dataDir;
  const mod = await import(pathToFileURL(path.join(mirrorDir, "lib", "index.mjs")).href);

  const tools = new Map();
  const routes = new Map();
  /**
   * 假的 `sessions` 宿主服务 —— 形状照官方 `dsh-session`：
   * `ctx.get("sessions").get(id)` → Session，`session.header.cwd` 是工作目录。
   */
  const sessionTable = new Map([[`session-${tag}`, { header: { id: `session-${tag}`, cwd: sessionRoot } }]]);
  const sessionsService = {
    get: (id) => sessionTable.get(id),
  };
  const ctx = {
    get: (k) => {
      if (k === "tools") return { register: (d) => tools.set(d.name, d) };
      if (k === "sessions") return sessionsService;
      return null;
    },
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: { register: (r) => routes.set(r.path, r), tapIndex: () => {} },
  };
  mod.apply(ctx);
  if (savedEnv === undefined) delete process.env.DSH_KNOWLEDGE_DATA;
  else process.env.DSH_KNOWLEDGE_DATA = savedEnv;

  /** 发一次 HTTP 请求（同形态：真 handler + 真 req/res）。 */
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

  return {
    tag,
    scratch,
    dataDir,
    baseDir,
    sessionRoot,
    otherRoot,
    registeredRoot,
    sessionId: `session-${tag}`,
    mirrorDir,
    identical,
    diff,
    rewrites,
    specifiers,
    rewroteCount,
    tools,
    routes,
    route,
  };
}

/** 建库（走真 `kb_init` 工具，不手搓目录）。 */
async function makeLibrary(p, root, name = "") {
  const tool = p.tools.get("kb_init");
  if (tool === undefined) throw new Error("没有注册 kb_init 工具");
  const value = await tool.execute({ cwd: root, project: name }, { cwd: root });
  return value;
}

// ══════════════════════════════════════════════════════════════
// 起三份真插件：BEFORE（改动前快照）/ NOW（改动后源码）/ SABOTAGE（拆掉修复）
// ══════════════════════════════════════════════════════════════

/**
 * 把本次修复**拆掉**：删掉宿主的 sessionId 兜底（还原成只信请求体 cwd）。
 *
 * 这不是「换个参数再试一次」，而是把判据指向的那段代码真的拿掉 ——
 * 拿掉之后测试**必须**变红，否则说明测试根本没在测这段代码。
 */
const stripSessionFallback = (name, text) => {
  if (name !== "index.js") return text;
  let out = text;
  // ① 把 distill 路由的 cwd 解析还原成改动前的写法
  out = out.replace(
    /const sessionId = typeof body\.sessionId === "string" \? body\.sessionId\.trim\(\) : "";\n\s*const cwd = asked !== "" \? asked : sessionRootOf\(sessionId\);/u,
    'const sessionId = "";\n        const cwd = asked;',
  );
  // ② projects 路由同理
  out = out.replace(
    /const cwd =\n\s*askedCwd\.trim\(\) !== "" \? askedCwd\.trim\(\) : sessionRootOf\(queryParam\(req, "sessionId"\)\);/u,
    "const cwd = askedCwd.trim();",
  );
  return out;
};

head("0. 被测的是真源码吗 / 环境");
console.log(`   被测源码（改动后）: ${SRC_NOW}`);
console.log(`   对照组①（改动前）: ${SRC_BEFORE}`);
console.log(`   node              : ${process.version}`);

const BEFORE = await launch({ tag: "before", srcDir: SRC_BEFORE });
const NOW = await launch({ tag: "now", srcDir: SRC_NOW });
const SABOTAGE = await launch({ tag: "sab", srcDir: SRC_NOW, rewrite: stripSessionFallback });
console.log(
  `   BEFORE 镜像 : ${BEFORE.mirrorDir}  等价=${BEFORE.identical}（改写 ${BEFORE.rewrites} / 相对 import ${BEFORE.specifiers}）`,
);
console.log(
  `   NOW    镜像 : ${NOW.mirrorDir}  等价=${NOW.identical}（改写 ${NOW.rewrites} / 相对 import ${NOW.specifiers}）`,
);
console.log(
  `   SABOTAGE    : 被人为改写的源文件数=${SABOTAGE.rewroteCount}（期望 ≥1，否则「拆掉修复」这件事没发生）`,
);
console.log(`   NOW  数据目录 : ${NOW.dataDir}（baseDir=${NOW.baseDir}）`);
console.log(`   NOW  会话项目 : ${NOW.sessionRoot}`);
console.log(`   NOW  登记项目 : ${NOW.registeredRoot}`);
console.log("   真实数据目录 / 真实知识库目录全程没有被本测试引用");
console.log(`   本报告的原始 stdout 落盘 : ${TRANSCRIPT}`);

assert("BEFORE 镜像与改动前快照逐字符等价", BEFORE.identical, JSON.stringify(BEFORE.diff));
assert("NOW 镜像与当前源码逐字符等价", NOW.identical, JSON.stringify(NOW.diff));
assert("SABOTAGE 确实被改写（拆掉修复）", SABOTAGE.rewroteCount >= 1, String(SABOTAGE.rewroteCount));

// ══════════════════════════════════════════════════════════════
// 1. 场景搭建：给「当前会话的项目」建库，另有一个手工登记的项目
// ══════════════════════════════════════════════════════════════
head("1. 场景：当前会话的项目有库；登记表里另有一个项目（本会话项目**没有**登记）");

for (const p of [BEFORE, NOW, SABOTAGE]) {
  const init = await makeLibrary(p, p.sessionRoot);
  if (init?.ok !== true) {
    console.log(`   !! ${p.tag} kb_init 失败：${JSON.stringify(init)}`);
  }
}
console.log(`   NOW  kb_init(sessionRoot) => ${JSON.stringify(await makeLibrary(NOW, NOW.sessionRoot))}`);
const regFile = JSON.parse(fs.readFileSync(path.join(NOW.dataDir, "projects.json"), "utf8"));
console.log(`   NOW  projects.json registry = ${JSON.stringify(regFile.registry)}`);
console.log(`   NOW  projects.json projects = ${JSON.stringify(regFile.projects)}`);

// ══════════════════════════════════════════════════════════════
// 2. 复现：cwd 为空 + 「由智能体自己决定」 ⇒ 改动前必须误报
// ══════════════════════════════════════════════════════════════
head("2. 复现（对照组①）：cwd 为空 + agentDecides ⇒ 指令说「没有任何候选项目」");

const beforeEmpty = await BEFORE.route("/__kb/distill", {
  body: { cwd: "", kind: "", domain: "", agentDecides: true },
});
console.log(`   BEFORE status=${beforeEmpty.status}`);
console.log(
  `   BEFORE resolvedCwd=${JSON.stringify(beforeEmpty.json?.resolvedCwd)} cwdFromSession=${JSON.stringify(beforeEmpty.json?.cwdFromSession)}`,
);
const beforeHasFalseReport =
  typeof beforeEmpty.json?.instruction === "string" &&
  beforeEmpty.json.instruction.includes("当前没有任何候选项目");
console.log(`   BEFORE 指令含「当前没有任何候选项目」= ${beforeHasFalseReport}`);
console.log("   ── BEFORE 指令的「写到哪个项目」那一段 ──");
console.log(
  (String(beforeEmpty.json?.instruction ?? "").split("## 写到哪个项目")[1] ?? "")
    .split("必填字段")[0]
    .split("\n")
    .map((l) => `   | ${l}`)
    .join("\n"),
);
assert("改动前**确实**误报「当前没有任何候选项目」（复现成立）", beforeHasFalseReport === true);

// ══════════════════════════════════════════════════════════════
// 3. 修复后：cwd 为空 + sessionId ⇒ 指令必须正确指出当前项目
// ══════════════════════════════════════════════════════════════
head("3. 修复后：cwd 为空 + sessionId ⇒ 指令正确指出当前项目（不再误报）");

const nowEmpty = await NOW.route("/__kb/distill", {
  body: { cwd: "", sessionId: NOW.sessionId, kind: "", domain: "", agentDecides: true },
});
console.log(`   NOW status=${nowEmpty.status}`);
console.log(`   NOW resolvedCwd=${JSON.stringify(nowEmpty.json?.resolvedCwd)}`);
console.log(`   NOW cwdFromSession=${JSON.stringify(nowEmpty.json?.cwdFromSession)}`);
console.log("   ── NOW 指令的「写到哪个项目」那一段 ──");
console.log(
  (String(nowEmpty.json?.instruction ?? "").split("## 写到哪个项目")[1] ?? "")
    .split("必填字段")[0]
    .split("\n")
    .map((l) => `   | ${l}`)
    .join("\n"),
);

assert("修复后 distill 返回 200", nowEmpty.status === 200, String(nowEmpty.status));
assert(
  "修复后**不再**出现「当前没有任何候选项目」",
  nowEmpty.json?.instruction?.includes("当前没有任何候选项目") !== true,
);
assert(
  "修复后 resolvedCwd = 会话项目根（宿主用 sessionId 解析出来的）",
  nowEmpty.json?.resolvedCwd === NOW.sessionRoot,
  `${JSON.stringify(nowEmpty.json?.resolvedCwd)} != ${JSON.stringify(NOW.sessionRoot)}`,
);
assert("修复后标记 cwdFromSession=true（如实说明来源是会话）", nowEmpty.json?.cwdFromSession === true);
assert(
  "指令里出现当前项目路径",
  nowEmpty.json?.instruction?.includes(NOW.sessionRoot) === true,
);
const candidateLines = String(nowEmpty.json?.instruction ?? "")
  .split("\n")
  .filter((l) => l.startsWith("- ") && l.includes("（库："));
console.log(`   NOW 候选项目行数 = ${candidateLines.length}`);
for (const l of candidateLines) console.log(`   | ${l}`);
assert(
  "候选清单里**恰有一行**指向当前会话项目（没有重复列出同一本库）",
  candidateLines.filter((l) => l.includes(NOW.sessionRoot)).length === 1,
  `实际 ${candidateLines.length} 条：${JSON.stringify(candidateLines)}`,
);
assert(
  "候选清单里含当前会话项目根",
  candidateLines.some((l) => l.includes(NOW.sessionRoot)),
);

// ══════════════════════════════════════════════════════════════
// 4. 选择器数据来源：/__kb/projects 也要能解析出当前项目
// ══════════════════════════════════════════════════════════════
head("4. 选择器：cwd 为空 + sessionId ⇒ /__kb/projects 里必须有当前项目");

const beforeProjects = await BEFORE.route("/__kb/projects", {
  method: "GET",
  query: "cwd=&sessionId=",
});
const nowProjects = await NOW.route("/__kb/projects", {
  method: "GET",
  query: `cwd=&sessionId=${encodeURIComponent(NOW.sessionId)}`,
});
const pathList = (r) => (Array.isArray(r.json?.projects) ? r.json.projects.map((x) => x.path) : []);
console.log(`   BEFORE projects 路径 = ${JSON.stringify(pathList(beforeProjects))}`);
console.log(`   NOW    resolvedCwd = ${JSON.stringify(nowProjects.json?.resolvedCwd)}`);
console.log(`   NOW    projects 路径 = ${JSON.stringify(pathList(nowProjects))}`);
assert(
  "改动前：当前会话项目**不在**清单里（缺陷可观测）",
  pathList(beforeProjects).includes(BEFORE.sessionRoot) === false,
);
assert(
  "修复后：当前会话项目**在**清单里",
  pathList(nowProjects).includes(NOW.sessionRoot) === true,
);
assert(
  "修复后 resolvedCwd 回给了前端（选择器据此渲染「当前项目」那一项）",
  nowProjects.json?.resolvedCwd === NOW.sessionRoot,
);

// ══════════════════════════════════════════════════════════════
// 5. cwd 正常时：与改动前**逐字一致**
// ══════════════════════════════════════════════════════════════
head("5. 无回归：cwd 正常时，改动前后两条指令**逐字一致**");

// ⚠ 「逐字一致」要比的是**同一件事**：两个实例各自给 otherRoot 建库，
//   否则一边有库一边没库，比的是两个不同场景（那是假失败）。
for (const p of [BEFORE, NOW, SABOTAGE]) {
  const init = await makeLibrary(p, p.otherRoot);
  if (init?.ok !== true) console.log(`   !! ${p.tag} kb_init(otherRoot) 失败：${JSON.stringify(init)}`);
}

const agentPayload = (cwd, sessionId) => ({
  body:
    sessionId === undefined
      ? { cwd, kind: "", domain: "", agentDecides: true }
      : { cwd, sessionId, kind: "", domain: "", agentDecides: true },
});

/**
 * 把**实例自己的临时路径**换成占位符 —— 两个实例的临时目录名必然不同，
 * 不归一化就比不出「指令逐字一致」，那是假失败。
 */
const norm = (s, p) =>
  String(s ?? "")
    .split(p.sessionRoot)
    .join("<SESSION_ROOT>")
    .split(p.otherRoot)
    .join("<OTHER_ROOT>")
    .split(p.baseDir)
    .join("<BASE_DIR>")
    .split(p.registeredRoot)
    .join("<REGISTERED>")
    .split(path.sep)
    .join("/");

// 5a. 「由智能体自己决定」+ 有效 cwd（并且 sessionId 指向**另一个**目录，证明 cwd 优先）
const beforeValid = await BEFORE.route("/__kb/distill", agentPayload(BEFORE.otherRoot, BEFORE.sessionId));
const nowValid = await NOW.route("/__kb/distill", agentPayload(NOW.otherRoot, NOW.sessionId));
const iBefore = norm(beforeValid.json?.instruction, BEFORE);
const iNow = norm(nowValid.json?.instruction, NOW);
console.log(`   BEFORE status=${beforeValid.status}  NOW status=${nowValid.status}`);
console.log(`   BEFORE resolvedCwd=${JSON.stringify(beforeValid.json?.resolvedCwd)}  NOW resolvedCwd=${JSON.stringify(nowValid.json?.resolvedCwd)}`);
console.log(`   NOW cwdFromSession=${JSON.stringify(nowValid.json?.cwdFromSession)}（cwd 已给 ⇒ 必须为 false）`);
assert("cwd 正常时两条指令逐字一致", iBefore === iNow, JSON.stringify(firstDiff(iBefore, iNow)));
assert("cwd 正常时以请求里的 cwd 为准（不是会话里那个）", nowValid.json?.resolvedCwd === NOW.otherRoot);
assert("cwd 正常时 cwdFromSession=false", nowValid.json?.cwdFromSession === false);
console.log("   ── 两条指令都含的「当前项目」相关行 ──");
console.log(
  iNow
    .split("\n")
    .filter((l) => l.includes("<OTHER>") || l.includes("候选项目"))
    .map((l) => `   | ${l}`)
    .join("\n"),
);

// 5b. 「当前项目」老路径（不带 agentDecides）：真解析到了就照常
const beforeCurrent = await BEFORE.route("/__kb/distill", agentPayload(BEFORE.sessionRoot, BEFORE.sessionId));
const nowCurrent = await NOW.route("/__kb/distill", agentPayload(NOW.sessionRoot, NOW.sessionId));
console.log(`   老路径 BEFORE status=${beforeCurrent.status} / NOW status=${nowCurrent.status}`);
console.log(`   老路径 NOW target=${JSON.stringify(nowCurrent.json?.target)}`);
assert(
  "老路径（cwd 有效）改动前后指令逐字一致",
  norm(beforeCurrent.json?.instruction, BEFORE) === norm(nowCurrent.json?.instruction, NOW),
  JSON.stringify(firstDiff(norm(beforeCurrent.json?.instruction, BEFORE), norm(nowCurrent.json?.instruction, NOW))),
);

// 5c. 显式选一个登记过的项目：不受本次改动影响
const beforePick = await BEFORE.route("/__kb/distill", {
  body: { cwd: BEFORE.sessionRoot, project: "registered", kind: "", domain: "" },
});
const nowPick = await NOW.route("/__kb/distill", {
  body: { cwd: NOW.sessionRoot, project: "registered", kind: "", domain: "" },
});
console.log(`   选登记项目 BEFORE status=${beforePick.status} / NOW status=${nowPick.status}`);
console.log(`   选登记项目 NOW target=${JSON.stringify(nowPick.json?.target)}`);
assert(
  "显式选登记项目：改动前后指令逐字一致",
  norm(beforePick.json?.instruction, BEFORE) === norm(nowPick.json?.instruction, NOW),
  JSON.stringify(firstDiff(norm(beforePick.json?.instruction, BEFORE), norm(nowPick.json?.instruction, NOW))),
);

// ══════════════════════════════════════════════════════════════
// 6. 如实报错仍然保留（只是不再误报）
// ══════════════════════════════════════════════════════════════
head("6. 真解析不到时：如实报错**必须**还在（这次只去掉误报，不删报错）");

const nowUnknownSession = await NOW.route("/__kb/distill", {
  body: { cwd: "", sessionId: "session-does-not-exist", kind: "", domain: "" },
});
console.log(
  `   未知 sessionId + 空 cwd ⇒ status=${nowUnknownSession.status} code=${JSON.stringify(nowUnknownSession.json?.code)}`,
);
console.log(`   error=${JSON.stringify(nowUnknownSession.json?.error)}`);
assert("未知 sessionId 且空 cwd ⇒ 400", nowUnknownSession.status === 400, String(nowUnknownSession.status));
assert("未知 sessionId 且空 cwd ⇒ code=NO_CWD", nowUnknownSession.json?.code === "NO_CWD");
assert(
  "报错文案仍是「尚未确定当前项目…」",
  String(nowUnknownSession.json?.error ?? "").includes("尚未确定当前项目"),
  JSON.stringify(nowUnknownSession.json?.error),
);

// ⚠ 「真的一个候选都没有」需要一个**干净实例**：NOW 那台已经在场景搭建时建了库，
//   候选清单里本来就有东西 —— 拿它断言「没有候选」是假命题。
head("6b. 干净实例（登记表为空 + 没有任何库）：真解析不到时仍如实说「没有候选项目」");
const CLEAN = await launch({ tag: "clean", srcDir: SRC_NOW });
console.log(`   CLEAN 登记表 = ${fs.readFileSync(path.join(CLEAN.dataDir, "projects.json"), "utf8").replace(/\s+/gu, " ")}`);

const cleanNoSession = await CLEAN.route("/__kb/distill", {
  body: { cwd: "", sessionId: "session-does-not-exist", kind: "", domain: "", agentDecides: true },
});
console.log(
  `   agentDecides + 空 cwd + 查不到的会话 ⇒ status=${cleanNoSession.status} resolvedCwd=${JSON.stringify(cleanNoSession.json?.resolvedCwd)}`,
);
console.log(
  `   指令含「当前没有任何候选项目」=${String(cleanNoSession.json?.instruction ?? "").includes("当前没有任何候选项目")}`,
);
assert("干净实例 + 查不到的会话 ⇒ 200", cleanNoSession.status === 200, String(cleanNoSession.status));
assert("干净实例 + 查不到的会话 ⇒ resolvedCwd=null（不编一个路径出来）", cleanNoSession.json?.resolvedCwd === null);
assert(
  "真的没有候选项目时，仍然如实说「当前没有任何候选项目」（报错没被顺手删掉）",
  cleanNoSession.json?.instruction?.includes("当前没有任何候选项目") === true,
);

// 同一个干净实例：cwd 为空、会话能解析到 ⇒ 兜底照常生效（证明不是靠「有库」蒙对的）
{
  const initClean = await makeLibrary(CLEAN, CLEAN.sessionRoot);
  console.log(`   CLEAN kb_init(sessionRoot) ok=${initClean?.ok === true}`);
  const out = await CLEAN.route("/__kb/distill", {
    body: { cwd: "", sessionId: CLEAN.sessionId, kind: "", domain: "", agentDecides: true },
  });
  console.log(
    `   干净实例 + 会话可解析 ⇒ resolvedCwd=${JSON.stringify(out.json?.resolvedCwd)} 含「没有任何候选项目」=${String(out.json?.instruction ?? "").includes("当前没有任何候选项目")}`,
  );
  assert("干净实例 + 会话可解析 ⇒ resolvedCwd = 会话项目根", out.json?.resolvedCwd === CLEAN.sessionRoot);
  assert(
    "干净实例 + 会话可解析 ⇒ 不再误报「没有候选项目」",
    out.json?.instruction?.includes("当前没有任何候选项目") !== true,
  );
}

// sessions 服务缺失 / 会话查不到 ⇒ 兜底失效但**不能抛**
head("6c. 会话查不到且 cwd 也为空 ⇒ 不抛、如实走报错那一路");
{
  const out = await CLEAN.route("/__kb/distill", {
    body: { cwd: "", sessionId: "session-not-in-table", kind: "", domain: "" },
  });
  console.log(`   老路径（无 agentDecides）⇒ status=${out.status} code=${JSON.stringify(out.json?.code)}`);
  assert("老路径 + 两个都解析不到 ⇒ 400 NO_CWD", out.status === 400 && out.json?.code === "NO_CWD");
}

// ══════════════════════════════════════════════════════════════
// 7. 对照②：把修复拆掉 ⇒ 判据必须变红
// ══════════════════════════════════════════════════════════════
head("7. 对照②：拆掉宿主的 sessionId 兜底 ⇒ 第 3 节的判据必须变红");

const sabEmpty = await SABOTAGE.route("/__kb/distill", {
  body: { cwd: "", sessionId: SABOTAGE.sessionId, kind: "", domain: "", agentDecides: true },
});
const sabFalseReport =
  typeof sabEmpty.json?.instruction === "string" &&
  sabEmpty.json.instruction.includes("当前没有任何候选项目");
console.log(`   SABOTAGE resolvedCwd=${JSON.stringify(sabEmpty.json?.resolvedCwd)}`);
console.log(`   SABOTAGE 指令含「当前没有任何候选项目」= ${sabFalseReport}`);
assert(
  "拆掉修复后**复现**误报（证明第 3 节的判据不是空转）",
  sabFalseReport === true && sabEmpty.json?.resolvedCwd !== SABOTAGE.sessionRoot,
);

const sabProjects = await SABOTAGE.route("/__kb/projects", {
  method: "GET",
  query: `cwd=&sessionId=${encodeURIComponent(SABOTAGE.sessionId)}`,
});
console.log(`   SABOTAGE projects 路径 = ${JSON.stringify(pathList(sabProjects))}`);
assert(
  "拆掉修复后当前会话项目**不在**选择器清单里（第 4 节判据同样变红）",
  pathList(sabProjects).includes(SABOTAGE.sessionRoot) === false,
);

// ══════════════════════════════════════════════════════════════
// 8. 客户端半：静态证据（客户端是 lazy-CJS bundle，本测试用**文本判据**，如实标注）
// ══════════════════════════════════════════════════════════════
head("8. 客户端半：源码判据（不是运行时证据，如实标注）");

const clientSrc = fs.readFileSync(path.join(SRC_NOW, "client.js"), "utf8");
const checks = [
  ["currentCwd 收 props（标准 props 入口）", /function currentCwd\(props\)/u.test(clientSrc)],
  ["新增 currentSessionId（把会话 id 交给宿主）", /function currentSessionId\(props\)/u.test(clientSrc)],
  ["新增 sessionCwdFrom（读根级 sessions 标准源）", /function sessionCwdFrom\(props\)/u.test(clientSrc)],
  ["用 useSessions 读 byId[...].cwd", /useSessions\(/u.test(clientSrc) && /byId\?\.\[id\]/u.test(clientSrc)],
  ["distill 请求体带 sessionId", /sessionId: sessionIdNow/u.test(clientSrc)],
  ["projects 请求带 sessionId", /"\/__kb\/projects\?cwd="[\s\S]{0,200}?sessionId=/u.test(clientSrc)],
  ["config 请求带 sessionId", /"\/__kb\/config\?cwd="[\s\S]{0,200}?sessionId=/u.test(clientSrc)],
  ["选择器用 cwdEffective 渲染「当前项目」", /cwdEffective !== ""/u.test(clientSrc)],
];
for (const [label, ok] of checks) assert(label, ok);
const beforeClientPath = path.join(SRC_BEFORE, "client.js");
const nowClientPath = path.join(SRC_NOW, "client.js");
const beforeLen = fs.existsSync(beforeClientPath) ? fs.statSync(beforeClientPath).size : null;
console.log(
  `   改动前快照里 client.js 字节数=${beforeLen === null ? "（快照未收录 client.js，无法对比）" : beforeLen}，改动后=${fs.statSync(nowClientPath).size}`,
);
console.log("   ⚠ 本节是**文本判据**：客户端半的行为未在浏览器里真跑（需要页面刷新才生效），");
console.log("     所以这一节只算「改动确实落在源码里」的证据，不算运行时证据。");

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
head("汇总");
console.log(`   失败断言数 = ${failures}`);
console.log(`   RESULT-ALL :: ${failures === 0 ? "OK" : "FAIL"}`);
console.log(`   原始 stdout 落盘 : ${TRANSCRIPT}`);
process.exit(failures === 0 ? 0 : 1);
