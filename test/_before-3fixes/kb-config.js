/**
 * 知识库配置 —— 用户可改的运行参数。
 *
 * ## 为什么单独成文件
 * 存储层（kb-store.js）管的是「条目在分册里怎么放」，
 * 配置管的是「库放哪、上限是多少、超了怎么办」—— 生命周期不同：
 * 配置是**跨项目全局**的（存在插件数据目录，不是项目里），
 * 而条目是**按项目**的。混在一起会让「换项目」误带走配置。
 *
 * ## 落盘位置
 * `<插件数据目录>/config.json`，即 `~/.dsh/.dsh-knowledge-data/config.json`。
 * **全局一份**，所有项目共用同一套参数 —— 用户设一次即可。
 *
 * ## 版本
 * 带 `version`，将来加字段时可迁移；未知字段一律丢弃，
 * 避免手改 JSON 塞进来的脏数据污染运行。
 *
 * v1 → v2（2026-10-08）：新增存储位置、注入、搜索、默认值等 7 个字段。
 * 老的 v1 配置**不需要手工迁移** —— `normalizeConfig` 会按 SCHEMA 遍历所有字段，
 * 缺的一律补默认值，所以读出来就是一份完整的 v2。
 */

import fs from "node:fs";
import path from "node:path";

/** 配置文件名。 */
const CONFIG_FILE = "config.json";

/** 可写入「避错 / 方法」两类。 */
export const KINDS = Object.freeze(["方法", "避错"]);

/**
 * 默认配置。
 *
 * ⚠ 每个字段的默认值都对应「加这个配置之前的行为」——
 *   这样老用户升级后行为**完全不变**，不会因为多了设置项而措手不及。
 */
export const DEFAULT_CONFIG = Object.freeze({
  version: 2,

  // ── 存储位置 ────────────────────────────────────────────
  /**
   * 知识库父目录。**空串 = 每个项目在自己的根目录下建「知识库」**（默认，跟着项目走，
   * 能随 git 一起提交、团队共享）。
   *
   * 非空时库路径变成 `<baseDir>/<项目名>` —— 所有项目的库集中在一起，
   * 便于统一备份。
   *
   * ⚠ 改这个值**不会自动搬运已有条目**：原来的库还在老位置。
   *   设置页会显示实际路径，界面上也写了这条提醒（不做隐藏操作）。
   */
  baseDir: "",

  // ── 容量与上限 ──────────────────────────────────────────
  /**
   * 每册容量（准则 6.2：装满即开新册）。
   * 默认 10 = 原硬编码常量 `VOLUME_PER_BOOK`。
   */
  volumePerBook: 10,
  /**
   * 总量上限。**0 = 不限**。
   * 超过时 `write()` 拒绝并返回 `MAX_TOTAL_REACHED`，
   * **不自动删** —— 删哪些条目是用户的决定，不是工具的。
   */
  maxTotal: 0,
  /**
   * 自动清理阈值。超过这个条数时 `pruneIfNeeded()` 才会动手。
   * **0 = 从不自动清理**（默认）。
   */
  autoPruneThreshold: 0,
  /**
   * 自动清理后**保留**多少条。
   * **0 = 按每册容量推算**（`volumePerBook × 2`），即「正好留满两册」。
   */
  autoPruneKeep: 0,
  /**
   * 单条最大字节数。
   */
  maxEntryBytes: 64 * 1024,

  // ── 注入（影响每轮对话的 token 消耗）────────────────────
  /**
   * 是否把使用约定（总纲）注入系统提示。
   * 关掉之后智能体不会主动知道知识库怎么用，只能靠用户明说 ——
   * 但每轮能省掉约 1.4k 字符。
   */
  injectEnabled: true,
  /**
   * 注入内容的字数上限（超出截断）。
   * 总纲本身约 1441 字，默认给足余量；调小可以省 token。
   */
  injectMaxChars: 6000,

  // ── 检索 ────────────────────────────────────────────────
  /**
   * `kb_search` 一次最多返回几条（智能体仍可显式传 limit 覆盖）。
   */
  searchLimit: 5,

  // ── 手动沉淀的默认值 ────────────────────────────────────
  /** 点「沉淀」按钮时默认写进哪一类。 */
  defaultKind: "避错",
  /** 默认领域。**空 = 交给智能体按对话内容判断**（推荐）。 */
  defaultDomain: "",
});

/**
 * 字段校验表：每一项的类型与范围。越界 / 类型不对一律回退默认值。
 *
 * 用「类型化 schema」而不是给每个字段写 if —— 加字段时只需加一行，
 * 也就不会出现「新字段漏了归一化」这种只有到运行时才炸的问题。
 */
