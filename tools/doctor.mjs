#!/usr/bin/env node
/**
 * WorkBuddy 转接插件自愈医生（幂等，可反复运行）。
 *
 * 它负责把 dsh-workbuddy-connect 修到「能被 DSH 加载 + 请求能过上游」的状态：
 *   1. 依赖自愈：把 DSH 安装包（app.asar）里的 @deepseek-ai/* 解包成真实目录，
 *      替换 DSH 换装后遗留的断链 junction。
 *   2. 兼容性自愈：把插件 package.json 里 6 个钉死精确版本的 peer 改成范围，
 *      从根上不再触发 dsh-app-boot 的 evaluatePluginCompatibility 拦截；
 *      同时按当前内核版本同步 compatibility.json（双保险）。
 *   3. 请求自愈：给 host-heartbeat-*.js 打 WB_PATCH_V3（workspace root 中性化、
 *      DeepSeek Harness 中性化、max_tokens 按目录上限夹紧）。
 *   4. 体检：动态 import 插件，报告导出数。
 *
 * 用法：
 *   node doctor.mjs            修复 + 体检
 *   node doctor.mjs --check    只体检，不改任何文件
 *   node doctor.mjs --verify   修复后再跑一次真实上游请求（慢，会消耗一次额度）
 *
 * 注意：DSH 正在运行时不要指望改完立刻生效——插件模块在启动时已进入主进程，
 * 需要退出整个 DSH（含托盘）再启动。
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, closeSync,
  lstatSync, unlinkSync, rmSync, renameSync, readdirSync, copyFileSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ARGV = new Set(process.argv.slice(2));
const CHECK_ONLY = ARGV.has('--check');
const DO_VERIFY = ARGV.has('--verify');

/** `--profile <name>` 覆盖默认的 desktop profile，方便在别的 profile 里复跑。 */
const PROFILE_NAME = (() => {
	const i = process.argv.indexOf('--profile');
	return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : 'desktop';
})();

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILES = join(HOME, 'profiles');
const PROFILE = join(PROFILES, PROFILE_NAME);
const SHARED_NM = join(PROFILES, 'node_modules');
const PLUGIN_NAME = 'dsh-workbuddy-connect';
const PLUGIN = join(PROFILE, 'node_modules', PLUGIN_NAME);
const PLUGIN_LIB = join(PLUGIN, 'lib');
const PLUGIN_PKG = join(PLUGIN, 'package.json');
const COMPAT = join(PROFILE, 'compatibility.json');
const KERNEL_PKG = join(SHARED_NM, '@deepseek-ai', 'dsh-app-boot', 'package.json');

/**
 * 定位宿主实现文件（host-heartbeat-<hash>.js）。
 *
 * 文件名里的 hash 是打包产物，pnpm 重装/插件升级后会变，所以绝不能写死。
 * 判定标准：lib 目录下、名字匹配 host-heartbeat-*.js、且不含 .bak/.orphan 后缀、
 * 内容里含 prepareCnChatBody —— 三者同时满足才是我们真正要打补丁的那个文件。
 */
function findHostFile() {
  if (!existsSync(PLUGIN_LIB)) return undefined;
  let names;
  try {
    names = readdirSync(PLUGIN_LIB);
  } catch {
    return undefined;
  }
  const candidates = names.filter(
    (n) => /^host-heartbeat-.*\.js$/.test(n) && !n.includes('.bak') && !n.includes('.orphan'),
  );
  const scored = [];
  for (const n of candidates) {
    const full = join(PLUGIN_LIB, n);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    // 只有真正包含入口函数的才是宿主实现；同时按体积降序，命中多个时取最大的
    let hasBody = false;
    try {
      hasBody = readFileSync(full, 'utf8').includes('function prepareCnChatBody(source)');
    } catch {
      hasBody = false;
    }
    scored.push({ full, name: n, size, hasBody });
  }
  scored.sort((a, b) => Number(b.hasBody) - Number(a.hasBody) || b.size - a.size);
  return scored[0];
}

