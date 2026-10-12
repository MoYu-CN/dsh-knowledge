/**
 * verify-applyconfig.mjs —— 验 `KnowledgeBase.applyConfig()` 的目录重算。
 *
 * 为什么要它：设置页改「知识库父目录」后，`index.js` 会对所有已缓存的库调 `applyConfig`。
 * 改之前它只换 `this.config`、**不重算 `this.dir`** ⇒ 填了新目录也没用
 * （表现：设置页填了父目录，插件仍然找不到库）。本脚本用**真模块**验三件事：
 *   A. 改了 baseDir 之后 `dir` 真的变了，并且落在新父目录下；
 *   B. 目录没变时**不丢**已加载的状态（保住「不重载条目」的原语义）；
 *   C. 拿正确配置能真读到库里已有的条目（在**自己造的**库上验，不碰任何真实数据目录）。
 *
 * ## 从干净检出就能跑
 * 插件位置由 `import.meta.url` 反推（`_harness.mjs` 的 `srcDir`），
 * 父目录用临时目录，退出时删除。**不需要任何环境变量。**
 *
 * ## 可选：在真实库上再验一遍
 * `DSH_KNOWLEDGE_REAL_BASE=<父目录>`（例如 `D:/knowledge-base`）设了的话，
 * 会额外对 `<父目录>/<本次项目名>` 做一次**只读**加载并核对路径。
 * 没设就打印一句 SKIP —— 不静默跳过。
 *
 * 用法：node test/verify-applyconfig.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { envPath, printSkip, srcDir, tempDir } from "./_harness.mjs";

const STORE = path.join(srcDir, "kb-store.js");
const SCRATCH = tempDir("kb-applycfg-");
process.on("exit", () => {
  try {
    SCRATCH.cleanup();
  } catch {
    /* 退出时清理失败不该改变结论 */
  }
});

const { KnowledgeBase } = await import(pathToFileURL(STORE).href);
let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : "   " + detail}`);
};

/**
 * 在 `root` 下造一本最小可加载的库。
 *
 * ⚠ 布局有两种（见 `resolveKbDir`）：
 *   - `baseDir` 为空 → `<项目根>/知识库`；
 *   - `baseDir` 非空 → `<父目录>/<项目名>`（**不再套一层「知识库」**）。
 * 这里造的是后者，因为本脚本验的就是「配了父目录」这条路径。
 */
function seedLibrary(root, projectName) {
  const dir = path.join(root, projectName);
  fs.mkdirSync(path.join(dir, "避错"), { recursive: true });
  fs.writeFileSync(path.join(dir, "00-开始这里-总纲.md"), "# 知识库总纲\n\n> 测试用。\n", "utf8");
  fs.writeFileSync(
    path.join(dir, "避错", "避错-001-测试.md"),
    "# 避错分册\n\n## P-001 测试条目\n\n**触发条件**：测试。\n\n**先做**：\n\n1. 无。\n\n**为什么**：无。\n\n**违规症状**：无。\n",
    "utf8",
  );
  return dir;
}

// ── A. 目录重算 + 状态保留 ──────────────────────────────
const rootA = path.join(SCRATCH.dir, "rootA");
const rootB = path.join(SCRATCH.dir, "rootB");
fs.mkdirSync(rootA, { recursive: true });
fs.mkdirSync(rootB, { recursive: true });
const projectName = "测试项目";

const kb = new KnowledgeBase(path.join(rootA, projectName), { baseDir: rootA });
const before = kb.dir;
kb.applyConfig({ baseDir: rootB });
const after = kb.dir;
console.log(`     改前 dir = ${before}`);
console.log(`     改后 dir = ${after}`);
check("A1 改了 baseDir 之后 dir 真的变了", before !== after);
check("A2 新 dir 落在新的父目录下", after.startsWith(rootB), after);

// 目录没变时：已加载状态不该被清掉
kb.load();
const loadedOk = kb.loaded;
kb.applyConfig({ baseDir: rootB }); // 同一个 baseDir ⇒ 目录没变
check("A3 目录没变时不丢已加载状态", kb.loaded === loadedOk);

// 目录再变一次 ⇒ 状态必须被作废（不能拿旧目录的条目当新目录的）
kb.applyConfig({ baseDir: rootA });
check("A4 目录再变时状态被作废（loaded=false）", kb.loaded === false);

// ── B. 正确配置下读得到自己造的库（只写临时目录）────────────
const rootC = path.join(SCRATCH.dir, "rootC");
const seeded = seedLibrary(rootC, projectName);
const lib = new KnowledgeBase(path.join(SCRATCH.dir, "projC"), { baseDir: rootC }, projectName);
const okLoad = lib.load();
console.log(`     造的库 dir = ${lib.dir}`);
check("B1 正确配置能加载库", okLoad === true);
check("B2 dir = <父目录>/<项目名>（baseDir 非空时不再套一层「知识库」）", lib.dir === seeded, lib.dir);
const n = okLoad ? lib.count() : 0;
check("B3 条数 > 0", n > 0, `实际 ${n} 条`);
const p1 = okLoad ? lib.get("P-001") : undefined;
check("B4 能按编号读到条目（P-001）", p1 !== undefined && p1 !== null, p1 === undefined || p1 === null ? "" : String(p1.title).slice(0, 30));

// ── C. 可选：在真实库上再验一遍（只读）──────────────────────
const realBase = envPath("DSH_KNOWLEDGE_REAL_BASE");
if (realBase === null) {
  printSkip(
    "C. 真实库只读复核：没设 DSH_KNOWLEDGE_REAL_BASE。\n" +
      "      设了它会在 <DSH_KNOWLEDGE_REAL_BASE>/<当前目录名> 上做一次只读加载并核对路径。",
  );
} else {
  const real = new KnowledgeBase(process.cwd(), { baseDir: realBase });
  const okReal = real.load();
  console.log(`     真实库 dir = ${real.dir}`);
  check("C1 正确配置能加载真实库", okReal === true);
  check("C2 真实库路径 = <DSH_KNOWLEDGE_REAL_BASE>/<当前目录名>", real.dir === path.join(realBase, path.basename(process.cwd())), real.dir);
  check("C3 真实库条数 > 0", (okReal ? real.count() : 0) > 0, `实际 ${okReal ? real.count() : 0} 条`);
}

console.log("");
console.log(`== 结果：${bad === 0 ? "全部通过" : bad + " 项失败"} ==`);
process.exitCode = bad === 0 ? 0 : 1;
