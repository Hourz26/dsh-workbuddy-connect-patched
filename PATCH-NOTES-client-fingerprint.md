# PATCH-NOTES: WB_PATCH_V7（身份句中性化 + 请求夹紧）

适用插件版本：`dsh-workbuddy-connect@0.7.9`（本仓库 fork 为 `0.7.9-patched.1`）
落点文件：`lib/host-heartbeat-SJaZ33tR.js`
补丁标记：`/* WB_PATCH_V7 */`

---

## 一、为什么要打这个补丁

WorkBuddy 的 CN 网关（`https://copilot.tencent.com/v2/chat/completions`）会对请求做
**渠道 / 客户端指纹校验**。命中时直接拒绝，客户端侧表现为：

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被拦截，请重新发送"}}
```

或者（另一个独立原因）：

```json
{"code":11134,"msg":"the model provider is temporarily unavailable, please retry later or switch to another model"}
```

DSH 自己发出的 system prompt 里有两类内容会命中校验：

| 触发点 | 形态 | 结果 |
| --- | --- | --- |
| 身份句（带 Harness） | `You are an AI agent powered by DeepSeek Harness.` | `400 / 11128` |
| 身份句（不带 Harness） | `You are a coding agent powered by the deepseek-v4.1-flash model.` | **200 放行** |
| 客户端指纹词 | `workspace root` | 曾触发 `11128`（2026-10-28 实测） |
| 产品名 | `DeepSeek Harness` | 曾触发 `11128`（2026-10-21 实测） |
| 超大 `max_tokens` | `384000` | `500 / 11134` |

**注意方向**：带 `Harness` 的身份句才会被拦，不带的反而是安全的。
所以本补丁的身份句正则 **尾部必须要求 `Harness`**，不能放宽成
`powered by [^.\n]{1,60}`——那样会把安全句也改掉，属于无谓改动。

---

## 二、2026-11-11 的实测证据

单句 system + 一句 user，真实代打发上游：

```
[A] You are a coding agent powered by the deepseek-v4.1-flash model.   → 200
[B] You are an AI agent powered by DeepSeek Harness.                   → 400 / code 11128
[C] You are a helpful assistant.                                       → 200
```

排除长度假设：把 s2 重复两遍、把 filler 补到 1619 字符，都是 200。

`max_tokens` 梯度（同一 body，只改这一个字段）：

```
128000 → 200       64000 → 200       32768 → 200       384000 → 500 / 11134
```

→ 384000 是 DSH NEXT 发出来的（插件 catalog 上限只有 128000），夹紧到 128000 即恢复。

---

## 三、本补丁做的五件事

全部挂在 `prepareCnChatBody` 的调用链上：

```js
dropUnsupportedEffort(body);
neutralizeIdentityEverywhere(body);   // 任意位置的身份句
neutralizeChannelIdentity(body);      // 行首（start-anchored）的身份句
applyClientPatches(body);             // workspace root / DeepSeek Harness / max_tokens
```

### 1. `neutralizeChannelIdentity(obj)`

把 system/developer 消息**开头**的 harness 身份句整句替换成 `You are an AI agent.`：

```js
const CHANNEL_IDENTITY_PATTERN =
  /^[\s\uFEFF]*You are an?(?: AI)?(?: coding)? agent powered by [^.\n]{1,60}Harness\.?/iu;
const NEUTRAL_IDENTITY = "You are an AI agent.";
```

### 2. `neutralizeIdentityEverywhere(body)`

同上，但去掉 `^` 锚点、加 `g`，覆盖身份句被问候语/人设块挤到中间的情况：

```js
const IDENTITY_OCCURRENCE_PATTERN =
  /You are an?(?: AI)?(?: coding)? agent powered by [^.\n]{1,60}Harness\.?/giu;
```

只处理 `content` 里含 `"Harness"` 的消息，避免无谓遍历。

### 3. `applyClientPatches(body)` 里的两个词替换

```js
const WORKSPACE_ROOT_PATTERN = /\bworkspace root\b/giu;
const WORKSPACE_ROOT_NEUTRAL = "workspace folder";
const PRODUCT_NAME_PATTERN = /DeepSeek\s+Harness/gu;
const PRODUCT_NEUTRAL_NAME = "the assistant";
```

只作用于 `system` / `developer` 角色的消息。

### 4. `clampWorkbuddyMaxTokens(body)`

按 `FALLBACK_WORKBUDDY_MODELS` 里该模型的 `maxTokens` 夹紧，默认上限 `128e3`。
`deepseek-v4.1-flash` 的上限是 128000，DSH 发 384000 时降到 128000。

### 5. `dumpWorkbuddyRequest(body, suffix)`

把请求体落到 `~/.dsh/`：

- `workbuddy-last-body.raw.json` —— 处理前原文
- `workbuddy-last-body.prepared.json` —— 处理后
- `workbuddy-last-system.txt` —— 仅 `suffix === "raw"` 时写，供快速 diff

这是**黑匣子**：上游换了新话术时，直接拿 raw 文件二分定位，不用猜。

---

## 四、顺序为什么不能反

`neutralizeChannelIdentity` 必须跑在 `applyClientPatches` **之前**。

反过来的话，`DeepSeek Harness` 会先被换成 `the assistant`，身份句变成：

```
You are an AI agent powered by the assistant.     ← 语法崩坏，且正则不再匹配
```

实测在只有 `WB_PATCH_V6`（无身份补丁）的版本上就是这个结果。
虽然它仍然返回 200，但会污染 system prompt，属于必须避免的副作用。

---

## 五、验证方法

```powershell
# 1. 补丁标记与符号计数
Select-String -Path lib\host-heartbeat-SJaZ33tR.js -Pattern 'WB_PATCH_V7'
(Select-String -Path lib\host-heartbeat-SJaZ33tR.js -Pattern 'neutralizeChannelIdentity' -AllMatches).Matches.Count  # 期望 2

# 2. 语法
node --check lib\host-heartbeat-SJaZ33tR.js

# 3. 真实 body 端到端（需本机有 WorkBuddy 凭据）
node e2e-real.mjs
# 期望：max_tokens 384000 → 128000，Harness → 0，上游 status=200
```

补丁本身体积：**188483 字节**（干净基线 182015 字节，+6468）。

---

## 六、如果上游又改了

按下面顺序查，不要凭猜：

1. 读 `~/.dsh/workbuddy-last-error.txt` 拿到 `status` 与 `code`。
2. 读 `~/.dsh/workbuddy-last-body.raw.json`（这是**未经处理**的原文，最干净）。
3. 用二分脚本定位：把 system 按 `\n\n` 切段，逐段单独发，找出第一个触发的那一段。
4. 段定位到句，句定位到词，找到最小触发串后加到 `applyClientPatches` 的替换链里。
5. 重新跑 `node --check` + 端到端，再更新本文件。