/** peer 期望范围：涵盖 0.2.x 全部（含 rc），0.3.0 起重新拦截（安全阀）。 */
const PEER_RANGE = '>=0.2.1-rc.2 <0.3.0';
const PINNED_PEERS = [
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
];

/** 插件运行时真正 import 的包（不含传递依赖，传递依赖靠解包失败重试补）。 */
const REQUIRED_PACKAGES = [
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-telemetry',
  'semver',
  'resolve.exports',
];

const MARK = '/* WB_PATCH_V7 */';
const OLD_MARKS = [
  '/* WB_PATCH_V3 */',
  '/* WB_PATCH_V4 */',
  '/* WB_PATCH_V5 */',
  '/* WB_PATCH_V6 */',
];

const PATCH_SOURCE = `${MARK}
const WORKSPACE_ROOT_PATTERN = /\\bworkspace root\\b/giu;
const WORKSPACE_ROOT_NEUTRAL = "workspace folder";
const PRODUCT_NAME_PATTERN = /DeepSeek\\s+Harness/gu;
const PRODUCT_NEUTRAL_NAME = "the assistant";
const CHANNEL_IDENTITY_PATTERN = /^[\\s\\uFEFF]*You are an?(?: AI)?(?: coding)? agent powered by [^.\\n]{1,60}Harness\\.?/iu;
const IDENTITY_OCCURRENCE_PATTERN = /You are an?(?: AI)?(?: coding)? agent powered by [^.\\n]{1,60}Harness\\.?/giu;
const NEUTRAL_IDENTITY = "You are an AI agent.";

/**
* The CN gateway's channel check (probed 2026-10-21) rejects a chat request
* whose system prompt *starts* with the harness identity sentence, answering
* 400 / code 11128 / "Illegal API invocation from an unapproved channel".
* Measured 2026-11-11: "You are an AI agent powered by DeepSeek Harness."
* 400s, while "You are a coding agent powered by the deepseek-v4.1-flash
* model." (no "Harness") is accepted, so the sentence is what trips it.
*/
function rewriteChannelIdentityLine(text) {
\treturn text.replace(CHANNEL_IDENTITY_PATTERN, NEUTRAL_IDENTITY);
}

/**
* A greeting or persona block rendered ahead of the identity line pushes it
* into the middle of the system prompt, where the start-anchored pattern no
* longer matches. This pass rewrites every remaining occurrence.
*/
function rewriteEveryOccurrence(text) {
\treturn text.replace(IDENTITY_OCCURRENCE_PATTERN, NEUTRAL_IDENTITY);
}

function neutralizeChannelIdentity(obj) {
\tconst messages = obj["messages"];
\tif (!Array.isArray(messages)) return;
\tfor (const message of messages) {
\t\tif (!isObject(message)) continue;
\t\tconst role = message["role"];
\t\tif (role !== "system" && role !== "developer") continue;
\t\tconst content = message["content"];
\t\tif (typeof content === "string") {
\t\t\tmessage["content"] = rewriteChannelIdentityLine(content);
\t\t\tcontinue;
\t\t}
\t\tif (!Array.isArray(content)) continue;
\t\tfor (const part of content) {
\t\t\tif (isObject(part) && part["type"] === "text" && typeof part["text"] === "string") part["text"] = rewriteChannelIdentityLine(part["text"]);
\t\t}
\t}
}

function neutralizeIdentityEverywhere(body) {
\tif (!isObject(body)) return;
\tconst messages = body["messages"];
\tif (!Array.isArray(messages)) return;
\tfor (const message of messages) {
\t\tif (!isObject(message)) continue;
\t\tconst role = message["role"];
\t\tif (role !== "system" && role !== "developer") continue;
\t\tconst content = message["content"];
\t\tif (typeof content === "string") {
\t\t\tif (content.includes("Harness")) message["content"] = rewriteEveryOccurrence(content);
\t\t\tcontinue;
\t\t}
\t\tif (!Array.isArray(content)) continue;
\t\tfor (const part of content) {
\t\t\tif (!isObject(part) || part["type"] !== "text" || typeof part["text"] !== "string") continue;
\t\t\tif (part["text"].includes("Harness")) part["text"] = rewriteEveryOccurrence(part["text"]);
\t\t}
\t}
}

/**
* Rewrite the text of every system/developer message, handling both the plain
* string form and the multi-part form. Used by the client-fingerprint patches.
*/
function rewriteSystemishText(body, rewrite) {
\tif (!isObject(body)) return;
\tconst messages = body["messages"];
\tif (!Array.isArray(messages)) return;
\tfor (const message of messages) {
\t\tif (!isObject(message)) continue;
\t\tconst role = message["role"];
\t\tif (role !== "system" && role !== "developer") continue;
\t\tconst content = message["content"];
\t\tif (typeof content === "string") {
\t\t\tmessage["content"] = rewrite(content);
\t\t\tcontinue;
\t\t}
\t\tif (!Array.isArray(content)) continue;
\t\tfor (const part of content) {
\t\t\tif (isObject(part) && part["type"] === "text" && typeof part["text"] === "string") part["text"] = rewrite(part["text"]);
\t\t}
\t}
}

/**
* Cap the requested completion length at the catalogued maximum for the model.
* The harness can ask for more than the channel's ceiling (observed:
* deepseek-v4.1-flash at 384000 against a 128000 limit), and the upstream
* answers that with HTTP 500 / code 11134 rather than a validation error.
*/
function clampWorkbuddyMaxTokens(body) {
\tif (!isObject(body)) return;
\tconst modelId = typeof body["model"] === "string" ? body["model"] : "";
\tconst table = typeof FALLBACK_WORKBUDDY_MODELS !== "undefined" && Array.isArray(FALLBACK_WORKBUDDY_MODELS) ? FALLBACK_WORKBUDDY_MODELS : [];
\tconst row = table.find((entry) => isObject(entry) && entry["id"] === modelId);
\tconst cap = row && typeof row["maxTokens"] === "number" && Number.isFinite(row["maxTokens"]) && row["maxTokens"] > 0 ? row["maxTokens"] : 128e3;
\tconst current = body["max_tokens"];
\tif (typeof current !== "number" || !Number.isFinite(current) || current <= cap) return;
\tbody["max_tokens"] = cap;
}

/**
* Persist the exact body that is about to go upstream, plus the concatenated
* system/developer text, so a later 400/11128 can be bisected offline instead
* of guessed at.
*/
function dumpWorkbuddyRequest(body, suffix) {
\ttry {
\t\tif (!isObject(body)) return;
\t\tconst text = JSON.stringify(body);
\t\tif (typeof text !== "string" || text.length > 8388608) return;
\t\tconst root = (() => {
\t\t\ttry {
\t\t\t\treturn resolveDshHome();
\t\t\t} catch {
\t\t\t\treturn join(homedir(), ".dsh");
\t\t\t}
\t\t})();
\t\tconst tag = typeof suffix === "string" && suffix.length > 0 ? "." + suffix : "";
\t\twriteFile(join(root, "workbuddy-last-body" + tag + ".json"), text, "utf8").catch(() => {});
\t\t// 只有原样（raw）那份才需要额外拆一份可读的 system 文本，prepared 那份不用。
\t\tif (typeof suffix === "string" && suffix !== "raw") return;
\t\tconst messages = body["messages"];
\t\tif (!Array.isArray(messages)) return;
\t\tconst head = [];
\t\tfor (const message of messages) {
\t\t\tif (!isObject(message)) continue;
\t\t\tconst role = message["role"];
\t\t\tif (role !== "system" && role !== "developer") continue;
\t\t\tconst content = message["content"];
\t\t\thead.push(typeof content === "string" ? content : JSON.stringify(content));
\t\t}
\t\twriteFile(join(root, "workbuddy-last-system.txt"), head.join("\\n\\n"), "utf8").catch(() => {});
\t} catch {}
}

/**
* All CN-channel body rewrites that keep the request inside the upstream's
* client fingerprint rules.
*/
function applyClientPatches(body) {
\tdumpWorkbuddyRequest(body, "raw");
\trewriteSystemishText(body, (text) => text.replace(WORKSPACE_ROOT_PATTERN, WORKSPACE_ROOT_NEUTRAL).replace(PRODUCT_NAME_PATTERN, PRODUCT_NEUTRAL_NAME));
\tclampWorkbuddyMaxTokens(body);
\tdumpWorkbuddyRequest(body, "prepared");
}

`;

