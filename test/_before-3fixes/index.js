/**
 * dsh-knowledge —— host 侧入口。
 *
 * 让智能体把踩过的坑与可复用做法**沉淀进项目知识库**，并在后续会话里自动受益。
 * 规格来源：`AI通用行为准则/AI通用行为准则.md` 第六节「沉淀机制」——
 * 那份文档是需求，本实现不自行发明规则。
 *
 * ## 四项功能与它们的落点
 *
 * | 功能 | 落点 | 依据 |
 * |---|---|---|
 * | ① 知识库管理 | `kb_init` / `kb_add` / `kb_list` / `kb_get` / `kb_search` 五个工具 | 准则 6.2/ 6.4 / 6.5 |
 * | ② 自动沉淀 | 同一批工具 + 提示词里的「触发词」约定 | 准则 6.1（搞定/ 复盘 / 记住） |
 * | ③ 实时提醒 | `systemPrompt` 段 + `kb_search` 工具（智能体自行判断时机） | 准则 6.2「按需抽调」 |
 * | ④ 注入指令 | **只注入总纲**，条目靠 `kb_search` 按需拉取 | 用户明确选了省上下文那档 |
 *
 * ## 为什么只注入总纲
 * 全量注入每个条目 = 每次会话都烧几十条避错的 token，
 * 而当前任务真正相关的通常只有两三条。
 * 总纲 + 「用 kb_search 按需抽」是**唯一不漏又不烧**的组合
 * （详见准则 6.2「怎么读（按需加载）」与 6.7「成本控制」）。
 *
 * ## 关于 `agentTeams` / `tools` 等服务
 * `tools` 与 `systemPrompt` 都**不进 inject**：缺任何一个都不该让整个插件停摆
 * —— 插件停摆 ⇒ 知识库这条防线整个消失，比「工具没注册」严重得多。
 * 所以走 `ctx.get()` 按需取，缺失时对应能力降级（记日志、不抛错）。
 *
 * ⚠ 教训（来自 dsh-team-chat 踩过两次的坑）：cordis 的 `inject` 是硬依赖，
 *   未 inject 的属性访问**会抛错**，且 `?.` 挡不住。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KnowledgeBase,
  KB_DIR_NAME,
  resolveKbDir,
  safeDirName,
  ORIGIN_NAME,
  KINDS,
  VOLUME_PER_BOOK,
  PREFIX,
} from "./kb-store.js";
import { ConfigStore, DEFAULT_CONFIG } from "./kb-config.js";

export const name = "knowledge";
export const inject = ["webServer"];

const here = path.dirname(fileURLToPath(import.meta.url));

/** 客户端 bundle 路由。 */
const CLIENT_SCRIPT_PATH = "/__kb/client.js";

/** 数据目录名（放 DSH 安装根下，卸载重装插件不丢）。 */
const DATA_DIR_NAME = ".dsh-knowledge-data";

/**
 * 解析数据目录。与 team-chat 同策略：从 exe 位置反推安装根，
 * **绝不硬编码盘符**（换机就写不到数据的教训）。
 * @returns {string} 目录绝对路径。
 */
function resolveDataDir() {
  const explicit = process.env.DSH_KNOWLEDGE_DATA;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return path.resolve(explicit.trim());
  }
  for (const candidate of [process.argv[1], process.execPath]) {
    if (typeof candidate !== "string" || candidate === "") continue;
    const dir = path.dirname(path.resolve(candidate));
    const marker = `${path.sep}resources${path.sep}`;
    const at = dir.indexOf(marker);
    if (at > 0) return path.join(dir.slice(0, at), DATA_DIR_NAME);
    const exeName = path.basename(candidate).toLowerCase();
    if (exeName.startsWith("dsh")) return path.join(dir, DATA_DIR_NAME);
  }
  const installDir = process.env.DSH_INSTALL_DIR;
  if (typeof installDir === "string" && installDir.trim() !== "") {
    return path.join(path.resolve(installDir.trim()), DATA_DIR_NAME);
  }
  return path.resolve(here, "..", "..", DATA_DIR_NAME);
}

/**
 * 剥出 `host:port`，兼容带/不带协议前缀。
 * @param {string} value 原始值。
 * @returns {string | null} 主机名，解析失败返 null。
 */
function hostOf(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).host;
  } catch {
    return null;
  }
}

/**
 * 同源守卫。
 *
 * ⚠ **语义经��修过一次，别改回去**：`<script src>` 发起的同源 GET **不带 Origin**
 * （只有 CORS / 表单 / SSE 才带）。所以「只看 Origin」会让 client.js 恒 403
 * → 面板整个空白 —— 正是最该避免的失败形态。
 *
 * 现在的规则是「**硬证据只用于否决，不用于放行**」：
 * 1. `Sec-Fetch-Site: cross-site` → 拒
 * 2. `Origin` 存在 → 必须与 Host 对齐
 * 3. `Referer` 存在 → 必须与 Host 对齐
 * 4. 都没有 → 放行（非浏览器上下文，如 curl 探活）
 *
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @returns {boolean} 是否放行。
 */
function passSameOrigin(req, res) {
  const host = hostOf(req.headers?.host);
  const site = req.headers?.["sec-fetch-site"];
  if (typeof site === "string" && site === "cross-site") {
    res.writeHead(403).end();
    return false;
  }
  for (const header of ["origin", "referer"]) {
    const value = req.headers?.[header];
    if (typeof value !== "string" || value === "") continue;
    const valueHost = hostOf(value);
    if (host === null || valueHost === null || valueHost !== host) {
      res.writeHead(403).end();
      return false;
    }
  }
  return true;
}

/**
 * 读 JSON 请求体。带体积上限。
 *
 * ⚠ 要求 `req` **异步可迭代**（Node 原生 IncomingMessage 满足）。
 *   自造 mock 若用 `on("data")` 就喂不进来 → 所有 POST 恒 400。
 *
 * @param {object} req 请求。
 * @param {number} limit 字节上限。
 * @returns {Promise<{ok: boolean, status?: number, value?: object, error?: string}>}
 */
async function readJsonBody(req, limit) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) return { ok: false, status: 413, error: "请求体过大。" };
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: "请求体不是合法 JSON。" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "请求体必须是对象。" };
  }
  return { ok: true, value };
}

/**
 * 发 JSON 响应。
 * @param {object} res 响应。
 * @param {number} status HTTP 码。
 * @param {object} payload 载荷。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

// ══════════════════════════════════════════════════════════════
// 总纲正文（功能④ 注入的就是它）
//
// 严格照抄准则 6.2 的结构与理由措辞 —— 它是需求文档，不是可以随意改写的实现细节。
// 特别保留「为什么分册」「最后一列是核心」这类论证：
// 智能体理解了理由，才会在要册满时主动开新册，而不是硬塞进旧册。
// ══════════════════════════════════════════════════════════════
const OUTLINE_TEXT = `# 知识库总纲

本目录是**项目级知识库**：可复用的做法放\`方法/\`，踩过的坑放 \`避错/\`。

## 结构

\`\`\`
${KB_DIR_NAME}/
├── 00-开始这里-总纲.md      ← 本文件
├── 方法/
│   ├── 00-方法主体.md                ← 分册索引
│   └── 方法-01-【领域】.md           ← 装${PREFIX.方法}-001 ~ ${PREFIX.方法}-010
└── 避错/
    ├── 00-避错主体.md                ← 分册索引
    └── 避错-01-【领域】.md           ← 装 ${PREFIX.避错}-001 ~ ${PREFIX.避错}-010
\`\`\`

## 为什么分册（省上下文）

**一条一个文件** → 查 30 条要读 30 次文件，每次都烧上下文。
**分册装订** → 一册 ${VOLUME_PER_BOOK} 条，读 1 次拿到 ${VOLUME_PER_BOOK} 条。

但光分册不够—— **必须有一个主体文件写明每册「什么时候读它」**。
没有它，你不知道该读哪册，只能全量加载，分册就白分了。

## 怎么读（按需加载，别全量读）

1. 读本总纲 → 知道有几册、各管什么
2. 读该侧的**主体文件** → 定位相关册
3. **只读那1~2 册**
4. 或直接用 \`kb_search\` 工具按关键词抽（更快，不用手读）

## 编号规则

- \`${PREFIX.方法}-0XX\` = 方法，\`${PREFIX.避错}-0XX\` = 避错
- 三位数从 001 起，**只增不改** —— 已发布编号永不复用，引用才靠得住
- 领域靠分册体现，不靠编号前缀

## 分册规则

- **按领域分册，不按时间分册**（按时间分，「找某个坑」要翻遍所有册）
- 每册容量 ${VOLUME_PER_BOOK} 条，装满即开新册；册名要自解释
  - 每次新增条目，**索引由工具自动同步**（你不用手改索引里的行）。

## 上限与删除

  - **每册装满自动开新册**（默认 ${VOLUME_PER_BOOK} 条/册，用户可在设置里改）。
  - **总量上限**默认不限；设了之后写满会被**拒绝**并提示你删几条 ——
    系统**不会替你删**，删哪条是你的决定。
  - ` + "`kb_remove`" + ` 删单条、` + "`kb_prune`" + ` 清理到指定条数（**只删最旧的**）。
    两者都**不可撤销**，动手前先跟用户确认要删哪条。

## 沉淀约定（准则 6.1）

| 触发词 | 时机 | 你该做什么 |
|---|---|---|
| **搞定** | 一个问题刚解决 | 用 \`kb_add\` 写一条避错 |
| **复盘** | 一个阶段结束 | \`kb_list\` 通读，补漏 / 去重 / 删过期 |
| **记住** | 用户陈述偏好或约定 | 告诉用户你已记录 |

**用户不说，但你自己意识到「这是个以后还会踩的坑」→ 主动问一句「要不要记进避错」。**
主动提议沉淀是加分项；擅自往库里堆垃圾是减分项。

## 写条目的硬要求（准则 6.4 / 6.6）

**避错条目**必须有四段，缺一不可：

\`\`\`
触发条件    下次什么时候会遇到
先做        1、2、3 可执行动作（不是「注意规范」这种空话）
为什么      依据是什么
违规症状    怎么判断你没做 —— **没这一项等于没规则**
\`\`\`

**每写一条，反问自己：怎么判断违反了这条？** 答不上来说明它是装饰品。

**不要写事故叙事。**「那天我改了个文件结果编译炸了」没人会看第二次；
写成下次可执行的检查指令才有用。

## 内容归属：什么写哪

| 内容性质 | 去处 |
|---|---|
| 可复用的流程、做法 | \`方法/\` |
| 踩过的坑、失败原因 | \`避错/\` |
| 今天具体干了什么 | 当日记录（不污染本库） |
| 用户偏好 / 项目约定 | 长期记忆 |

判断标准：**这条换个项目还有用吗？** 只对眼前这次有用就别写进长期库。
`;

/**
 * 生成「手动沉淀」的指令文本。
 *
 * ## 为什么只生成指令、不直接写库
 * 沉淀的**质量**取决于「刚跟用户聊完、知道踩了什么坑」的那个智能体。
 * 旁路调一个模型来提炼，等于让它猜这次对话发生了什么 ——
 * 而库里的条目是要长期复用的，猜错的内容比没有更糟。
 *
 * 所以分工是：**host 负责校验与限流，智能体负责提炼与写入**。
 * host 已经在这里挡掉了两种不该白跑的情况：
 * - 库不存在（NO_LIBRARY）
 * - 总量已满（MAX_TOTAL_REACHED）
 *
 * ## 类别 / 领域 / 项目都由**智能体**判断
 * host 只给「建议」和「候选清单」，不再替它拍板：
 * - `kindHint` / `domainHint` 是设置页里的建议值，允许被推翻
 * - domain **不再兜底成「未分类」** —— 硬塞一个「未分类」等于没判断，
 *   还会把所有没判断的条目挤进同一个册子
 * - 目标项目可能是 `null`（用户选了「由智能体自己决定」），
 *   这时给出候选清单让它挑，而不是替它选
 *
 * @param {object} options 组装指令所需的一切。
 * @param {"避错"|"方法"} options.kindHint 建议类别（智能体可推翻）。
 * @param {string} options.domainHint 建议领域（空 = 不给建议）。
 * @param {KnowledgeBase | null} options.kb 目标库（agent 自己决定时为 null）。
 * @param {{root: string, name: string}} [options.target] 已敲定的目标项目。
 * @param {Array<{name: string, path: string, dir: string, exists: boolean}>} options.candidates
 *   候选项目清单（已敲定目标时为空数组）。
 * @returns {string} 给智能体的指令。
 */
