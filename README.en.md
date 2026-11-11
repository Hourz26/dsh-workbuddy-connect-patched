# DSH WorkBuddy Connect

English | [中文](./README.md)

Brings the models available in your signed-in WorkBuddy / WorkBuddy AI desktop app into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); the two versions each show their own model group and reuse their own account sign-in and credit.

## Installation

**Prerequisite**: WorkBuddy (China edition) or the WorkBuddy AI desktop app installed and signed in on the same machine. The plugin reuses the app's login state, so switching accounts just works.

> ⚠️ **Do not install `dsh-workbuddy-connect@0.7.9`.** That is the npm original — last updated 2026-10-19, it lacks the three patches in this repo and will be rejected by Tencent's gateway (`400 / 11128` or `500 / 11134`). **Install from this repo.**

### Shortest path

```sh
# 0. Confirm the core version is >=0.2.1-rc.2 and <0.3.0
dsh --version

# 1. Install (--profile web for Web, --profile dsh-tui for TUI)
dsh plugin --profile web add github:Hourz26/dsh-workbuddy-connect-patched

# 2. Quit DSH completely and reopen (not a page refresh)
```

A **WorkBuddy** group should appear in the model picker.

### On a phone (DSH Go)

Phones cannot run the WorkBuddy desktop app, so the encrypted credential can never be opened there. Export it on your computer first:

```powershell
set ELECTRON_RUN_AS_NODE=1
set "WORKBUDDY_ELECTRON_BIN=D:\\Apps\\WorkBuddy\\WorkBuddy.exe"
"%WORKBUDDY_ELECTRON_BIN%" export-own.js
```

Copy the resulting `workbuddy-auth.json` to `~/.dsh/.workbuddy-auth.json` on the phone (note the leading dot), then run the same `dsh plugin --profile web add github:...` there.

**Full guide**: [`deploy/README.md`](./deploy/README.md) — desktop [`DESKTOP.md`](./deploy/DESKTOP.md), mobile [`MOBILE.md`](./deploy/MOBILE.md).

### Verify you actually got the patched build

```sh
grep -c "WB_PATCH"                ~/.dsh/profiles/*/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-*.js
grep -c "applyClientPatches"      ~/.dsh/profiles/*/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-*.js
grep -c "clampWorkbuddyMaxTokens" ~/.dsh/profiles/*/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-*.js
```

All three counts must be non-zero. Any zero means you installed the npm original.

### Let an existing agent do it

Hand the following to any assistant with terminal and file access (DSH Agent, Codex, Claude Code, Cursor, ...):

```text
Install and verify the DSH plugin from https://github.com/Hourz26/dsh-workbuddy-connect-patched

1. Run dsh --version first and confirm the core version is within >=0.2.1-rc.2 <0.3.0.
2. Determine whether I use Desktop / Web / TUI. For Desktop, use the version bundled in the app,
   not the standalone CLI's.
3. Install with: dsh plugin --profile <profile> add github:Hourz26/dsh-workbuddy-connect-patched
   If the desktop profile is managed by the app and rejects the standalone CLI, report that
   honestly and install through the app's own plugin UI instead.
4. Ask for my consent and take a backup before changing any local file or config.
5. After installing, grep lib/host-heartbeat-*.js for WB_PATCH and applyClientPatches to confirm
   the patches are present. If they are missing, you installed the npm original — start over.
6. Restart the UI, verify a WorkBuddy group appears in the model picker, and run a short conversation.
7. If a request fails with "请求被拦截，请重新发送" (request blocked) or "the model provider is
   temporarily unavailable", the patches did not take effect. Do not work around it — tell me
   exactly which package was installed.
```

### Version requirements

This fork widens `peerDependencies` to `>=0.2.1-rc.2 <0.3.0`:

| DSH core | Result |
|---|---|
| `0.2.0.x` and older | skipped, not loaded |
| `0.2.1-rc.1` ~ `0.2.2.x` | works |
| `0.3.0` and later | blocked (safety valve) |

