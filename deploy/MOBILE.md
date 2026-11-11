# 部署到手机（DSH Go）

这个教程把 WorkBuddy 模型接到手机上运行的 DSH Go。全程两条路，按你的情况选一条。

---

## 先搞清楚一件事：手机上没有 WorkBuddy

插件在电脑上能工作，是因为它能直接解密 **WorkBuddy 桌面 App** 的登录凭据。
手机上装不了 WorkBuddy 桌面 App，所以这份凭据**解不出来**——必须先在电脑上导出，
再拷到手机上。

这件事没法绕过，所以两条路都要求：**先有一台登录了 WorkBuddy 的 Windows / macOS 电脑**。

---

## 路线 A：手机里已有 dsh 命令（推荐）

适用：你能打开 DSH Go 的终端，`dsh --version` 有输出。

### 第 1 步：在电脑上导出凭据

1. 确认 WorkBuddy 桌面 App 已登录，且能正常聊天。
2. 找到 WorkBuddy 的安装位置：

   ```powershell
   # Windows
   (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                     'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' `
     -ErrorAction SilentlyContinue |
     Where-Object { $_.DisplayName -like 'WorkBuddy*' }).DisplayIcon
   ```

   会输出类似 `D:\Apps\WorkBuddy\WorkBuddy.exe,0` 的内容，前面那截就是路径。

3. 在一个空目录里下载 `export-own.js`（本仓库 `deploy/export-own.js`），然后执行：

   ```powershell
   cd D:\某个空目录
   curl.exe -L -o export-own.js https://raw.githubusercontent.com/Hourz26/dsh-workbuddy-connect-patched/main/deploy/export-own.js

   set ELECTRON_RUN_AS_NODE=1
   set "WORKBUDDY_ELECTRON_BIN=D:\Apps\WorkBuddy\WorkBuddy.exe"
   "%WORKBUDDY_ELECTRON_BIN%" export-own.js
   ```

   成功时会打印：

   ```
   wrote D:\某个空目录\workbuddy-auth.json (3247 bytes)
   accessToken  剩余约 30 天
   ```

   > ⚠️ **必须用 WorkBuddy 自己的 WorkBuddy.exe 跑**，不能双击、不能用系统 node。
   > 脚本要用 App 内部的解密接口，系统 node 没有。
   >
   > ⚠️ 产出的 `workbuddy-auth.json` 里是明文 token，等同于账号密码。

### 第 2 步：把凭据文件传到手机

文件名必须是 `.workbuddy-auth.json`（开头一个点），放在 `$DSH_HOME` 里，
默认就是 `~/.dsh/`。

**方式一：ADB（安卓，电脑连 USB）**

```sh
adb push workbuddy-auth.json /sdcard/Download/
```

然后在手机的 DSH Go 终端里：

```sh
mkdir -p ~/.dsh
cp /sdcard/Download/workbuddy-auth.json ~/.dsh/.workbuddy-auth.json
chmod 600 ~/.dsh/.workbuddy-auth.json
```

**方式二：SSH（电脑和手机同网）**

先在电脑上：

```powershell
scp workbuddy-auth.json <用户名>@<手机IP>:~/.dsh/.workbuddy-auth.json
```

**方式三：贴 base64（最不依赖工具）**

在电脑上生成一段 base64：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("workbuddy-auth.json")) | Set-Clipboard
```

然后在手机的 DSH Go 终端里粘贴：

```sh
mkdir -p ~/.dsh
base64 -d > ~/.dsh/.workbuddy-auth.json <<'WBEOF'
把刚才复制的 base64 整段粘在这里
WBEOF
chmod 600 ~/.dsh/.workbuddy-auth.json
```

### 第 3 步：确认文件就位

```sh
ls -l ~/.dsh/.workbuddy-auth.json
head -c 100 ~/.dsh/.workbuddy-auth.json
```

第二条应该输出类似：

```json
{"version":1,"credential":{"accessToken":"eyJhbGci...
```

有 `accessToken` 就对了。

### 第 4 步：装插件

```sh
dsh plugin --profile web add github:Hourz26/dsh-workbuddy-connect-patched
```

装完后**彻底退出 DSH Go**——不是刷新页面，是在系统里把进程杀掉重开。

### 第 5 步：验证

1. 打开 DSH Go，模型选择器里应该出现 **WorkBuddy** 分组
2. 从分组里选一个模型，发一句话，能正常回复
3. 想确认插件状态：

   ```sh
   dsh plugin --profile web exec dsh-workbuddy-connect status
   ```

---

## 路线 B：手机里没有 dsh 命令

适用：DSH Go 只在 App 界面里操作，给不了终端。

这种情况只能走「预先打好补丁的插件目录替换」。等本仓库的 `deploy/stage/`
打包好后，按 `deploy/stage/README-安装说明.md` 走：用一个带 shell 的终端
（Termux，或 DSH Go 自带的「设置 › 本机引擎 › 终端」）跑 `install.sh`。

如果这两条路都走不通，把 DSH Go 的版本号和 App 内的设置菜单截图发 issue，
我们再想办法。

---

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `no signed-in WorkBuddy account found` | 凭据文件不在这儿或名字不对 | 确认路径是 `~/.dsh/.workbuddy-auth.json`（有点） |
| `the desktop auth file ... is unreadable` | 设了 `WORKBUDDY_AUTH_FILE` 但指向坏文件 | `unset WORKBUDDY_AUTH_FILE`，或让它指向上面的文件 |
| 模型分组不出现 | 没真正重启 App，或凭据没读到 | 先 `dsh plugin --profile web exec dsh-workbuddy-connect status` 看状态 |
| 回复报 401 / token invalid | accessToken 过期且续期失败 | 回电脑重跑第 1 步，覆盖一次 |
| 回复报 `请求被拦截，请重新发送` | 装的是 **npm 原版**，没有本仓库的补丁 | 卸载重装，确认 spec 是 `github:Hourz26/...` 而不是 `@0.7.9` |
| 回复报 `the model provider is temporarily unavailable` | 同上，max_tokens 没被压到 128000 | 同上 |
| 插件加载失败 / DSH 起不来 | 内核版本不匹配 | 见下面「版本对应」 |

---

## 版本对应

本 fork 的 `peerDependencies` 放宽成了 `>=0.2.1-rc.2 <0.3.0`，所以：

| DSH Go 内核 | 能不能用 |
|---|---|
| `0.2.0.x` 及更早 | 不能，会因 peer 不满足被跳过 |
| `0.2.1-rc.1` ~ `0.2.2.x` | 可以 |
| `0.3.0` 及以后 | 会被挡住（安全阀，防止跨大版本静默出错） |

查内核版本：

```sh
dsh --version
```

如果输出的是 `0.2.2-rc.1` 这类，就在范围内。

---

## token 寿命

- accessToken 约 **30 天**
- refreshToken 约 **60 天**

插件会在 accessToken 快过期时自动用 refreshToken 换新的，并写回
`~/.dsh/.workbuddy-auth.json`。所以：

- **这个文件必须可写**，别设成只读、别放到只读挂载点
- refreshToken 也过期后只能回电脑重新导一次——手机上没法自己续，
  因为续期需要 WorkBuddy 桌面端的 Electron 二进制

---

## 一条限制先说清楚

这条通道**不返回思维链**。上游返回的 delta 里只有 `role` 和 `content`，
`reasoning: { effort: "high" }` 传了也没用。所以手机上能正常用模型，
但看不到「思考过程」。
