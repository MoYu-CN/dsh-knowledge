/**
 * dsh-knowledge —— client 侧入口（浏览器 bundle）。
 *
 * ## 形态必须是 lazy-CJS
 * DSH 用普通 `<script src>` 加载客户端 bundle（`kind:"script-src"`），**不是 ESM**。
 * 裸 ESM 的 `export` 直接是语法错误，连带 `web boot: N entry did not activate`。
 * 正解形态见下方 `__ModuleLoader__.load({id, factory})`。
 *
 * ## 幂等栅栏（必须有）
 * tapIndex 注入的脚本**会被执行两次**（DSH 前端插件恢复流程会重跑）。
 * loader 遇同 id 二次 `load()` 直接抛 `duplicate factory registration`，
 * 并连带整个 web boot 层不激活。所以要套 IIFE + 全局布尔栅栏。
 *
 * ⚠ **本文件 CSS 常量里禁止出现反引号**（注释里也不行）——
 *   会提前终止模板串，`node --check` 查不出（语法合法，反引号配对成了新模板串），
 *   只在求值时炸 `ReferenceError`。dsh-team-chat 在同一个坑上栽过 6 次。
 *
 * ## 不 require 任何 Harness Client 包
 * 官方 `practices.md:35` / `SKILL.md:21` 双重明令禁止依赖除基线外的客户端包
 * （它们随版本变化、plain-JS 无类型检查，一个抛错的组件清空整个插槽条目）。
 * 需要控件就照官方实现自己写，类名换 `kb-` 前缀，只用 `--dsw-alias-*` token。
 */