function distillInstruction(options) {
  const { kindHint, domainHint, kb, target, candidates } = options;
  const cap = kb === null
    ? ""
    : kb.maxTotal > 0
      ? `（该库当前 ${kb.count()}/${kb.maxTotal} 条）`
      : `（该库当前 ${kb.count()} 条）`;
  const kindLabel = kindHint === "方法" ? "方法" : "避错";
  const fields =
    "避错 → trigger（触发条件）、steps（先做，1..n 条）、why（为什么）、symptoms（违规症状）；" +
    "方法 → trigger（适用场景）、steps（步骤，1..n 条）、verify（验证方式）、boundaries（已知边界）";

  const lines = [
    "【手动沉淀】用户点了「沉淀」按钮，请把**本次对话**里值得长期复用的经验沉淀进知识库。",
    "",
    "## 先由你判断（不要照抄建议）",
    "- **这一条该进「方法」还是「避错」**：由你按本次对话内容判断，并说明依据。",
    "- **它属于哪个「领域」**：由你按本次对话内容判断，并说明依据。",
    `  · 设置页给的只是**建议**，你可以推翻：kind 建议=${kindLabel}，domain 建议=${
      domainHint === "" ? "（无，完全由你判断）" : domainHint
    }`,
    "  · 判断依据请用一句话写进你的回复里，用户要能看到你为什么这么归类。",
    "",
    "## 写到哪个项目",
  ];

  if (target !== undefined && target !== null) {
    lines.push(
      `目标项目：**${target.name === "" ? "(未命名)" : target.name}** —— ${target.root}`,
      cap === "" ? "" : `容量：${cap}`,
    );
  } else {
    lines.push(
      "用户在按钮里选了**「由智能体自己决定」**：先判断本次对话属于下面哪一个项目，再决定写哪本库。",
    );
    if (candidates.length === 0) {
      lines.push(
        "",
        "⚠ **当前没有任何候选项目**（没有登记过项目，当前会话项目也没有知识库）。",
        "请直接告诉用户「现在没有可写入的知识库项目」，并说明怎么建 —— 不要随便挑一个地方写。",
      );
    } else {
      lines.push("", "候选项目（都已建好知识库）：");
      for (const c of candidates) {
        lines.push(`- ${c.name} —— ${c.path}（库：${c.dir}）`);
      }
      lines.push(
        "",
        "挑定之后，`kb_add` 必须带上 `project`，值用**项目名**（上面横线前的那个）。",
        "如果本次对话不属于其中任何一个项目，就如实说明并停下，**不要硬塞进最近的那个**。",
      );
    }
  }

  lines.push(
    "",
    `必填字段：${fields}`,
    "",
    "硬性要求（不满足会被 kb_add 直接拒绝）：",
    "避错：写成**前瞻式 guard**，不写事故叙事（「那天改了文件结果编译炸了」没人会看第二次）；",
    "      「违规症状 symptoms」必填 —— 没有可观测症状的规则等于没规则；",
    "      反问自己：怎么判断违反了这条？答不上来说明它是装饰品，别写。",
    "方法：steps 必须是可执行动作，不是「注意规范」这种空话；",
    "      verify 写怎么确认做对了；boundaries 写什么情况下这套不适用。",
    "",
    "如果本次对话**没有**值得沉淀的东西（只是闲聊/查资料/一次性的操作），",
    "就**直接说明「本次对话没有可沉淀的内容」并停下** —— 不要硬凑一条空泛的。",
    "宁可这一轮不写，也不要往库里堆垃圾条目。",
    "",
    target !== undefined && target !== null
      ? "确认有料就调 kb_add(kind=..., domain=..., ...)，写完把编号告诉用户。"
      : "确认有料就调 kb_add(project=\"项目名\", kind=..., domain=..., ...)，写完把编号告诉用户。",
  );
  return lines.join("\n");
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文。
 * @returns {Function} disposer。
 */
export function apply(ctx) {
  const dataDir = resolveDataDir();

  //用户配置（全局一份，跨项目共用）。**apply 时就 load**——
  // 读不出来也要继续（用默认值），配置损坏不该让整个插件起不来。
  const configStore = new ConfigStore(dataDir);
  configStore.load();
  if (configStore.lastError !== null) {
    ctx.logger?.warn?.(
      `[dsh-knowledge] 配置读取失败，已用默认值：${configStore.lastError}`,
    );
  }

  // 启动时把目录选择能力的探测结果写进日志。
  // ⚠ 这行是为「为什么界面上没有浏览按钮」准备的 —— 那个问题的答案
  //   全在 kind/reason 里，但配置文件里看不到，写日志才能一眼定位。
  ctx.logger?.info?.(`[dsh-knowledge] 目录选择器探测：${JSON.stringify(pickerInfo())}`);

  /** @type {Map<string, KnowledgeBase>} 项目根 → 已加载的库 */
  const cache = new Map();

  /**
   * 项目登记表的内存副本（`<dataDir>/projects.json` 的 `registry`）。
   *
   * 放内存是为了不每次 `kbFor()` 都读一次盘；
   * 每次登记后**必须**重新赋值（见 registerProject 的调用点）。
   * @type {Array<{name: string, path: string}>}
   */
  let projectRegistry = readProjectRegistry(dataDir).registry;

  /**
   * 取某个项目根登记过的名字（没登记返回空串）。
   * @param {string} root 已 resolve 的项目根。
   * @returns {string}
   */
  function projectNameOf(root) {
    const hit = projectRegistry.find((e) => path.resolve(e.path) === root);
    return hit?.name ?? "";
  }

  /**
   * 取某项目的知识库。**不存在时返回 null**（绝不自动建，见 KnowledgeBase.locate 注释）。
   * @param {string} projectRoot 项目根。
   * @param {string} [explicitName] 已解析好的项目名（空 = 自己查登记表）。
   * @returns {KnowledgeBase | null}
   */
  /**
   * 正在进行的原生目录选择（并发锁）。
   *
   * ⚠ 同时弹两个系统对话框会让用户不知所措，返回值也会错配到两个请求上。
   */
  let picking = null;

  /**
   * 取官方目录选择服务的**能力类型**。
   *
   * ## 契约（实读 @deepseek-ai/dsh-host-directory-picker）
   * ```
   * ctx.directoryPicker.capability() -> { kind, pick? }
   *   kind === "native" → 在宿主显示器上开一个 OS 选择器；pick(signal) -> 路径 | null
   *   kind === "browse" → 只有 listing/creation 原语（给应用内浏览器用，没有弹窗）
   * ```
   * 官方原话：「未知 kind 的默认处理是**隐藏选择入口**，而不是失败」——
   * 所以拿不到就返回 null，前端据此不显示「浏览」按钮。
   *
   * ## 为什么用 ctx.get 软探测而**不进 inject**
   * 它是**可选**服务：缺了只是「不能弹原生选择框」，
   * 不该让整个插件停 PENDING（这正是 inject 的语义 —— 声明了就必须有）。
   *
   * ## 本机为什么是 native
   * `dsh-host-directory-picker-auto` 的解析规则：
   *   bindHost 必须是 127.0.0.1、非 SSH 启动，
   *   且 win32/darwin 直接判 native。
   * 桌面端正是 loopback + 本地启动 ⇒ 解析为 native（真实测过依赖链：
   * dsh-web-app 依赖 directory-picker-auto，而本机 profile 装了 dsh-web-app）。
   *
   * @returns {"native" | "browse" | null} 能力类型；服务不可用时为 null。
   */
  function pickerInfo() {
    try {
      const svc = ctx.get?.("directoryPicker");
      if (svc === undefined || svc === null) {
        return { kind: null, canPick: false, reason: "service-absent" };
      }
      const capability = svc.capability?.();
      if (capability === undefined || capability === null) {
        return { kind: null, canPick: false, reason: "capability-missing" };
      }
      const kind = typeof capability.kind === "string" ? capability.kind : null;
      // ⚠ `canPick` 是**最终结论**：前端只看它，不做字符串比较 ——
      //   判断只留一处（在这里），前端改不动也不用跟着改。
      const canPick = kind === "native" && typeof capability.pick === "function";
      if (kind === "native") {
        return { kind, canPick, reason: canPick ? "ok" : "no-pick-method" };
      }
      // browse = 官方说的「应用内浏览器」后端，没有原生弹窗能力
      return { kind, canPick, reason: kind === null ? "kind-missing" : "not-native" };
    } catch (error) {
      // 服务没装载时 cordis 的 get 会抛错 —— 软探测必须吞掉它
      return { kind: null, canPick: false, reason: "get-threw: " + (error?.message ?? String(error)) };
    }
  }

  function kbFor(projectRoot, explicitName = "") {
    if (typeof projectRoot !== "string" || projectRoot.trim() === "") return null;
    const key = path.resolve(projectRoot.trim());
    // ⚠ 项目名会影响库路径（baseDir 布局下的子目录名），所以它变了
    //   缓存就必须作废 —— 否则改完名字还在按老路径读，界面上看起来
    //   「设置改了但没用」。登记/改名的地方会 cache.clear()。
    const name = explicitName !== "" ? safeDirName(explicitName) : projectNameOf(key);
    const cached = cache.get(key);
    if (cached !== undefined && cached.projectName === name) return cached;
    if (cached !== undefined) cache.delete(key);
    // ⚠ 必须把配置传进去 —— 库路径由 baseDir 决定，
    //   不传的话用户在设置里改了「存储位置」也没用。
    const kb = KnowledgeBase.locate(key, configStore.get(), name);
    if (kb === null) return null;
    // ⚠ **必须传配置**：KnowledgeBase 的默认构造等价于 DEFAULT_CONFIG，
    //   但用户在设置页改了上限后，缓存里的库也得跟着改 ——
    //   所以每次新建都读一次 ConfigStore，且 setConfig 生效时
    //   会 applyConfig 到所有已缓存的库（见下面 setConfig）。
    kb.applyConfig(configStore.get());
    kb.load();
    cache.set(key, kb);
    return kb;
  }

  /**
   * 候选项目清单 = 登记表里的项目 + 当前会话项目。
   *
   * 两处共用同一份定义（客户端的选择器、给智能体的候选清单），
   * 免得「界面上能选」和「智能体被告知的」是两份不一样的名单。
   *
   * @param {string} currentRoot 当前会话项目根（可为空串）。
   * @returns {Array<{name: string, path: string, dir: string, exists: boolean}>}
   */
  function projectCandidates(currentRoot) {
    const rows = [];
    const push = (root, name) => {
      if (root === "" || rows.some((r) => r.root === root)) return;
      rows.push({ root, name });
    };
    for (const entry of projectRegistry) push(path.resolve(entry.path), entry.name);
    if (typeof currentRoot === "string" && currentRoot.trim() !== "") {
      const root = path.resolve(currentRoot.trim());
      push(root, projectNameOf(root));
    }
    return rows.map((r) => {
      const kb = kbFor(r.root, r.name);
      return {
        name: r.name !== "" ? r.name : path.basename(r.root),
        path: r.root,
        dir: kb !== null ? kb.dir : resolveKbDir(r.root, configStore.get().baseDir, r.name),
        exists: kb !== null,
      };
    });
  }

  /**
   * 把新配置套到所有已缓存的库上。
   *
   * ⚠ 必须做：缓存里的 KnowledgeBase 是在配置改动**之前**建的，
   *   不刷新的话用户改完上限立刻写入，仍按旧上限走 —— 表现为
   *   「设置改了但没用」，而界面上没有任何提示。
   *
   * @param {object} config 新配置。
   */
  function setConfig(config) {
    for (const kb of cache.values()) kb.applyConfig(config);
  }

  /**
   * 从执行上下文里推断当前项目根。
   *
   * 优先用 `exec.cwd`（工具执行时带的），退到会话工作区，
   * 再退到 `process.cwd()`。拿不到就用空串——
   * **宁可让智能体显式传 cwd，也不要猜错项目**（猜错会检索到别的项目的避错）。
   *
   * @param {object} exec 工具执行上下文。
   * @returns {string} 项目根。
   */
  function projectOf(exec) {
    const candidates = [
      exec?.cwd,
      exec?.session?.header?.cwd,
      exec?.agent?.session?.header?.cwd,
      process.cwd(),
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim() !== "") return path.resolve(c.trim());
    }
    return process.cwd();
  }

  ctx.effect(() => {
    // ── 工具注册 ────────────────────────────────────────────
    //
    // `tools` 走 ctx.get() 软探测：缺服务时只是「工具没注册」，
    // 而如果写进 inject，服务缺失会让**整个插件停摆**（知识库这条防线消失）。
    const tools = ctx.get?.("tools") ?? null;
    if (tools === null) {
      ctx.logger?.warn?.("[dsh-knowledge] 未取到 tools 服务，工具未注册（知识库仍可读写文件）");
    } else {
      registerTools(ctx, tools, {
        kbFor,
        projectOf,
        dataDir,
        cache,
        configStore,
        registryOf: () => projectRegistry,
        // ⚠ 登记表的内存副本是 `apply()` 作用域的变量，改它的正规动作是**回调**
        //   （`registerTools` 是顶层函数，够不着那个变量 —— 直接赋值会是
        //   `ReferenceError: projectRegistry is not defined`）。
        onRegistryChanged: () => {
          projectRegistry = readProjectRegistry(dataDir).registry;
          // 项目名决定库路径（baseDir 布局下的子目录名）⇒ 缓存必须作废
          cache.clear();
        },
      });
    }

    // ── 系统提示注入（功能④）──────────────────────────────
    //
    // 只注入**总纲**，条目靠 kb_search 按需拉。
    // 这符合用户明确选的策略，也是准则 6.7「沉淀不能拖慢干活」的要求。
    const cfgForInject = configStore.get();
    const systemPrompt = ctx.get?.("systemPrompt") ?? null;
    if (systemPrompt === null) {
      ctx.logger?.warn?.("[dsh-knowledge] 未取到 systemPrompt 服务，总纲未注入");
    } else if (cfgForInject.injectEnabled !== true) {
      // 用户在设置里关掉了注入 —— 每轮省掉约 1.4k 字符，
      // 代价是智能体不再主动知道知识库怎么用（只能靠用户明说）。
      ctx.logger?.info?.("[dsh-knowledge] 已按设置关闭总纲注入");
    } else {
      // ⚠ section 的 order 必须是**有限数**，否则抛 TypeError。
      //   900 这个档位是官方 FILE_REFERENCE 附近 —— 放在工具说明之后、
      //   文件引用之前，保证「知识库怎么用」在模型读工具之前就说清楚。
      //
      // 按 injectMaxChars 截断：总纲约 1441 字，默认给足余量；
      // 调小可以省 token，但截断处要留一句提示，否则模型会以为总纲就这么多。
      const cap = Number.isInteger(cfgForInject.injectMaxChars) && cfgForInject.injectMaxChars > 0
        ? cfgForInject.injectMaxChars
        : OUTLINE_TEXT.length;
      const text = OUTLINE_TEXT.length > cap
        ? OUTLINE_TEXT.slice(0, cap) + "\n\n（总纲已按设置的字数上限截断）"
        : OUTLINE_TEXT;
      systemPrompt.section({
        name: "dsh-knowledge:outline",
        order: 900,
        text,
      });
    }

    // ── 路由 ────────────────────────────────────────────────
    ctx.webServer.register({
      kind: "exact",
      path: CLIENT_SCRIPT_PATH,
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        try {
          const text = fs.readFileSync(path.join(here, "client.js"), "utf8");
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            // ⚠ 必须显式禁止缓存：这个 URL 是固定的 `/__kb/client.js`，
            //   一旦 renderer 缓存住旧 JS，用户会「重启了也看不到改动」——
            //   而那种现象极难与「没重启」区分开。
            "cache-control": "no-store, no-cache, must-revalidate",
            pragma: "no-cache",
          });
          res.end(text);
        } catch (error) {
          res.writeHead(500).end();
        }
      },
    });

    ctx.webServer.register({
      kind: "exact",
      path: "/__kb/list",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        const root = queryParam(req, "cwd") ?? process.cwd();
        const kb = kbFor(root);
        if (kb === null) {
          sendJson(res, 200, { ok: true, exists: false, cwd: path.resolve(root), entries: [] });
          return;
        }
        sendJson(res, 200, { ok: true, exists: true, ...kb.describe(), entries: kb.list() });
      },
    });

    ctx.webServer.register({
      kind: "exact",
      path: "/__kb/get",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        const id = queryParam(req, "id");
        const kb = kbFor(queryParam(req, "cwd") ?? process.cwd());
        if (kb === null) {
          sendJson(res, 200, { ok: true, exists: false, entry: null });
          return;
        }
        const entry = id === null ? null : kb.get(id);
        if (entry === null) {
          sendJson(res, 404, { ok: false, error: `没有编号 ${id}` });
          return;
        }
        sendJson(res, 200, { ok: true, exists: true, entry });
      },
    });

    ctx.webServer.register({
      kind: "prefix",
      path: "/__kb/search",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        const kb = kbFor(queryParam(req, "cwd") ?? process.cwd());
        if (kb === null) {
          sendJson(res, 200, { ok: true, exists: false, results: [] });
          return;
        }
        const limit = Number(queryParam(req, "limit") ?? "5");
        const results = kb.search({
          text: queryParam(req, "q") ?? "",
          kind: queryParam(req, "kind") ?? undefined,
          domain: queryParam(req, "domain") ?? undefined,
          limit: Number.isInteger(limit) ? limit : 5,
        });
        sendJson(res, 200, { ok: true, exists: true, results });
      },
    });

    // ── 选目录：调官方 directoryPicker 的**原生**对话框 ────────────
    //
    // 用户不该被要求手打路径 —— 正常软件都是「浏览…」弹出系统选择框。
    // DSH 官方把这个能力做成了 `ctx.directoryPicker` 服务，
    // 我们用它的 native 后端（桌面端 = loopback + 本地启动，正是 native）。
    ctx.webServer.register({
      kind: "exact",
      path: "/__kb/pick-dir",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }

        const cap = (() => {
          try {
            return ctx.get?.("directoryPicker")?.capability?.() ?? null;
          } catch {
            return null;
          }
        })();
        const info = pickerInfo();

        // 官方文档：对不可用的 kind 应当**隐藏入口**，而不是报一个用户看不懂的错。
        // 前端本来就不该在非 native 时显示按钮 —— 这里兜住直接调接口的情况。
        if (cap?.kind !== "native" || typeof cap.pick !== "function") {
          sendJson(res, 501, {
            ok: false,
            code: "NO_NATIVE_PICKER",
            kind: info.kind,
            reason: info.reason,
            error: "当前环境没有可用的系统目录选择框，请手动填写路径。",
          });
          return;
        }

        if (picking !== null) {
          sendJson(res, 409, {
            ok: false,
            code: "PICKING",
            error: "已经有一个目录选择窗口开着，请先处理它。",
          });
          return;
        }

        const controller = new AbortController();
        // 兜底超时：用户把对话框晾着不关时，别让请求和锁一直挂着。
        const timer = setTimeout(() => {
          try {
            controller.abort();
          } catch {
            /* abort 不该抛 */
          }
        }, 5 * 60 * 1000);
        picking = controller;

        try {
          const chosen = await cap.pick(controller.signal);
          // 官方约定：用户取消 → 空串/null（见 native 后端的 outputPath）
          if (typeof chosen !== "string" || chosen.trim() === "") {
            sendJson(res, 200, { ok: true, canceled: true, path: null });
            return;
          }
          sendJson(res, 200, { ok: true, canceled: false, path: chosen });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`,
          });
        } finally {
          clearTimeout(timer);
          picking = null;
        }
      },
    });

    // ── 配置：读 / 写 / 恢复默认 ────────────────────────────
    //
    // GET  顺带返回当前项目的条目数，让设置页能显示「已沉淀 N 条」
    // POST { volumePerBook?, maxTotal?, autoPruneThreshold?, maxEntryBytes? }
    // POST { restoreDefaults: true } → 回默认
    ctx.webServer.register({
      kind: "exact",
      path: "/__kb/config",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;

        if (req.method === "GET") {
          // ⚠ 设置页**没有会话上下文**，客户端拿不到项目根 ⇒ cwd 会缺失。
          //   此时**不许用 process.cwd() 兜底** —— 那是宿主进程的工作目录，
          //   不是用户的项目，会返回一个「看起来像真的」但属于别的项目的计数。
          //   如实回 null 让前端显示「尚未确定当前项目」。
          //
          //   注意：config 是**全局**的（存 ~/.dsh），与 cwd 无关 ——
          //   所以 cwd 缺失照样能把配置读回去，这正是设置页能显示的原因。
          const root = queryParam(req, "cwd");
          const kb = root === null ? null : kbFor(root);
          sendJson(res, 200, {
            ok: true,
            config: configStore.get(),
            defaults: { ...DEFAULT_CONFIG },
            clientScript: CLIENT_SCRIPT_PATH,
            dataDir,
            // cwd 缺失时 project 为 null，前端据此显示「尚未确定当前项目」
            project: kb === null ? null : kb.dir,
            // 库还没建时也告诉前端「将会建在哪」——
            // 用户改了存储位置后要能立刻看到实际生效的目录。
            // ⚠ 必须带登记名：baseDir 布局下子目录名用的是**项目名**，
            //   不带就会显示成 basename，与真正落盘的位置不一致。
            targetDir:
              root === null
                ? null
                : resolveKbDir(
                    root,
                    configStore.get().baseDir,
                    projectNameOf(path.resolve(root)),
                  ),
            // 前端据此决定要不要显示「浏览…」按钮：
            // 官方要求对未知 kind **隐藏入口**，而不是点了才报错。
            picker: pickerInfo(),
            count: kb === null ? null : kb.count(),
            counts: kb === null ? null : kb.describe().counts,
            exists: kb !== null,
            cwdKnown: root !== null,
          });
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const parsed = await readJsonBody(req, 64 * 1024);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const result =
          parsed.value?.restoreDefaults === true
            ? await configStore.restoreDefaults()
            : await configStore.save(parsed.value);
        if (result.ok === true) {
          // ⚠ 必须刷新已缓存的库 —— 否则「设置改了但写入仍按旧上限」，
          //   用户看到设置生效了却没效果，且界面上没有任何提示。
          setConfig(result.config);
          result.config.appliedToCachedLibraries = cache.size;
        }
        sendJson(res, result.ok === true ? 200 : 500, result);
      },
    });

    // ── 删除单条 ────────────────────────────────────────────
    ctx.webServer.register({
      kind: "prefix",
      path: "/__kb/remove",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const parsed = await readJsonBody(req, 64 * 1024);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const root =
          typeof parsed.value.cwd === "string" ? parsed.value.cwd : process.cwd();
        const kb = kbFor(root);
        if (kb === null) {
          sendJson(res, 409, { ok: false, error: "这个项目还没有知识库。" });
          return;
        }
        const result = await kb.remove(String(parsed.value.id ?? ""));
        sendJson(res, result.ok === true ? 200 : 400, { ...result, count: kb.count() });
      },
    });

    // ── 手动沉淀：把当前对话交给智能体提炼 ────────────────────
    ctx.webServer.register({
      kind: "prefix",
      path: "/__kb/distill",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const parsed = await readJsonBody(req, 64 * 1024);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const body = parsed.value;
        const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

        // ── ① 先敲定「沉淀到哪个项目」─────────────────────────
        // 客户端的选择器给出四选一：
        //   当前项目(cwd) / 已登记项目(project) / 新建项目(newProject) / 由智能体决定(agentDecides)
        let target = null;
        let explicitPick = false;
        const agentDecides = body.agentDecides === true;

        if (body.newProject !== null && typeof body.newProject === "object") {
          const reg = registerProject(dataDir, body.newProject.name, body.newProject.path);
          if (reg.ok !== true) {
            sendJson(res, 400, { ok: false, code: "BAD_PROJECT", error: reg.error });
            return;
          }
          projectRegistry = readProjectRegistry(dataDir).registry;
          cache.clear();
          target = { root: reg.project.path, name: reg.project.name };
          explicitPick = true;
        } else if (agentDecides === true) {
          target = null;
        } else if (typeof body.project === "string" && body.project.trim() !== "") {
          const hit = resolveProjectRef(body.project, projectRegistry);
          if (hit === null) {
            sendJson(res, 400, {
              ok: false,
              code: "UNKNOWN_PROJECT",
              error: `找不到项目「${body.project.trim()}」：它不在项目登记表里，也不是一个存在的目录。`,
            });
            return;
          }
          target = hit;
          explicitPick = true;
        } else {
          // 老路径：用会话 cwd。**拿不到就说拿不到**，不兜底 process.cwd()
          // —— 那会把条目写进「插件进程所在目录」，而用户以为写进了自己的项目。
          if (cwd === "") {
            sendJson(res, 400, {
              ok: false,
              code: "NO_CWD",
              error: "尚未确定当前项目。请先选一个项目，或填一个新项目。",
            });
            return;
          }
          target = { root: path.resolve(cwd), name: projectNameOf(path.resolve(cwd)) };
        }

        // 用户**显式**点了某个项目（含新建）时，库不存在就顺手把骨架建出来 ——
        // 「选了这个项目，还得先去别处建库」是条死路。
        // ⚠ 「当前项目」这条老路径**不建**：静默建库会掩盖
        //   「这个项目其实没在用知识库」这个事实（见 KnowledgeBase.locate 的注释）。
        if (target !== null && explicitPick) {
          if (kbFor(target.root, target.name) === null) {
            const init = initKnowledgeBase(target.root, dataDir, configStore.get(), target.name);
            if (init.ok !== true) {
              sendJson(res, 500, { ok: false, error: `建库失败：${init.error ?? "未知原因"}` });
              return;
            }
            cache.clear();
          }
        }

        // ── ② 目标库校验（只有「由智能体决定」时没有目标库）────
        const kb = target === null ? null : kbFor(target.root, target.name);
        if (target !== null && kb === null) {
          sendJson(res, 409, {
            ok: false,
            code: "NO_LIBRARY",
            error: "这个项目还没有知识库。先建出骨架再沉淀（准则 6.2：不许只在脑子里记着）。",
          });
          return;
        }
        if (kb !== null && kb.maxTotal > 0 && kb.count() >= kb.maxTotal) {
          sendJson(res, 409, {
            ok: false,
            code: "MAX_TOTAL_REACHED",
            error: `条目总数已达上限 ${kb.maxTotal} 条。先删几条，或调高设置里的总量上限。`,
            count: kb.count(),
            maxTotal: kb.maxTotal,
          });
          return;
        }

        // ── ③ 只给**建议**，判断权在智能体 ────────────────────
        // 客户端不指定时用设置页的建议值。
        // domain 留空 = 不给建议；**绝不兜底成「未分类」** ——
        // 那等于替智能体做了判断，还会把所有没判断的条目挤进同一个册子。
        const cfgDistill = configStore.get();
        const kindHint =
          body.kind === "方法" || body.kind === "避错"
            ? body.kind
            : cfgDistill.defaultKind === "方法"
              ? "方法"
              : "避错";
        const domainHint =
          typeof body.domain === "string" && body.domain.trim() !== ""
            ? body.domain.trim()
            : typeof cfgDistill.defaultDomain === "string"
              ? cfgDistill.defaultDomain.trim()
              : "";

        // ④ **不代智能体写条目** —— 只投递一条明确指令，让它自己读对话、提炼、
        //    然后调 kb_add。
        //
        // 为什么不在这里旁路调 LLM：
        //   - 拿不到当前会话的 Agent 对象（官方 startContinuable 硬要求
        //     caller 是**精确的 live Agent 对象**，客户端跨端拿不到）
        //   - 沉淀质量取决于「懂这次对话上下文的那个智能体」，
        //     换旁路模型提炼等于让它猜
        //   - 写入前会走 normalizeEntry 的四段硬校验，垃圾进不来
        const candidates =
          target === null ? projectCandidates(cwd).filter((c) => c.exists === true) : [];
        const instruction = distillInstruction({
          kindHint,
          domainHint,
          kb,
          target,
          candidates,
        });
        sendJson(res, 200, {
          ok: true,
          kindHint,
          domainHint,
          target:
            target === null
              ? null
              : { name: target.name, path: target.root, dir: kb === null ? null : kb.dir },
          count: kb === null ? null : kb.count(),
          maxTotal: kb === null ? null : kb.maxTotal,
          // 由客户端注入到会话里（前端拿它去拼接投递内容）
          instruction,
          // 告诉前端「只是委托，不是已写入」—— 避免假装成功
          delegated: true,
        });
      },
    });

    // ── 项目登记表：客户端的选择器靠它列出「已登记的项目」────────
    ctx.webServer.register({
      kind: "prefix",
      path: "/__kb/projects",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        const cwd = queryParam(req, "cwd") ?? "";

        if (req.method === "GET") {
          projectRegistry = readProjectRegistry(dataDir).registry;
          sendJson(res, 200, {
            ok: true,
            projects: projectCandidates(cwd),
            // 前端据此决定「新建项目」表单里要不要显示「浏览…」——
            // 与设置页同一条规则：弹不出系统选择框就隐藏入口。
            picker: pickerInfo(),
          });
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const parsedBody = await readJsonBody(req, 64 * 1024);
        if (!parsedBody.ok) {
          sendJson(res, parsedBody.status, { ok: false, error: parsedBody.error });
          return;
        }
        const reg = registerProject(dataDir, parsedBody.value.name, parsedBody.value.path);
        if (reg.ok !== true) {
          sendJson(res, 400, { ok: false, code: "BAD_PROJECT", error: reg.error });
          return;
        }
        projectRegistry = readProjectRegistry(dataDir).registry;
        // 项目名决定库路径（baseDir 布局下），缓存必须作废
        cache.clear();
        sendJson(res, 200, { ok: true, project: reg.project, projects: projectCandidates(cwd) });
      },
    });

    ctx.webServer.register({
      kind: "prefix",
      path: "/__kb/init",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const parsed = await readJsonBody(req, 64 * 1024);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const cwd = typeof parsed.value.cwd === "string" ? parsed.value.cwd : process.cwd();
        // ⚠ 带上登记名 —— 库路径由 baseDir + 项目名决定，不带就会把骨架
        //   建到 `<baseDir>/<basename>`，而其它路径都去 `<baseDir>/<项目名>` 找。
        const name = projectNameOf(path.resolve(cwd));
        sendJson(res, 200, initKnowledgeBase(cwd, dataDir, configStore.get(), name));
      },
    });

    ctx.webServer.register({
      kind: "exact",
      path: "/__kb/add",
      handler: async (req, res) => {
        if (!passSameOrigin(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const parsed = await readJsonBody(req, 256 * 1024);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const cwd = typeof parsed.value.cwd === "string" ? parsed.value.cwd : process.cwd();
        const kb = kbFor(cwd);
        if (kb === null) {
          sendJson(res, 409, {
            ok: false,
            error: `这个项目还没有知识库。先调 kb_init 建骨架（准则 6.2：不许只在脑子里记着）。`,
          });
          return;
        }
        const kind = parsed.value.kind;
        if (!KINDS.includes(kind)) {
          sendJson(res, 400, { ok: false, error: `kind 必须是 ${KINDS.join(" 或 ")}` });
          return;
        }
        const result = await kb.write(kind, parsed.value);
        sendJson(res, result.ok ? 200 : 400, result);
      },
    });

    // 注入客户端 bundle 到 index.html
    //
    // ⚠⚠ **tapIndex 收的是「transform 函数」，不是字符串**——
    //   官方实现：`for (const transform of this.indexTaps) out = transform(out);`
    //   传字符串会让 `transform` 不是函数 → `TypeError: transform is not a function`
    //   → **整个 index.html 渲染失败** → 桌面端 renderer 认证端点拿不到
    //   → 表现为 `browser authentication failed with HTTP 400`，
    //   而插件日志里一行错误都没有（400 出现在 Electron 主进程，栈里全是官方文件）。
    //
    //   幂等：DSH 每次渲染 index 都会跑一遍所有 tap，所以要自己防重复注入。
    ctx.webServer.tapIndex((html) => {
      if (typeof html.includes("data-knowledge-bridge") === "function" && html.includes("data-knowledge-bridge")) {
        return html;
      }
      const script = `<script defer src="${CLIENT_SCRIPT_PATH}" data-knowledge-bridge></script>`;
      return html.includes("</body>")
        ? html.replace("</body>", `${script}</body>`)
        : `${html}${script}`;
    });
  });
}

/**
 * 取查询参数。路由用 `kind: "prefix"`，参数在 search 里。
 * @param {object} req 请求。
 * @param {string} name 参数名。
 * @returns {string | null}
 */
function queryParam(req, name) {
  try {
    const url = new URL(req.url, `http://${req.headers?.host ?? "127.0.0.1"}`);
    const value = url.searchParams.get(name);
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/**
 * 项目登记表文件名。
 *
 * 里面有两个键，**共用一个文件、互不覆盖**：
 * - `projects`: 库目录清单（老字段，`initKnowledgeBase()` 一直在写）
 * - `registry`: `[{name, path}]` 项目登记（用户手填的项目名 + 项目路径）
 */
const PROJECTS_FILE = "projects.json";

/**
 * 读项目登记表。**不抛错** —— 表损坏只当「什么都没登记」。
 *
 * 老格式（只有 `projects` 数组）照读不误：那是 `initKnowledgeBase` 写的，
 * 加 `registry` 不能把老数据弄丢。
 *
 * @param {string} dataDir 插件数据目录。
 * @returns {{projects: string[], registry: Array<{name: string, path: string}>}}
 */
function readProjectRegistry(dataDir) {
  const empty = { projects: [], registry: [] };
  try {
    const file = path.join(dataDir, PROJECTS_FILE);
    if (!fs.existsSync(file)) return empty;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const projects = Array.isArray(parsed?.projects)
      ? parsed.projects.filter((p) => typeof p === "string" && p.trim() !== "")
      : [];
    const registry = Array.isArray(parsed?.registry)
      ? parsed.registry
          .filter((e) => e !== null && typeof e === "object")
          .map((e) => ({
            name: typeof e.name === "string" ? e.name.trim() : "",
            path: typeof e.path === "string" ? e.path.trim() : "",
          }))
          .filter((e) => e.name !== "" && e.path !== "")
      : [];
    return { projects, registry };
  } catch {
    return empty;
  }
}

/**
 * 把项目登记进 `projects.json`。
 *
 * 同一个路径**只留一条**（重登记 = 改名），这样「一个路径一个名字」，
 * 不会出现两个名字指向同一本库、让人以为有两份数据。
 *
 * @param {string} dataDir 插件数据目录。
 * @param {string} name 项目名（人看，也决定 baseDir 布局下的子目录名）。
 * @param {string} projectPath 项目路径。
 * @returns {{ok: boolean, project?: {name: string, path: string}, error?: string}}
 */
function registerProject(dataDir, name, projectPath) {
  const cleanName = safeDirName(name);
  if (cleanName === "") {
    return { ok: false, error: "项目名不能为空，也不能只由符号组成（它会被用来当知识库的子目录名）。" };
  }
  if (typeof projectPath !== "string" || projectPath.trim() === "") {
    return { ok: false, error: "项目路径不能为空。" };
  }
  const root = path.resolve(projectPath.trim());
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const current = readProjectRegistry(dataDir);
    const registry = current.registry.filter((e) => path.resolve(e.path) !== root);
    registry.push({ name: cleanName, path: root });
    const file = path.join(dataDir, PROJECTS_FILE);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ projects: current.projects, registry }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, project: { name: cleanName, path: root } };
  } catch (error) {
    return { ok: false, error: `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}` };
  }
}

