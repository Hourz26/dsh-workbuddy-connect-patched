# 部署到电脑（DSH Desktop / Web / TUI）

本教程适用于 Windows、macOS、Linux。三条路按你的 DSH 形态选。

---

## 前置条件

1. 已经安装并**登录** WorkBuddy（国内版）或 WorkBuddy AI 桌面 App，且能正常聊天
2. 有 DSH 可用（Desktop 版 / Web 版 / TUI 版都行）
3. 插件复用 App 的登录状态，所以**桌面 App 必须先装好**——手机端除外，见 [MOBILE.md](./MOBILE.md)

---

## 先看你的 DSH 内核版本

```sh
dsh --version
```

输出类似 `0.2.2-rc.1`。本 fork 的 peer 范围是 `>=0.2.1-rc.2 <0.3.0`：

| 内核版本 | 结果 |
|---|---|
| `0.2.0.x` 及更早 | 会被跳过，不加载 |
| `0.2.1-rc.1` ~ `0.2.2.x` | 正常 |
| `0.3.0` 及以后 | 会被挡住（安全阀） |

---

## 路线 A：DSH Web / TUI（有 dsh 命令）

### 装

```sh
dsh plugin --profile web add github:Hourz26/dsh-workbuddy-connect-patched
```

TUI 换成 `--profile dsh-tui`。

> 不要用 `dsh plugin add dsh-workbuddy-connect@0.7.9`。那是 npm 原版，
> **不带本仓库的三套补丁**，2026-10 之后的腾讯网关会拒掉它。

### 重启

彻底退出再重开（不是刷新页面）。

```sh
dsh web          # 或 dsh --profile dsh-tui
```

### 验

模型选择器里出现 **WorkBuddy** 分组，选一个模型发一句话能回。

---

## 路线 B：DSH Desktop（DSH NEXT 这类桌面版）

桌面版的 profile 由 App 管理，独立 CLI 的 `--profile desktop` 会被拒绝，各发行版规则不同。

### 先确认你的桌面版属于哪种

打开 App，看有没有插件管理界面：

- **有插件管理界面**：直接在界面里装，spec 填
  `github:Hourz26/dsh-workbuddy-connect-patched`
- **没有**：看下面

### 手工装进桌面版 profile

桌面版的 profile 目录一般是 `~/.dsh/profiles/desktop/`（Windows 是
`C:\Users\<你>\.dsh\profiles\desktop\`）。

在**已经装了本插件**的前提下，把补丁版 `lib/` 覆盖进去：

```sh
# 1) 先让桌面版自己装一遍原版（建立目录和依赖）
#    在 App 的插件界面里装 dsh-workbuddy-connect@0.7.9，或者用 App 自带的命令

# 2) 用本仓库的 lib 覆盖
PLUGIN_DIR="$HOME/.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect"
cp -a "$PLUGIN_DIR" "$PLUGIN_DIR.bak-$(date +%Y%m%d%H%M%S)"
git clone https://github.com/Hourz26/dsh-workbuddy-connect-patched.git /tmp/wbc
cp -a /tmp/wbc/lib/. "$PLUGIN_DIR/lib/"

# 3) 放宽 peer 范围（否则内核升级后会被静默跳过）
node -e '
const fs=require("node:fs");
const p=process.argv[1]+"/package.json";
const j=JSON.parse(fs.readFileSync(p,"utf8"));
for (const k of Object.keys(j.peerDependencies)) {
  if (k.startsWith("@deepseek-ai/dsh")) j.peerDependencies[k]=">=0.2.1-rc.2 <0.3.0";
}
fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
' "$PLUGIN_DIR"

# 4) 验证补丁在不在
grep -c "WB_PATCH" "$PLUGIN_DIR"/lib/host-heartbeat-*.js
grep -c "applyClientPatches" "$PLUGIN_DIR"/lib/host-heartbeat-*.js
```

两条 `grep` 都要有输出且不为 0。

### 重启

桌面版必须**完全退出**——包括托盘图标，然后重新打开。

---

## 路线 C：本机已有 Agent，让它替你装

把下面这段原样发给任何有终端和文件权限的助手（DSH Agent、Codex、Claude Code、Cursor 都行）：

```text
请帮我安装并验证 DSH 插件，来源是 https://github.com/Hourz26/dsh-workbuddy-connect-patched

步骤要求：
1. 先运行 dsh --version，确认内核版本落在 >=0.2.1-rc.2 <0.3.0 这个区间；
2. 确认我实际使用的是 Desktop / Web / TUI 哪种形态，桌面版以 App 内置核心为准，
   不要用独立 CLI 的版本号代替；
3. 用 dsh plugin --profile <对应 profile> add github:Hourz26/dsh-workbuddy-connect-patched 安装；
   如果桌面版的 profile 由 App 管理、拒绝独立 CLI，请如实报告并改为在 App 的插件界面里装；
4. 任何本地文件或配置改动，先征得我同意并做好备份；
5. 装完 grep 一下 lib/host-heartbeat-*.js 里有没有 WB_PATCH 和 applyClientPatches 标记，
   确认补丁确实在；如果 lib 里没有这些标记，说明装成了 npm 原版，需要重来；
6. 最后重启对应界面，验证模型选择器里出现 WorkBuddy 分组，并陪我完成一次简短对话；
7. 如果报 请求被拦截 / 请求被拦截，请重新发送 或 the model provider is temporarily unavailable，
   说明补丁没生效，不要绕过，如实告诉我装的是哪个包。
```

---

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 模型选择器里压根没有 WorkBuddy 分组 | 内核版本不在 peer 范围内，插件被静默跳过 | `dsh --version` 查版本；日志里搜 `skipping profile bundle` |
| 有分组但一发就报 `请求被拦截，请重新发送` | 装的是 npm 原版，没有 channel-identity 补丁 | 卸载重装，确认 spec 是 `github:Hourz26/...` |
| 有分组但报 `the model provider is temporarily unavailable` | max_tokens 超过上游上限（128000） | 同上，确认 `clampWorkbuddyMaxTokens` 在 `lib/` 里 |
| `no signed-in WorkBuddy account found` | WorkBuddy 桌面 App 没装或没登录 | 装好并登录 App，重启 DSH |
| `the desktop auth file ... is unreadable` | App 的加密凭据读不了 | 重新登录 WorkBuddy App；或手动导出后用 `WORKBUDDY_AUTH_FILE` 指过去 |
| 重装插件后又不工作了 | pnpm 重装覆盖了 `lib/`，补丁丢失 | 重跑路线 B 的第 2、3、4 步 |

---

## 补丁为什么会丢

这是猫鼠游戏的现实。`dsh plugin add` / pnpm install / 桌面版升级，都可能把
`lib/` 整个重写回 npm 原版。

三条自查命令：
```sh
grep -c "WB_PATCH" ~/.dsh/profiles/*/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-*.js
grep -c "applyClientPatches" ~/.dsh/profiles/*/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-*.js
grep -c "clampWorkbuddyMaxTokens" ~/.dsh/profiles/*/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-*.js
```

三个数字都不为 0 才正常。补丁细节见 `PATCH-NOTES*.md`。

---

## 验证成功的样子

1. 模型选择器里出现 **WorkBuddy** 分组，里面有 `DeepSeek-V4.1-Flash` 等模型
2. 选一个发「你好」，能正常回复
3. 再发一个需要长输出的请求（比如「写个 500 字的短文」），也能正常回来

第 3 条特别重要——很多 400 / 500 只在生成长内容时才触发。
