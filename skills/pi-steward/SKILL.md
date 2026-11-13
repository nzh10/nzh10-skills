---
name: pi-steward
description: 管理 nzh10-skills 仓库中跨机器的 Pi 宿主全局配置（canon/settings.canon.json、canon/AGENTS.md、canon/plain-check.toml）与单机试验沉淀池（pools/*/incubating.json）。仅当用户要求把某个 Pi 插件/规则/技能转正（promote）到全局 canon、从 canon 全局卸载某个 Pi 插件/模型、把本机试用中的 Pi 插件存进沉淀池、查看/调取某台机器的沉淀池、或初始化新机器冷启动环境时使用。不处理业务代码仓库或单个业务 skill 的评测。
---

# Pi 跨端配置与沉淀池管理 (pi-steward)

用于在多台机器之间维护「全网统一主干（Canon）」与「单机自由孵化（Incubator Pool）」双层 Pi 配置体系（配置根目录 `<agentDir>` 默认为 `~/.pi/agent`，若设了 `$PI_CODING_AGENT_DIR` 则以其为准）。

## 四条不可逾越的红线

1. **未经明确指示绝不自动 Promote 或 Push**：仅当用户明确要求「存进沉淀池」或「promote / 转正到全局」时才写入仓库或推送。
2. **只读同步节点严禁手改包缓存**：若 `<agentDir>/machine.json` 无有效 `hubRepoPath`，当前机器即为只读同步节点（由 `pi-steward` 在交互式启动与 `/reload` 时自动拉取并硬重置 `<agentDir>/git/github.com/nzh10/nzh10-skills` 包缓存至远端，严禁人工在包缓存内编辑或提交）；需改全局配置时，直接用一句话说明当前为只读同步节点，引导在主力开发机操作或先克隆仓库运行 `/hub-init <machineId> <hubRepoPath>`。
3. **严禁绕过隐私与密钥钩子（绝不使用 `--no-verify`）**：公开仓库依靠 `.githooks/pre-commit` 与 `.githooks/pre-push` 结合本地 `.git/info/no-upload-personal` 拦截本机用户名、主机名、家目录路径与密钥。任何时候严禁传 `--no-verify`；钩子拦截时立即停止并如实报告命中项。
4. **保护云端自动同步路径（Read-Only Paths）**：除非用户点名要求，**绝不修改 `skills/skill-creator/`、`patches/skill-creator.patch`、`scripts/sync-skill-creator.sh`、`upstream.json` 或 `.github/workflows/sync-skill-creator.yml`**。

---

## 三层目录结构与冷启动脚本

1. **全局主干 (`<hubRepoPath>/canon/`、`skills/`、`extensions/`)**：
   - `canon/settings.canon.json`：共享手感配置（默认模型、`enabledModels`、`modelThinkingLevels`、TUI 配置）与正式全局 `packages`。
   - `canon/AGENTS.md`：英文 ASD-STE100 全局通用规则（首次接管非空本地 `AGENTS.md` 时，`pi-steward.ts` 自动备份为 `AGENTS.md.bak`）。
   - `canon/plain-check.toml`：跨平台黑话拦截器全局规则（启动与 `/reload` 时自动同步至 `<agentDir>/plain-check.toml`，首次接管非空旧文件时自动备份 `.bak`）。
2. **各机器沉淀池 (`<hubRepoPath>/pools/<machineId>/`)**：
   - `incubating.json`：备份该机可跨机安装的试用包（`npm:`/`git:`）与脱敏备注（严禁写入含真实用户名/家目录的本机绝对路径）。
   - `machine-env.md`：脱敏单机环境模板（严禁含真实用户名、hostname 或个人路径），本机 `APPEND_SYSTEM.md` 为空时用于首次初始化。
   - `pools/<machineId>/skills/`：该机器正在试验、尚未晋升到顶层 `skills/` 的半成品技能备份。
3. **本机运行层 (`<agentDir>/`)**：
   - `settings.json`：由 `pi-steward.ts` 自动合并 `canon/settings.canon.json` 与本机额外试用插件（支持在 `machine.json` 中用 `defaultProvider`/`defaultModel` 覆盖单机默认模型）。
   - `.pi-steward-state.json`（同步快照，支持从 `canon` 全局卸载）、`APPEND_SYSTEM.md`（本机环境指令）、`machine.json`（本机身份与 `hubRepoPath` 指针）：**以上三项均严格留在本地，严禁提交进 Git**。
4. **新机器用户态冷启动 (`<hubRepoPath>/scripts/bootstrap-cli.sh`)**：
   - 空白 WSL / Linux 机器（甚至缺失系统 `python3`、`uv`、`ntn`）无需 `sudo`，先运行 `sh <hubRepoPath>/scripts/bootstrap-cli.sh --check` 检查；只要用户问到「缺的话怎么装 / 如何安装」或确实缺失工具，无论当前检查是否已装齐，都在回复中明确附上一键补装命令 `sh <hubRepoPath>/scripts/bootstrap-cli.sh --install`（在 `~/.local/bin` 安装 `uv`、托管 Python 3.12 与 `ntn`）。

---

## 强制前置检查（每次写仓前必跑脚本）

执行任何「存沉淀池」「Promote 到全局」或「从全局移除」写操作前，**必须先按本 `SKILL.md` 所在目录的绝对路径运行内置前置检查脚本（非 0 退出立即中止并向用户报告原因）**：

```bash
# 将 <skill-dir> 替换为当前读取的 SKILL.md 所在父目录绝对路径（或 <hubRepoPath>/skills/pi-steward）
sh <skill-dir>/scripts/steward-preflight.sh
```

该脚本纯只读完成 4 项前置校验（绝不自动改写工作树）：① `machine.json` 的 `machineId` 与 `hubRepoPath` 存在且不在 `<agentDir>/git` 缓存内；② `core.hooksPath == .githooks` 且 `.git/info/no-upload-personal` 非空；③ 暂存区（staged index）无无关文件；④ 刷新远端引用并检查 `HEAD...@{upstream}` 是否落后（若落后于远端则报错中止，由人工执行 `git pull --ff-only`）。

---

## 标准操作流程与回复风格

- **回复准则（精炼直给）**：直接报结果、有效差异与下一步动作；不要罗列无差异项（如“模型一致、没有试验技能目录”），不要堆砌“不能…也不能…”或“没有改A、没有写B、也没有提交C”的防御性套话，常规提交推送无需报具体 commit hash（用户追问或回滚排查时再给），用直白工程术语描述前置检查与 Git 钩子。

1. **查看酝酿状态（只读）**：读取 `machine.json`、`canon/settings.canon.json` 与 `<agentDir>/settings.json`（或用 `/hub-status`），对比 `packages` 与 `enabledModels` 差异（区分 `npm:`/`git:` 与本机绝对路径插件），并检查 `<agentDir>/skills/` 或 `pools/<machineId>/` 下未合入顶层的技能。
2. **保存到本机沉淀池（Save to Pool）**：
   - 先盘点本机多于 `canon` 的插件（区分可跨机 `npm:`/`git:` 与须排除的本机绝对路径），再跑 `sh <skill-dir>/scripts/steward-preflight.sh`（若被脏暂存区拦住，简明点出阻塞暂存文件并附上「可保存 / 已排除」两行清单即可）。
   - 将可跨机插件写入 `pools/<machineId>/incubating.json`；如用户明确点名保存某个试验技能或脱敏环境模板，同步放入 `pools/<machineId>/` 对应路径。
   - 精确暂存并推送（默认仅暂存 `pools/<machineId>/incubating.json` 及用户明确指定的精确文件路径，严禁盲目 `git add .` 或 `--no-verify`）：
     `/usr/bin/git -C <hubRepoPath> add -- pools/<machineId>/incubating.json && /usr/bin/git -C <hubRepoPath> diff --cached && /usr/bin/git -C <hubRepoPath> commit -m "chore: update <machineId> incubating pool" && /usr/bin/git -C <hubRepoPath> push`
   - 推送完成后，下次启动或执行 `/reload` 时 `pi-steward` 会自动将 `<agentDir>/git/github.com/nzh10/nzh10-skills` 包缓存对齐到 `origin/master`。
3. **晋升到全局主干（Promote to Canon）**：
   - 跑通 `sh <skill-dir>/scripts/steward-preflight.sh`。
   - 插件从 `settings.json`/`incubating.json` 补全 `npm:`/`git:` 前缀写入 `canon/settings.canon.json`（并从 `incubatingPackages` 移除）；规则写入 `canon/AGENTS.md` 并同步 `<agentDir>/AGENTS.md`；Skill/Extension 移入顶层 `skills/` 或 `extensions/`。
   - 精确 `git add -- <exact-paths>`，核对 `git diff --cached` 零隐私零密钥后按 `feat:` / `fix:` / `chore:` 提交并推送；推送后执行 `/reload` 自动对齐 `<agentDir>/git/github.com/nzh10/nzh10-skills` 包缓存并同步 `canon/`（若本次改动了 `extensions/` 或 `skills/` 代码，缓存更新后再执行一次 `/reload` 即可将新代码载入内存）。
4. **从全局卸载（Demote / Remove）**：
   - 跑通 `sh <skill-dir>/scripts/steward-preflight.sh`。
   - 从 `canon/settings.canon.json`（`packages`、`enabledModels` 或 `modelThinkingLevels`）、本机 `<agentDir>/settings.json` 及 `.pi-steward-state.json` 同步移除目标项。
   - 仅暂存 `canon/settings.canon.json`，核对 `git diff --cached` 后执行 `git commit -m "chore: remove <item> from canon" && git push`（其他节点下次交互式启动或执行 `/reload` 时按快照自动卸载）。
5. **跨机器沉淀池调取**：可写节点在 `<hubRepoPath>` 执行 `git pull --ff-only`（或 `git fetch origin`），只读节点（含 Windows PowerShell）直接执行 `/reload` 让 `pi-steward` 将 `<agentDir>/git/github.com/nzh10/nzh10-skills` 对齐远端后，直接读取其中的 `pools/<other-machineId>/incubating.json` 或 `skills/`，按指示 `pi install <pkg>` 试用或走流程 3 转正。
