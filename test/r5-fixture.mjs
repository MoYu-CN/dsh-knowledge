/**
 * _r5-fixture.mjs —— round5「工序接入（方案C）」真跑验证用的**临时小库**。
 *
 * ⚠ 只往 DSH_KNOWLEDGE_DATA 指向的临时目录里写，**绝不碰**任何真实数据目录
 *   （插件的数据目录与用户真实的知识库都不引用）。
 *
 * 库的形态刻意照真实分册格式手写（不是用 kb_add 生成）：
 * 要能造出「触发条件与标题关键词故意不同」的条目，才能验证
 * 「以触发条件为主字段」这条判据真的生效（而不是靠标题碰巧命中）。
 */
import fs from "node:fs";
import path from "node:path";

/** 手写一条避错（格式 = kb-store 的 renderEntry 产物）。 */
function pitfall({ id, title, trigger, steps, why, symptoms }) {
  const lines = ["", `## ${id} ${title}`, "", `**触发条件**：${trigger}`, "", "**先做**：", ""];
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("", `**为什么**：${why}`, "", `**违规症状（怎么判断你没做）**：${symptoms}`, "");
  return lines.join("\n");
}

/** 手写一条方法。 */
function method({ id, title, trigger, steps, verify, boundaries }) {
  const lines = ["", `## ${id} ${title}`, "", `**适用场景**：${trigger}`, "", "**步骤**：", ""];
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("", `**验证方式**：${verify}`, "", `**已知边界**：${boundaries}`, "");
  return lines.join("\n");
}

const PITFALLS = [
  pitfall({
    id: "P-001",
    title: "客户端 bundle 改完要刷新页面",
    trigger:
      "改完客户端 bundle（lib/client.js）后打开设置页或右栏面板，界面上看不到改动、还是旧样子时",
    steps: [
      "先确认改的是**磁盘上的那份**：实装目录是 Junction 指向源码目录，改源码即改实装。",
      "把改动**重建**进浏览器读的那份产物，再让用户刷新页面（F5）。",
      "刷新后仍然不变，看响应头里有没有 no-store —— 有缓存的话旧脚本会一直被用着。",
    ],
    why: "渲染进程会把脚本缓存住，服务端文件换了不等于页面上跑的是新的。",
    symptoms: "你只说了「改好了」，却没提「要刷新页面」；用户回一句「没变化」。",
  }),
  pitfall({
    id: "P-002",
    title: "工具出参不能带 undefined 的自有键",
    trigger: "新增或改动一个工具、它的出参里某个可选字段这次没有值时",
    steps: [
      "可选字段没值时**把键删掉**，不要赋 null、也不要留着 undefined。",
      "用宿主自己的 isJsonValue 过一遍出参，别凭感觉认为「应该没事」。",
    ],
    why: "宿主对工具返回值做无损 JSON 检查，值为 undefined 的自有可枚举键会被直接拒绝。",
    symptoms:
      "调用工具时抛 `returned invalid output: value is not lossless JSON`；界面上那条工具调用整条失败。",
  }),
  pitfall({
    id: "P-003",
    title: "改设置项要同步改归一化表",
    trigger: "往设置页加一个新的配置项、或改某个已有配置项的取值区间时",
    steps: [
      "在归一化表（SCHEMA）里补上这一项的类型与上下界，缺了会被静默丢掉。",
      "确认旧配置文件读进来能自动补默认值（遍历的是 SCHEMA，不是输入对象的键）。",
    ],
    why: "读配置时按表逐字段归一化，表里没有的字段一律不认。",
    symptoms: "设置页填了值、保存也成功，但重新读回来仍是默认值。",
  }),
  pitfall({
    id: "P-004",
    title: "数据目录不许硬编码盘符",
    trigger: "写任何要落盘的插件路径、或调试「数据写到哪去了」时",
    steps: [
      "从 exe 位置反推安装根，或读环境变量指定的目录，**不要写死盘符**。",
      "验证时把数据目录指向一个临时目录，跑完就删。",
    ],
    why: "硬编码盘符换一台机器就写不进去，而且失败得很安静。",
    symptoms: "换机器后数据「凭空消失」，日志里却没有任何报错。",
  }),
];

const METHODS = [
  method({
    id: "M-001",
    title: "真跑验证：拿临时目录造一本小库",
    trigger: "要验收一个知识库相关的工具、或改动了匹配逻辑、想确认命中是否相关时",
    steps: [
      "把 DSH_KNOWLEDGE_DATA 指向一个临时目录，别用真实数据目录。",
      "造 3~5 条小条目（方法与避错都要有），输入真实的任务描述各跑一次。",
      "把命中结果**打印出来人工看**，不要只断言「返回了非空数组」。",
    ],
    verify: "每条命中都能说清「为什么是它」，且无关条目没有混进来。",
    boundaries: "临时小库只有几条，覆盖不了真实库几十条时的噪音；真实库还要再抽查一次。",
  }),
  method({
    id: "M-002",
    title: "每处改动都给出「解析通过 + 故意写坏的对照组」",
    trigger: "改完源码要提交、或要向别人证明「这份文件真的能解析」时",
    steps: [
      "对每个改过的文件跑真解析检查（不是 node --check 那种空转）。",
      "同一轮里跑一个**故意写坏**的对照文件，它必须 FAIL —— 否则这份证据是假的。",
    ],
    verify: "好的全 OK、坏的那份 FAIL，两个结论同时出现才算数。",
    boundaries: "只能证明语法可解析，证明不了语义正确；语义要靠真跑。",
  }),
];

/**
 * 往 `projectRoot` 底下造一本知识库（默认布局：`<项目根>/知识库`）。
 * @param {string} projectRoot 项目根。
 * @returns {{dir: string, files: string[]}} 库目录与写出的文件。
 */
export function seedLibrary(projectRoot) {
  const dir = path.join(projectRoot, "知识库");
  fs.mkdirSync(path.join(dir, "避错"), { recursive: true });
  fs.mkdirSync(path.join(dir, "方法"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "00-开始这里-总纲.md"),
    "# 知识库总纲\n\n> 测试用总纲（仅为让 load() 认得出这是本库）。\n",
    "utf8",
  );
  const files = [];
  const pit = path.join(dir, "避错", "避错-001-工具与配置.md");
  fs.writeFileSync(
    pit,
    "# 避错分册\n\n> 本册收录踩过的坑。**写成前瞻式 guard，不写事故叙事**（准则 6.4）。\n" +
      PITFALLS.join("\n"),
    "utf8",
  );
  files.push(pit);
  const met = path.join(dir, "方法", "方法-001-验收与检查.md");
  fs.writeFileSync(
    met,
    "# 方法分册\n\n> 本册收录可复用的流程与做法。按领域归册，编号全局连续。\n" + METHODS.join("\n"),
    "utf8",
  );
  files.push(met);
  return { dir, files };
}

/** 库里全部条目编号（供断言「不许少给/多给」用）。 */
export const FIXTURE_IDS = [
  ...PITFALLS.map((b) => /^## ([MP]-\d{3})\b/m.exec(b)?.[1]),
  ...METHODS.map((b) => /^## ([MP]-\d{3})\b/m.exec(b)?.[1]),
].filter((x) => typeof x === "string");