(() => {
	const KEY = "__DSH_KNOWLEDGE_REGISTERED__";
	const loader = globalThis.window?.__ModuleLoader__;
	if (loader === undefined) return;
	if (globalThis[KEY] === true) return;
	globalThis[KEY] = true;

	loader.load({
		id: "dsh-knowledge",
		factory: (require) => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

			// ⚠⚠ **这里必须是 createElement，不能用 react/jsx-runtime 的 jsx()**。
			//   两者签名不同：
			//     createElement(type, props, ...children)   ← 子元素是变长参数
			//     jsx(type, props, maybeKey)                ← 第三个参数是 key！
			//   原先写的是 `var h = jsxRuntime.jsx`，于是每个
			//   h("div", {className}, 子元素…) 里的子元素都被当成 key 丢掉：
			//   组件照常返回、不抛错、控制台无任何提示，只渲染出一个空壳
			//   —— 表现就是「设置里的知识库那行、右栏知识库面板全是空白」。
			//   jsx(Fragment, null, child) 更会直接抛
			//   TypeError: Cannot convert undefined or null to object。
			//   实测探针见 dsh-agent-profiles/test/jsx-probe.mjs。
			var react = require("react");
			var h = react.createElement;
			var Fragment = react.Fragment;
			var useState = react.useState;
			var useEffect = react.useEffect;
			var useCallback = react.useCallback;

			// ── i18n 字典（必须内联：bundle 走 <script src>，不能 import JSON）──
			//
			// ⚠⚠ **必须先 register 再 bind** —— 只 bind 不register 的后果是
			//   t("settings.label") 找不到翻译就**原样返回 key**，
			//   界面上会直接印出 "settings.label" / "header.distill" 这种字符串。
			//   2026-10-07 实测：注册缺失 ⇒ 整个界面全是 key（见截图）。
			// 官方范例同款：ctx.effect(() => ctx.locale.register(NS, { zh, en }))
			var zhCN = {
				"title": "知识库",
				"description": "把踩过的坑与可复用做法沉淀进项目知识库：避错分册 + 方法分册，编号只增不改，索引自动同步。",
				"pane.title": "知识库",
				"pane.guideTitle": "查看知识库",
				"pane.guideDesc": "浏览当前项目的避错与方法条目。",
				"header.open": "打开知识库",
				"settings.label": "启用知识库沉淀",
				"settings.hint": "把踩过的坑与做法沉淀进项目知识库，并注入使用约定。",
				"settings.open": "打开",
				"panel.search": "搜索避错与方法…",
				"panel.empty": "知识库还是空的。让智能体用 kb_add 写第一条。",
				"panel.noMatch": "没有匹配的条目",
				"panel.noLibrary": "这个项目还没有知识库",
				"panel.init": "建出知识库骨架",
				"panel.noCwd": "尚未确定当前项目",
				"panel.groupPitfall": "避错",
				"panel.groupMethod": "方法",
				"panel.total": "共 {n} 条 · 路径 {path}",
				"panel.deleted": "已删除 {id}，剩 {n} 条",
				"panel.removeFailed": "删除失败",
				"panel.created": "已创建骨架",
				"panel.createFailed": "创建失败",
				"entry.confirmDelete": "删掉 {id}？不可撤销。",
				"entry.confirmYes": "确认删除",
				"entry.confirmCancel": "取消",
				"entry.delete": "删除这条",
				"entry.verify": "验证方式",
				"entry.boundaries": "已知边界",
				"entry.kind.method.trigger": "适用场景",
				"entry.kind.method.steps": "步骤",
				"entry.kind.pitfall.trigger": "触发条件",
				"entry.kind.pitfall.steps": "先做",
				"entry.kind.pitfall.why": "为什么",
				"entry.kind.pitfall.symptoms": "违规症状",
				"header.distill": "沉淀",
				"distill.delegated": "已交给智能体，请让它提炼本次对话",
				"distill.noCwd": "尚未确定当前项目",
				"distill.failed": "沉淀请求失败",
				"distill.loading": "读取项目清单…",
				"distill.current": "当前项目",
				"distill.newProject": "新建项目…",
				"distill.agentDecides": "由智能体自己决定",
				"distill.confirm": "沉淀",
				"distill.cancel": "取消",
				"distill.namePlaceholder": "项目名（决定知识库目录名）",
				"distill.pathPlaceholder": "项目路径（等同会话的工作目录）",
				"distill.needName": "请填项目名",
				"distill.needPath": "请填项目路径",
				"distill.noLibrary": "（还没有知识库，确认后自动建）",
				"distill.sent": "已把沉淀指令投递给智能体，等它提炼并写库",
				"distill.drafted": "输入框里已有内容：指令已追加到末尾，请按回车发送",
				"distill.noInput": "拿不到输入框，指令没能送达当前会话",
				// ③ 改名会挪库：host 默认只拦不改，这里负责把话说明白 + 给确认动作
				"rename.blockedNotice": "改名没有执行：登记与原库都保持不动",
				"rename.moveFailedNotice": "搬运失败：没有改名，原库没动",
				"rename.panelTitle": "这个路径已经登记过另一个名字",
				"rename.body": "知识库目录按项目名解析：直接换成新名字登记，库会指向一个空目录，看起来就像条目全丢了。这次没有改名。",
				"rename.oldName": "原登记名",
				"rename.newName": "要改成的名字",
				"rename.oldDir": "原库位置",
				"rename.newDir": "改名后会指向",
				"rename.confirm": "把原库搬过去并改名",
				"rename.cancel": "取消",
				"rename.moved": "已把知识库搬到",
				"settings.count": "已沉淀条目",
				"settings.countValue": "共",
				"settings.countHint": "清理只删最旧的条目；删除不可撤销。",
				"settings.countNone": "这个项目还没有知识库",
				"settings.restore": "恢复默认",
				"settings.restored": "已恢复默认",
				"settings.badNumber": "请填数字",
				"settings.loading": "读取配置…",
				"settings.capReached": "已达总量上限，新条目会被拒绝。请先删除几条或调高上限。",
				"settings.volume": "每册容量",
				"settings.volumeHint": "装满即开新册（准则 6.2）",
				"settings.maxTotal": "总量上限",
				"settings.maxTotalHint": "0 = 不限。写满后会拒绝新条目，不会替你删。",
				"settings.prune": "自动清理阈值",
				"settings.pruneHint": "0 = 从不自动清。超过此数时清理掉最旧的条目。",
				"settings.maxBytes": "单条体积上限（KB）",
				"settings.maxBytesHint": "一条写太长就该拆开，别把整篇报告塞进一条。",
				"settings.countUnit": " 条",
				"settings.countUnknown": "未知",
				"settings.countNoProject": "尚未确定当前项目，条数暂不可见（配置是全局的，下面几项照常可用）",
				"settings.pageTitle": "知识库",
				"header.view": "查看",
				"header.distillTitle": "把本次对话沉淀进知识库（类别与领域由智能体判断）",
				"settings.cardStatus": "沉淀状态",
				"settings.cardLimits": "容量与上限",
				"settings.cardStorage": "存储位置",
				"settings.baseDir": "知识库父目录",
				"settings.baseDirHint": "留空 = 每个项目在自己的目录下建「知识库」（跟着项目走，能随项目一起备份）。填写后所有项目的库集中到该目录下的同名子文件夹。**改这里不会搬运已有条目**，原库仍在老位置。",
				"settings.baseDirPlaceholder": "例如 D:/knowledge-base",
				"settings.effectiveDir": "实际使用",
				"settings.dirUnknown": "尚未确定当前项目",
				"settings.cardInject": "注入与检索",
				"settings.injectEnabled": "注入使用约定",
				"settings.injectEnabledHint": "把知识库的使用约定加进每轮对话的系统提示。关掉可省约 1.4k 字符，但智能体不再主动知道怎么用。",
				"settings.injectMaxChars": "注入字数上限",
				"settings.injectMaxCharsHint": "超出即截断，并在末尾注明。总纲约 1441 字。",
				"settings.guideInjectEnabled": "注入「本项目必读」",
				"settings.guideInjectEnabledHint": "每轮按当前工序自动挑最相关的几条塞进系统提示。**与上面那个开关各管一摊**：那一项管使用说明书（恒定约 1.4k 字），这一项管本次该照哪几条；两项都关 = 完全不注入。",
				"settings.guideInjectLimit": "必读最多注入几条",
				"settings.guideInjectLimitHint": "硬上限（1~10）。超出的只给编号与标题，要点详情让智能体用 kb_guide 深挖；整节的字数还有 1200 字的固定上限。",
				"settings.searchLimit": "搜索返回条数",
				"settings.searchLimitHint": "kb_search 一次最多返回几条；智能体显式指定时以它为准。",
				"settings.defaultKind": "沉淀建议类别",
				"settings.defaultKindHint": "只是给智能体的**建议**：最终进「方法」还是「避错」由它按本次对话内容判断，并在回复里说明依据。",
				"settings.defaultDomain": "沉淀建议领域",
				"settings.defaultDomainHint": "同上，只是建议。留空 = 不给建议，领域完全由智能体按对话内容判断。",
				"settings.defaultDomainPlaceholder": "留空 = 不给建议",
				"settings.autoPruneKeep": "自动清理保留条数",
				"settings.autoPruneKeepHint": "0 = 按「每册容量 × 2」推算。阈值决定何时清理，这里决定清到多少。",
				"settings.browse": "浏览…",
				"settings.pickFailed": "打开选择框失败",
				"settings.pickerUnavailable": "当前环境无法弹出系统目录选择框，请手动填写路径。",
				"settings.saveHint": "改完要点保存（本页没有保存按钮：离开输入框、或点一下开关就存下了）",
				"settings.dirtyHint": "有未保存改动",
			};
			var enUS = {
				"title": "Knowledge Base",
				"description": "Accumulate pitfalls and reusable practices into a per-project knowledge base: pitfall and method volumes, monotonic entry IDs, index kept in sync automatically.",
				"pane.title": "Knowledge Base",
				"pane.guideTitle": "Browse knowledge base",
				"pane.guideDesc": "View pitfall and method entries of the current project.",
				"header.open": "Open knowledge base",
				"settings.label": "Enable knowledge accumulation",
				"settings.hint": "Accumulate pitfalls and practices into a per-project knowledge base, and inject the usage contract.",
				"settings.open": "Open",
				"panel.search": "Search pitfalls and methods…",
				"panel.empty": "The knowledge base is empty. Ask the agent to write the first entry with kb_add.",
				"panel.noMatch": "No matching entries",
				"panel.noLibrary": "This project has no knowledge base yet",
				"panel.init": "Create the skeleton",
				"panel.noCwd": "Current project is not determined yet",
				"panel.groupPitfall": "Pitfalls",
				"panel.groupMethod": "Methods",
				"panel.total": "{n} entries · path {path}",
				"panel.deleted": "Deleted {id}, {n} left",
				"panel.removeFailed": "Delete failed",
				"panel.created": "Skeleton created",
				"panel.createFailed": "Could not create it",
				"entry.confirmDelete": "Delete {id}? This cannot be undone.",
				"entry.confirmYes": "Delete",
				"entry.confirmCancel": "Cancel",
				"entry.delete": "Delete this entry",
				"entry.verify": "How to verify",
				"entry.boundaries": "Known limits",
				"entry.kind.method.trigger": "Applies when",
				"entry.kind.method.steps": "Steps",
				"entry.kind.pitfall.trigger": "Trigger",
				"entry.kind.pitfall.steps": "Do first",
				"entry.kind.pitfall.why": "Why",
				"entry.kind.pitfall.symptoms": "Violation symptoms",
				"header.distill": "Distill",
				"distill.delegated": "Handed to the agent — ask it to distill this conversation",
				"distill.noCwd": "Current project is not determined yet",
				"distill.failed": "Distill request failed",
				"distill.loading": "Loading project list…",
				"distill.current": "Current project",
				"distill.newProject": "New project…",
				"distill.agentDecides": "Let the agent decide",
				"distill.confirm": "Distill",
				"distill.cancel": "Cancel",
				"distill.namePlaceholder": "Project name (names the knowledge base folder)",
				"distill.pathPlaceholder": "Project path (same meaning as the session working directory)",
				"distill.needName": "Enter a project name",
				"distill.needPath": "Enter a project path",
				"distill.noLibrary": " (no knowledge base yet — created on confirm)",
				"distill.sent": "Distill instruction sent to the agent — it will distill and write the entry",
				"distill.drafted": "The input box already had content: the instruction was appended — press Enter to send",
				"distill.noInput": "Cannot reach the input box, so the instruction was not delivered",
				"rename.blockedNotice": "Rename not applied — the registration and its library stay unchanged",
				"rename.moveFailedNotice": "Move failed — nothing was renamed, the library is untouched",
				"rename.panelTitle": "This path is already registered under another name",
				"rename.body": "The library folder is derived from the project name: registering the new name points it at an empty folder, as if every entry were lost. Nothing was renamed this time.",
				"rename.oldName": "Registered as",
				"rename.newName": "New name",
				"rename.oldDir": "Library now at",
				"rename.newDir": "Would point at",
				"rename.confirm": "Move the library and rename",
				"rename.cancel": "Cancel",
				"rename.moved": "Library moved to",
				"settings.count": "Accumulated entries",
				"settings.countValue": "",
				"settings.countHint": "Pruning removes the oldest entries; deletion cannot be undone.",
				"settings.countNone": "This project has no knowledge base yet",
				"settings.restore": "Restore defaults",
				"settings.restored": "Defaults restored",
				"settings.badNumber": "Enter a number",
				"settings.loading": "Loading configuration…",
				"settings.capReached": "Total cap reached — new entries will be rejected. Delete some or raise the cap.",
				"settings.volume": "Entries per volume",
				"settings.volumeHint": "A full volume spawns the next one (rule 6.2)",
				"settings.maxTotal": "Total cap",
				"settings.maxTotalHint": "0 = unlimited. Once full, new entries are rejected — nothing is deleted for you.",
				"settings.prune": "Auto-prune threshold",
				"settings.pruneHint": "0 = never. Above this count the oldest entries are pruned.",
				"settings.maxBytes": "Max entry size (KB)",
				"settings.maxBytesHint": "Split long entries instead of putting a whole report into one.",
				"settings.countUnit": " entries",
				"settings.countUnknown": "unknown",
				"settings.countNoProject": "Current project not determined; counts unavailable (configuration is global — the settings below still work).",
				"settings.pageTitle": "Knowledge Base",
				"header.view": "View",
				"header.distillTitle": "Distill this conversation into the knowledge base (the agent decides kind and domain)",
				"settings.cardStatus": "Status",
				"settings.cardLimits": "Limits",
				"settings.cardStorage": "Storage location",
				"settings.baseDir": "Knowledge base parent folder",
				"settings.baseDirHint": "Empty = each project keeps its own \"知识库\" folder (travels with the project). Set a folder to keep every project's base under it in a same-named subfolder. **Changing this does not move existing entries** — the old base stays where it is.",
				"settings.baseDirPlaceholder": "e.g. D:/knowledge",
				"settings.effectiveDir": "In use",
				"settings.dirUnknown": "Current project not determined",
				"settings.cardInject": "Injection and search",
				"settings.injectEnabled": "Inject usage rules",
				"settings.injectEnabledHint": "Adds the knowledge-base usage rules to every turn's system prompt. Turning it off saves ~1.4k chars, but the agent no longer knows how to use it unprompted.",
				"settings.injectMaxChars": "Injection character cap",
				"settings.injectMaxCharsHint": "Truncated beyond this, with a note appended. The full rules are ~1441 chars.",
				"settings.guideInjectEnabled": "Inject \"must-read for this project\"",
				"settings.guideInjectEnabledHint": "Each turn, picks the most relevant entries for the current step and adds them to the system prompt. **Separate from the switch above**: that one injects the usage rules (~1.4k chars, constant), this one injects what to follow right now; turning both off injects nothing at all.",
				"settings.guideInjectLimit": "Max entries injected",
				"settings.guideInjectLimitHint": "Hard cap (1-10). Entries beyond the budget are reduced to ID and title, and the agent digs deeper with kb_guide; the whole section also has a fixed 1200-character cap.",
				"settings.searchLimit": "Search result count",
				"settings.searchLimitHint": "How many entries kb_search returns at most; an explicit agent limit still wins.",
				"settings.defaultKind": "Suggested kind",
				"settings.defaultKindHint": "A **suggestion** only: whether the entry becomes a method or a pitfall is decided by the agent from this conversation, and it states its reasoning.",
				"settings.defaultDomain": "Suggested domain",
				"settings.defaultDomainHint": "Also a suggestion only. Empty = no suggestion; the agent infers the domain from the conversation.",
				"settings.defaultDomainPlaceholder": "Empty = no suggestion",
				"settings.autoPruneKeep": "Entries kept after auto-prune",
				"settings.autoPruneKeepHint": "0 = derive from volumes × 2. The threshold decides when to prune; this decides how many to keep.",
				"settings.browse": "Browse…",
				"settings.pickFailed": "Failed to open the folder picker",
				"settings.pickerUnavailable": "This environment cannot open a native folder picker — enter the path manually.",
				"settings.saveHint": "Click save after editing (no save button on this page: leaving a field, or clicking a switch, saves it)",
				"settings.dirtyHint": "Unsaved changes",
			};
			// ── i18n ──────────────────────────────────────────────────
			// ctx.locale 上**没有** t(ns,key) 方法，只有 register/bind/translate。
			// 正确姿势：const t = ctx.locale.bind(NS)，回调里 t("key")。
			var NS = "dsh-knowledge";
			//⚠ `ctx` **不在 factory 闭包里** —— 它是 `apply(ctx)` 的参数。
			//   官方cordis 客户端协议：`factory(require)` 返回 `{ inject, apply }`，
			//   真正执行时 loader 才调 apply(ctx)。
			//   所以任何用 ctx 的东西都必须**惰性求值**（在 apply 之后才跑），
			//   在 factory 里直接写 `ctx.xxx` 会得到
			//   `ReferenceError: ctx is not defined` ⇒ renderer boot failed。
			//
			// 这里存成变量，由 apply() 首次进来时填上。
			var bindLocale = null;
			// apply 作用域外的辅助函数（useSessionCwd / openPane）要拿 ctx，
			// 而它们不在 apply 的参数作用域里 —— 用模块级引用桥接。
			var ctxRef = null;
			var getCtx = function () { return ctxRef; };
			var t = function (key) {
				if (bindLocale === null) return key;
				try {
					return bindLocale(key);
				} catch {
					return key;
				}
			};

			/**
			 * 取词条 + 替换 `{name}` 占位。
			 *
			 * ⚠ 与 `t()` 的区别是**兜底是真的**：`t()` 在 locale 没绑定时返回
			 *   key 本身（不是空串、也不是 null），所以 `t("k") ?? "中文"`
			 *   这种写法里那段中文永远不会生效 —— 界面上会直接印出
			 *   `entry.confirmDelete` 这种东西。这里显式判 `=== key`，
			 *   兜底取 `zhCN`，最坏情况显示中文而不是显示键名。
			 *
			 * @param key - 词条键。
			 * @param tokens - `{id: "P-003"}` → 词条里的 `{id}` 会被替换。
			 * @returns 可直接放进元素 children 的字符串。
			 */
			var tz = function (key, tokens) {
				var out = t(key);
				if (out === key && typeof zhCN[key] === "string") out = zhCN[key];
				var map = tokens ?? {};
				for (var name in map) out = out.split("{" + name + "}").join(String(map[name]));
				return out;
			};

			// ── 数据访问 ─────────────────────────────────────────────
			// ⚠ 所有 fetch 都**不带自定义头** —— `<script src>` / 同源 fetch
			//   能带，但一旦走代理就可能被剥。同源判定靠浏览器自动带Origin/Referer。
			var api = {
				list: function (cwd) {
					return fetch("/__kb/list?cwd=" + encodeURIComponent(cwd)).then(function (r) {
						return r.json();
					});
				},
				get: function (cwd, id) {
					return fetch(
						"/__kb/get?cwd=" + encodeURIComponent(cwd) + "&id=" + encodeURIComponent(id),
					).then(function (r) {
						return r.json();
					});
				},
				search: function (cwd, q, limit) {
					return fetch(
						"/__kb/search?cwd=" +
							encodeURIComponent(cwd) +
							"&q=" +
							encodeURIComponent(q) +
							"&limit=" +
							String(limit ?? 8),
					).then(function (r) {
						return r.json();
					});
				},
init: function (cwd) {
					return fetch("/__kb/init", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ cwd: cwd }),
					}).then(function (r) {
						return r.json();
					});
				},
				// ── 配置（读 / 改 / 恢复默认）─────────────────────
				getConfig: function (cwd) {
					return fetch("/__kb/config?cwd=" + encodeURIComponent(cwd)).then(function (r) {
						return r.json();
					});
				},
				saveConfig: function (patch, cwd) {
					var payload = {};
					for (var k in patch) payload[k] = patch[k];
					payload.cwd = cwd;
					return fetch("/__kb/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					}).then(function (r) {
						return r.json();
					});
				},
				/**
				* 调系统**原生目录选择框**。
				*
				* 走官方 `ctx.directoryPicker` 服务的 native 后端 ——
				* 正常软件都是这样让用户挑文件夹的，不该让他手打路径。
				*/
				pickDir: function () {
					return fetch("/__kb/pick-dir", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({}),
					}).then(function (r) {
						return r.json();
					});
				},
				restoreDefaults: function (cwd) {

					return fetch("/__kb/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ restoreDefaults: true, cwd: cwd }),
					}).then(function (r) {
						return r.json();
					});
				},
				// ── 删除 ────────────────────────────────────────
				remove: function (id, cwd) {
					return fetch("/__kb/remove", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: id, cwd: cwd }),
					}).then(function (r) {
						return r.json().then(function (j) {
							return { status: r.status, body: j };
						});
					});
				},
				// ── 手动沉淀（委托给当前智能体）─────────────────────
				/**
				* 请求一条「沉淀指令」。
				*
				* ⚠ **不传 kind / domain** —— 类别与领域由智能体按对话内容判断，
				*   设置页那两项只作为建议由 host 附在指令里（见 index.js 的 distill 路由）。
				*
				* @param {object} payload `{cwd, project?, newProject?, agentDecides?}`
				*/
				distill: function (payload) {
					var body = {};
					for (var k in payload) body[k] = payload[k];
					// 显式传空 = 「没有客户端指定」，让设置页的建议值与后端兜底生效
					if (body.kind === undefined) body.kind = "";
					if (body.domain === undefined) body.domain = "";
					return fetch("/__kb/distill", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}).then(function (r) {
						return r.json().then(function (j) {
							return { status: r.status, body: j };
						});
					});
				},
				// ── 项目登记表（沉淀去处选择器要用）─────────────────
				projects: function (cwd) {
					return fetch("/__kb/projects?cwd=" + encodeURIComponent(cwd ?? "")).then(function (r) {
						return r.json();
					});
				},
			};

			// ── 样式 ─────────────────────────────────────────────────
			// ⚠ 本段内禁止出现反引号。
			var KB_CSS = [
				".kb-panel { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }",
				"/* 设置页根容器：照官方 section（max-width 760 + column gap 14） */",
				".kb-section { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 760px; }",
				"/* ══ 卡片 —— DSH 设置页的「圆角方框」本体 ══════════════",
				" * 要点：描边 .5px（不是 1px）、radius-xl(20px)、",
				" *       fill/stroke 用 settings-card 专用 token。 */",
				"/* 页头（照「智能体配置」页：标题 + 描述 + 右侧入口）*/",
				".kb-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }",
				".kb-page-head-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }",
				".kb-page-title { font-size: 15px; font-weight: 500; line-height: 22px; }",
				".kb-page-desc { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }",
				".kb-card-head { padding: 14px 14px 0; }",
				"/* 文本输入（路径 / 领域）*/",
				".kb-text { box-sizing: border-box; width: 260px; max-width: 100%; height: 32px; padding: 0 10px;",
				"  border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);",
				"  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);",
				"  font: inherit; font-size: 13px; outline: none; }",
				".kb-text::placeholder { color: var(--dsw-alias-label-tertiary); }",
				".kb-text:focus-visible, .kb-switch:focus-visible {",
				"  border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));",
				"  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 18%, transparent); }",
				"/* 开关（照官方 Switch：aria-checked 驱动 + 胶囊退出超椭圆）*/",
				".kb-switch { position: relative; box-sizing: border-box; flex: 0 0 auto;",
				"  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;",
				"  corner-shape: round; background: var(--dsw-alias-border-l3); cursor: pointer;",
				"  transition: background .2s; }",
				".kb-switch[aria-checked=\"true\"] { background: var(--dsw-alias-state-business-primary); }",
				".kb-switch::after { content: \"\"; display: block; width: 16px; height: 16px;",
				"  border-radius: 50%; background: var(--dsw-alias-bg-layer-1); transition: transform .2s; }",
				".kb-switch[aria-checked=\"true\"]::after { transform: translateX(16px); }",
				".kb-switch:disabled { opacity: .4; cursor: not-allowed; }",
				"/* 二选一 */",
				".kb-seg { display: inline-flex; gap: 2px; padding: 2px;",
				"  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); }",
				".kb-seg-item { box-sizing: border-box; height: 24px; padding: 0 12px; border: 0;",
				"  border-radius: var(--dsw-radius-xs); background: transparent; cursor: pointer;",
				"  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; }",
				".kb-seg-item:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }",
				".kb-seg-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);",
				"  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l3); }",
				".kb-path { word-break: break-all;",
				"  font-family: var(--ds-font-family-code, ui-monospace, monospace); }",
				".kb-card {",
				"  display: flex; flex-direction: column; overflow: hidden;",
				"  border: .5px solid var(--dsw-alias-settings-card-stroke);",
				"  border-radius: var(--dsw-radius-xl);",
				"  background: var(--dsw-alias-settings-card-fill);",
				"}",
				".kb-card-title { font-size: 14px; font-weight: 500; line-height: 20px; }",
				".kb-card-desc { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }",
				"/* ══ 卡片内的设置行 ══════════════════════════════════════",
				" * 左：标题 + 描述（column）；右：控件。行间用 .5px 分隔线。 */",
				".kb-item {",
				"  box-sizing: border-box; min-height: 52px;",
				"  display: flex; align-items: center; justify-content: space-between; gap: 12px;",
				"  padding: 12px 14px;",
				"}",
				".kb-item + .kb-item { border-top: .5px solid var(--dsw-alias-border-l2); }",
				".kb-item:hover { background: var(--dsw-alias-interactive-bg-hover); }",
				".kb-item-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }",
				".kb-item-label { font-size: 13px; line-height: 20px; }",
				".kb-item-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }",
				".kb-item-ctl { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }",
				"/* ══ 输入框（官方 Input 规范）═══════════════════════════ */",
				".kb-num, .kb-input {",
				"  box-sizing: border-box; height: 32px; padding: 0 10px;",
				"  border: .5px solid var(--dsw-alias-border-l4);",
				"  border-radius: var(--dsw-radius-md);",
				"  background: var(--dsw-alias-bg-layer-1);",
				"  color: var(--dsw-alias-label-primary);",
				"  font: inherit; font-size: 13px; outline: none;",
				"}",
				".kb-num { width: 96px; text-align: right; font-variant-numeric: tabular-nums; }",
				".kb-input { flex: 1 1 140px; min-width: 0; }",
				".kb-input::placeholder { color: var(--dsw-alias-label-tertiary); }",
				".kb-num:focus-visible, .kb-input:focus-visible {",
				"  border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));",
				"  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 18%, transparent);",
				"}",
				".kb-num:disabled { opacity: .5; }",
				"/* ══ 按钮（官方 Button.sm 规范）═════════════════════════ */",
				".kb-btn {",
				"  box-sizing: border-box; height: 28px; padding: 0 10px;",
				"  display: inline-flex; align-items: center; justify-content: center; gap: 4px;",
				"  border: .5px solid var(--dsw-alias-border-l3);",
				"  border-radius: var(--dsw-radius-sm);",
				"  background: transparent; color: var(--dsw-alias-label-primary);",
				"  font: inherit; font-size: 12px; line-height: 18px;",
				"  white-space: nowrap; cursor: pointer;",
				"}",
				".kb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
				".kb-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }",
				".kb-btn:disabled { opacity: .4; cursor: not-allowed; }",
				".kb-btn:focus-visible {",
				"  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));",
				"  outline-offset: 2px;",
				"}",
				".kb-btn-primary { border-color: transparent;",
				"  background: var(--dsw-alias-button-primary-fill);",
				"  color: var(--dsw-alias-label-primary-foreground); }",
				".kb-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }",
				".kb-btn-primary:active:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }",
				".kb-del { width: 28px; padding: 0; color: var(--dsw-alias-label-tertiary); }",
				".kb-del:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary);",
				"  border-color: var(--dsw-alias-state-error-primary); background: transparent; }",
				"/* ══ 徽标（官方 cardIdentity 规范）══════════════════════ */",
				".kb-badge { display: inline-block; padding: 1px 6px;",
				"  border-radius: var(--dsw-radius-xs);",
				"  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary);",
				"  font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }",
				".kb-badge-warn { color: var(--dsw-alias-state-error-primary); }",
				"/* ══ 提示条 ═════════════════════════════════════════════ */",
				".kb-notice { padding: 8px 12px; border-radius: var(--dsw-radius-md);",
				"  font-size: 12px; line-height: 18px;",
				"  border: .5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); }",
				".kb-notice-ok { color: var(--dsw-alias-state-success-primary); }",
				".kb-notice-err { color: var(--dsw-alias-state-error-primary); }",
				"/* 会话头部通知：轻量内联，不占块（头部空间紧） */",
				".kb-head-notice { font-size: 12px; line-height: 18px; margin-left: 8px; }",
				".kb-head-notice-ok { color: var(--dsw-alias-state-success-primary); }",
				".kb-head-notice-err { color: var(--dsw-alias-state-error-primary); }",
				".kb-actions { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }",
				"/* 会话头部的「沉淀到哪」选择器。",
				" * ⚠ 刻意**不做绝对定位下拉**：头部容器没有 position:relative，",
				" *   谁也说不准哪层有 overflow:hidden。看不见的下拉 = 又一个死按钮。",
				" *   这里让它**在流内**展开，最坏是头部变高，但一定看得见。 */",
				".kb-actions-wrap { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 0; }",
				".kb-chooser { display: flex; flex-direction: column; gap: 6px; align-items: flex-end;",
				"  padding: 8px; border: .5px solid var(--dsw-alias-settings-card-stroke);",
				"  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-settings-card-fill);",
				"  box-shadow: 0 4px 16px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent); }",
				".kb-chooser-row { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; max-width: 560px; }",
				".kb-chooser-sel { box-sizing: border-box; max-width: 320px; height: 32px; padding: 0 8px;",
				"  border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);",
				"  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);",
				"  font: inherit; font-size: 13px; outline: none; }",
				".kb-chooser-sel:focus-visible {",
				"  border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));",
				"  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 18%, transparent); }",
				".kb-chooser-input { width: 200px; }",
				".kb-chooser-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }",
				"/* ══ 右栏面板：搜索 / 分组 / 条目 ═══════════════════════ */",
				".kb-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }",
				".kb-group { margin-bottom: 14px; }",
				".kb-group-title { display: flex; align-items: center; gap: 6px; margin: 0 0 8px;",
				"  font-size: 12px; font-weight: 500; line-height: 18px;",
				"  color: var(--dsw-alias-label-secondary); }",
				".kb-entries { display: flex; flex-direction: column; gap: 6px; }",
				".kb-entry { display: flex; flex-direction: column; gap: 4px;",
				"  box-sizing: border-box; padding: 10px 12px;",
				"  border: .5px solid var(--dsw-alias-settings-card-stroke);",
				"  border-radius: var(--dsw-radius-lg);",
				"  background: var(--dsw-alias-settings-card-fill); cursor: pointer; }",
				".kb-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }",
				".kb-entry-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }",
				".kb-id { flex: 0 0 auto; padding: 1px 6px; border-radius: var(--dsw-radius-xs);",
				"  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary);",
				"  font-family: var(--ds-font-family-code, ui-monospace, monospace);",
				"  font-size: 12px; line-height: 18px; }",
				".kb-entry-title { font-size: 13px; line-height: 20px; min-width: 0; }",
				".kb-domain { margin-left: auto; flex: 0 0 auto; font-size: 12px; line-height: 18px;",
				"  color: var(--dsw-alias-label-tertiary); }",
				".kb-detail { display: flex; flex-direction: column; gap: 6px;",
				"  margin-top: 4px; padding-top: 8px;",
				"  border-top: .5px solid var(--dsw-alias-border-l2);",
				"  font-size: 12px; line-height: 18px; }",
				".kb-field { display: flex; flex-direction: column; gap: 2px; }",
				".kb-field-label { font-weight: 500; color: var(--dsw-alias-label-secondary); }",
				".kb-steps { margin: 0; padding-left: 18px; }",
				".kb-steps li { margin-bottom: 2px; }",
				".kb-symptom { color: var(--dsw-alias-state-error-primary); }",
				".kb-empty { padding: 20px 12px; text-align: center;",
				"  border: .5px dashed var(--dsw-alias-border-l3);",
				"  border-radius: var(--dsw-radius-lg); color: var(--dsw-alias-label-tertiary); }",
				".kb-panel-embedded { position: static; padding: 0; border: none;",
				"  background: none; box-shadow: none; }",
				"/* ══ 旧类名兼容（其他位置仍在用，映射到同一套视觉）═══ */",
				".kb-empty-action { margin-top: 10px; }",
				".kb-confirm-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }",
				".kb-row { display: flex; align-items: center; justify-content: space-between;",
				"  gap: 12px; }",
				".kb-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }",
				".kb-entry-row { display: flex; align-items: flex-start; gap: 6px; }",
				".kb-entry-row > .kb-entry { flex: 1 1 auto; min-width: 0; }",
				".kb-cfg { padding: 12px 14px; }",
				".kb-cfg + .kb-cfg { border-top: .5px solid var(--dsw-alias-border-l2); }",
				".kb-cfg-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }",
				".kb-cfg-label { font-size: 13px; line-height: 20px; }",
				".kb-cfg-ctl { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }",
				".kb-cfg-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px;",
				"  margin-top: 2px; }",
				".kb-cfg-num { font-variant-numeric: tabular-nums; font-size: 13px; }",
			].join("\n");

			var STYLE_ID = "__DSH_KNOWLEDGE_STYLE__";
			/**
			 * 注入样式，**返回清理函数**。
			 *
			 * ⚠ 官方 `references/practices.md`（UI 段）：
			 *   「Register styles, timers, listeners and other resources inside `apply`
			 *   with `ctx.effect`/`ctx.on` and return their cleanup functions.」
			 *   我原先直接 appendChild 且不返回清理 ⇒插件卸载后 <style> 留在文档里。
			 *   官方另一条更狠：「Do not write DOM outside your component or append
			 *   to `document.body`」—— head 里的 <style> 属于灰色地带，
			 *   但**由effect 持有并在卸载时移除**是明确要求，必须照做。
			 *
			 * @returns {Function} 清理函数（幂等）。
			 */
			function mountStyle() {
				if (document.getElementById(STYLE_ID) !== null) {
					return function () { /* 已被别人挂上，不归本次 effect 管 */ };
				}
				var el = document.createElement("style");
				el.id = STYLE_ID;
				el.textContent = KB_CSS;
				document.head.appendChild(el);
				return function () {
					try {
						el.remove();
					} catch {
						/* 文档可能已卸载，忽略 */
					}
				};
			}

			// ── 组件 ─────────────────────────────────────────────────

			/**
			 * 单条条目（含展开后的四段/五段）。
			 */
			function Entry(props) {
				var e = props.entry;
				var open = props.open === true;
				// 删除是**不可撤销**的破坏性操作（准则二·5）：
				// 必须先二次确认，不能一点就删。
				var s = useState(false);
				var confirming = s[0];
				var setConfirming = s[1];

				if (confirming === true) {
					return h(
						"div",
						{ className: "kb-entry", key: e.id },
						h(
							"div",
							{ className: "kb-cfg-hint" },
							tz("entry.confirmDelete", { id: e.id }),
						),
						h(
							"div",
							{ className: "kb-confirm-actions" },
							h(
								"button",
								{
									className: "kb-btn kb-btn-primary",
									onClick: function () {
										props.onRemove(e);
									},
								},
								tz("entry.confirmYes"),
							),
							h(
								"button",
								{
									className: "kb-btn",
									onClick: function () {
										setConfirming(false);
									},
								},
								tz("entry.confirmCancel"),
							),
						),
					);
				}

				return h(
					"div",
					{ className: "kb-entry-row", key: e.id },
					h(
						"div",
						{
							className: "kb-entry",
							onClick: function () {
								props.onToggle(e.id);
							},
						},
						h(
							"div",
							{ className: "kb-entry-head" },
							h("span", { className: "kb-id" }, e.id),
							h("span", null, e.title),
							e.domain ? h("span", { className: "kb-domain" }, e.domain) : null,
						),
						open ? h(Detail, { entry: e }) : null,
					),
					h(
						"button",
						{
							className: "kb-btn kb-del",
							title: tz("entry.delete"),
							onClick: function () {
								setConfirming(true);
							},
						},
						"×",
					),
				);
			}

			/** 展开后的完整内容。 */
			function Detail(props) {
				var e = props.entry;
				var h2 = headingsOf(e.kind);
				var field = function (label, value) {
					if (value === undefined || value === null || value === "") return null;
					return h(
						"div",
						{ className: "kb-field" },
						h("span", { className: "kb-field-label" }, label),
						"：",
						h("span", null, value),
					);
				};
				return h(
					"div",
					{ className: "kb-detail", onClick: function (ev) { ev.stopPropagation(); } },
					field(h2.trigger, e.trigger),
					e.steps && e.steps.length > 0
						? h(
								"div",
								{ className: "kb-field" },
								h("span", { className: "kb-field-label" }, h2.steps),
								h(
									"ol",
									{ className: "kb-steps" },
									e.steps.map(function (s, i) {
										return h("li", { key: i }, s);
									}),
								),
							)
						: null,
					field(h2.why, e.why),
					field(tz("entry.verify"), e.verify),
					field(tz("entry.boundaries"), e.boundaries),
					e.symptoms
						? h(
								"div",
								{ className: "kb-field" },
								h(
									"span",
									{ className: "kb-field-label kb-symptom" },
									h2.symptoms,
								),
								"：",
								h("span", { className: "kb-symptom" }, e.symptoms),
							)
						: null,
				);
			}

			/** 分组标题。 */
			function GroupTitle(props) {
				return h(
					"p",
					{ className: "kb-group-title" },
					props.title,
					// 数量用官方徽标样式 —— 原来靠内联 opacity/fontWeight，与 token 体系脱节
					h("span", { className: "kb-badge" }, String(props.count)),
				);
			}

			/**
			 * 主面板内容。**两个宿主**（右栏页签 / 设置页）复用它，
			 * 定位与装饰由各自宿主负责（见 README「同一个面板组件两个宿主」）。
			 */
			function Panel(props) {
				var cwd = props.cwd;
				var state = useState(null); // 列表态
				var entries = state[0];
				var setEntries = state[1];
				var s2 = useState(null); // 详情态
				var detail = s2[0];
				var setDetail = s2[1];
				var s3 = useState(""); // 搜索框
				var query = s3[0];
				var setQuery = s3[1];
				var s4 = useState(false); // 加载中
				var loading = s4[0];
				var setLoading = s4[1];
				var s5 = useState(null); // 错误/提示
				var notice = s5[0];
				var setNotice = s5[1];

				var reload = useCallback(
					function () {
						if (typeof cwd !== "string" || cwd === "") return;
						setLoading(true);
						api
							.search(cwd, query, 50)
							.then(function (data) {
								setEntries(data.exists === false ? null : data.results ?? []);
								setLoading(false);
							})
							.catch(function () {
								setLoading(false);
								setEntries(null);
							});
					},
					[cwd, query],
				);

				useEffect(reload, [cwd, query]);

				// 没给 cwd（比如面板刚挂载还没拿到会话信息）—— 不猜，宁可不显示
				if (typeof cwd !== "string" || cwd === "") {
					return h(
						"div",
						{ className: "kb-panel" },
						h("div", { className: "kb-empty" }, t("panel.noCwd") ?? "尚未确定当前项目"),
					);
				}

				var onToggle = function (id) {
					if (detail !== null && detail.id === id) {
						setDetail(null);
						return;
					}
					api.get(cwd, id).then(function (data) {
						if (data.entry) setDetail(data.entry);
					});
				};

				// 删除单条（Entry 里已做过二次确认，这里只发请求）
				var onRemove = function (entry) {
					api.remove(entry.id, cwd).then(function (r) {
						if (r?.body?.ok !== true) {
							setNotice(r?.body?.error ?? tz("panel.removeFailed"));
							return;
						}
						// 删掉的是当前展开的那条 → 顺手收起详情
						if (detail !== null && detail.id === entry.id) setDetail(null);
						setNotice(tz("panel.deleted", { id: entry.id, n: r.body.count ?? 0 }));
						reload();
					});
				};

				if (entries === null) {
					return h(
						"div",
						{ className: "kb-panel" },
						h(
							"div",
							{ className: "kb-empty" },
							h("div", null, t("panel.noLibrary") ?? "这个项目还没有知识库"),
							h(
								"div",
								{ className: "kb-empty-action" },
								h(
									"button",
									{
										className: "kb-btn kb-btn-primary",
										onClick: function () {
											api.init(cwd).then(function (r) {
												if (r.ok === true) {
													setNotice(tz("panel.created"));
													reload();
												} else {
													setNotice(r.error ?? tz("panel.createFailed"));
												}
											});
										},
									},
									t("panel.init") ?? "建出知识库骨架",
								),
							),
							notice ? h("div", { className: "kb-hint" }, notice) : null,
						),
					);
				}

				var pitfalls = entries.filter(function (e) { return e.kind === "避错"; });
				var methods = entries.filter(function (e) { return e.kind === "方法"; });
				var renderGroup = function (title, list) {
					if (list.length === 0) return null;
					return h(
						"div",
						{ className: "kb-group", key: title },
						h(GroupTitle, { title: title, count: list.length }),
						// 条目列表用 column + gap 排 —— 原来直接返回数组，
						// 条目彼此贴在一起，没有卡片间距。
						h(
							"div",
							{ className: "kb-entries" },
							list.map(function (e) {
								return h(Entry, {
									key: e.id,
									entry: e,
									open: detail !== null && detail.id === e.id,
									onToggle: onToggle,
									onRemove: onRemove,
								});
							}),
						),
					);
				};

				return h(
					"div",
					{ className: "kb-panel" },
					h(
						"div",
						{ className: "kb-toolbar" },
						h("input", {
							className: "kb-input",
							placeholder: t("panel.search") ?? "搜索避错与方法…",
							value: query,
							onChange: function (ev) { setQuery(ev.target.value); },
						}),
						loading ? h("span", { className: "kb-hint" }, "…") : null,
					),
					entries.length === 0
						? h(
								"div",
								{ className: "kb-empty" },
								query === ""
									? (t("panel.empty") ?? "知识库还是空的。让智能体用 kb_add 写第一条。")
									: (t("panel.noMatch") ?? "没有匹配的条目"),
							)
						: h(
								Fragment,
								null,
								renderGroup(tz("panel.groupPitfall"), pitfalls),
								renderGroup(tz("panel.groupMethod"), methods),
							),
					h(
						"div",
						{ className: "kb-hint" },
						tz("panel.total", { n: entries.length, path: cwd }),
					),
				);
			}

			// ── 运行时 inject（★ 必须导出，见下）──────────────────────
			//
			// ⚠⚠ **cordis 对「没进 inject 的服务名」是抛错，不是返 undefined**：
			//   cannot get property "slots" without inject
			//   `?.` **完全挡不住** —— 抛错发生在「读属性那一刻」，不是读到 undefined。
			//   后果：apply 整个炸掉→ 渲染进程报 "renderer boot failed (plugins: dsh-knowledge)"，
			//   而 **The client Loader did not provide an error message**（连报错都没有）。
			//
			//   这个坑dsh-team-chat 踩过两次（remote.pluginManager、uiSession）。
			//
			// 为什么这几个要声明进 inject（而不是 ctx.get 软探测）：
			//   声明缺失 → fiber 停在 pending → **整个插件不激活**。
			//   但它们是**本插件界面存在的地基** —— 右栏页签、设置行、槽注册全靠这些，
			//   缺任何一个界面都不存在，所以是硬依赖，必须声明。
			//
			// 官方先例：dsh-client-ui-sidebar-terminal 的 inject 里就有 sidebarRightTabs。
			var inject = [
				"slots",              // 槽注册（四个槽全靠它）
				"locale",             // i18n bind
				"sidebarRight",       // openTab
				"sidebarRightTabs",   // 注册页签类型
				"layout",             // openRightbar
				"uiConversation",     // 会话头部 actions 槽的宿主
			];

			/**
			 * 条目字段标签，按 kind 取。
			 *
			 * ⚠ **必须是函数、在渲染那一刻现算**：`kind` 的值（`"方法"` / `"避错"`）
			 *   是数据、不变；但标签文案要跟随界面语言，而模块加载期 locale 还没
			 *   bind（见上面 `bindLocale` 的说明）。原来写成模块级常量对象，
			 *   标签在生产时就被定死成中文了 —— 切英文界面也是中文。
			 */
			var headingsOf = function (kind) {
				if (kind === "方法") {
					return {
						trigger: tz("entry.kind.method.trigger"),
						steps: tz("entry.kind.method.steps"),
					};
				}
				if (kind === "避错") {
					return {
						trigger: tz("entry.kind.pitfall.trigger"),
						steps: tz("entry.kind.pitfall.steps"),
						why: tz("entry.kind.pitfall.why"),
						symptoms: tz("entry.kind.pitfall.symptoms"),
					};
				}
				return {};
			};

			// ── 右栏页签（两段式注册，官方支持的第三方路径）────────────
			//
			// ⚠ **两段都要做**，只注册一半 = 没有任何 UI 能打开它：
			//   ① sidebarRightTabs.register({id, kind, title, guide}) —— 注册页签**类型**
			//   ② slots.inject("sidebar.right.pane.tab" / ".title") —— 注册页签**内容与标题**
			// ⚠ **没有 guide 条目 = 页签注册了也没有 UI 能打开它**（右栏 add 控件只列有 guide 的 kind）。
			// ⚠ 顺序不能反：`openTab` 内部走 require()，右栏未挂载时直接抛
			//   `sidebarRight: no session surface is mounted`，首次要用 requestAnimationFrame 重试。
			var PANE_ID = "dsh-knowledge/entries";
			var PANE_KIND = "knowledge-entries";

			function PaneBody(props) {
				var cwd = useSessionCwd(props);
				return h(Panel, { cwd: cwd });
			}

			function PaneTitle() {
				return h(Fragment, null, t("pane.title") ?? "知识库");
			}

			/**
			 * 取当前会话的工作目录（= 项目根）。
			 * 官方姿势是 `ctx.uiSession.adapter.current` 的 snapshot。
			 * ⚠ 拿不到跟踪器时**返回空串**而不是猜 —— 猜错会列出别的项目的条目，
			 *   比不显示严重得多（用户会以为知识库内容是错的）。
			 */
			function useSessionCwd(props) {
				var s = useState("");
				var cwd = s[0];
				var setCwd = s[1];
				useEffect(function () {
					var current = getCtx()?.get?.("uiSession")?.adapter?.current;
					if (current === undefined || current === null) return undefined;
					var read = function () {
						var snap = current.getSnapshot?.();
						var next = snap?.header?.cwd ?? snap?.cwd ?? "";
						setCwd(typeof next === "string" ? next : "");
					};
					read();
					var unsub = current.subscribe?.(read);
					return function () {
						if (typeof unsub === "function") unsub();
					};
				}, []);
				if (typeof props?.cwd === "string" && props.cwd !== "") return props.cwd;
				return cwd;
			}

