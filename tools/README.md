# tools/

本目录放的是**给已安装的插件打补丁/体检**的脚本，不是插件运行时的一部分。

---

## doctor.mjs

一键自愈脚本。做四件事，全部幂等，重复跑无副作用：

| 步骤 | 做什么 | 修不好会怎样 |
|---|---|---|
| 1. `cleanOrphanLinks()` | 清掉 `@deepseek-ai/` 下指向已卸载旧安装的断链 junction | 依赖解析失败，插件 import 不起来 |
| 2. `healDependencies()` | 检查 10 个运行时依赖，缺了从 `app.asar` 解包 | 同上 |
| 3. `healCompatibility()` | 把 6 个 peer 从精确 pin 改成 `>=0.2.1-rc.2 <0.3.0`，并登记 `compatibility.json` | 内核小版本一升，插件被静默跳过，模型分组消失 |
| 4. `healRequestPatch()` | 给 `lib/host-heartbeat-*.js` 打上 `WB_PATCH_V7` | 上游 `400 / 11128 请求被拦截` 或 `500 / 11134` |

### 用法

```sh
# 体检，只读，不写任何文件
node doctor.mjs --check

# 修复
node doctor.mjs

# 指定 profile（默认 desktop）
node doctor.mjs --profile web
```

修完必须**彻底退出 DSH 再重开**——已经加载进主进程的模块不会热更新。

### 它怎么定位要打补丁的文件

**不写死文件名。** 按下面四个条件筛 `lib/` 下的候选：

1. 名字匹配 `host-heartbeat-*.js`
2. 不含 `.bak` / `.orphan` 后缀
3. 内容里含 `function prepareCnChatBody(source)`
4. 体积降序取最大的

因为文件名里的 hash（`host-heartbeat-SJaZ33tR.js` 的 `SJaZ33tR`）是打包产物，
插件升级或 `pnpm` 重装后会变，写死必然失效。

### 它怎么处理版本升降级

补丁有历史版本（V3~V7）。遇到旧标记时**不能直接往上叠**——新块里声明的
`const WORKSPACE_ROOT_PATTERN` 等会和旧块重复，`SyntaxError: Identifier ... has already been declared`。

所以走「先剥后加」：

1. `stripPatchBlock()` 把旧补丁整块剥掉，还原成干净基线；
2. 再在干净基线里按锚点插入新块。

历史上补丁有两种摆放方式，两种都要能拆：

- **集中式**（V7）：`MARK` 到 `applyClientPatches` 结束是一整块；
- **分散式**（V6 及更早）：身份补丁单独一段放在 `prepareChatBody` 后面，其余在 `MARK` 块里。
  只拆 `MARK` 块会留下前缀那份的 `const`，和新块撞名。

剥离失败时会兜底去找真正干净的原版备份（`.bak-doctor-original` /
`.bak-original-0.7.9`），并且**只在文件本身没被污染时才写这个备份**——
否则会把带补丁的文件当原版存下来，下次拿它重建就叠出两个补丁块。

### 依赖它的行为

- 需要能读到 `app.asar`（自动扫 `%LOCALAPPDATA%\Programs\*\resources\app.asar`，取最新的）
- 需要 `dsh-app-boot` 的 `package.json` 来读内核版本，决定 `compatibility.json` 登记什么
- `probeImport()` 会真的 `import()` 一次插件，确认导出符号数正常（期望 68）