const SCHEMA = {
  baseDir: { type: "path" },
  volumePerBook: { type: "int", min: 1, max: 200 },
  maxTotal: { type: "int", min: 0, max: 100000 },
  autoPruneThreshold: { type: "int", min: 0, max: 100000 },
  autoPruneKeep: { type: "int", min: 0, max: 100000 },
  maxEntryBytes: { type: "int", min: 1024, max: 16 * 1024 * 1024 },
  injectEnabled: { type: "bool" },
  injectMaxChars: { type: "int", min: 200, max: 20000 },
  searchLimit: { type: "int", min: 1, max: 100 },
  defaultKind: { type: "enum", values: KINDS },
  defaultDomain: { type: "text", maxLen: 40 },
};

/**
 * 归一化单个字段。
 *
 * @param {unknown} value 原始值（可能来自 JSON、也可能来自设置页的字符串）。
 * @param {object} rule SCHEMA 里的一条规则。
 * @param {unknown} fallback 回退值。
 * @returns {unknown} 合法值。
 */
function normalizeField(value, rule, fallback) {
  switch (rule.type) {
    case "int": {
      // 设置页的输入框传来的是**字符串**，这里一并接受
      const n =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(n)) return fallback;
      return Math.min(rule.max, Math.max(rule.min, Math.trunc(n)));
    }
    case "bool":
      // 字符串 true/false 也认（复选框传过来可能是字符串）
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return fallback;
    case "path":
      // ⚠ 路径**不做存在性校验**：设置时那个目录可能还没建，
      //   也可能在可移动盘上暂时不可见。写入时再 mkdir。
      return typeof value === "string" ? value.trim() : fallback;
    case "text": {
      if (typeof value !== "string") return fallback;
      const t = value.trim();
      return t.length > rule.maxLen ? t.slice(0, rule.maxLen) : t;
    }
    case "enum":
      return rule.values.includes(value) ? value : fallback;
    default:
      return fallback;
  }
}

/**
 * 把任意输入规整成合法配置。
 *
 * ⚠ **非法值一律回退默认值，绝不抛错** ——
 *   设置页的输入框可能传来空串/负数/超长数字，
 *   配置读不出来不该让整个插件起不来。
 *
 * ⚠ 遍历的是 **SCHEMA**（而不是输入对象的键）：
 *   这样 v1 的老配置读进来会自动补齐 v2 的新字段，
 *   不需要写迁移代码，也不会漏字段。
 *
 * @param {object} raw 原始输入。
 * @returns {object} 合法配置。
 */
export function normalizeConfig(raw) {
  const out = { version: DEFAULT_CONFIG.version };
  if (raw === null || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  for (const [key, rule] of Object.entries(SCHEMA)) {
    out[key] = normalizeField(raw[key], rule, DEFAULT_CONFIG[key]);
  }
  return out;
}

/**
 * 配置读写。
 *
 * 一次性读入内存，写时落盘（与知识库本体的策略一致）。
 */
export class ConfigStore {
  /**
   * @param {string} dataDir 插件数据目录。
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, CONFIG_FILE);
    /** @type {object} */
    this.config = { ...DEFAULT_CONFIG };
    /** 最近一次读写失败原因。 */
    this.lastError = null;
  }

  /**
   * 从磁盘加载。**不抛错**：失败时用默认值并记下原因。
   * @returns {boolean} 是否成功读到合法配置。
   */
  load() {
    try {
      if (!fs.existsSync(this.file)) {
        this.config = { ...DEFAULT_CONFIG };
        this.lastError = null;
        return false;
      }
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.config = normalizeConfig(parsed);
      this.lastError = null;
      return true;
    } catch (error) {
      // 配置损坏**不该阻塞插件** —— 用默认值继续，让用户能在设置页改回来
      this.config = { ...DEFAULT_CONFIG };
      this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      return false;
    }
  }

  /**
   * 原子写盘。
   * @param {object} patch 要改的字段（可含部分字段）。
   * @returns {{ok: boolean, config: object, error?: string}}
   */
  async save(patch) {
    const next = normalizeConfig({ ...this.config, ...(patch ?? {}) });
    try {
      await fs.promises.mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
      await fs.promises.rename(tmp, this.file);
      this.config = next;
      this.lastError = null;
      return { ok: true, config: { ...next } };
    } catch (error) {
      this.lastError = `${error?.code ?? "ERR"}: ${error?.message ?? String(error)}`;
      return { ok: false, config: { ...this.config }, error: this.lastError };
    }
  }

  /**
   * 恢复默认。
   * @returns {{ok: boolean, config: object, error?: string}}
   */
  async restoreDefaults() {
    return await this.save({ ...DEFAULT_CONFIG });
  }

  /**
   * 当前配置的浅拷贝。
   * @returns {object}
   */
  get() {
    return { ...this.config };
  }
}

export { CONFIG_FILE };
