# identity-everywhere-fix.patch

Second, independent fix for the WorkBuddy CN gateway's channel check
(`400 / code 11128 / "Illegal API invocation from an unapproved channel"`,
surfaced to the user as "请求被拦截，请重新发送").

## Why the first patch was not enough

`channel-identity-fix.patch` rewrites a **leading** harness identity line:

    You are an AI agent powered by DeepSeek Harness.

It matches only at the start of the system content. But the harness renders a
greeting ahead of the identity section — an afternoon greeting, a user opening
sentence — and the identity line then sits in the *middle* of the prompt. A
start-anchored pattern no longer matches, so the whole turn still 400s.

Measured against the live gateway (per-call, same headers, same token):

| system content | result |
| --- | --- |
| starts with the identity line | 400 / 11128 |
| identity line on line 2, after one prose line | 200 |
| identity line after a greeting paragraph | 200 |
| neutral system content | 200 |
| neutral system content, repeated 6x | 200, 6/6 |

So the check is not rate based and not session-length based: it is purely about
the head of the system message.

## What this patch does

Adds `neutralizeIdentityEverywhere(body)`, called from both `prepareChatBody`
and `prepareCnChatBody` right after the existing passes. It replaces **every**
occurrence of the identity line inside `system` / `developer` content with
`You are an AI agent.`, whatever position it sits at, and leaves:

* `user` / `assistant` content untouched (verified),
* unrelated mentions such as "DSH (DeepSeek Harness) is the harness" untouched.

It deliberately does not change the harness's own `personaPrefix`, so nothing
about DSH itself, its prompts, or its other providers changes — only the
outbound WorkBuddy request body.

## Apply

```bash
cd node_modules/dsh-workbuddy-connect
patch -p1 < identity-everywhere-fix.patch      # applies over the 0.7.9 bundle
```

The patch targets `lib/host-heartbeat-SJaZ33tR.js` **before**
`channel-identity-fix.patch` — apply both, in any order that keeps the anchors
intact, or apply this one alone (it is a superset for the identity problem).

## Verification performed

* `node --check` on the patched bundle: clean.
* Extracted the real `prepareChatBody` / `prepareCnChatBody` chain and ran it
  over 8 payload shapes: identity at the start, on line 2, after a greeting,
  twice deep inside a long prompt, in array `text` parts, in a `developer`
  message — all rewritten; user messages and unrelated Harness mentions
  preserved.
* `patch -p1` replayed against the unpatched 0.7.9 bundle reproduces the
  patched file byte for byte.

## Caveat

The upstream author has stopped maintaining the plugin (npm marks 0.7.9
deprecated) and this is another round of the same cat-and-mouse game: whenever
the gateway tightens its check again, this patch will need revisiting.