/**
 * 把「项目名或项目路径」解析成项目根。
 *
 * 顺序：命中登记表名字 → 用登记路径；否则当路径（**必须真实存在**）；
 * 两个都不成 → 返回 null。**绝不静默退到当前项目** ——
 * 那会把条目写进用户没指定的库，而且表面上一切正常。
 *
 * @param {string} ref 项目名或项目路径。
 * @param {Array<{name: string, path: string}>} registry 登记表。
 * @returns {{root: string, name: string} | null}
 */
function resolveProjectRef(ref, registry) {
  const raw = typeof ref === "string" ? ref.trim() : "";
  if (raw === "") return null;
  const byName = registry.find((e) => e.name === raw);
  if (byName !== undefined) return { root: path.resolve(byName.path), name: byName.name };
  let asPath = "";
  try {
    asPath = path.resolve(raw);
  } catch {
    return null;
  }
  if (!fs.existsSync(asPath)) return null;
  const known = registry.find((e) => path.resolve(e.path) === asPath);
  return { root: asPath, name: known?.name ?? "" };
}

/**
 * 在指定项目根建出知识库骨架。
 *
 * 刻意**不覆盖**已有文件 —— 重复调 kb_init 应该幂等，
 * 而不是把用户手写的总纲冲掉。
 *
 * @param {string} projectRoot 项目根。
 * @param {string} dataDir 插件数据目录（记一份「哪些项目开了库」）。
 * @param {object} [config] 生效配置。
 * @param {string} [projectName] 登记过的项目名。
 *   ⚠ **必须传**：库路径由 `baseDir` + 项目名决定，不传就会把骨架建到
 *   `<baseDir>/<basename>`，而 `kbFor()` 去 `<baseDir>/<项目名>` 找 —— 建完仍然「没有库」。
 * @returns {{ok: boolean, created: string[], dir: string}}
 */