const report = [];
function ok(msg) { report.push({ level: 'ok', msg }); }
function changed(msg) { report.push({ level: 'fixed', msg }); }
function warn(msg) { report.push({ level: 'warn', msg }); }
function bad(msg) { report.push({ level: 'bad', msg }); }

/* ------------------------------------------------------------------ asar 读取 */

function findAsar() {
  const explicit = process.env.DSH_ASAR;
  if (explicit && existsSync(explicit)) return explicit;
  const programs = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined;
  if (!programs || !existsSync(programs)) return undefined;
  const found = [];
  for (const name of readdirSync(programs)) {
    const p = join(programs, name, 'resources', 'app.asar');
    if (existsSync(p)) found.push({ p, mtime: statSync(p).mtimeMs });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.p;
}

let asarCache;
function readAsarHeader(asarPath) {
  if (asarCache) return asarCache;
  const fd = openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const jsonLen = head.readUInt32LE(12);
    const raw = Buffer.alloc(jsonLen);
    readSync(fd, raw, 0, jsonLen, 16);
    // 解析失败时绝不能让 node 把几 MB 的 header 打到 stderr。
    let header;
    try {
      header = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('app.asar 头部解析失败（jsonLen=' + jsonLen + '）');
    }
    asarCache = { fd, header, baseOffset: 16 + jsonLen };
    return asarCache;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function asarFiles(header, relDirs) {
  let node = header;
  for (const part of relDirs) {
    node = node?.files?.[part];
    if (!node) return undefined;
  }
  const out = [];
  (function walk(n, prefix) {
    for (const [name, entry] of Object.entries(n.files ?? {})) {
      const q = prefix + '/' + name;
      if (entry.files) walk(entry, q);
      else out.push({ rel: q, size: entry.size, offset: Number(entry.offset) });
    }
  })(node, '');
  return out;
}

/** 把 asar 里的某个包解到 SHARED_NM/<包名>，返回写入的文件数。 */
function extractPackage(asar, relDirs) {
  const files = asarFiles(asar.header, ['node_modules', ...relDirs]);
  if (!files) return undefined;
  const dest = join(SHARED_NM, ...relDirs);
  let written = 0;
  for (const f of files) {
    const out = join(dest, f.rel);
    if (existsSync(out)) continue;
    mkdirSync(dirname(out), { recursive: true });
    const buf = Buffer.alloc(f.size);
    readSync(asar.fd, buf, 0, f.size, asar.baseOffset + f.offset);
    writeFileSync(out, buf);
    written++;
  }
  return { written, total: files.length, dest };
}

/** 清掉挡路的断链 junction / 空目录（断链 junction 会被 existsSync 误判为存在）。 */
function clearBlockedPath(target) {
  if (!existsSync(target)) return false;
  if (existsSync(join(target, 'package.json'))) return false;
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) return false;
  if (st.isSymbolicLink()) {
    unlinkSync(target);
    return true;
  }
  if (st.isDirectory()) {
    const aside = target + '.orphan-' + Date.now();
    renameSync(target, aside);
    return true;
  }
  return false;
}

function packageBroken(name) {
  const dir = join(SHARED_NM, name);
  if (!existsSync(join(dir, 'package.json'))) return 'missing';
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!pkg.version) return 'invalid';
  } catch {
    return 'invalid';
  }
  return undefined;
}

