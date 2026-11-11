/**
 * 从 WorkBuddy 桌面 App 导出当前账号凭据。
 *
 * 为什么要这个：插件在装了 WorkBuddy 桌面 App 的机器上可以直接解密 App 的
 * 加密凭据；但手机（DSH Go）、WSL、Linux 机器上没有 WorkBuddy 的 Electron
 * 二进制，永远解不开那份加密文件。所以要在有 App 的电脑上导出成明文格式，
 * 再拷到目标机器。
 *
 * 用法（Windows，必须在命令行里跑，不能双击）：
 *
 *   set ELECTRON_RUN_AS_NODE=1
 *   set WORKBUDDY_ELECTRON_BIN=D:\Apps\WorkBuddy\WorkBuddy.exe
 *   "%WORKBUDDY_ELECTRON_BIN%" export-own.js
 *
 * 或指定输出路径：
 *
 *   "%WORKBUDDY_ELECTRON_BIN%" export-own.js "" D:\out\workbuddy-auth.json
 *
 * Linux / macOS：
 *
 *   export ELECTRON_RUN_AS_NODE=1
 *   export WORKBUDDY_ELECTRON_BIN=/path/to/WorkBuddy
 *   "$WORKBUDDY_ELECTRON_BIN" export-own.js
 *
 * 输出默认落在当前目录的 workbuddy-auth.json。
 *
 * ⚠️ 产出的文件包含明文 accessToken 和 refreshToken，等同于账号密码。
 *    不要发到群里、不要提交进 git、不要放进共享网盘。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const OWN_FORMAT_VERSION = 1;

/** WorkBuddy 桌面 App 的加密凭据默认位置。 */
function defaultAuthFile() {
	const localAppData = process.env.LOCALAPPDATA
		|| path.join(process.env.USERPROFILE || "", "AppData", "Local");
	return path.join(
		localAppData,
		"CodeBuddyExtension",
		"Data",
		"Public",
		"auth",
		"workbuddy-desktop.info",
	);
}

/**
 * 重建 App 加密字段的 AAD（附加认证数据）。
 * 这套结构是逆向 App 得到的，字段顺序和长度前缀都不能改。
 */
function buildAuthenticatedContextAad(keyId, suite) {
	const prefix = Buffer.from("WB-AAD\0", "ascii");
	const lengthPrefixed = (value) => {
		const bytes = Buffer.from(value, "utf8");
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32BE(bytes.length);
		return Buffer.concat([header, bytes]);
	};
	const suiteBytes = Buffer.allocUnsafe(4);
	suiteBytes.writeUInt32BE(suite);
	return Buffer.concat([
		prefix,
		Buffer.from([1]),
		lengthPrefixed("WBEV1"),
		lengthPrefixed("sym-v1"),
		suiteBytes,
		lengthPrefixed(keyId),
		Buffer.from([2]),
		Buffer.from([0]),
		Buffer.from([0]),
	]);
}

/** 用 App 的 at-rest 主密钥解开一个 `$wbEncrypted` 字段。 */
function openField(protectorKey, envelope) {
	const env = JSON.parse(Buffer.from(envelope, "base64").toString("utf8"));
	if (env.suite !== 1) throw new Error(`unsupported envelope suite ${env.suite}`);
	const decipher = crypto.createDecipheriv(
		"aes-256-gcm",
		protectorKey,
		Buffer.from(env.nonce, "base64"),
		{ authTagLength: 16 },
	);
	decipher.setAAD(buildAuthenticatedContextAad(env.keyId, env.suite));
	decipher.setAuthTag(Buffer.from(env.authTag, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(env.ciphertext, "base64")),
		decipher.final(),
	]).toString("utf8");
}

/** App 里有的时间戳是秒，有的是毫秒，统一成毫秒。 */
function expiryToMs(value) {
	if (typeof value !== "number" || value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1000;
}

function main() {
	const authFile = process.argv[2]
		|| process.env.WORKBUDDY_AUTH_FILE
		|| defaultAuthFile();
	const outFile = process.argv[3] || path.join(process.cwd(), "workbuddy-auth.json");

	if (!fs.existsSync(authFile)) throw new Error(`auth file not found: ${authFile}`);

	// 这一步必须跑在 WorkBuddy 自己的 Electron 里（ELECTRON_RUN_AS_NODE=1），
	// 普通 node 没有这个私有 binding。
	const binding = process._linkedBinding("electron_browser_workbuddy_storage");
	const payload = JSON.parse(String(binding.loggerGet()));
	if (payload.version !== 1 || !payload.atRestSecretKey) {
		throw new Error("unexpected at-rest payload");
	}
	const protectorKey = crypto.createHash("sha256").update(payload.atRestSecretKey, "utf8").digest();

	const doc = JSON.parse(fs.readFileSync(authFile, "utf8"));
	const auth = doc.auth && typeof doc.auth === "object" ? doc.auth : doc;
	const identity = doc.account && typeof doc.account === "object" ? doc.account : doc;

	const read = (field) => {
		const raw = auth[field];
		if (typeof raw === "string" && raw) return raw;
		if (raw && raw.$wbEncrypted === 1 && typeof raw.envelope === "string") {
			return openField(protectorKey, raw.envelope);
		}
		return "";
	};

	const accessToken = read("accessToken");
	const refreshToken = read("refreshToken");
	if (!accessToken) throw new Error(`no accessToken in ${authFile}`);

	// 插件自留副本的文件格式（parseOwnDocument / ownDocument 读的就是这个）
	const credential = {
		accessToken,
		refreshToken,
		expiresAtMs: expiryToMs(auth.expiresAt),
		domain: typeof auth.domain === "string" ? auth.domain : "",
		uid: typeof identity.uid === "string" ? identity.uid : "",
		source: "dsh",
	};
	const refreshExpiresAtMs = expiryToMs(auth.refreshExpiresAt);
	if (refreshExpiresAtMs > 0) credential.refreshExpiresAtMs = refreshExpiresAtMs;
	if (typeof identity.enterpriseId === "string" && identity.enterpriseId) {
		credential.enterpriseId = identity.enterpriseId;
	}
	if (typeof identity.nickname === "string" && identity.nickname) {
		credential.nickname = identity.nickname;
	}

	const out = { version: OWN_FORMAT_VERSION, credential };
	fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
	fs.chmodSync(outFile, 0o600);

	const days = Math.max(0, Math.round((credential.expiresAtMs - Date.now()) / 86400000));
	process.stdout.write(`wrote ${outFile} (${fs.statSync(outFile).size} bytes)\n`);
	process.stdout.write(`accessToken  剩余约 ${days} 天\n`);
	if (credential.expiresAtMs > 0) {
		process.stdout.write(`  expires ${new Date(credential.expiresAtMs).toISOString()}\n`);
	}
	if (credential.refreshExpiresAtMs) {
		process.stdout.write(`refreshToken 到期 ${new Date(credential.refreshExpiresAtMs).toISOString()}\n`);
	}
	process.stdout.write("\n⚠️  这个文件等同于账号密码，别提交进 git、别传群、别放公开网盘。\n");
}

try {
	main();
} catch (error) {
	process.stdout.write(`FAILED: ${error && error.message ? error.message : String(error)}\n`);
	if (error && /linkedBinding/.test(String(error.message))) {
		process.stdout.write(
			"\n提示：这个脚本必须用 WorkBuddy 自己的 Electron 跑，并且设置 ELECTRON_RUN_AS_NODE=1。\n"
			+ "直接双击或用系统 node 跑都会报错。\n",
		);
	}
	process.exitCode = 1;
}
