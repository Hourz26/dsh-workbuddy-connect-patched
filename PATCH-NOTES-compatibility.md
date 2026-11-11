# Compatibility: peer range widening

把 6 个 `@deepseek-ai/dsh-*` peer 从精确版本改成范围。

## 改了什么

```diff
 "peerDependencies": {
-  "@deepseek-ai/dsh-attachment": "0.2.1-rc.2",
-  "@deepseek-ai/dsh-home-paths": "0.2.1-rc.2",
-  "@deepseek-ai/dsh-host-webserver": "0.2.1-rc.2",
-  "@deepseek-ai/dsh-llm": "0.2.1-rc.2",
-  "@deepseek-ai/dsh-llm-pi-ai": "0.2.1-rc.2",
-  "@deepseek-ai/dsh-settings": "0.2.1-rc.2",
+  "@deepseek-ai/dsh-attachment": ">=0.2.1-rc.2 <0.3.0",
+  "@deepseek-ai/dsh-home-paths": ">=0.2.1-rc.2 <0.3.0",
+  "@deepseek-ai/dsh-host-webserver": ">=0.2.1-rc.2 <0.3.0",
+  "@deepseek-ai/dsh-llm": ">=0.2.1-rc.2 <0.3.0",
+  "@deepseek-ai/dsh-llm-pi-ai": ">=0.2.1-rc.2 <0.3.0",
+  "@deepseek-ai/dsh-settings": ">=0.2.1-rc.2 <0.3.0",
 }
```

`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`react` 不动。

## 为什么

DSH 内核从 `0.2.1-rc.2` 升到 `0.2.2-rc.1` 之后，插件的模型就从列表里
**整个消失了**，日志里一行都不提。原因在宿主侧的兼容性检查：

`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`

```js
// :1097-1117
function unmetRequirements(fields, runtimeVersion) {
  // 有 engines.dsh 就只看它；否则只校验 peerDependencies 里的
  // @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 包
}
// :1129-1144
function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion()) {
  // 有不满足的要求就返回 { name, version, runtimeVersion, requirements, exempted }
}
// :1795-1832 主循环
const issue = evaluatePluginCompatibility(bundleManifest, exemptions);
if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue));
// catch 里只 push 到 skippedBundles
```

`skippedBundles` 只写 stderr，**不上升成启动错误**，所以 DSH 照常起来，
只是模型没了。这就是「消失但无日志」的机制。

改成范围之后 `unmetRequirements` 永远返回空，不需要豁免文件，
也免疫后续的小版本升级。

## 为什么上界是 `<0.3.0`

`<0.3.0` 是一道安全阀：真到了大版本跃迁时，仍然会被拦下来并给出警告，
而不是盲目加载一个可能已经改了内部 API 的插件。

## 副作用

- 内核 `0.2.2-rc.1` 上实测可加载（19 个 bundle 全部 OK）
- 不再需要 `~/.dsh/profiles/desktop/compatibility.json` 里的豁免条目
- **pnpm 重装插件会覆盖这个改动**，重装后需要重新应用

## 重装后怎么恢复

```powershell
node C:\Users\Hourz26\.dsh\workbuddy-doctor\doctor.mjs
```

或者手工改回范围。