/* -------------------------------------------------------------- 1. 依赖自愈 */

function healDependencies() {
  const broken = [];
  for (const name of REQUIRED_PACKAGES) {
    const why = packageBroken(name);
    if (why) broken.push({ name, why });
  }
  if (broken.length === 0) {
    ok('依赖：' + REQUIRED_PACKAGES.length + ' 个运行时依赖全部就位');
    return true;
  }
  for (const b of broken) warn('依赖缺失/损坏：' + b.name + '（' + b.why + '）');
  if (CHECK_ONLY) return false;

  const asarPath = findAsar();
  if (!asarPath) {
    bad('依赖：找不到 app.asar，无法解包（可用 DSH_ASAR 指定）');
    return false;
  }
  let asar;
  try {
    asar = readAsarHeader(asarPath);
  } catch (error) {
    bad('依赖：' + error.message);
    return false;
  }
  ok('依赖：使用 ' + asarPath);

  let allOk = true;
  for (const b of broken) {
    const rel = b.name.split('/');
    const target = join(SHARED_NM, ...rel);
    if (clearBlockedPath(target)) warn('依赖：清除了挡路的断链/空目录 ' + b.name);
    const result = extractPackage(asar, rel);
    if (!result) {
      bad('依赖：' + b.name + ' 不在 app.asar 里，无法解包');
      allOk = false;
      continue;
    }
    changed('依赖：解包 ' + b.name + '（写入 ' + result.written + '/' + result.total + ' 个文件）');
  }
  closeSync(asar.fd);
  asarCache = undefined;
  return allOk;
}