/**
			 * 设置页的配置区。
			 *
			 * ## 为什么要自己写而不用官方控件
			 * 官方 practices.md 明令：不要 `require` 任何 Harness Client 包
			 * （`dsh-client-ui-primitives` 等），它们随版本变化、
			 * plain-JS 无类型检查、一个抛错的组件清空整个插槽条目。
			 * 所以数字输入框、按钮都是自己写的，只用 `--dsw-alias-*` token。
			 *
			 * ## 四项配置
			 * | 字段 | 含义 | 0 的含义 |
			 * |---|---|---|
			 * | volumePerBook | 每册容量，满则开新册 | —（不能为 0） |
			 * | maxTotal | 总量上限 | 0 = 不限 |
			 * | autoPruneThreshold | 自动清理阈值 | 0 = 从不自动清 |
			 * | maxEntryBytes | 单条体积上限 | —（不能为 0） |
			 *
			 * ⚠ **保存策略是「点保存才生效」**而不是每次输入都存 ——
			 *   输入框中途的半截数字（"" / "-"/"3e"）不该被写进配置。
			 *   离开输入框或点保存时才读值。
			 */
			function SettingsBlock(props) {
				var p = props ?? {};
				var tr = p.t;
				var cwd = typeof p.cwd === "string" ? p.cwd : "";

				var s1 = useState(null);
				var state = s1[0];
				var setState = s1[1];
				var s2 = useState("");
				var busy = s2[0];
				var setBusy = s2[1];
				var s3 = useState(null);
				var notice = s3[0];
				var setNotice = s3[1];
				// 「有未保存改动」：输入框里改了、但还没离开焦点（= 还没存下去）的那一刻。
				// ⚠ 别的设置页是「改了要点保存」，这里没有保存按钮 —— 用户会找不到按钮，
				//   所以既要**在会改配置的地方**写明保存方式（settings.saveHint），
				//   也要在真有没落盘的值时给出这条提示（settings.dirtyHint）。
				var s4 = useState(false);
				var dirty = s4[0];
				var setDirty = s4[1];

				// ⚠⚠ **cwd 为空也必须照常拉配置** —— 这是一个真实修过的 bug：
				//   设置页**没有会话上下文**，currentCwd() 必然返回空串。
				//   我原来写 `if (cwd === "") return;`，
				//   于是 state 永远停在 null → 整个组件只渲染「读取配置…」，
				//   **四个配置项一个都不显示**，而槽里的行是 active 的
				//   （表现为「插件在跑但设置页什么都没有」）。
				//
				// 关键认知：**配置是全局的**（存 ~/.dsh/.dsh-knowledge-data/config.json），
				// 读它**根本不需要 cwd**。cwd 只影响「已沉淀 N 条」这个计数
				// ——那是 per-project 的。两者不该耦合。
				var reload = useCallback(
					function () {
						api.getConfig(cwd).then(function (data) {
							// cwd 为空时 host 仍会返回 config（count 为 0），
							// 失败才保持 null（显示加载中/错误）。
							if (data?.ok === true) setState(data);
						});
					},
					[cwd],
				);
				useEffect(reload, [cwd]);

				if (state === null) {
					return h("div", { className: "kb-cfg-hint" }, tr ? tr("settings.loading") : "读取配置…");
				}

				var cfg = state.config ?? {};
				// ⚠ count 可能是 **null**（cwd 未知，host 拒绝猜），
				//   也可能是 0（cwd 已知但项目还没建库）。两者含义不同：
				//   null →「还没法确定是哪个项目」；0 →「这个项目确实一条都没有」。
				//   显示成同一个「共 0 条」就是把「不知道」谎报成「没有」。
				var total = state.count;

				/** 改一个字段并立即保存（点保存才走这里）。 */
				var save = function (patch) {
					setBusy(true);
					setNotice(null);
					api.saveConfig(patch, cwd).then(function (r) {
						setBusy(false);
						if (r?.ok === true) {
							setDirty(false);
							setState(function (prev) {
								return prev === null
									? prev
									: { ok: true, config: r.config, defaults: prev.defaults, count: prev.count, exists: prev.exists };
							});
							reload();
						} else {
							setNotice({ kind: "err", text: r?.error ?? "保存失败" });
						}
					});
				};

				/**
				* 一个数字配置项：**左侧标题+描述，右侧输入框**。
				*
				* ⚠ 布局照 DSH 官方设置行（label 列 + 控件列）。
				*   原来是「标题与输入框挤同一行、提示文字吊在下面」——
				*   在窄设置页里会挤成一团，文字与控件互相顶。
				*/
				var numRow = function (key, label, hint, min, max) {
					return h(
						"div",
						{ className: "kb-item", key: key },
						h(
							"div",
							{ className: "kb-item-main" },
							h("div", { className: "kb-item-label" }, tr ? tr(label) : label),
							h("div", { className: "kb-item-hint" }, tr ? tr(hint) : hint),
						),
						h(
							"div",
							{ className: "kb-item-ctl" },
							h("input", {
								className: "kb-num",
								type: "number",
								min: min,
								max: max,
								// 用 defaultValue + key，值变化时重挂载，避免受控输入的
								// 半截值问题（用户正在输入时不能把 "" 打回去）
								defaultValue: String(cfg[key] ?? 0),
								key: key + ":" + String(cfg[key] ?? 0),
								disabled: busy,
								// 值还没离开焦点 ⇒ 它还在框里、没落盘（只在真不一样时才算「未保存」）
								onChange: function (ev) {
									setDirty(String(ev.target.value) !== String(cfg[key] ?? 0));
								},
								onBlur: function (ev) {
									var n = Number(ev.target.value);
									if (!Number.isFinite(n)) {
										setNotice({ kind: "err", text: tr ? tr("settings.badNumber") : "请填数字" });
										return;
									}
									// ⚠ 先按本行的 min/max 夹一下再保存。
									//   `type="number"` 的 min/max **不阻止**手打超范围的值
									//   （它只管上下箭头的步进），手打 0 或 999 照样提交；
									//   而 host 的 normalizeField 会**静默**把它夹回合法区间 ——
									//   于是「我填了 0，界面显示 0，实际按 3 走」，谁也看不出来。
									//   在这里夹一次，界面显示的就是真正生效的值。
									if (Number.isFinite(min) && n < min) n = min;
									if (Number.isFinite(max) && n > max) n = max;
									if (n === cfg[key]) return;
									var patch = {};
									patch[key] = n;
									save(patch);
								},
							}),
						),
					);
				};

				// 总量已满时给个醒目的提示——用户改完设置就该知道为什么写不进去
				/**
				* 文本配置项（路径 / 领域名）。
				*
				* @param withBrowse 是否带「浏览…」按钮（弹系统原生目录选择框）。
				*   ⚠ **只有 host 报告 `picker.kind === "native"` 时才渲染按钮** ——
				*     官方对不可用的 kind 要求「隐藏入口」而不是点了才报错，
				*     所以这里不是"禁用"，而是根本不出现。
				*/
				var textRow = function (key, label, hint, placeholder, withBrowse) {
					var canBrowse = withBrowse === true && canBrowseDir === true;
					return h(
						"div",
						{ className: "kb-item", key: key },
						h(
							"div",
							{ className: "kb-item-main" },
							h("div", { className: "kb-item-label" }, tr ? tr(label) : label),
							h("div", { className: "kb-item-hint" }, tr ? tr(hint) : hint),
						),
						h(
							"div",
							{ className: "kb-item-ctl" },
							h("input", {
								className: "kb-text",
								type: "text",
								placeholder: placeholder ?? "",
								defaultValue: String(cfg[key] ?? ""),
								key: key + ":" + String(cfg[key] ?? ""),
								disabled: busy,
								// 同上：框里的值与已生效的值不一样时，就是「有未保存改动」
								onChange: function (ev) {
									setDirty(String(ev.target.value).trim() !== String(cfg[key] ?? ""));
								},
								// 与数字项一样：**离开输入框才保存** ——
								// 路径输到一半（"D:\\知"）不该被写进配置。
								onBlur: function (ev) {
									var v = String(ev.target.value ?? "").trim();
									if (v === (cfg[key] ?? "")) return;
									var patch = {};
									patch[key] = v;
									save(patch);
								},
							}),
							canBrowse === true
								? h(
										"button",
										{
											className: "kb-btn",
											type: "button",
											disabled: busy,
											// 点了会弹出**系统原生**窗口，请求一直挂到
											// 用户选完或取消，所以期间禁用按钮防重复触发
											onClick: function () {
												setBusy(true);
												setNotice(null);
												api.pickDir().then(function (r) {
													setBusy(false);
													if (r?.ok !== true) {
														setNotice({
															kind: "err",
															text:
																r?.error ??
																(tr ? tr("settings.pickFailed") : "打开选择框失败"),
														});
														return;
													}
													// ⚠ 用户取消 → **什么都不做**。
													//   把空值写进配置会把他的目录清掉。
													if (r.canceled === true) return;
													var patch = {};
													patch[key] = r.path;
													save(patch);
												});
											},
										},
										tr ? tr("settings.browse") : "浏览…",
									)
								: null,
						),
					);
				};

				/** 开关配置项。 */
				var boolRow = function (key, label, hint) {
					var on = cfg[key] === true;
					return h(
						"div",
						{ className: "kb-item", key: key },
						h(
							"div",
							{ className: "kb-item-main" },
							h("div", { className: "kb-item-label" }, tr ? tr(label) : label),
							h("div", { className: "kb-item-hint" }, tr ? tr(hint) : hint),
						),
						h(
							"div",
							{ className: "kb-item-ctl" },
							h("button", {
								className: "kb-switch",
								type: "button",
								// ⚠ 用 aria-checked 表达开关态（照官方 Switch 的做法）——
								//   视觉状态与辅助技术读到的是**同一个来源**，不会各说各话。
								"aria-checked": on ? "true" : "false",
								disabled: busy,
								onClick: function () {
									var patch = {};
									patch[key] = on !== true;
									save(patch);
								},
							}),
						),
					);
				};

				/** 二选一（避错 / 方法）。 */
				var segRow = function (key, label, hint, options) {
					var current = cfg[key];
					return h(
						"div",
						{ className: "kb-item", key: key },
						h(
							"div",
							{ className: "kb-item-main" },
							h("div", { className: "kb-item-label" }, tr ? tr(label) : label),
							h("div", { className: "kb-item-hint" }, tr ? tr(hint) : hint),
						),
						h(
							"div",
							{ className: "kb-item-ctl" },
							h(
								"div",
								{ className: "kb-seg" },
								options.map(function (opt) {
									return h(
										"button",
										{
											key: opt,
											type: "button",
											className: "kb-seg-item" + (current === opt ? " kb-seg-on" : ""),
											disabled: busy,
											onClick: function () {
												if (current === opt) return;
												var patch = {};
												patch[key] = opt;
												save(patch);
											},
										},
										opt,
									);
								}),
							),
						),
					);
				};				// host 给出的**最终结论**：能不能弹系统原生目录选择框。
				// ⚠ 只看这一个布尔值，不在前端做 kind 字符串比较 ——
				//   判断逻辑只留在 host 一处，前端改不动、也不用跟着改。
				// 官方要求：不能弹就**隐藏入口**，而不是让用户点了才报错。
				var canBrowseDir = state.picker?.canPick === true;

				// 实际生效的库目录 —— 由 host 按 baseDir 解析后回传（targetDir）。
				// ⚠ 库还没建时 host 也会返回「将会建在哪」，所以这里拿到的
				//   是「改了设置后实际会用的路径」，而不是「当前已存在的库路径」。
				//   ——用户改完存储位置要能立刻看到生效结果。
				var effectiveDir =
					typeof state.targetDir === "string" && state.targetDir !== ""
						? state.targetDir
						: typeof state.project === "string" && state.project !== ""
							? state.project
							: tr
								? tr("settings.dirUnknown")
								: "尚未确定当前项目";

				var capWarn =
					typeof total !== "number" || state.exists === false
						? false
						: (cfg.maxTotal ?? 0) > 0 && total >= cfg.maxTotal;

				return h(
					Fragment,
					null,
					// ── 保存提示：这一页**没有保存按钮**，改完就直接生效 ──────
					// 用户从别的设置页过来（那边要按钮）会找不到按钮、以为没存上，
					// 所以把保存方式摆在**会改配置的地方**，并在真有未落盘的值时
					// 复用同一条「有未保存改动」提示。
					h(
						"div",
						{ className: "kb-notice" },
						(tr
							? tr("settings.saveHint")
							: "改完要点保存（本页没有保存按钮：离开输入框、或点一下开关就存下了）") +
							(dirty === true ? " " : ""),
						dirty === true
							? h(
									"span",
									{ className: "kb-badge kb-badge-warn" },
									tr ? tr("settings.dirtyHint") : "有未保存改动",
								)
							: null,
					),
					// ── 卡片一：已沉淀条数 + 恢复默认 ────────────────
					h(
						"div",
						{ className: "kb-card" },
						h(
							"div",
							{ className: "kb-card-head" },
							h(
								"div",
								{ className: "kb-card-title" },
								tr ? tr("settings.cardStatus") : "沉淀状态",
							),
						),
						h(
							"div",
							{ className: "kb-item" },
							h(
								"div",
								{ className: "kb-item-main" },
								h("div", { className: "kb-item-label" }, tr ? tr("settings.count") : "已沉淀条目"),
								h(
									"div",
									{ className: "kb-item-hint" },
									typeof total !== "number"
										? tr
											? tr("settings.countNoProject")
											: "尚未确定当前项目，条数暂不可见（配置是全局的，下面几项照常可用）"
										: state.exists === false
											? tr
												? tr("settings.countNone")
												: "这个项目还没有知识库"
											: tr
												? tr("settings.countHint")
												: "清理只删最旧的条目；删除不可撤销。",
								),
							),
							h(
								"div",
								{ className: "kb-item-ctl" },
								h(
									"span",
									{ className: "kb-badge" + (capWarn === true ? " kb-badge-warn" : "") },
									total === null || total === undefined
										? tr
											? tr("settings.countUnknown")
											: "未知"
										: (tr ? tr("settings.countValue") : "") +
											total +
											(tr ? tr("settings.countUnit") : " 条"),
									typeof cfg.maxTotal === "number" && cfg.maxTotal > 0 && typeof total === "number"
										? "/" + cfg.maxTotal
										: "",
								),
								h(
									"button",
									{
										className: "kb-btn",
										disabled: busy,
										onClick: function () {
											setBusy(true);
											api.restoreDefaults(cwd).then(function (r) {
												setBusy(false);
												if (r?.ok === true) {
													setNotice({ kind: "ok", text: tr ? tr("settings.restored") : "已恢复默认" });
													reload();
												} else {
													setNotice({ kind: "err", text: r?.error ?? "恢复失败" });
												}
											});
										},
									},
									tr ? tr("settings.restore") : "恢复默认",
								),
							),
						),
					),
					capWarn === true
						? h(
								"div",
								{ className: "kb-notice kb-notice-err" },
								tr
									? tr("settings.capReached")
									: "已达总量上限，新条目会被拒绝。请先删除几条或调高上限。",
							)
						: null,
					notice === null
						? null
						: h(
								"div",
								{
									className:
										"kb-notice " + (notice.kind === "err" ? "kb-notice-err" : "kb-notice-ok"),
								},
								notice.text,
							),
					// ── 卡片：存储位置 ───────────────────────────────
					//
					// ⚠ 改路径**不会自动搬运已有条目** —— 原库还在老地方。
					//   这是刻意的（跨盘搬用户数据风险太高，且失败一半最难收拾），
					//   所以界面上必须把「实际使用」的目录摆出来，让用户看得见。
					h(
						"div",
						{ className: "kb-card" },
						h(
							"div",
							{ className: "kb-card-head" },
							h(
								"div",
								{ className: "kb-card-title" },
								tr ? tr("settings.cardStorage") : "存储位置",
							),
						),
						textRow(
							"baseDir",
							"settings.baseDir",
							"settings.baseDirHint",
							tr ? tr("settings.baseDirPlaceholder") : "例如 D:/knowledge-base",
							true, // ← 带「浏览…」：弹系统原生目录选择框
						),
						// ⚠ 不能弹选择框时**把原因说出来**，别让用户对着输入框猜
						//   「为什么别人有这个按钮我没有」。
						//   官方只要求隐藏「按钮」，没要求隐藏「为什么」。
						canBrowseDir === true
							? null
							: h(
									"div",
									{ className: "kb-item" },
									h(
										"div",
										{ className: "kb-item-main" },
										h(
											"div",
											{ className: "kb-item-hint" },
											tr
												? tr("settings.pickerUnavailable")
												: "当前环境无法弹出系统目录选择框，请手动填写路径。",
										),
									),
								),
						h(
							"div",
							{ className: "kb-item" },
							h(
								"div",
								{ className: "kb-item-main" },
								h(
									"div",
									{ className: "kb-item-label" },
									tr ? tr("settings.effectiveDir") : "实际使用",
								),
								h("div", { className: "kb-item-hint kb-path" }, effectiveDir),
							),
						),
					),
					// ── 卡片二：四项上限 ─────────────────────────────
					h(
						"div",
						{ className: "kb-card" },
						h(
							"div",
							{ className: "kb-card-head" },
							h(
								"div",
								{ className: "kb-card-title" },
								tr ? tr("settings.cardLimits") : "容量与上限",
							),
						),
						numRow("volumePerBook", "settings.volume", "settings.volumeHint", 1, 200),
						numRow("maxTotal", "settings.maxTotal", "settings.maxTotalHint", 0, 100000),
						numRow("autoPruneThreshold", "settings.prune", "settings.pruneHint", 0, 100000),
						numRow(
							"autoPruneKeep",
							"settings.autoPruneKeep",
							"settings.autoPruneKeepHint",
							0,
							100000,
						),
						numRow("maxEntryBytes", "settings.maxBytes", "settings.maxBytesHint", 1024, 16777216),
					// ── 卡片：注入与检索 ─────────────────────────────
					//
					// 这几项直接影响**每轮对话的 token 消耗**，所以单独成卡：
					// 用户想省 token 时知道该动哪几个开关。
					h(
						"div",
						{ className: "kb-card" },
						h(
							"div",
							{ className: "kb-card-head" },
							h(
								"div",
								{ className: "kb-card-title" },
								tr ? tr("settings.cardInject") : "注入与检索",
							),
						),
						boolRow("injectEnabled", "settings.injectEnabled", "settings.injectEnabledHint"),
						numRow(
							"injectMaxChars",
							"settings.injectMaxChars",
							"settings.injectMaxCharsHint",
							200,
							20000,
						),
						// 「本项目必读」：开关 + 条数硬上限。
						// ⚠ 与 injectEnabled 分开两行 —— 它们管的是两件事（见字典里的 hint），
						//   合成一个开关会让「我只想关总纲」变成「连必读也没了」。
						boolRow(
							"guideInjectEnabled",
							"settings.guideInjectEnabled",
							"settings.guideInjectEnabledHint",
						),
						numRow(
							"guideInjectLimit",
							"settings.guideInjectLimit",
							"settings.guideInjectLimitHint",
							1,
							10,
						),
						numRow("searchLimit", "settings.searchLimit", "settings.searchLimitHint", 1, 100),
						segRow("defaultKind", "settings.defaultKind", "settings.defaultKindHint", ["避错", "方法"]),
						textRow(
							"defaultDomain",
							"settings.defaultDomain",
							"settings.defaultDomainHint",
							tr ? tr("settings.defaultDomainPlaceholder") : "留空 = 智能体自己判断",
						),
					),
					),
				);
			}

			// ── apply ────────────────────────────────────────────────
			/**
			 * 客户端入口。
			 *
			 * ⚠ `ctx` 是**参数**，不是 factory 闭包变量（官方 loader 在这里才注入）。
			 *⚠ 抛错 = fiber FAILED = renderer boot failed（该插件整个不激活），
			 *   所以先 try/catch 上报一份完整堆栈再重抛 —— 官方只说
			 *   "The client Loader did not provide an error message"，不给内容。
			 */
			function apply(ctx) {
				try {
					ctxRef = ctx;
					// ⚠⚠ **必须先 register 字典，再 bind** ——顺序反了/ 漏了register，
					//   t("settings.label") 会**原样返回 key**，界面上就印出
					//   "settings.label" / "header.distill" 这种字符串。
					//   2026-10-07 实测踩过：注册缺失导致整个界面全是 key。
					//
					// 官方范例同款（dsh-client-ui-settings-general）：
					//   ctx.effect(() => ctx.locale.register(NS, { zh, en }), "...")
					// register 必须包在 effect 里：effect 结束时应随之注销。
					ctx.effect(
						() => ctx.locale.register(NS, { zh: zhCN, en: enUS }),
						"knowledge: dictionaries",
					);
					bindLocale = ctx.locale.bind(NS);
					return applyInner(ctx);
				} catch (error) {
					try {
						ctx.logger?.error?.("[dsh-knowledge] apply 失败:", error?.stack ?? String(error));
					} catch {
						/* logger 不可用就算了，别把原错误吃掉 */
					}
					throw error;
				}
			}

			function applyInner(ctx) {
				// ⚠ 官方 practices.md：「Register styles, timers, listeners and other
				//   resources inside `apply` with `ctx.effect`… and return their
				//   cleanup functions.」
				// 全部注册进一个 effect：effect 作用域结束（插件卸载 / 换层）时统一注销。
				return ctx.effect(() => {
					var disposeStyle = mountStyle();

				ctx.sidebarRightTabs?.register?.({
					id: PANE_ID,
					kind: PANE_KIND,
					priority: "extension",
					title: function () { return t("pane.title") ?? "知识库"; },
					guide: [
						{
							id: "entries",
							order: 50,
							title: function () { return t("pane.guideTitle") ?? "查看知识库"; },
							description: function () {
								return t("pane.guideDesc") ?? "浏览当前项目的避错与方法条目。";
							},
						},
					],
				});

				ctx.slots.inject("sidebar.right.pane.tab", function () {
					return ctx.slots.register(
						{ name: "sidebar.right.pane.tab", key: PANE_ID, locale: NS, inject: function () { return { t: t }; } },
						PaneBody,
					);
				});
				ctx.slots.inject("sidebar.right.pane.tab.title", function () {
					return ctx.slots.register(
						{ name: "sidebar.right.pane.tab.title", key: PANE_ID, locale: NS, inject: function () { return { t: t }; } },
						PaneTitle,
					);
				});

				// 会话头部一个入口按钮（一键直达）
				ctx.slots.inject("conversation.session.header.actions", function () {
					return ctx.slots.register(
						{
							name: "conversation.session.header.actions",
							id: "kb-open-entries",
							order: 210,
							locale: NS,
							inject: function () {
								return {
									t: t,
									sidebarRightTabs: ctx.sidebarRightTabs,
									sidebarRight: ctx.sidebarRight,
									layout: ctx.layout,
								};
							},
						},
					function (props) {
						var p = props ?? {};
						// 「查看」+「沉淀」按钮。后者调 /__kb/distill：host 校验与限流后
						// 返回一条**指令**，由客户端把它**投进当前会话**，
						// 由**当前这个智能体**提炼并写库。
						//
						// ⚠⚠ 2026-10 修：以前这里只把状态文案改成「已交给智能体」，
						//   返回的 instruction **被直接丢掉** —— 智能体永远收不到，
						//   按钮等于没反应。**不许再退回那种「假装成功」**。
						var s1 = useState(null);
						var distillState = s1[0];
						var setDistillState = s1[1];

						// 「沉淀到哪」选择器（null = 收起）。四选一：
						// 当前项目 / 已登记项目 / 新建项目 / 由智能体自己决定。
						var s2 = useState(null);
						var chooser = s2[0];
						var setChooser = s2[1];
						// 新建项目的表单值与上次的选择**留在组件状态里** ——
						// 会话没换就不必重填（会话一换，session 作用域重挂载，自然清空）。
						var s3 = useState({ name: "", path: "" });
						var form = s3[0];
						var setForm = s3[1];
						var s4 = useState("");
						var lastSel = s4[0];
						var setLastSel = s4[1];
						// ③ 待用户确认的「改名 + 搬库」（null = 没有）。
						// host 遇到「同一路径换名字」默认**不改名**，只回 renameBlocked；
						// 用户在这里点确认，才带 moveLibrary 重发。
						var s5 = useState(null);
						var renamePending = s5[0];
						var setRenamePending = s5[1];

						// ── 投递手段：官方标准 prop ───────────────────────
						//
						// `conversation.session.header.actions` 的 standardProps 里有
						//   useInput: SnapshotSelectorHook<InputState>
						//   inputActions: InputActions
						// （见官方 dsh-cordis-client-runner 的插槽目录，以及
						//   dsh-client-ui-conversation 里 ctx.uiSession.provide 的
						//   `hooks:["conversation","input"], props:["inputActions"]`）
						//
						// InputActions 的真实实现是 SessionInputShell.actions：
						//   { captureInsertion, insertText, setDraft, addAttachments,
						//     removeAttachment, pruneAttachments, submit }
						// setDraft() 换掉整条草稿；submit() 走「回车」同一条路
						// （SubmitMachine.onEnter → 非空、非 "/" 开头 ⇒ 真的发出去）。
						//
						// ⚠ useInput 是标准 **Hook 座位**，只能在组件顶层无条件调用。
						//   standardProps 按 scope binding 缓存，同一次挂载里身份稳定，
						//   所以这里的 hasInputHook 在一次挂载内是常量。
						var hasInputHook = typeof p.useInput === "function";
						var inputSnap = hasInputHook ? p.useInput(function (s) { return s; }) : null;

						/**
						 * 把指令送进当前会话。
						 *
						 * 返回 `"sent"`（真投递）/ `"drafted"`（进了输入框，等用户回车）/
						 * `"noInput"`（够不着输入框 —— **如实报错，不假装**）。
						 *
						 * ⚠ 输入框里已有用户没发出去的内容时**不覆盖**：
						 *   setDraft 是整体替换，直接盖掉等于把用户打的字弄丢。
						 *   这种情况下把指令追加到末尾，并明确告诉他按回车。
						 *
						 * @param {string} instruction host 给的指令全文。
						 * @returns {"sent" | "drafted" | "noInput"}
						 */
						var deliver = function (instruction) {
							var ia = p.inputActions;
							if (ia === null || typeof ia !== "object" || typeof ia.setDraft !== "function") {
								return "noInput";
							}
							// 读不到草稿就**不动它** —— 宁可让用户自己发，
							// 也不能把他正在写的东西悄悄盖掉。
							if (inputSnap === null || typeof inputSnap.draft !== "string") {
								return "noInput";
							}
							try {
								var existing = inputSnap.draft;
								if (existing.trim() !== "") {
									ia.setDraft(String(existing).replace(/\s+$/u, "") + "\n\n" + instruction);
									return "drafted";
								}
								ia.setDraft(instruction);
								if (typeof ia.submit !== "function") return "drafted";
								ia.submit();
								return "sent";
							} catch {
								return "noInput";
							}
						};

						/** 选择器的取值编码。用路径而不是下标 —— 列表每次都会重新拉。 */
						var SEL_CURRENT = "current";
						var SEL_NEW = "new";
						var SEL_AGENT = "agent";
						var PREFIX = "p:";

						/** 默认选中：记得住就沿用上次，否则「当前项目」；cwd 未知时退到「新建」。 */
						var defaultSel = function (list, cwdValue) {
							if (lastSel === SEL_NEW || lastSel === SEL_AGENT) return lastSel;
							if (lastSel === SEL_CURRENT && cwdValue !== "") return lastSel;
							if (lastSel.indexOf(PREFIX) === 0) {
								var wanted = lastSel.slice(PREFIX.length);
								for (var i = 0; i < list.length; i += 1) {
									if (list[i]?.path === wanted) return lastSel;
								}
							}
							return cwdValue !== "" ? SEL_CURRENT : SEL_NEW;
						};

						/** 打开选择器，并拉一次项目清单。 */
						var openChooser = function () {
							var cwdValue = currentCwd();
							setDistillState(null);
							setChooser({ loading: true, projects: [], sel: "", canBrowse: false });
							api.projects(cwdValue).then(function (r) {
								var list = Array.isArray(r?.projects) ? r.projects : [];
								setChooser({
									loading: false,
									projects: list,
									sel: defaultSel(list, cwdValue),
									canBrowse: r?.picker?.canPick === true,
								});
							});
						};

						/** 发请求，然后把拿回来的指令**真的投出去**。 */
						var runDistill = function (payload) {
							setChooser(null);
							setRenamePending(null);
							setDistillState({ kind: "busy" });
							api.distill(payload).then(function (r) {
								var b = r?.body;
								// ③ 改名会挪库 —— host 默认拦下并把新旧目录都报回来。
								//   这里显示提示 + 「把原库搬过去」那个动作，等用户点了才搬。
								//   ⚠ 不许默默改名后让库看起来空了，也不许假装成功。
								if (b?.renameBlocked === true) {
									var moveFailed = b.code === "RENAME_MOVE_FAILED";
									setRenamePending({
										cwd: typeof payload?.cwd === "string" ? payload.cwd : "",
										name: payload?.newProject?.name ?? "",
										path: payload?.newProject?.path ?? "",
										oldName: b.oldName ?? "",
										oldDir: b.oldDir ?? "",
										newDir: b.newDir ?? "",
										// 搬运失败要保留 host 的原话 —— 里面有手工搬运办法，
										// 转述会把它弄丢。
										error: moveFailed ? String(b.error ?? "") : "",
									});
									setDistillState({
										kind: "err",
										text: moveFailed
											? p.t
												? p.t("rename.moveFailedNotice")
												: "搬运失败：没有改名，原库没动"
											: p.t
												? p.t("rename.blockedNotice")
												: "改名没有执行：登记与原库都保持不动",
									});
									return;
								}
								if (b?.ok !== true) {
									setDistillState({
										kind: "err",
										text: b?.error ?? (p.t ? p.t("distill.failed") : "沉淀请求失败"),
									});
									return;
								}
								if (typeof b.instruction !== "string" || b.instruction === "") {
									// host 说 ok 却没给指令 = 契约坏了。**如实说**，
									// 不能顺手报个「已交给智能体」糊过去。
									setDistillState({
										kind: "err",
										text: p.t ? p.t("distill.failed") : "沉淀请求失败",
									});
									return;
								}
								var outcome = deliver(b.instruction);
								// ③ 顺带把原库搬过去了 → 如实说一句「搬到哪了」，
								//   不然用户只看到项目名变了，不知道库去哪了。
								var movedNote =
									typeof b?.libraryMoved?.newDir === "string"
										? " " + (p.t ? p.t("rename.moved") : "已把知识库搬到") + b.libraryMoved.newDir
										: "";
								if (outcome === "sent") {
									setDistillState({
										kind: "ok",
										text: (p.t ? p.t("distill.sent") : "已把沉淀指令投递给智能体，等它提炼并写库") + movedNote,
									});
									return;
								}
								if (outcome === "drafted") {
									setDistillState({
										kind: "ok",
										text:
											(p.t ? p.t("distill.drafted") : "输入框里已有内容：指令已追加到末尾，请按回车发送") +
											movedNote,
									});
									return;
								}
								setDistillState({
									kind: "err",
									text: p.t ? p.t("distill.noInput") : "拿不到输入框，指令没能送达当前会话",
								});
							});
						};

						/**
						 * 用户点了「把原库搬过去并改名」→ 带着 moveLibrary 重发同一件事。
						 * ⚠ 顺序由 host 保证：**先搬库、再改名登记**；搬不动就只报错，什么都不改。
						 */
						var confirmRename = function () {
							var pend = renamePending;
							if (pend === null) return;
							setRenamePending(null);
							runDistill({
								cwd: pend.cwd,
								newProject: { name: pend.name, path: pend.path, moveLibrary: true },
							});
						};

						/** 确认选择器 → 按选择发对应的请求。 */
						var confirmChooser = function () {
							var cwdValue = currentCwd();
							var sel = chooser?.sel ?? "";
							if (sel === SEL_NEW) {
								var nm = String(form.name ?? "").trim();
								var pth = String(form.path ?? "").trim();
								if (nm === "") {
									setDistillState({ kind: "err", text: p.t ? p.t("distill.needName") : "请填项目名" });
									return;
								}
								if (pth === "") {
									setDistillState({ kind: "err", text: p.t ? p.t("distill.needPath") : "请填项目路径" });
									return;
								}
								setLastSel(SEL_NEW);
								runDistill({ cwd: cwdValue, newProject: { name: nm, path: pth } });
								return;
							}
							if (sel === SEL_AGENT) {
								setLastSel(SEL_AGENT);
								runDistill({ cwd: cwdValue, agentDecides: true });
								return;
							}
							if (sel.indexOf(PREFIX) === 0) {
								setLastSel(sel);
								runDistill({ cwd: cwdValue, project: sel.slice(PREFIX.length) });
								return;
							}
							setLastSel(SEL_CURRENT);
							// 老路径：会话自带的 cwd。**拿不到就说拿不到**，
							// 不兜底 process.cwd()（那会写进宿主进程的目录）。
							runDistill({ cwd: cwdValue });
						};

						var cwdNow = currentCwd();
						var chooserOpen = chooser !== null;
						var chooserNode = null;
						if (chooserOpen) {
							if (chooser.loading === true) {
								chooserNode = h(
									"div",
									{ className: "kb-chooser" },
									h(
										"span",
										{ className: "kb-chooser-hint" },
										p.t ? p.t("distill.loading") : "读取项目清单…",
									),
								);
							} else {
								var opts = [];
								if (cwdNow !== "") {
									opts.push(
										h(
											"option",
											{ key: SEL_CURRENT, value: SEL_CURRENT },
											(p.t ? p.t("distill.current") : "当前项目") + " — " + cwdNow,
										),
									);
								}
								for (var oi = 0; oi < (chooser.projects?.length ?? 0); oi += 1) {
									var pr = chooser.projects[oi];
									// 当前会话项目已经在上面单独有一项了，别列两遍 ——
									// 同一本库出现两行只会让人以为有两份数据。
									if (cwdNow !== "" && pr.path === cwdNow) continue;
									opts.push(
										h(
											"option",
											{ key: PREFIX + pr.path, value: PREFIX + pr.path },
											pr.name +
												" — " +
												pr.path +
												(pr.exists === true
													? ""
													: p.t
														? p.t("distill.noLibrary")
														: "（还没有知识库）"),
										),
									);
								}
								opts.push(
									h("option", { key: SEL_NEW, value: SEL_NEW }, p.t ? p.t("distill.newProject") : "新建项目…"),
								);
								opts.push(
									h(
										"option",
										{ key: SEL_AGENT, value: SEL_AGENT },
										p.t ? p.t("distill.agentDecides") : "由智能体自己决定",
									),
								);

								var rows = [
									h(
										"div",
										{ className: "kb-chooser-row", key: "pick" },
										h(
											"select",
											{
												className: "kb-chooser-sel",
												value: chooser.sel ?? "",
												onChange: function (ev) {
													// 用函数式更新：两个输入框的 handler 在同一帧里
													// 都还闭包着**旧**的 form，直接展开会把对方刚写进去的值抹掉。
													var next = ev.target.value;
													setChooser(function (prev) {
														return { ...prev, sel: next };
													});
												},
											},
											opts,
										),
										h(
											"button",
											{
												className: "kb-btn kb-btn-primary",
												type: "button",
												disabled: distillState?.kind === "busy",
												onClick: confirmChooser,
											},
											p.t ? p.t("distill.confirm") : "沉淀",
										),
										h(
											"button",
											{
												className: "kb-btn",
												type: "button",
												onClick: function () {
													setChooser(null);
												},
											},
											p.t ? p.t("distill.cancel") : "取消",
										),
									),
								];

								if (chooser.sel === SEL_NEW) {
									rows.push(
										h(
											"div",
											{ className: "kb-chooser-row", key: "form" },
											h("input", {
												className: "kb-text kb-chooser-input",
												type: "text",
												placeholder: p.t ? p.t("distill.namePlaceholder") : "项目名",
												value: form.name ?? "",
												onChange: function (ev) {
													var next = ev.target.value;
													setForm(function (prev) {
														return { name: next, path: prev.path ?? "" };
													});
												},
											}),
											h("input", {
												className: "kb-text kb-chooser-input",
												type: "text",
												placeholder: p.t ? p.t("distill.pathPlaceholder") : "项目路径",
												value: form.path ?? "",
												onChange: function (ev) {
													var next = ev.target.value;
													setForm(function (prev) {
														return { name: prev.name ?? "", path: next };
													});
												},
											}),
											// 官方要求：弹不出系统选择框就**隐藏入口**，不是点了才报错。
											chooser.canBrowse === true
												? h(
														"button",
														{
															className: "kb-btn",
															type: "button",
															onClick: function () {
																api.pickDir().then(function (r) {
																	// 用户取消 → 什么都不做
																	if (r?.ok !== true || r.canceled === true) return;
																	if (typeof r.path !== "string" || r.path === "") return;
																	var chosen = r.path;
																	// 用 prev.name：系统对话框挂着的时候用户
																	// 可能还在打字，别把手里的旧值盖回去。
																	setForm(function (prev) {
																		return { name: prev.name ?? "", path: chosen };
																	});
																});
															},
														},
														p.t ? p.t("settings.browse") : "浏览…",
													)
												: null,
										),
									);
								}
								chooserNode = h("div", { className: "kb-chooser" }, rows);
							}
						}

						// ③ 改名提示 + 「把原库搬过去」那个动作。
						// ⚠ 选择器关掉了也照样显示 —— 这是一次**待用户确认的破坏性动作**，
						//   藏在收起的面板里等于没提示。
						var renameNode = null;
						if (renamePending !== null) {
							renameNode = h(
								"div",
								{ className: "kb-chooser" },
								h(
									"span",
									{ className: "kb-chooser-hint" },
									p.t ? p.t("rename.panelTitle") : "这个路径已经登记过另一个名字",
								),
								h(
									"span",
									{ className: "kb-chooser-hint" },
									p.t
										? p.t("rename.body")
										: "知识库目录按项目名解析：直接换成新名字登记，库会指向一个空目录，看起来就像条目全丢了。这次没有改名。",
								),
								h(
									"span",
									{ className: "kb-chooser-hint" },
									(p.t ? p.t("rename.oldName") : "原登记名") +
										"：" +
										renamePending.oldName +
										"　" +
										(p.t ? p.t("rename.newName") : "要改成的名字") +
										"：" +
										renamePending.name,
								),
								h(
									"span",
									{ className: "kb-chooser-hint" },
									(p.t ? p.t("rename.oldDir") : "原库位置") + "：" + renamePending.oldDir,
								),
								h(
									"span",
									{ className: "kb-chooser-hint" },
									(p.t ? p.t("rename.newDir") : "改名后会指向") + "：" + renamePending.newDir,
								),
								// 搬运失败时把 host 的原话照贴（含「手工搬运」那一条）
								renamePending.error !== ""
									? h("span", { className: "kb-chooser-hint" }, renamePending.error)
									: null,
								h(
									"div",
									{ className: "kb-chooser-row" },
									h(
										"button",
										{
											className: "kb-btn kb-btn-primary",
											type: "button",
											disabled: distillState?.kind === "busy",
											onClick: confirmRename,
										},
										p.t ? p.t("rename.confirm") : "把原库搬过去并改名",
									),
									h(
										"button",
										{
											className: "kb-btn",
											type: "button",
											onClick: function () {
												setRenamePending(null);
												setDistillState(null);
											},
										},
										p.t ? p.t("rename.cancel") : "取消",
									),
								),
							);
						}

												return h(
							"div",
							{ className: "kb-actions-wrap" },
							h(
							"div",
							{ className: "kb-actions" },
							// ⚠ 不用 emoji 当按钮文字 —— 2026-10-07 实测在 Windows 上
							//   「📚」渲染成方块（缺字形）。文字标签与宿主按钮一致。
							h(
								"button",
								{
									className: "kb-btn",
									title: p.t ? p.t("header.open") : "查看知识库",
									onClick: function () {
										openPane(p);
									},
								},
								p.t ? p.t("header.view") : "查看",
							),
							h(
								"button",
								{
									className: "kb-btn kb-btn-primary",
									title: p.t
										? p.t("header.distillTitle")
										: "把本次对话沉淀进知识库（类别与领域由智能体判断）",
									disabled: distillState?.kind === "busy",
									// 再点一次 = 收起选择器（同一个按钮开关）
									onClick: chooserOpen
										? function () {
												setChooser(null);
											}
										: openChooser,
								},
								p.t ? p.t("header.distill") : "沉淀",
							),
							// 头部空间紧张：通知用轻量内联样式，不占块、不带边框
							distillState === null || distillState.kind === "busy"
								? null
								: h(
										"span",
										{
											className:
												"kb-head-notice " +
												(distillState.kind === "err"
													? "kb-head-notice-err"
													: "kb-head-notice-ok"),
										},
										distillState.text,
									),
							),
							// 「沉淀到哪」选择器：**在流内**展开，不做绝对定位下拉
							chooserNode,
							renameNode,
						);
					},
					);
				});

				// 设置：**独立页面**（settings.section）
				//
				// ⚠⚠ 为什么不用 `settings.general.item`：
				//   那是「通用」页里的**共享行位**，第三方塞进去会与别人的开关
				//   争同一个位置（order 决定谁先谁后），而且 team-chat 的源码注释
				//   明确写着「一旦注册了这个，就不要再往 settings.general.item 里
				//   塞东西，否则同一个开关会出现两次」。
				//   `settings.section` 是**独立设置页**：自带导航项（label + order），
				//   出现在设置面板的页面列表里，不与任何人抢行位。
				//   官方 dsh-client-ui-settings-general自己也是这么注册「通用」页的：
				//     slots.register({ name:"settings.section", id:"general", label:()=>t("general.nav"), ... })
				ctx.slots.inject("settings.section", function () {
					return ctx.slots.register(
						{
							name: "settings.section",
							id: "dsh-knowledge",
							// label 决定设置面板左侧导航里那一项显示什么
							label: function () { return t("settings.pageTitle"); },
							order: 52,
							locale: NS,
							inject: function () { return { t: t }; },
						},
						function (props) {
							var p = props ?? {};
							// 标题 + 「打开面板」+ **配置区**（四项上限 + 恢复默认）
																					return h(
								"div",
								{ className: "kb-section" },
								// ── 页头：标题 + 描述 + 面板入口 ─────────────
								h(
									"div",
									{ className: "kb-page-head" },
									h(
										"div",
										{ className: "kb-page-head-main" },
										h(
											"div",
											{ className: "kb-page-title" },
											p.t ? p.t("settings.label") : "启用知识库沉淀",
										),
										h(
											"div",
											{ className: "kb-page-desc" },
											p.t
												? p.t("settings.hint")
												: "把踩过的坑与做法沉淀进项目知识库，并注入使用约定。",
										),
									),
									h(
										"button",
										{
											className: "kb-btn",
											onClick: function () {
												openPane(p);
											},
										},
										p.t ? p.t("settings.open") : "打开",
									),
								),
								h(SettingsBlock, { t: p.t, cwd: currentCwd() }),
							);
						},
					);
				});

					// ⚠⚠ **清理函数必须是「返回值」，绝不能在这里直接调用** ——
					//   这是 2026-10-08 的真实事故，也是「UI 很丑 / 只有纯粹的文字与标点符号」
					//   的**真正主因**：
					//   `disposeStyle()` 写在 effect 的函数体里 = **同步执行**，
					//   于是刚 appendChild 的 <style> 立刻被 remove ⇒
					//   界面上**一点样式都没有**：输入框是全宽默认外观、
					//   label/hint/input 全部垂直堆叠、没有卡片也没有圆角。
					//
					//   我当时把它归因于「用了不存在的 token」（那也是真问题，已修），
					//   但主因是这一行 —— 静态守卫与真跑 apply 全都发现不了它，
					//   因为它们检查的是「代码结构」和「apply 是否抛错」，
					//   而这个是**运行时把资源提前销毁**，只有看界面才发现。
					//
					//   正确写法：cleanup 只能通过 ctx.effect 回调的**返回值**交给框架。
					return function () {
						disposeStyle();
					};
				});
			}

			/**
			 * 取当前项目根（设置页/会话头部都要用）。
			 *
			 * ⚠ 设置页**没有会话上下文**（它不在某个会话里），
			 *   所以拿不到 `uiSession.adapter.current` 的快照 ——
			 *   只能退到 `process.cwd()`，而客户端里那通常是页面所在目录，
			 *   **不等于**项目根。
			 *
			 *   后果要说清楚：设置页显示的「已沉淀 N 条」可能对应错误的项目。
			 *   正解是让用户在右栏面板里看（那里有准确的 cwd），
			 *   或者等 manifest 阶段宿主把项目根传进来。
			 *   **不猜** —— 宁可显示 0 并提示，也不显示一个看起来像真的错数字。
			 *
			 * @returns {string} 项目根，取不到时返回空串。
			 */
			function currentCwd() {
				var c = getCtx();
				var fromSession = c?.get?.("uiSession")?.adapter?.current;
				if (fromSession != null) {
					try {
						var snap = fromSession.getSnapshot?.();
						var cwd = snap?.header?.cwd ?? snap?.cwd ?? "";
						if (typeof cwd === "string" && cwd !== "") return cwd;
					} catch {
						/* 取不到就往下退 */
					}
				}
				return "";
			}

			/**
			 * 打开右栏页签。**必须先展开右栏**，且挂载在下一帧 ——
			 * 所以首次失败要 requestAnimationFrame 重试一次。
			 */
			function openPane(props) {
				var c = getCtx();
				var layout = props?.layout ?? c?.layout;
				var sidebarRight = props?.sidebarRight ?? c?.sidebarRight;
				if (layout?.openRightbar) layout.openRightbar();
				var attempt = function (retried) {
					try {
						sidebarRight?.openTab?.(PANE_KIND, { revealIfOpened: true });
					} catch {
						if (retried === true) return;
						requestAnimationFrame(function () { attempt(true); });
					}
				};
				attempt(false);
			}

			// ⚠⚠ **不要在这里调 applyInner()**——
			//   `factory(require)` 只负责返回 `{inject, apply}`，
			//   真正执行是 loader 拿到 ctx 之后调 `apply(ctx)`。
			//   在 factory 里立即调用 ⇒ ctx 是 undefined
			//   ⇒ `Cannot read properties of undefined (reading 'sidebarRightTabs')`
			//   ⇒ fiber FAILED ⇒ renderer boot failed（该插件整个不激活）。
			//   官方契约见 dsh-client-modules/lib/index.js:
			//     `exports.apply` 由 loader 调用，且必须是函数。
			exports.inject = inject;
			exports.apply = apply;
			return module.exports;
		},
	});
})();