The original exact pin `0.2.1-rc.2` makes `dsh-app-boot` **silently skip** the whole bundle
after a minor core bump — it only writes `skipping profile bundle` to stderr, and the model
group just disappears from the picker.

### TUI pairing

The terminal shell `@deepseek-harness-tui/dsh-tui` must be 0.10.0-beta.5 or later; earlier
versions fail to boot with this plugin (`events is not iterable`). Manual reasoning-effort
detection is Web / Desktop only — TUI does not have it.

### Desktop

On some Desktop distributions the `desktop` profile is managed by the app, and the standalone
CLI's `--profile desktop` is rejected. Rules differ per distribution: install through the app's
own plugin UI with the spec `github:Hourz26/dsh-workbuddy-connect-patched`. Do not bypass the
app's validation.

### Verification

After restarting, the model picker should show a **WorkBuddy** group. Pick a model there, send
a message and get a normal reply — then send something that needs a long answer (e.g. "write a
500-word essay") and confirm that works too. The second test matters: most 400 / 500 failures
only surface when generating longer content.

## Features

- **Works out of the box**: install and enable the plugin, then use it directly in DSH — no extra configuration.

- **CN and international side by side**: the CN app appears as the WorkBuddy group and the international one (WorkBuddy AI) as the WorkBuddy AI group; their models, accounts, and credit never mix. Each group follows only its own app's sign-in — install just the international app and only WorkBuddy AI appears, install both and both groups appear, sign out of one and that group goes away. Settings shows one card per version, each with its own account and balance.

- **Image input**: most models accept images pasted or dropped straight into the conversation (GLM-5.3-Flash, the DeepSeek-V4 series, and more); the few text-only models (e.g. GLM-5.1 / GLM-5.2 on the China endpoint) clearly say so.

- **Reasoning levels**: levels explicitly declared by WorkBuddy appear directly — for example, GLM-5.3 and GLM-5.3-Flash offer low / high / max. For models without declared levels, Web and Desktop offer a manual check in the model picker (it sends a few requests and may consume credit); models without a check result or selectable levels keep using WorkBuddy's default.

- **Balance at a glance**: with a WorkBuddy / WorkBuddy AI model selected, the composer shows the account's remaining credit next to the model selector (e.g. `WB.3,401 credits`, `WB AI.3,401 credits` on the international app). Credit is not polled automatically (every status read is a real billing query): one read on mount, then refresh on demand with the ↻ before the balance. During session switching, the controls may briefly hide until the model selection is ready, then return automatically. The refresh button remains available even when the model has no reasoning-level detection entry or the balance cannot be read.

- **Status and detection**: Settings → Plugins → the matching card shows the account, token validity, remaining credit, and model offers; it also refreshes the model list manually, shows whether the current list came from the upstream or the built-in fallback, and runs manual reasoning-level detection for eligible models. On DSH 0.1.5 the entry lives under Settings → Plugins; on 0.1.6+ it moved to the left-sidebar Plugins panel (workbuddy-connect → View) — and the Settings → Models page shows no WorkBuddy entries on either generation, by design.

- **Model visibility**: the Context window tab of each card lets you check which models appear in the model picker. Hidden lists are saved per signed-in account: switching accounts switches to that account's own list, switching back restores it; new accounts and newly added models are visible by default. Hiding only affects pickability — existing chats using a hidden model keep working.

- **Enterprise credit**: on the CN product, enterprise accounts (non-empty `enterpriseId`) read their cycle quota from the enterprise billing endpoint, and the card shows the enterprise quota with the cycle reset time.

- **Rate**: every model name carries its credits multiplier (e.g. `GLM-5.2 · x0.79`, `Hy3 · x0.00`) in both the `/model` popup and the composer's model dropdown; the rate is display-only and never affects requests.

- **Promo badges**: promo badges (limited-time free, night discount) ride the model name itself (e.g. `Hy4 preview · x0.00 · 限时免费`), visible wherever you pick a model, and the status card collects currently discounted models — per WorkBuddy service data, synced each time DSH starts. The international version's promotions come from the service's `modelPromotions` (with an effective window); once a promotion lapses its badge is withdrawn, and because the service writes the discounted value into the model's own rate field, the original price cannot be reconstructed — the model then reports "price unavailable — refresh to update" instead of repeating the discounted rate or claiming it is free.

The expanded card has three tabs: Status shows the account, token validity, total credit, catalog source, and reasoning-level detection; Context lists each model's context window, and the international version's "use the upstream's largest declared context window" switch lives here (on by default, so DSH sizes context compression to the largest declared window; turn it off to follow the upstream default instead, and the preference persists across restarts); Details combines credit packages with the same name and shows model offers. The CN and international versions each get their own card.

## Why reasoning levels work this way

Information about WorkBuddy models' reasoning levels is currently split between upstream API responses and private UI logic in the client, while the model catalog changes quickly. If the plugin filled in one uniform set of levels for every model without an upstream declaration, it would need to keep chasing unpublished product logic with no stable contract.

Testing also found that some models accept the `reasoning_effort` parameter while ignoring unknown values and falling back to their default behavior. A successful request alone therefore does not prove that a level is actually usable.

For models without declared levels, Web and Desktop instead use user-authorized, on-demand detection: it first confirms that the upstream validates the parameter, then checks which standard levels it accepts. The check sends a few requests and may consume credit. Its result means only that the upstream currently accepts that level; it does not promise a particular change in reasoning quality, speed, or credit use.

## CLI

`dsh plugin --profile <web|dsh-tui> exec dsh-workbuddy-connect status`: sign-in state and remaining credit (`--json` for machine-readable output; `doctor` for diagnostics and `logout` for credential cleanup are also available). The `desktop` profile is generally managed by the desktop app, so the CLI (including `exec`) does not work against it (see the Desktop note under Install).

Both commands target the CN version by default; add `--provider workbuddy-ai` for the international one:

```sh
dsh plugin --profile web exec dsh-workbuddy-connect status --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect doctor --provider workbuddy-ai
```

`logout` removes only that version's plugin-owned credential copy. It leaves the desktop app's own sign-in alone and does not promise the model group will disappear (the app's credential file still supplies one).

## Known limitations

- Verified on macOS with the DSH Web / Desktop / TUI profiles (as of 0.3.2 this requires `0.1.5-rc.1`+ and Node 22+; TUI requires the terminal UI package `0.10.0-beta.5` or newer — see the Install section). Windows probes Local and Roaming AppData in order; WSL first reads credentials from the mounted Windows user profile. If the Windows and Linux user names differ and Windows environment variables are not forwarded into WSL, point `WORKBUDDY_AUTH_FILE` (or `WORKBUDDY_AI_AUTH_FILE` for the international version) at the actual file.
- **Encrypted desktop credential helper discovery**: the helper is auto-detected on macOS and Windows; on Windows the CN app checks the default path `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` first and then the uninstall registry records, while the international app has no verified default path and checks the registry only. If auto-detection fails, set `WORKBUDDY_ELECTRON_BIN` (CN) or `WORKBUDDY_AI_ELECTRON_BIN` (international) to the executable explicitly, then fully quit and restart DSH for the change to take effect. Linux has no auto-discovery; an explicit environment variable is required. When WSL invokes the Windows-side helper, the plugin automatically normalizes the `ELECTRON_RUN_AS_NODE` entry in the child's `WSLENV` to a single safe flag set (carrying `/w` for forwarding, with no path translation; all other entries are preserved) — no manual `WSLENV` setup is needed. This change has passed offline regression tests; real WSL2 / Windows verification remains outstanding.
- **The international version's model catalog comes from the app's own interface**: the service splits it by User-Agent, which is a private implementation detail that a server-side change can break. When that happens the plugin degrades to this account's last successful catalog and then to its built-in roster, showing the source (live / saved / built-in), the fetch time, and the failure reason on the card — but long-term compatibility is not guaranteed. The CN version's catalog uses the same interface as the official CLI and is unaffected.
- **International-version environments not yet covered**: on Windows / WSL / Linux no reliable source for the international app's version has been located yet, so the saved value or the built-in default is used. On macOS, real-shim checks covered complete GPT-family replies, tool calls, and continued turns.
- **Behaviour change with no credentials**: a version whose app was never signed in — and that left no plugin-owned copy — no longer shows a model group. The CN version used to display a built-in fallback list, but every model on it failed when selected.
- **The enterprise credit path currently covers the CN product only**: the international enterprise billing interface is unverified, so those accounts still read through the personal endpoint pending measurement. The enterprise branch could not be tested locally (the development machine holds a personal account); it was implemented from the official app's interface contract, and reports from enterprise users are welcome.
- **Settings entries vary with the DSH version**: older services use `installSection`; newer ones use SettingsForms. On DSH 0.2.1-rc.2, 0.7.9 restores the international edition's maximum-context switch, enabled by default. Turning it off uses the upstream default window, and the preference survives restarts. The switch appears only once this plugin's writable settings entry is ready; while waiting, the maximum window remains the default.
- Relies on WorkBuddy client interfaces (not a public API); the plugin may need updates as WorkBuddy changes.

## Compatibility and release history

The plugin version must match the DSH core — a mismatched combination fails to start DSH — and the Desktop app picks its plugin version by the bundled core. The newest npm release is not necessarily right for you: match your actual core first.

| DSH core | Recommended plugin | Notes |
|---|---|---|
| `0.2.1-rc.2` | `0.7.9` | Targets this core only; `0.2.0-rc.2` and `0.2.1-rc.2` differ. Check the core bundled in your Desktop app. |
| `0.2.1-rc.1` | `0.7.7` | The core moved to `@earendil-works/pi-ai` 1.3.0, so the plugin bundles 1.3.0 too — a leftover 0.87.1 overrides entry must be removed (see the pi-ai note below). |
| `0.2.0-rc.2` | `0.7.6` | Previous core line; fixes enterprise catalog gaps and international chat requests blocked by the upstream channel check. Avoid 0.7.2 with its registry regression. |
| `0.2.0-rc.1` | `0.7.0` | 0.7.1 drops rc.1 support; stay on this version. |
| `0.1.5` – `0.1.7` | `0.6.5` | Final release for the old cores; 0.7.0 targets 0.2.0 only. |
| `0.1.2-rc.1` | `0.3.1` | Older line, historical maintenance only. |
| `0.1.1-rc.2` | `0.2.6` | Older line, historical maintenance only. |

Release history (full records at [releases](https://github.com/corrinehu/dsh-workbuddy-connect/releases)):

- **0.7.9**: restores the international edition's maximum-context switch on DSH 0.2.1-rc.2, including delayed initialization and persistent settings (PR [#172](https://github.com/corrinehu/dsh-workbuddy-connect/pull/172), by @1Dreamer666); avoids fetch-blocked local ports that could cause international-edition 502 errors (PR [#164](https://github.com/corrinehu/dsh-workbuddy-connect/pull/164), by @Xiong-Ziyi); combines credit packages with the same name to reduce repeated entries.
- **0.7.8**: adapts to DSH 0.2.1-rc.2; bundles the official atomic-write helper instead of relying on host module exposure; refreshes the China catalog snapshot and distinguishes Hy3 / Hy3-X; improves probe result labels and fixes the credit-refresh placement and tooltip. Thanks to @chenpiyanghappy for PR [#156](https://github.com/corrinehu/dsh-workbuddy-connect/pull/156).
- **0.7.7**: adapts to the DSH 0.2.1-rc.1 core: peers narrow to 0.2.1-rc.1 and the plugin-bundled `@earendil-works/pi-ai` moves to 1.3.0 with it (a profile-level leftover 0.87.1 overrides entry must be removed, or the plugin fails to load).
- **0.7.6**: fixes enterprise accounts missing `glm-5.3-flashx` from the model catalog ([#123](https://github.com/corrinehu/dsh-workbuddy-connect/issues/123)), and fixes international chat requests being blocked by the upstream channel check ([#139](https://github.com/corrinehu/dsh-workbuddy-connect/issues/139) / [#142](https://github.com/corrinehu/dsh-workbuddy-connect/issues/142)).
- **0.7.5**: restores composer controls after session switching ([#125](https://github.com/corrinehu/dsh-workbuddy-connect/issues/125) / [#132](https://github.com/corrinehu/dsh-workbuddy-connect/issues/132)), fixes WSL helper environment forwarding ([#133](https://github.com/corrinehu/dsh-workbuddy-connect/issues/133)), and adds community projects to both READMEs.
- **0.7.4**: Windows diagnostics and stability improvements: accurate classification of oversized registry-subprocess output, cross-platform test-assumption fixes ([#62](https://github.com/corrinehu/dsh-workbuddy-connect/issues/62)), and a reworked install section.
- **0.7.3**: fixes Windows registry auto-discovery failing on non-default install paths ([#105](https://github.com/corrinehu/dsh-workbuddy-connect/issues/105)).
- **0.7.2**: pi-ai becomes a plugin-bundled dependency and rejected inference-field requests are fixed ([#92](https://github.com/corrinehu/dsh-workbuddy-connect/issues/92)); this release carries a Windows registry regression — use 0.7.4 or a newer stable release.
- **0.7.1**: narrows the pi-ai dependency range.
- **0.7.0**: adapts to DSH 0.2.0's settings-service rework and drops 0.1.x support.
- **0.6.5**: final release of the 0.1.x line.

Install command for this fork: `dsh plugin --profile web add github:Hourz26/dsh-workbuddy-connect-patched`.
(`dsh-workbuddy-connect@0.7.9` is the npm original without the patches — do not use it.)

**pi-ai versions are per core line and must not be mixed**: the 0.2.1-rc.1 / rc.2 core lines (plugin 0.7.7 / 0.7.8–0.7.9 respectively) moved to `@earendil-works/pi-ai` 1.3.0 (bundled by the plugin), so a profile-level leftover `overrides: {'@earendil-works/pi-ai': '0.87.1'}` **must be removed** or the plugin fails to load; the 0.2.0-rc.2 core line (plugin 0.7.6) still requires `^0.87.1` — on that line, **do not** upgrade the profile-level pi-ai to 1.x, and do not act on third-party plugin managers' "updatable" prompts, which do not check peer constraints ([#86](https://github.com/corrinehu/dsh-workbuddy-connect/issues/86)).

## Disclaimer

- This project is for **personal learning and research only**, driving your own WorkBuddy account on your own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with the WorkBuddy terms of service. Any consequence of using this project (including but not limited to account restrictions, depleted credit, or service interruption) is borne by the user.
- The author is not liable for any direct or indirect loss arising from the use or misuse of this project.
- This project is not affiliated with, endorsed by, or sponsored by Tencent, WorkBuddy, or DeepSeek. Product names are used for compatibility description only; trademarks belong to their respective owners.

## Related Projects / Community Ecosystem

- **[dsh-buddy-checkin](https://github.com/corrinehu/dsh-buddy-checkin)**: a daily check-in plugin for the WorkBuddy China edition, maintained by this project's author.
- **[dsh-workbuddy-switcher](https://github.com/ddGuo/dsh-workbuddy-switcher)**: a community-maintained WorkBuddy account management and switching plugin.
- **[hana-workbuddy-connect](https://github.com/miaoyongxu/hana-workbuddy-connect)**: a community-maintained unofficial adapter project that reuses parts of the `dsh-workbuddy-connect` implementation to bring WorkBuddy / WorkBuddy AI models to HanaAgent.

See each project's documentation for supported versions and installation requirements. Except for `dsh-buddy-checkin`, these projects are independently maintained by third parties. Listing them here is not an official endorsement or a stability or compatibility commitment for this plugin's internal interfaces.

## Acknowledgements

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT) — reference implementation of the WorkBuddy upstream protocol.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) — reference for the DSH plugin structure and provider registration.

## License

[MIT](./LICENSE)