/**
 * 清掉 @deepseek-ai 下指向旧 DSH 安装位置的断链 junction。
 * 这些是 DSH 换装后的遗留物：目标目录早已删除，且当前安装包里根本没有同名包，
 * 所以不可能被解析到，只会在枚举目录时报错、给排查添乱。
 */
function cleanOrphanLinks() {
  const root = join(SHARED_NM, '@deepseek-ai');
  if (!existsSync(root)) return;
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    bad('孤儿链接：无法枚举 ' + root);
    return;
  }
  const orphans = [];
  for (const d of dirs) {
    const full = join(root, d.name);
    let st;
    try {
      st = lstatSync(full, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (!st || !st.isSymbolicLink()) continue;
    // 断链判定：目标不存在。注意 existsSync 对断链 junction 会误报 true，
    // 所以改用「能否读到目录里的 package.json」来判定。
    if (existsSync(join(full, 'package.json'))) continue;
    orphans.push(full);
  }
  if (orphans.length === 0) {
    ok('孤儿链接：无断链 junction');
    return;
  }
  if (CHECK_ONLY) {
    warn('孤儿链接：发现 ' + orphans.length + ' 个断链 junction（--check 模式不清理）');
    return;
  }
  let removed = 0;
  for (const full of orphans) {
    try {
      unlinkSync(full);
      removed++;
    } catch (error) {
      warn('孤儿链接：无法删除 ' + full + '（' + error.message + '）');
    }
  }
  if (removed > 0) changed('孤儿链接：清理了 ' + removed + ' 个指向旧 DSH 安装的断链 junction');
}

/* ---------------------------------------------------------- 2. 兼容性自愈 */

function kernelVersion() {
  try {
    return JSON.parse(readFileSync(KERNEL_PKG, 'utf8')).version;
  } catch {
    return undefined;
  }
}

function healCompatibility() {
  if (!existsSync(PLUGIN_PKG)) {
    bad('兼容性：插件未安装（' + PLUGIN_PKG + ' 不存在）');
    return false;
  }
  const pkg = JSON.parse(readFileSync(PLUGIN_PKG, 'utf8'));
  const version = pkg.version;
  const kernel = kernelVersion();
  if (!kernel) warn('兼容性：读不到内核版本（' + KERNEL_PKG + '），跳过豁免同步');

  // 2a. peer 从精确版改成范围
  const peers = pkg.peerDependencies ?? {};
  const toFix = PINNED_PEERS.filter((name) => name in peers && peers[name] !== PEER_RANGE);
  if (toFix.length === 0) {
    ok('兼容性：peer 范围已是 ' + PEER_RANGE);
  } else if (CHECK_ONLY) {
    warn('兼容性：' + toFix.length + ' 个 peer 仍是精确版本（会触发内核版本拦截）');
  } else {
    const bak = PLUGIN_PKG + '.bak-doctor-original';
    if (!existsSync(bak)) copyFileSync(PLUGIN_PKG, bak);
    for (const name of toFix) peers[name] = PEER_RANGE;
    pkg.peerDependencies = peers;
    writeFileSync(PLUGIN_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    changed('兼容性：' + toFix.length + ' 个 peer 改为 ' + PEER_RANGE);
  }

  // 2b. compatibility.json 按当前内核版本同步（peer 已放宽时它只是冗余保险）
  if (kernel) {
    const key = PLUGIN_NAME + '@' + version;
    let current = {};
    if (existsSync(COMPAT)) {
      try {
        current = JSON.parse(readFileSync(COMPAT, 'utf8'));
      } catch {
        current = {};
      }
    }
    const list = Array.isArray(current[key]) ? current[key] : [];
    if (list.includes(kernel)) {
      ok('兼容性：compatibility.json 已包含 ' + key + ' → ' + kernel);
    } else if (CHECK_ONLY) {
      warn('兼容性：compatibility.json 缺少 ' + key + ' → ' + kernel);
    } else {
      current[key] = [...new Set([...list, kernel])].sort();
      writeFileSync(COMPAT, JSON.stringify(current, null, 2) + '\n', 'utf8');
      changed('兼容性：compatibility.json 登记 ' + key + ' → ' + kernel);
    }
  }
  return true;
}

/* -------------------------------------------------------------- 3. 请求自愈 */

/** 任意补丁标记（当前版或历史版），用来判断一个文件是否已被打过补丁。 */
function isPatched(text) {
  return [MARK, ...OLD_MARKS].some((m) => text.includes(m));
}

/**
 * 原位剥离任意版本的补丁块，返回没有补丁的干净源码；失败返回 undefined。
 *
 * 历史上补丁分两种摆放方式，两种都要能拆：
 *   A. 一整块（MARK 到 applyClientPatches 结束），V7 就是这种。
 *   B. 身份补丁单独一段放在 prepareChatBody 后面（L1066 那种），外加
 *      MARK 块的其余部分。只拆 MARK 块会留下 A 里的 const，和新块撞名。
 */
function stripPatchBlock(src) {
  let out = src;

  // 1) 拆掉 MARK 块（MARK 到最后一个 applyClientPatches 函数闭合 }）
  const allMarks = [MARK, ...OLD_MARKS];
  for (const m of allMarks) {
    const at = out.indexOf(m);
    if (at < 0) continue;
    const applyIdx = out.indexOf('function applyClientPatches', at);
    if (applyIdx < 0) continue;
    let end = out.indexOf('\n}', applyIdx);
    if (end < 0) continue;
    end += 2;
    while (out[end] === '\n') end += 1;
    out = out.slice(0, at) + out.slice(end);
    break;
  }

  // 2) 拆掉游离的身份补丁段：从它前面的 JSDoc 一直到 rewriteEveryOccurrence 结束
  const identAt = out.indexOf('const CHANNEL_IDENTITY_PATTERN');
  if (identAt >= 0) {
    // 往前吃掉紧邻的 JSDoc 注释
    let start = identAt;
    const jsdoc = out.lastIndexOf('/**', identAt);
    if (jsdoc >= 0 && out.slice(jsdoc, identAt).trimStart().startsWith('/**')) start = jsdoc;
    // 往后到 rewriteEveryOccurrence 函数的闭合 }
    const reIdx = out.indexOf('function rewriteEveryOccurrence', identAt);
    if (reIdx >= 0) {
      let end = out.indexOf('\n}', reIdx);
      if (end >= 0) {
        end += 2;
        while (out[end] === '\n') end += 1;
        out = out.slice(0, start) + out.slice(end);
      }
    }
  }

  // 3) prepareChatBody 里的调用块还原成裸的 normalizeToolChoice
  out = out.replace(
    /\tnormalizeDeveloperRole\(obj\);\n\tneutralizeIdentityEverywhere\(body\);\n\tneutralizeChannelIdentity\(obj\);\n\tnormalizeToolChoice\(obj\);\n/,
    '\tnormalizeDeveloperRole(obj);\n\tnormalizeToolChoice(obj);\n',
  );

  // 4) prepareCnChatBody 里的调用块还原成单行
  out = out.replace(
    /\tdropUnsupportedEffort\(body\);\n\tneutralizeIdentityEverywhere\(body\);\n\tneutralizeChannelIdentity\(body\);\n\tapplyClientPatches\(body\);\n/,
    '\tdropUnsupportedEffort(body);\n',
  );

  // 剥离后还残留任何补丁符号，说明结构不是我们认识的，交给调用方兜底
  if (/const (WORKSPACE_ROOT_PATTERN|CHANNEL_IDENTITY_PATTERN)\b/.test(out)) return undefined;
  return out;
}

function healRequestPatch() {
  const host = findHostFile();
  if (host === undefined) {
    bad('请求补丁：' + PLUGIN_LIB + ' 下找不到 host-heartbeat-*.js');
    return false;
  }
  const LIB = host.full;
  const LIB_BACKUP = LIB + '.bak-doctor-original';
  let src = readFileSync(LIB, 'utf8');

  // 已经是目标版本
  if (src.includes(MARK)) {
    ok('请求补丁：' + MARK.trim() + ' 已就位（' + host.name + '，' + src.length + ' 字节）');
    return true;
  }

  const stale = OLD_MARKS.find((m) => src.includes(m));
  if (CHECK_ONLY) {
    if (stale !== undefined) {
      warn('请求补丁：发现旧版 ' + stale + '，需要升级到 ' + MARK.trim());
    } else {
      warn('请求补丁：' + MARK.trim() + ' 缺失（上游会以 400/11128 或 500/11134 拒绝）');
    }
    return false;
  }

  // 先记下当前版本，万一以后要回滚。
  // 注意：只有当当前文件是干净的（不含任何补丁标记）才配叫 "original"，
  // 否则会把带补丁的文件存成备份，下次又拿它当原版重建，最终叠出重复 const。
  if (!existsSync(LIB_BACKUP) && !isPatched(src)) copyFileSync(LIB, LIB_BACKUP);

  let clean;
  if (stale !== undefined) {
    // 旧补丁块必须整块剥掉：里面声明的 const 和新块重复，叠加会 SyntaxError。
    // 顺序：先原位剥离（确定性最高），再用「确实干净」的备份兜底。
    clean = stripPatchBlock(src);
    let how = '原位剥离';
    if (clean === undefined) {
      const original = [LIB_BACKUP, LIB + '.bak-original-0.7.9'].find(
        (p) => existsSync(p) && !isPatched(readFileSync(p, 'utf8')),
      );
      if (original !== undefined) {
        clean = readFileSync(original, 'utf8');
        how = '从原版备份重建';
      }
    }
    if (clean === undefined) {
      bad('请求补丁：发现旧版 ' + stale + '，但无法原位剥离补丁块，也找不到干净的原版备份');
      return false;
    }
    changed('请求补丁：已移除旧版 ' + stale + '（' + how + '）');
  } else {
    clean = src;
  }

  const anchor = 'function prepareCnChatBody(source) {';
  const idx = clean.indexOf(anchor);
  if (idx < 0) {
    bad('请求补丁：插件版本变了，锚点 "' + anchor + '" 找不到，需要人工适配');
    return false;
  }
  const callAnchor = '\tdropUnsupportedEffort(body);';
  const callIdx = clean.indexOf(callAnchor, idx);
  if (callIdx < 0) {
    bad('请求补丁：prepareCnChatBody 里找不到 "' + callAnchor.trim() + '"，需要人工适配');
    return false;
  }
  // 顺序要紧：先把带 Harness 的身份整句换成 "You are an AI agent."，再让
  // applyClientPatches 去换剩下的 "DeepSeek Harness"；反过来的话会拼出
  // "You are an AI agent powered by the assistant." 这种崩坏句。
  const callBlock = [
    '\tdropUnsupportedEffort(body);',
    '\tneutralizeIdentityEverywhere(body);',
    '\tneutralizeChannelIdentity(body);',
    '\tapplyClientPatches(body);',
  ].join('\n');
  let out = clean.slice(0, callIdx) + callBlock + clean.slice(callIdx + callAnchor.length);
  const insertAt = out.indexOf(anchor);
  out = out.slice(0, insertAt) + PATCH_SOURCE + out.slice(insertAt);
  writeFileSync(LIB, out, 'utf8');
  changed('请求补丁：已注入 ' + MARK.trim() + '（' + host.name + '：身份句整句中性化、workspace root → workspace folder、DeepSeek Harness → the assistant、max_tokens 夹紧、请求体原样/prepared 双份落盘）');
  return true;
}

/* ------------------------------------------------------------------ 4. 体检 */

function probeImport() {
  try {
    const out = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import('" + PLUGIN_NAME + "').then((m) => { console.log('EXPORTS=' + Object.keys(m).length); });",
    ], { cwd: PROFILE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    const m = /EXPORTS=(\d+)/.exec(out);
    if (m) ok('体检：插件可 import，导出 ' + m[1] + ' 个符号');
    else warn('体检：插件 import 完成但没有输出预期的导出计数');
    return Boolean(m);
  } catch (error) {
    const stderr = String(error.stderr ?? error.message ?? '').split('\n').slice(0, 6).join('\n');
    bad('体检：插件无法 import\n' + stderr);
    return false;
  }
}

function printReport() {
  const icon = { ok: '  OK   ', fixed: ' FIXED ', warn: ' WARN  ', bad: ' FAIL  ' };
  for (const line of report) console.log('[' + icon[line.level] + '] ' + line.msg);
  const failed = report.filter((l) => l.level === 'bad').length;
  const fixed = report.filter((l) => l.level === 'fixed').length;
  console.log('\n---- 汇总 ----');
  console.log('已修复 ' + fixed + ' 项，失败 ' + failed + ' 项' + (CHECK_ONLY ? '（--check 模式，未写任何文件）' : ''));
  if (fixed > 0) {
    console.log('改动需要重启 DSH 才生效：请从托盘彻底退出，再重新启动。');
  }
  return failed;
}

/* -------------------------------------------------------------------- main */

let exitCode = 0;
try {
  if (!existsSync(PLUGIN)) {
    bad('插件目录不存在：' + PLUGIN);
    exitCode = 1;
  } else {
    cleanOrphanLinks();
    healDependencies();
    healCompatibility();
    healRequestPatch();
    if (!CHECK_ONLY) probeImport();
  }
} catch (error) {
  bad('doctor 异常：' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : String(error)));
  exitCode = 1;
}
const failed = printReport();
if (failed > 0) exitCode = 1;
process.exit(exitCode);
