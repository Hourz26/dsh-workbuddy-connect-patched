# 一键部署

把 WorkBuddy 桌面 App 里的模型接到 DSH 上。电脑、手机都覆盖。

---

## 我该看哪份

| 你的情况 | 看这个 |
|---|---|
| 电脑上用 DSH（Desktop / Web / TUI） | [DESKTOP.md](./DESKTOP.md) |
| 手机上用 DSH Go | [MOBILE.md](./MOBILE.md) |
| 什么都不想读，想让 AI 帮你装 | [DESKTOP.md § 路线 C](./DESKTOP.md#路线-c本机已有-agent让它替你装) |

---

## 最短路径（两条命令）

### 电脑

```sh
# 0. 确认版本在范围内
dsh --version    # 需要 >=0.2.1-rc.2 且 <0.3.0

# 1. 装
dsh plugin --profile web add github:Hourz26/dsh-workbuddy-connect-patched

# 2. 彻底退出 DSH 再重开，然后看模型选择器里有没有 WorkBuddy 分组
```

> **不要装 `dsh-workbuddy-connect@0.7.9`**。那是 npm 上的原版，
> 不带本仓库的三套补丁，2026-10 之后会被腾讯网关拒掉。

### 关于退出码 1（`ERR_PNPM_IGNORED_BUILDS`）

`github:` 安装会**成功装好包，但命令返回退出码 1**，输出类似：

```
+ dsh-workbuddy-connect 0.7.9-patched.1
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @google/genai@2.21.0, protobufjs@7.6.6
```

**这是正常的，可以忽略。** 那两个被拦的构建脚本跟本插件能不能跑无关：

| 包 | 被拦的脚本 | 实际做什么 |
|---|---|---|
| `@google/genai@2.21.0` | `prepare: node scripts/prepare.js` | 该包的 tarball 里**根本没有 `scripts/` 目录**，跑了也是失败。`dist/index.mjs` 已经打包好在包里 |
| `protobufjs@7.6.6` | `postinstall: node scripts/postinstall` | 只读自己的 `package.json`、往 stderr 打一句版本兼容警告，**不改任何文件** |

只要包目录下能看到插件（见下面「验证装的到底是不是打过补丁的」），就是装好了。
如果你想让退出码也变 0，可以在 profile 的 `pnpm-workspace.yaml` 里加：

```yaml
allowBuilds:
  "@google/genai": true
  "protobufjs": true
```

但这不是必需的。

### 手机（DSH Go）

手机上没有 WorkBuddy 桌面 App，解不出凭据，所以要先在电脑上导一份：

```powershell
# 电脑上：WorkBuddy 已登录的前提下
set ELECTRON_RUN_AS_NODE=1
set "WORKBUDDY_ELECTRON_BIN=D:\Apps\WorkBuddy\WorkBuddy.exe"
"%WORKBUDDY_ELECTRON_BIN%" export-own.js
```

把产出的 `workbuddy-auth.json` 传到手机的 `~/.dsh/.workbuddy-auth.json`
（注意文件名有个点），然后在手机终端里：

```sh
dsh plugin --profile web add github:Hourz26/dsh-workbuddy-connect-patched
```

细节和传文件方式见 [MOBILE.md](./MOBILE.md)。

---

## 这个 fork 相比 npm 原版多了什么

npm 上的 `dsh-workbuddy-connect@0.7.9` 是 2026-10-19 发布的，之后上游仓库就 404 了。
2026-10 中旬起腾讯网关加了三层校验，原版会撞上：

| 补丁 | 解决什么 | 不装会怎样 |
|---|---|---|
| `channel-identity-fix` | system prompt 里的渠道身份行 | `400 / 11128 请求被拦截，请重新发送` |
| `identity-everywhere-fix` | 同上，但覆盖所有出现位置 | 同上，出现位置一变就复发 |
| `client-fingerprint-fix`（V7） | 身份句整句中性化 + `workspace root` / `DeepSeek Harness` 替换 + `max_tokens` 封顶 | `400 / 11128` 或 `500 / 11134 the model provider is temporarily unavailable` |
| peer 范围放宽 | 精确 pin `0.2.1-rc.2` 会在内核小版本升级后被静默跳过 | 模型分组直接消失，日志里只有一行 `skipping profile bundle` |

V7 起三套身份补丁已经合并成一份集中在 `WB_PATCH_V7` 块里，不再分散在两处。
每个补丁的实测边界见仓库根目录的 `PATCH-NOTES*.md`。

---

## 验证装的到底是不是打过补丁的

```sh
HB=~/.dsh/profiles/web/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-*.js

grep -c "WB_PATCH_V7"              $HB   # 期望 >= 1
grep -c "applyClientPatches"       $HB   # 期望 >= 2
grep -c "clampWorkbuddyMaxTokens"  $HB   # 期望 >= 2
grep -c "neutralizeChannelIdentity" $HB  # 期望 >= 2
```

四个数字都不为 0 = 补丁在。有任何一个是 0 = 装成了 npm 原版，必须重装。

如果看到的是 `WB_PATCH_V6`（旧版），说明装的是本仓库 2026-11-11 之前的提交，
可以执行 `dsh plugin --profile web update dsh-workbuddy-connect` 升到 V7，
或者直接跑 [`doctor.mjs`](../tools/doctor.mjs) 让它原地升级。

---

## 目录说明

```
deploy/
├── README.md        ← 你在这里
├── DESKTOP.md       电脑端部署（Desktop / Web / TUI）
├── MOBILE.md        手机端部署（DSH Go）
└── export-own.js    从 WorkBuddy 桌面 App 导出凭据的脚本
```

---

## 安全提醒

`workbuddy-auth.json` 里是**明文 accessToken 和 refreshToken**，等同于账号密码。

- 别提交进 git（本仓库 `.gitignore` 已挡）
- 别发群、别放公开网盘
- 用完可以删掉，插件会自动续期并写回，但删了就得重新导

---

## 一条硬限制

这条通道**不返回思维链**。上游返回的 delta 里只有 `role` 和 `content`，
`reasoning: { effort: "high" }` 传了也没用。能看到回答，看不到「思考过程」。
