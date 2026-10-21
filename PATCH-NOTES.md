# 渠道身份改写补丁（channel-identity-fix）

> 这是对 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) `v0.7.9` 的一个本地补丁，用于绕开 2026-10-20 起腾讯云助手网关新增的渠道校验。
> 上游已标记 deprecated 且停止维护，所以以 fork + 补丁的形式留存。

## 现象

2026-10-20 傍晚起，`copilot.tencent.com/v2/chat/completions` 开始返回：

```
HTTP 400
{"message":"workbuddy upstream client (http 400): 请求被拦截，请重新发送",
 "type":"client","code":"****"}
```

DSH 侧归类为 `INVALID_REQUEST`（不在重试白名单，整轮直接失败）。日志位置：

```
%APPDATA%\DSH Desktop\logs\host\dsh-YYYY-MM-DD.error.log
```

清理积分、登录态、网络、限流都无效；换模型、开新会话同样失败。

## 真因

网关对请求体做**系统提示词指纹校验**。若首条 `system` / `developer` 消息以 DSH 的固定开场白

```
You are an AI agent powered by DeepSeek Harness.
```

开头，就判定为「非官方渠道」并拒绝：

```
code 11128 / msg: Illegal API invocation from an unapproved channel
displayMsg.zh: 请求被拦截，请重新发送
displayTips.zh: 这次调用没通过渠道校验，可能不是官方客户端发出的。
```

实测边界（每一条都验过）：

| 请求形态 | 结果 |
|---|---|
| 首条 system 以该句开头（string） | 400 |
| 首条 system 以该句开头（`[{type:"text",...}]` 数组） | 400 |
| 该句前有普通文字 | 200 |
| 该句出现在更靠后的 system 消息 | 200 |
| 该句只出现在 user 消息里 | 200 |
| 换成中性开场白 | 200，流式正常 |

注意最后一条推论：长会话里 DSH 会因为提示词变化**重发多个 system 消息**，所以必须**逐个改写**，只改第一条仍然是 400。

## 补丁内容

文件：`lib/host-heartbeat-SJaZ33tR.js`（183389 字节 / v0.7.9）

```js
const CHANNEL_IDENTITY_PATTERN =
  /^[\s\uFEFF]*You are an?(?: AI)?(?: coding)? agent powered by [^.\n]{1,60}Harness\.?/iu;
const NEUTRAL_IDENTITY = "You are an AI agent.";

/** 把单行文本里的身份句替换成中性开场白 */
function rewriteChannelIdentityLine(text) { /* ... */ }

/**
 * 遍历 messages，对 role 为 system / developer 的消息做身份改写。
 * 同时覆盖 content 为 string 和 [{type:"text", text}] 数组两种形态。
 */
function neutralizeChannelIdentity(obj) { /* ... */ }
```

挂载点：

- `prepareChatBody()`：`normalizeDeveloperRole(obj);` **之后**
- `prepareCnChatBody()`：`dropUnsupportedEffort(body);` **之后**

两处都要挂，因为国际版走前一个、CN 版走后一个。只做字符串匹配是不够的——数组形态的 `content` 也要处理，否则某些客户端拼装方式下依旧 400。

完整 diff 见 `channel-identity-fix.patch`。

## 应用方式

### 直接用本仓库的 `lib/`（推荐）

```bash
# 先把补丁后的文件覆盖进已安装的插件目录
cp lib/host-heartbeat-SJaZ33tR.js \
   ~/.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect/lib/
```

然后重启 DSH。

### 自己重新打（上游升级后）

```bash
python tools/patch_wb_channel.py            # 幂等，检测到已有补丁会跳过
python tools/verify_wb_channel.py           # node --check + 6 条行为测试
```

（两个脚本在 `qqbot` 仓库的 `tools/` 目录。）

## 验证

`verify_wb_channel.py` 的 6 条用例：

```
PASS  system opener rewritten
PASS  prose-prefixed untouched
PASS  user msg untouched
PASS  array form rewritten
PASS  developer rewritten
PASS  neutral untouched
```

## ⚠️ 可持续性警告

这是典型的猫鼠游戏：

- 腾讯已开始用**系统提示词指纹**识别第三方客户端，后续可能换别的指纹（UA、header 组合、token 绑定、请求体字段顺序）。
- 上游作者已停止维护（npm 标记 deprecated），这个 PR 不会合并进正式版。
- 每次 `dsh plugin add/update` 都会覆盖 `lib/`，**补丁会失效**，需要重跑。

长期方案只有两个：用官方客户端，或换一个不依赖腾讯网关的模型供应商。

## 上游信息

- 仓库：`https://github.com/corrinehu/dsh-workbuddy-connect`
- 版本：`0.7.9`（本 fork 基线）
- License：MIT（Copyright (c) 2026 Corrine Hu），本 fork 沿用同一许可

---

## Second pass: `identity-everywhere-fix.patch` (2026-10-21 17:40)

The prefix patch above only rewrites the identity line when it **starts** the
system content. In practice the harness renders a greeting ahead of it (an
afternoon greeting, a user opening sentence), so the line lands mid-prompt and
the whole turn still returns `400 / 11128`. See
`PATCH-NOTES-identity-everywhere.md` for the measurements; the fix adds a
second, position-independent pass. Both patches are applied to the shipped
`lib/host-heartbeat-SJaZ33tR.js` here.
