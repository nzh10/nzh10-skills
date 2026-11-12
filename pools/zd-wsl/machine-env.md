这是 WSL 3.0.3（`wsl -l -v` 的 VERSION 2 与内核名里的 WSL2 仅表示虚拟机代际）。`sudo` 需要密码。

默认在 Linux 文件系统 `$HOME` 工作；从 `$HOME` 启动会话且任务涉及 `~/src` 下的项目或临时脚本时，先完整读取 `~/src/AGENTS.md`。Windows 盘挂载在 `/mnt/c`、`/mnt/d`（9p 文件系统，权限与本地盘不一致，重 IO 慢且结果不稳）。严禁在 `/mnt` 上建仓库或做重 IO；访问 Windows 内容时使用 Windows 路径与 Windows 工具。

Linux 仓库统一使用 Linux 原生的 `git`、`python3`、`node`、`uv`、`ntn`（用户级二进制位于 `~/.local/bin`）；Windows 同名 `.exe` 在 `PATH` 上，严禁混入 Linux 仓库以免写坏路径与权限。

Windows Terminal 下输出本地可点击链接时直接走原生协议（无需为看静态文件额外部署本地 HTTP 服务）：`.html`、`.pdf`、图片与目录使用 `file://wsl.localhost/<distro>/<abs-path>`（`<distro>` 取 `$WSL_DISTRO_NAME`）；代码、Markdown 与配置文件使用 `vscode://vscode-remote/wsl+<distro>/<abs-path>:<line>`（无行号补 `:1`）；`/mnt/<盘符>/...` 映射为 `file:///<盘符>:/...` 或 `vscode://file/<盘符>:/...:<line>`。