function initKnowledgeBase(projectRoot, dataDir, config = null, projectName = "") {
  const root = path.resolve(projectRoot);
  // 库位置由 baseDir 决定（空 = 项目内「知识库」）
  const dir = resolveKbDir(root, config?.baseDir ?? "", projectName);
  const created = [];
  try {
    for (const kind of KINDS) {
      const kindDir = path.join(dir, kind);
      if (!fs.existsSync(kindDir)) {
        fs.mkdirSync(kindDir, { recursive: true });
        created.push(`${kind}/`);
      }
      const index = path.join(kindDir, `00-${kind}主体.md`);
      if (!fs.existsSync(index)) {
        fs.writeFileSync(
          index,
          `# ${kind}分册索引\n\n> 落笔规则：按**领域**分册（不按时间）；每册约 ${VOLUME_PER_BOOK} 条，装满即开新册；\n> 编号全局连续、只增不改。每新增一条，**必须同步更新下表**。\n\n` +
            `| 册名 | 覆盖领域 | 编号区间 | 什么时候读它 |\n|---|---|---|---|\n`,
          "utf8",
        );
        created.push(`${kind}/${path.basename(index)}`);
      }
    }
    const outline = path.join(dir, "00-开始这里-总纲.md");
    if (!fs.existsSync(outline)) {
      fs.writeFileSync(outline, OUTLINE_TEXT, "utf8");
      created.push("00-开始这里-总纲.md");
    }
    // 用 baseDir 集中存放时，记下来源项目 ——
    // 不同路径的同名项目会撞同一个目录，靠这个文件把它们分开（见 resolveKbDir）。
    if (typeof config?.baseDir === "string" && config.baseDir.trim() !== "") {
      const marker = path.join(dir, ORIGIN_NAME);
      if (!fs.existsSync(marker)) {
        try {
          fs.writeFileSync(marker, JSON.stringify({ projectRoot: root }, null, 2) + "\n", "utf8");
        } catch {
          /* 写不了标记不该让建库失败 —— 退化成「可能撞名」的行为 */
        }
      }
    }

    // 记一笔「哪些项目开了库」—— 供插件侧做诊断/ 未来做「换库」用
    //
    // ⚠ 必须**读改写**：同一个文件里还有 `registry`（项目登记），
    //   直接覆盖会把用户登记过的项目悄悄抹掉。
    fs.mkdirSync(dataDir, { recursive: true });
    const storePath = path.join(dataDir, PROJECTS_FILE);
    const store = readProjectRegistry(dataDir);
    if (!store.projects.includes(dir)) store.projects.push(dir);
    fs.writeFileSync(
      storePath,
      JSON.stringify({ projects: store.projects, registry: store.registry }, null, 2) + "\n",
      "utf8",
    );

    return { ok: true, created, dir };
  } catch (error) {
    return { ok: false, created, dir, error: `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}` };
  }
}

