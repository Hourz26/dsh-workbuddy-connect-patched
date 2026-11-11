# Client-fingerprint fix (WB_PATCH_V6)

一个针对 **上游渠道校验** 的补丁：修好 `prepareCnChatBody` 在发请求前
对 body 做的三件事 —— 关键词中性化、`max_tokens` 夹紧、请求体落盘。

## 为什么需要它

上游（`copilot.tencent.com/v2/chat/completions`）会对请求做客户端指纹校验，
命中时返回的不是参数校验错误，而是：

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被拦截，请重新发送"}}
```

以及 `max_tokens` 超过模型上限时的：

```json
{"code":11134,"msg":"the model provider is temporarily unavailable ..."}
```

这两种都表现为「模型不可用」，从 UI 上看不出真因，只能靠请求体二分才能定位。

## 三处改动

| 改动 | 作用 |
|---|---|
| `workspace root` → `workspace folder` | 躲开旧指纹规则（`\bworkspace root\b`，正则大小写不敏感） |
| `DeepSeek Harness` → `the assistant` | 同上 |
| `max_tokens` 按目录上限夹紧 | 上游对超限的响应是 500/11134 而不是 400 |

### max_tokens 夹紧的细节

DSH NEXT 会发出 `max_tokens: 384000`（= 目录上限 128000 × 3），
上游直接以 500/11134 拒绝。补丁按 `FALLBACK_WORKBUDDY_MODELS` 里该模型
的 `maxTokens` 夹紧，查不到时退回 128000。

实测（`deepseek-v4.1-flash`）：

```
max_tokens=384000 → 500 code=11134
max_tokens=128000 → 200
max_tokens=64000  → 200
max_tokens=32768  → 200
```

### 黑匣子

`applyClientPatches()` 会把请求体落两份：

- `~/.dsh/workbuddy-last-body.raw.json` —— **替换前**（上游真正收到之前的原样）
- `~/.dsh/workbuddy-last-body.prepared.json` —— 替换后
- `~/.dsh/workbuddy-last-system.txt` —— 从 raw 里拆出的 system/developer 文本

上游再换新规则时，直接拿 raw 那份二分，不用再靠猜。

## 一个必须记住的坑

正则**不能多转义**。曾有一版写成了：

```js
const WORKSPACE_ROOT_PATTERN = /\\bworkspace root\\b/giu;   // 错：匹配字面反斜杠 + b
```

在 JS 源码里 `\\b` 是「反斜杠 + b」两个字符，不是词边界。那一版看起来
"打了补丁"，实际替换一次都没生效，而当时的验证数据恰好不含这些词，
所以没被发现。正确的写法是单反斜杠：

```js
const WORKSPACE_ROOT_PATTERN = /\bworkspace root\b/giu;
```

## 应用方式

这个仓库的 `lib/host-heartbeat-SJaZ33tR.js` **已经包含**该补丁。
下面这条只用于从其他基线合并：

```bash
git apply --check client-fingerprint-fix.patch   # 先验
git apply client-fingerprint-fix.patch
```

## 挂载点

`prepareCnChatBody` 里的调用顺序（顺序有讲究）：

```js
dropUnsupportedEffort(body);
neutralizeIdentityEverywhere(body);   // channel identity 补丁
neutralizeChannelIdentity(body);      // identity-everywhere 补丁
applyClientPatches(body);             // ← 本补丁，必须在最后
return JSON.stringify(body);
```

放最后是因为前两个 pass 可能改写 system 文本，本补丁要看到它们的产物。

## 实测验证

用一份真实 body（82 条消息 + 68 个 tools + 19536 字符 system）注入三种指纹后：

```
输入：  powered by = 2   workspace root = 2   DeepSeek Harness = 5   max_tokens = 384000
输出：  powered by = 0   workspace root = 0   DeepSeek Harness = 0   max_tokens = 128000
保留：  "You are an AI agent." = 2   "workspace folder" = 2   "the assistant" = 3
```

三套补丁（channel-identity、identity-everywhere、client-fingerprint）同时生效。

## 已知局限

`workspace root` / `DeepSeek Harness` 这两条规则是 2026-10 实测出来的，
到 2026-11 已经**不再触发** 400（往 user / tool / system 三种消息里塞回
这两个词，全部 200）。也就是说上游撤了或改了规则。

这个补丁留着不亏（能防旧规则），但**不能保证上游下次换规则时还能防住**。
真正的保障是那份 raw body 落盘 —— 出问题时能直接二分定位，不用从头猜。
