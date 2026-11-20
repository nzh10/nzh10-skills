---
name: pi-steward
description: 管理 nzh10-skills 仓库中跨机器的 Pi 宿主全局配置（canon/settings.canon.json、canon/AGENTS.md、canon/plain-check.toml）与单机试验沉淀池（pools/*/incubating.json）。仅当用户要求把某个 Pi 插件/规则/技能转正（promote）到全局 canon、从 canon 全局卸载某个 Pi 插件/模型、把本机试用中的 Pi 插件或点名的公共 Skill 可见性存进沉淀池、将公共 Skill 可见性转为仓库默认、查看/调取某台机器的沉淀池、或初始化新机器冷启动环境时使用。不处理业务代码仓库或单个业务 skill 的评测。
---

# Pi 跨端配置与沉淀池管理 (pi-steward)

用于在多台机器之间维护「全网统一主干（Canon）」与「单机自由孵化（Incubator Pool）」双层 Pi 配置体系（配置根目录 `<agentDir>` 默认为 `~/.pi/agent`，若设了 `$PI_CODING_AGENT_DIR` 则以其为准）。

## 四条不可逾越的红线

1. **未经明确指示绝不自动 Promote 或 Push**：仅当用户明确要求「存进沉淀池」或「promote / 转正到全局」时才写入仓库或推送。
2. **只读同步节点严禁手改包缓存**：若 `<agentDir>/machine.json` 无有效 `hubRepoPath`，当前机器即为只读同步节点（由 `pi-steward` 在交互式启动与 `/reload` 时自动拉取并硬重置 `<agentDir>/git/github.com/nzh10/nzh10-skills` 包缓存至远端，严禁人工在包缓存内编辑或提交）；遇到连接中断等可重试错误时会再拉一次；仍失败就保留当前版本并显示 Git 的具体错误。需改全局配置时，直接用一句话说明当前为只读同步节点，引导在主力开发机操作或先克隆仓库运行 `/hub-init <machineId> <hubRepoPath>`。
3. **严禁绕过隐私与密钥钩子（绝不使用 `--no-verify`）**：公开仓库依靠 `.githooks/pre-commit` 与 `.githooks/pre-push` 结合本地 `.git/info/no-upload-personal` 拦截本机用户名、主机名、家目录路径与密钥。任何时候严禁传 `--no-verify`；钩子拦截时立即停止并如实报告命中项。
4. **保护云端自动同步路径（Read-Only Paths）**：除非用户点名要求，**绝不修改 `skills/skill-creator/`、`patches/skill-creator.patch`、`scripts/sync-skill-creator.sh`、`upstream.json` 或 `.github/workflows/sync-skill-creator.yml`**。

---

## 三层目录结构与冷启动脚本

1. **全局主干 (`<hubRepoPath>/canon/`、`skills/`、`extensions/`)**：
   - `canon/settings.canon.json`：共享手感配置（默认模型、`enabledModels`、`modelThinkingLevels`、TUI 配置）与正式全局 `packages`。
   - `canon/AGENTS.md`：英文 ASD-STE100 全局通用规则（首次接管非空本地 `AGENTS.md` 时，`pi-steward.ts` 自动备份为 `AGENTS.md.bak`）。
   - `canon/plain-check.toml`：跨平台黑话拦截器全局规则（启动与 `/reload` 时自动同步至 `<agentDir>/plain-check.toml`，首次接管非空旧文件时自动备份 `.bak`）。
2. **各机器沉淀池 (`<hubRepoPath>/pools/<machineId>/`)**：
   - `incubating.json`：记录可跨机安装的试用包（`npm:`/`git:`）、脱敏备注和明确收录的公共 Skill 可见性。可见性记录是候选，不参与运行时合并。
   - `machine-env.md`：脱敏单机环境模板（严禁含真实用户名、hostname 或个人路径），本机 `APPEND_SYSTEM.md` 为空时用于首次初始化。
   - `pools/<machineId>/skills/`：该机器正在试验、尚未晋升到顶层 `skills/` 的半成品技能备份。
3. **本机运行层 (`<agentDir>/`)**：
   - `settings.json`：由 `pi-steward.ts` 自动合并 `canon/settings.canon.json` 与本机额外试用插件（支持在 `machine.json` 中用 `defaultProvider`/`defaultModel` 覆盖单机默认模型）；可写节点自动将 Canon 自包 `git:github.com/nzh10/nzh10-skills` 原位替换为本机 `<hubRepoPath>`，使配置、扩展与技能同源加载，只读节点继续从 `<agentDir>/git/...` 包缓存加载。`enabledModels` 仅在 TUI 模式下按本机已配置认证的厂商以 `seenVisibleCanon` 基线做增量同步，本机 `/scoped-models` 增删改排严格留在本地；补登缺登 Canon 厂商后执行 `/reload` 写盘再 `/new`（或重启 Pi）生效。
   - `.pi-steward-state.json`（同步快照，含 `seenVisibleCanon` 与 `loginGuideShown`，支持从 `canon` 全局卸载）、`APPEND_SYSTEM.md`（本机环境指令）、`machine.json`（本机身份与 `hubRepoPath` 指针）：**以上三项均严格留在本地，严禁提交进 Git**。
4. **新机器用户态冷启动 (`<hubRepoPath>/scripts/bootstrap-cli.sh`)**：
   - 空白 WSL / Linux 机器（甚至缺失系统 `python3`、`uv`、`ntn`）无需 `sudo`，先运行 `sh <hubRepoPath>/scripts/bootstrap-cli.sh --check` 检查；只要用户问到「缺的话怎么装 / 如何安装」或确实缺失工具，无论当前检查是否已装齐，都在回复中明确附上一键补装命令 `sh <hubRepoPath>/scripts/bootstrap-cli.sh --install`（在 `~/.local/bin` 安装 `uv`、托管 Python 3.12 与 `ntn`）。

---

## Skillful：本机可见性与仓库默认

`machine.json` 可用 `skillful.enabled: true` 启用、用 `false` 关闭；未指定时沿用该机的安装选择。已启用的机器加载当前仓库 `packages/pi-skillful/`，与 npm 来源保持单份。共享默认放在 `canon/settings.canon.json` 的 `skillful.visibility`。

对 Pi 已加载的本仓公共 Skill 和顶层个人 Skill，菜单按单项保存。可信 Project 优先于本机 Global，本机 Global 优先于仓库默认。「跟随上层」只撤掉选中项的限制；旧名单保持原义，已明确选择跟随的单项可跳过旧名单。隐藏只影响模型自动发现，手动调用保持可用。菜单、更改来源、入池和转正 Skill 内容是各自独立的操作。

明确要求收录或转正某个公共 Skill 时，使用工作仓 `skills/pi-steward/scripts/skillful-visibility.mjs`：

1. 用 `collect --id hub:skills/<path>/SKILL.md` 收录本机 Global 对该项的显式 `show` 或 `hide`；先跑现有 preflight，再写当前机器池。隐私路径、Project 设置和其他本机设置留在原处。
2. 用 `promote --id <id> --pool <machineId>` 或 `promote --id <id> --value show|hide` 预览。向用户说明 canon 当前值和目标值；若当前已不是池记录的基线且不同于目标，先处理冲突。
3. 明确转正时用 `promote --id <id> --value <预览的目标值> --apply --expected <基线：null|show|hide>`。脚本再次运行 preflight，只合入这一个 ID；已是目标值时不重写，不清除本机偏好。尚未发布的内容须已放在 `skills/` 下并当次明确同时转正，才使用 `--content-promoted`。提交和推送是独立操作。

## 强制前置检查（每次写仓前必跑脚本）

执行任何「存沉淀池」「Promote 到全局」或「从全局移除」写操作前，**必须先按本 `SKILL.md` 所在目录的绝对路径运行内置前置检查脚本（非 0 退出立即中止并向用户报告原因）**：

```bash
# 将 <skill-dir> 替换为当前读取的 SKILL.md 所在父目录绝对路径（或 <hubRepoPath>/skills/pi-steward）
sh <skill-dir>/scripts/steward-preflight.sh
```

该脚本纯只读完成 4 项前置校验（绝不自动改写工作树）：① `machine.json` 的 `machineId` 与 `hubRepoPath` 存在且不在 `<agentDir>/git` 缓存内；② `core.hooksPath == .githooks` 且 `.git/info/no-upload-personal` 非空；③ 暂存区（staged index）无无关文件；④ 刷新远端引用并检查 `HEAD...@{upstream}` 是否落后或分叉（纯落后提示 `git pull --ff-only`，已有本地提交且分叉提示 `git pull --rebase`）。

---

## 标准操作流程与回复风格

- **回复准则（精炼直给）**：直接报结果、有效差异与下一步动作；不要罗列无差异项（如“模型一致、没有试验技能目录”），不要堆砌“不能…也不能…”或“没有改A、没有写B、也没有提交C”的防御性套话，常规提交推送无需报具体 commit hash（用户追问或回滚排查时再给），用直白工程术语描述前置检查与 Git 钩子。

1. **查看酝酿状态（只读）**：读取 `machine.json`、`canon/settings.canon.json` 与 `<agentDir>/settings.json`（或用 `/hub-status`），对比 `packages` 与 `enabledModels` 差异（区分 `npm:`/`git:` 与本机绝对路径插件），并检查 `<agentDir>/skills/` 或 `pools/<machineId>/` 下未合入顶层的技能。
2. **保存到本机沉淀池（Save to Pool）**：
   - 先盘点本机多于 `canon` 的插件（区分可跨机 `npm:`/`git:` 与须排除的本机绝对路径），再跑 `sh <skill-dir>/scripts/steward-preflight.sh`（若被脏暂存区拦住，简明点出阻塞暂存文件并附上「可保存 / 已排除」两行清单即可）。
   - 将可跨机插件写入 `pools/<machineId>/incubating.json`；如用户明确点名保存某个试验技能或脱敏环境模板，同步放入 `pools/<machineId>/` 对应路径。
   - 精确暂存并推送（默认仅暂存 `pools/<machineId>/incubating.json` 及用户明确指定的精确文件路径，严禁盲目 `git add .` 或 `--no-verify`）：
     `/usr/bin/git -C <hubRepoPath> add -- pools/<machineId>/incubating.json && /usr/bin/git -C <hubRepoPath> diff --cached && /usr/bin/git -C <hubRepoPath> commit -m "chore: update <machineId> incubating pool" && /usr/bin/git -C <hubRepoPath> push`
   - 推送完成后，其他只读节点下次启动或执行 `/reload` 时自动将包缓存对齐到 `origin/master`。
3. **晋升到全局主干（Promote to Canon）**：
   - 跑通 `sh <skill-dir>/scripts/steward-preflight.sh`。
   - 插件从 `settings.json`/`incubating.json` 补全 `npm:`/`git:` 前缀写入 `canon/settings.canon.json`（并从 `incubatingPackages` 移除）；规则写入 `canon/AGENTS.md` 并同步 `<agentDir>/AGENTS.md`；Skill/Extension 移入顶层 `skills/` 或 `extensions/`。
   - 模型（`enabledModels`）晋升必须以最新 `canon/settings.canon.json` 为底稿，调用 `<hubRepoPath>/extensions/pi-steward.ts` 导出的 `mergeCanonModelsForPromote` 并传入实时厂商认证判定（与运行时 `getProvider` + `getProviderAuthStatus` 一致）：
     - `explicit` 模式（任意本地状态可用）：仅增删用户点名且本机已配置认证的厂商模型；
     - `align-providers` 模式（仅本地 `enabledModels` 为非空数组时可用，拒绝 `[]` 与缺键）：仅按显式指定的已配置 `targetProviders` 原槽位对齐（溢出项紧跟该厂商末槽，无原槽则追加），本机未登录或未点名厂商的 Canon 条目原位原序零改动。
   - 本机可写节点直接从 `<hubRepoPath>` 加载扩展与技能，改动后无需 push 即可通过 `/reload` 在本地验证；经用户明确授权后精确 `git add -- <exact-paths>`，核对 `git diff --cached` 零隐私零密钥后按 `feat:` / `fix:` / `chore:` 提交并推送（只读同步节点在 `/reload` 时自动对齐包缓存）。
4. **从全局卸载（Demote / Remove）**：
   - 跑通 `sh <skill-dir>/scripts/steward-preflight.sh`。
   - **插件或通用键卸载**：从 `canon/settings.canon.json`（`packages` 或 `modelThinkingLevels`）、本机 `<agentDir>/settings.json` 及 `.pi-steward-state.json` 同步移除目标项。
   - **模型（`enabledModels`）卸载**：仅对最新 `canon/settings.canon.json` 调用 `mergeCanonModelsForPromote({ mode: "explicit", remove: [...] })` 显式删除已配置厂商模型，**不手改 `.pi-steward-state.json`**；本机与其他节点下次 TUI 启动或 `/reload` 时按 `seenVisibleCanon` 自动清理，再 `/new`（或重启 Pi）生效。
   - 仅暂存 `canon/settings.canon.json`，核对 `git diff --cached` 后执行 `git commit -m "chore: remove <item> from canon" && git push`（其他节点下次交互式启动或执行 `/reload` 时按快照自动卸载）。
5. **跨机器沉淀池调取**：可写节点在 `<hubRepoPath>` 执行 `git pull --ff-only`（或 `git fetch origin`），只读节点（含 Windows PowerShell）直接执行 `/reload` 让 `pi-steward` 将 `<agentDir>/git/github.com/nzh10/nzh10-skills` 对齐远端后，直接读取其中的 `pools/<other-machineId>/incubating.json` 或 `skills/`，按指示 `pi install <pkg>` 试用或走流程 3 转正。