/**
 * 注册五个工具。
 *
 * 工具描述刻意写清「**什么时候该调用**」—— 那比任何说明书都有效。
 *
 * @param {object} ctx 上下文。
 * @param {object} tools tools 服务。
 * @param {object} helpers `{kbFor, projectOf}`。
 */
function registerTools(ctx, tools, { kbFor, projectOf, dataDir, cache, configStore, registryOf, onRegistryChanged }) {
  const reg = (def) => tools.register(def);

  /**
   * 解析这次调用该操作哪个项目。
   *
   * ⚠ **不传 `project` 时与加这个参数之前逐字一致** —— 走 `projectOf(exec)`。
   *
   * 传了就**只认传的那个**：
   * - 命中项目登记表的名字 → 用登记路径
   * - 否则当路径（必须真实存在）
   * - 两个都不成 → 返回 `error`，**绝不静默退到当前项目**
   *   （静默退会让条目写进用户没指定的库，而表面上一切正常）
   *
   * @param {object} args 工具参数。
   * @param {object} exec 执行上下文。
   * @returns {{root: string, name: string} | {error: string}}
   */
  const targetOf = (args, exec) => {
    const raw = typeof args?.project === "string" ? args.project.trim() : "";
    if (raw === "") return { root: projectOf(exec), name: "" };
    // ⚠ 用 getter 取登记表：登记/改名后 `projectRegistry` 会被**整个替换**，
    //   注册工具时捕获的那份数组会立刻过期（表现为「刚登记的项目仍然找不到」）。
    const registry = typeof registryOf === "function" ? registryOf() : [];
    const hit = resolveProjectRef(raw, registry);
    if (hit === null) {
      const names = registry.map((e) => e.name);
      return {
        error:
          `找不到项目「${raw}」：它不在项目登记表里，也不是一个存在的目录。` +
          (names.length > 0
            ? `已登记的项目名：${names.join("、")}。`
            : "当前还没有登记过任何项目。") +
          "请改用正确的项目名或一个存在的项目路径 —— 这条**没有**写进任何库。",
      };
    }
    return hit;
  };

  /**
   * 统一的「取目标库」入口。
   * @param {object} args 工具参数。
   * @param {object} exec 执行上下文。
   * @returns {{kb: KnowledgeBase} | {error: string} | {kb: null}}
   */
  const libraryOf = (args, exec) => {
    const target = targetOf(args, exec);
    if (target.error !== undefined) return { error: target.error };
    return { kb: kbFor(target.root, target.name) };
  };

  /**
   * 拼一条**真能跑通**的 `kb_init` 调用示例（给「还没有库」的报错文案用）。
   *
   * ⚠ 为什么不是「先建出骨架再沉淀」了事：智能体拿不到参数形状就只能猜，
   *   猜错一次就多烧一轮；而且它没别的路可走 —— 登记名与路径都在我们手上，
   *   直接给值比让它去翻登记表便宜。
   *
   * ⚠ **没登记过的名字必须同时给 `projectPath`** ——
   *   只给名字的话 `resolveProjectRef` 会把它当路径去 stat，目录不存在就解析不到，
   *   于是这条建议会变成一条跑不通的建议（比不给还糟）。
   *
   * @param {string} root 目标项目根（已 resolve）。
   * @param {string} name 登记名（空 = 没登记）。
   * @returns {string} 形如 `kb_init(project="乙项目", projectPath="D:\work\乙")`。
   */
  const buildInitCall = (root, name) => {
    const cleanName = safeDirName(name);
    if (cleanName !== "") {
      // 名字是登记过的 → 只给名字就能解析；否则必须连路径一起给。
      const known = (typeof registryOf === "function" ? registryOf() : []).find((e) => e.name === cleanName);
      return known !== undefined
        ? `kb_init(project="${cleanName}")`
        : `kb_init(project="${cleanName}", projectPath="${root}")`;
    }
    // 没名字的走路径形态 —— 路径形态不要求目录已存在，所以这条一定跑得通。
    return `kb_init(projectPath="${root}")`;
  };

  /**
   * 「这个项目还没有知识库」时的下一步提示（中英双语）。
   *
   * ⚠ **不自动建库**，只给路：工具擅自建库会让「这个项目其实没在用知识库」
   *   这个事实消失（见 `KnowledgeBase.locate` 的注释）。
   *
   * @param {string | null} [root] 目标项目根（null = 不知道/没解析出来）。
   * @param {string} [name] 登记名。
   * @returns {string} 可直接拼进报错的一句话（含可执行的调用示例）。
   */
  const noLibraryHint = (root, name = "") => {
    if (typeof root !== "string" || root.trim() === "") {
      return "请先调 kb_init 建出骨架，再沉淀（Call kb_init first to create the skeleton, then write）—— 别只在脑子里记着。";
    }
    const at = path.resolve(root.trim());
    return (
      `这个项目还没有知识库。请先调 ${buildInitCall(at, name)} 建出骨架，再沉淀` +
      `（The project has no knowledge base yet. Call ${buildInitCall(at, name)} to create the skeleton, then write）` +
      `；目标库将是 ${resolveKbDir(at, configStore?.get?.()?.baseDir ?? "", safeDirName(name))}。` +
      "这条**没有**写进任何库；工具**不会**替你静默建库。"
    );
  };

  /**
   * 渲染一条为紧凑文本（工具结果要能直接塞进上下文）。
   * @param {object} entry 条目。
   * @returns {string}
   */
  const render = (entry) => {
    const lines = [`## ${entry.id}${entry.title}`, ""];
    if (entry.trigger !== undefined) lines.push(`**触发条件**：${entry.trigger}`, "");
    if (entry.steps?.length > 0) {
      lines.push("**先做**：");
      entry.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      lines.push("");
    }
    if (entry.why !== undefined) lines.push(`**为什么**：${entry.why}`, "");
    if (entry.symptoms !== undefined) lines.push(`**违规症状**：${entry.symptoms}`, "");
    if (entry.verify !== undefined) lines.push(`**验证方式**：${entry.verify}`, "");
    if (entry.boundaries !== undefined) lines.push(`**已知边界**：${entry.boundaries}`, "");
    return lines.join("\n");
  };

  // ── kb_search：功能③ 的主入口（也是 ④ 按需拉取的手段）──────────────
  reg({
    name: "kb_search",
    description:
      "在当前项目的知识库里按关键词检索避错与方法条目。" +
      "**动手前先查**：正要写代码 / 改配置 / 构建 / 部署时，库里可能已有你上次踩过的坑。" +
      "返回命中条目（含触发条件与违规症状），照着做即可，别重新踩。" +
      "库不存在时返回 exists:false，说明这个项目还没建库。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "关键词。中文会按 2-gram 匹配。" },
        kind: { type: "string", enum: [...KINDS], description: "只要避错或只要方法。缺省两类都查。" },
        domain: { type: "string", description: "按领域精确过滤，如「构建与部署」。" },
        limit: { type: "integer", description: "最多返回几条。缺省时用设置页配置的条数。" },
        project: {
          type: "string",
          description:
            "要查哪个项目的库：项目名（见项目登记表）或项目路径。缺省 = 当前项目的库（老行为）。",
        },
      },
      required: ["query"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          exists: { type: "boolean" },
          results: { type: "array", items: { type: "object" } },
          error: { type: "string" },
        },
        required: ["ok", "exists"],
      },
      render: (_args, value) => {
        // ⚠ 解析不到项目时**不能**说「这个项目还没有知识库」——
        //   那是两回事，混在一起会让智能体以为库不存在并去建一个。
        if (typeof value?.error === "string") return [{ type: "text", text: `未检索：${value.error}` }];
        if (value?.exists === false) return [{ type: "text", text: "这个项目还没有知识库（exists:false）。" }];
        const list = value?.results ?? [];
        if (list.length === 0) return [{ type: "text", text: "知识库里没有匹配「" + (value?.query ?? "") + "」的条目。" }];
        return [{ type: "text", text: ["知识库命中（**动手前照着做**）：", "", ...list.map(render)].join("\n") }];
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const found = libraryOf(args, exec);
      if (found.error !== undefined) return { ok: false, exists: false, results: [], error: found.error };
      const kb = found.kb;
      if (kb === null) {
        return { ok: true, exists: false, results: [] };
      }
      const results = kb.search({
        text: typeof args?.query === "string" ? args.query : "",
        kind: typeof args?.kind === "string" ? args.kind : undefined,
        domain: typeof args?.domain === "string" ? args.domain : undefined,
        // 默认条数走设置页的「搜索返回条数」——
        // 智能体显式传了 limit 就听它的（那说明它自己知道要几条）。
        limit: Number.isInteger(args?.limit)
          ? args.limit
          : Number.isInteger(configStore?.get?.()?.searchLimit)
            ? configStore.get().searchLimit
            : 5,
      });
      return { ok: true, exists: true, query: args?.query, results };
    },
  });

  // ── kb_add：功能② 自动沉淀的落点 ──────────────────────────────────
  reg({
    name: "kb_add",
    description:
      "往知识库写一条避错或方法（默认写当前项目的那本）。**用户说「搞定」时立刻写一条避错**；" +
      "总结出一套可复用流程时写一条方法。" +
      "⚠ 避错的「触发条件/先做/为什么/违规症状」四段**全部必填，缺了会被拒绝** —— " +
      "没写违规症状的规则等于没规则（用户原话：怎么判断违反了这条？答不上来就是装饰品）。" +
      "不要写事故叙事，要写成下次可执行的检查指令。" +
      "目标项目还没有知识库时**不会静默替你建**，而是报错并给出建议的 `kb_init` 调用（含 project / projectPath）——" +
      "照那条建议建完骨架再写（The tool never silently creates a missing library; the error carries the suggested kb_init call, including project / projectPath）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: [...KINDS], description: "「避错」记踩过的坑，「方法」记可复用做法。" },
        domain: { type: "string", description: "领域名，如「构建与部署」「代码与接口」。同领域自动归入同一册。" },
        title: { type: "string", description: "一句话概括这条规则。" },
        trigger: { type: "string", description: "避错必填：下次什么时候会遇到。方法对应「适用场景」。" },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "避错必填（「先做」）或方法必填（「步骤」）：可执行的具体动作，不要写「注意规范」。",
        },
        why: { type: "string", description: "避错必填：依据是什么。" },
        symptoms: {
          type: "string",
          description: "避错必填：怎么判断你没做（可观测的症状）。这一项缺失会被直接拒绝。",
        },
        verify: { type: "string", description: "方法可用：怎么确认做对了。" },
        boundaries: { type: "string", description: "方法可用：什么情况下这套做法不适用。" },
        project: {
          type: "string",
          description:
            "写到哪个项目：项目名（见项目登记表）或项目路径。**缺省 = 当前项目的库（与以前完全一致）**。" +
            "只有在「用户明确要写进另一个项目」或「沉淀指令让你自己挑项目」时才传 —— " +
            "传了就必须解析得到，解析不到会直接报错，**不会**退回当前项目。",
        },
      },
      required: ["kind", "domain", "title", "steps"],
    },
    output: {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, id: { type: "string" }, error: { type: "string" } },
        required: ["ok"],
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            value?.ok === true
              ? `已写入 ${value.id}。分册索引已自动同步。`
              : `未写入：${value?.error ?? "未知原因"}`,
        },
      ],
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const found = libraryOf(args, exec);
      if (found.error !== undefined) return { ok: false, error: found.error };
      const kb = found.kb;
      if (kb === null) {
        // ⚠ 报错要指向**可执行的下一步**（带上建议参数），不只是「先建骨架」——
        //   见 noLibraryHint 的注释。
        const target = targetOf(args, exec);
        return { ok: false, error: noLibraryHint(target.root, target.name) };
      }
      return await kb.write(args?.kind, args ?? {});
    },
  });

  // ── kb_list：复盘时通读 ──────────────────────────────────────────
  reg({
    name: "kb_list",
    description:
      "列出知识库的全部条目摘要（编号/标题/领域），默认列当前项目的那本。" +
      "**用户说「复盘」时先调它**，然后据此补漏、去重、删过期条目。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: [...KINDS], description: "只要某类。缺省两类都列。" },
        project: {
          type: "string",
          description: "列哪个项目的库：项目名（见项目登记表）或项目路径。缺省 = 当前项目（老行为）。",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          exists: { type: "boolean" },
          entries: { type: "array", items: { type: "object" } },
          error: { type: "string" },
        },
        required: ["ok", "exists"],
      },
      render: (_args, value) => {
        if (typeof value?.error === "string") return [{ type: "text", text: `未列出：${value.error}` }];
        if (value?.exists === false) return [{ type: "text", text: "这个项目还没有知识库。" }];
        const list = value?.entries ?? [];
        if (list.length === 0) return [{ type: "text", text: "知识库是空的。" }];
        return [{ type: "text", text: `共 ${list.length} 条：\n` + list.map((e) => `- ${e.id} [${e.kind}/${e.domain}] ${e.title}`).join("\n") }];
      },
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const found = libraryOf(args, exec);
      if (found.error !== undefined) return { ok: false, exists: false, entries: [], error: found.error };
      const kb = found.kb;
      if (kb === null) return { ok: true, exists: false, entries: [] };
      const all = kb.list();
      const entries = typeof args?.kind === "string" ? all.filter((e) => e.kind === args.kind) : all;
      return { ok: true, exists: true, entries };
    },
  });

  // ── kb_get：读单条全文 ───────────────────────────────────────────
  reg({
    name: "kb_get",
    description:
      "按编号读一条条目的全文。检索结果只有片段、而你需要完整前置条件时用它。" +
      "⚠ **编号在不同项目里会重号**（每个项目都有自己的 P-003）：" +
      "如果这条是刚才带 project 搜出来的，这里必须带**同一个 project**，否则读到的是别的项目的同号条目。" +
      "目标项目还没有知识库时报错会给出建议的 `kb_init` 调用，含 project / projectPath" +
      "（If the target library does not exist, the error carries the suggested kb_init call with project / projectPath）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "条目编号，如 P-003。" },
        project: {
          type: "string",
          description: "读哪个项目的库：项目名（见项目登记表）或项目路径。缺省 = 当前项目（老行为）。",
        },
      },
      required: ["id"],
    },
    output: {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, entry: { type: "object" }, error: { type: "string" } },
        required: ["ok"],
      },
      render: (_args, value) => [
        { type: "text", text: value?.entry ? render(value.entry) : `没有编号 ${value?.id}` },
      ],
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const found = libraryOf(args, exec);
      if (found.error !== undefined) return { ok: false, error: found.error };
      const kb = found.kb;
      if (kb === null) {
        const target = targetOf(args, exec);
        return { ok: false, error: noLibraryHint(target.root, target.name) };
      }
      const entry = kb.get(String(args?.id ?? ""));
      if (entry === null) return { ok: false, id: args?.id, error: `没有编号 ${args?.id}` };
      return { ok: true, entry };
    },
  });

  // ── kb_init：建骨架 ─────────────────────────────────────────────
  // ── kb_remove / kb_prune：删除与清理 ─────────────────────
  //
  // 设置页与面板都能删，但智能体自己判断「这条已经过时了」时也需要这条路
  // （准则 6.8「修剪同样在复盘时做」）。
  //
  // ⚠ 删除**不可撤销**，所以描述里要求先跟用户确认删哪条 ——
  //   准则二·5：破坏性操作必须先警告、拿到明确确认再执行。
  reg({
    name: "kb_remove",
    description:
      "从知识库里删除一条条目（默认当前项目的那本）。**不可撤销**，所以调用前必须先问用户" +
      "「要删 P-003（标题）吗」并等到确认。" +
      "复盘（准则 6.8）时用过时条目就删它；不要为了凑数删正在用的。" +
      "⚠ **编号在不同项目里会重号**：删的是刚才带 project 列出来的那条时，这里必须带**同一个 project**。" +
      "目标项目还没有知识库时报错会给出建议的 `kb_init` 调用，含 project / projectPath" +
      "（If the target library does not exist, the error carries the suggested kb_init call with project / projectPath）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要删的条目编号，如 P-003。" },
        project: {
          type: "string",
          description: "删哪个项目的库：项目名（见项目登记表）或项目路径。缺省 = 当前项目（老行为）。",
        },
      },
      required: ["id"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          count: { type: "integer", description: "删除后剩余条数。" },
          error: { type: "string" },
        },
        required: ["ok"],
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            value?.ok === true
              ? `已删除 ${value.id ?? ""}，当前剩 ${value.count} 条。`
              : `未删除：${value?.error ?? "未知原因"}`,
        },
      ],
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const found = libraryOf(args, exec);
      if (found.error !== undefined) return { ok: false, error: found.error };
      const kb = found.kb;
      if (kb === null) {
        const target = targetOf(args, exec);
        return { ok: false, error: noLibraryHint(target.root, target.name) };
      }
      const id = String(args?.id ?? "");
      const before = kb.get(id);
      if (before === null) return { ok: false, id, error: `没有编号 ${id}` };
      const result = await kb.remove(id);
      return { ...result, id, count: kb.count() };
    },
  });

  // ── kb_prune：按数量清理（只删最旧的）─────────────────────
  reg({
    name: "kb_prune",
    description:
      "把知识库清理到不超过 keep 条，**只删最旧的**。" +
      "用在复盘时：条目太多、且你确认过最旧的那几条确实过时。" +
      "不可撤销，调用前先问用户确认。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        keep: { type: "integer", description: "保留多少条（两类合计）。" },
      },
      required: ["keep"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          removed: { type: "array", items: { type: "string" } },
          error: { type: "string" },
        },
        required: ["ok"],
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            value?.ok === true
              ? `已清理 ${value.removed?.length ?? 0} 条：${(value.removed ?? []).join(", ")}`
              : `未清理：${value?.error ?? "未知原因"}`,
        },
      ],
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const kb = kbFor(projectOf(exec));
      if (kb === null) return { ok: false, error: "这个项目还没有知识库。" };
      const keep = Number.isInteger(args?.keep) ? args.keep : 0;
      const result = await kb.prune(keep);
      return { ...result, count: kb.count() };
    },
  });

  reg({
    name: "kb_init",
    description:
      "建出知识库骨架（总纲 + 方法/避错两个主体索引）；也能把**一个全新项目**建出来（目录 + 骨架 + 登记一次完成）。" +
      "**幂等**：已存在的文件不会被覆盖。`kb_search` 返回 exists:false、或 `kb_add` 报「还没有知识库」时用它。" +
      "不传参数 = 建当前会话项目的库；" +
      "带 `projectPath` 建指定项目，建完登记进项目登记表 —— " +
      "界面上的项目选择器与 `kb_add(project=...)` 立刻能用它。" +
      "（Creates the knowledge-base skeleton and can create a brand-new project in one call — directory, skeleton, registry. " +
      "Idempotent. No arguments = the current session project; with projectPath it registers the project so the UI picker and kb_add(project=...) work immediately.）",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: {
          type: "string",
          description:
            "项目名（见项目登记表）或项目路径；与 `projectPath` 同时给出时只当名字用，路径以 `projectPath` 为准。" +
            "缺省 = 当前会话项目（与以前完全一致）。" +
            "解析不到会报错并给出可执行的 kb_init 写法，**不会**退回当前项目。" +
            "（Registry name or project path; treated as a name when projectPath is also given. " +
            "Default = the current session project. Unresolvable values fail loudly with a concrete kb_init call.）",
        },
        projectPath: {
          type: "string",
          description:
            "`project` 这个名字对应到哪个目录（= 新项目的项目根）。目录不存在会 mkdir -p 式建出来，建完登记进项目登记表。" +
            "（Filesystem root for that name; missing directories are created and the project is registered.）",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          dir: { type: "string" },
          created: { type: "array", items: { type: "string" } },
          // 下面几个是这次为「建指定项目」加的可核对信息
          project: { type: "string" },
          path: { type: "string" },
          registered: { type: "boolean" },
          createdRoot: { type: "boolean" },
          prefix: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok", "dir"],
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            value?.ok === true
              ? `知识库就绪：${value.dir}` +
                (value.project !== undefined && value.project !== ""
                  ? `\n项目：${value.project} —— ${value.path ?? ""}` +
                    (value.registered === true ? "（已登记进项目登记表）" : "")
                  : "") +
                (value.createdRoot === true ? "\n项目目录：本次新建" : "") +
                (value.prefix !== undefined ? `\n编号：${value.prefix}` : "") +
                (value.created?.length > 0 ? `\n新建：${value.created.join("、")}` : "\n（已存在，未改动）")
              : `创建失败：${value?.error ?? "未知"}`,
        },
      ],
    },
    timeoutMs: 10_000,
    async execute(args, exec) {
      const rawProject = typeof args?.project === "string" ? args.project.trim() : "";
      const rawPath = typeof args?.projectPath === "string" ? args.projectPath.trim() : "";

      let root;
      let name = "";
      /** 项目目录是不是这次新建的（baseDir 布局下才有意义，见下）。 */
      let createdRoot = false;
      if (rawProject === "" && rawPath === "") {
        // ── 老路径：当前会话项目。**与加参数之前逐字一致** ──────────
        root = projectOf(exec);
        // ⚠ 带上登记名：baseDir 布局下子目录名是**项目名**，不带就会
        //   建到 `<baseDir>/<basename>`，而 kbFor() 去 `<baseDir>/<项目名>` 找
        //   ⇒ 「建好了但搜不到」。
        name =
          (typeof registryOf === "function" ? registryOf() : []).find(
            (e) => path.resolve(e.path) === path.resolve(root),
          )?.name ?? "";
      } else {
        // ── 新路径：显式指定项目（可顺带把全新项目建出来）──────────
        // ⚠ `projectPath` **不要求目录已存在** —— 它就是「这个名字对应哪个目录」，
        //   全新项目的那条路正是靠它建出来的（要求先存在 = 把要建的东西当成前提）。
        if (rawPath !== "") {
          root = path.resolve(rawPath);
          // ── 项目目录不存在就建出来（mkdir -p 语义）──────────────
          //
          // ⚠ 只有 baseDir 为空时 initKnowledgeBase 才「顺带」建出项目目录
          //   （库就是 `<root>/知识库`）；baseDir 非空时库在 `<baseDir>/<项目名>`，
          //   项目目录谁都不建 ⇒ 登记表里会留下一条指向不存在目录的记录。
          //   所以这里显式建，并且**先建后登记**（不然登记的是个错路径）。
          if (!fs.existsSync(root)) {
            try {
              fs.mkdirSync(root, { recursive: true });
              createdRoot = true;
            } catch (error) {
              return {
                ok: false,
                dir: "",
                created: [],
                error:
                  `建不出项目目录 ${root}：${error?.code ?? "ERR"}: ${error?.message ?? String(error)}。` +
                  "换一个可写的路径，或先自己把目录建出来。（Cannot create the project directory; pick a writable path.）",
              };
            }
          }
          if (rawProject !== "") {
            // 名字由调用方给定 ⇒ 它决定 `baseDir` 布局下的子目录名
            name = safeDirName(rawProject);
            if (name === "") {
              return {
                ok: false,
                dir: "",
                created: [],
                error: `项目名「${rawProject}」洗不出可用的目录名（不能全由符号组成）。请换一个名字。（Unusable project name; pick another one.）`,
              };
            }
          } else {
            // 只给路径：名字能反查就带上（决定 baseDir 布局下的子目录名）
            // ⚠ 用 registryOf() 反查，**不能调 projectNameOf** ——
            //   那个函数是 apply() 的闭包，本函数是顶层 registerTools 里的，
            //   够不着（写了就是 `ReferenceError: projectNameOf is not defined`）。
            name =
              (typeof registryOf === "function" ? registryOf() : []).find(
                (e) => path.resolve(e.path) === path.resolve(root),
              )?.name ?? "";
          }
        } else {
          // 只给 project：与 kb_add 同一套解析（登记名 → 当路径）
          const hit = resolveProjectRef(rawProject, typeof registryOf === "function" ? registryOf() : []);
          if (hit === null) {
            return {
              ok: false,
              dir: "",
              created: [],
              error:
                `找不到项目「${rawProject}」：它不在项目登记表里，也不是一个存在的目录。` +
                `要建一个**全新项目**，请用 kb_init(project="新项目名", projectPath="它的目录")。` +
                `（Project "${rawProject}" is neither registered nor an existing directory; ` +
                `to create a new one, call kb_init(project="name", projectPath="dir").）` +
                "这条**没有**建出任何库，也没有退回当前项目。",
            };
          }
          root = hit.root;
          name = hit.name;
        }
      }

      const result = initKnowledgeBase(root, dataDir, configStore?.get?.() ?? null, name);

      // ⚠ **建完必须让缓存失效**，否则这条工具链会断：
      //   kb_init 刚把库建出来 → 但 kbFor() 里可能已经缓存了一本**空库**
      //   （比如面板先刷新过）→ 紧接着的 kb_add / kb_search 仍然按旧状态走
      //   → 智能体看到「建好了但写不进去」，会以为插件坏了并放弃用。
      cache.clear();

      // ── 登记进项目登记表（只在「新用法 + 真给名字」时）────────────
      //
      // ⚠ 只在 `rawProject !== ""` 时登记：老路径下 `name` 是从登记表**反查**来的，
      //   拿它去写登记表等于用同一个值覆盖自己，纯属多余动作。
      // ⚠ 登记成功必须**让内存副本重读** —— `resolveProjectRef` / `kbFor` 都读它，
      //   不重读的话紧接着的 `kb_add(project="新名字")` 仍会报「找不到项目」。
      //   重读 + 清缓存都在 apply() 给的 onRegistryChanged 里做（跨作用域只能走回调）。
      let registered = false;
      if (rawProject !== "" && name !== "" && typeof onRegistryChanged === "function") {
        const reg = registerProject(dataDir, name, root);
        if (reg.ok === true) {
          onRegistryChanged();
          registered = true;
        }
      }

      // baseDir 布局下这条尤其值得回：骨架建在 `<父目录>/<项目名>`
      // 而不是项目目录里，用户核对时看的是它。
      const dir = typeof result.dir === "string" && result.dir !== ""
        ? result.dir
        : resolveKbDir(root, configStore?.get?.()?.baseDir ?? "", name);

      return {
        ...result,
        dir,
        project: name,
        path: path.resolve(root),
        registered,
        // 只给路径时没有登记名可报；这里把「项目目录是不是新建的」报出来，
        // 智能体才好向用户交代「我顺手建了个目录」这件事。
        createdRoot,
        // 编号区间只取决于 PREFIX 与每册容量，与库里现存条目无关
        prefix: `${PREFIX.方法}-001 起/每册 ${VOLUME_PER_BOOK} 条开新册、${PREFIX.避错}-001 起/每册 ${VOLUME_PER_BOOK} 条开新册`,
      };
    },
  });
}

export { OUTLINE_TEXT, initKnowledgeBase };