本机默认 shell 为 `pwsh`。Python 默认使用 `uv`，在 Windows 控制台运行 Python 脚本时显式加 `-X utf8`（或设置 `PYTHONUTF8=1`）以避免 GBK 编码报错。Windows Terminal 下输出本地链接直接走原生协议（无需部署本地 HTTP 服务）：浏览器文件与目录用 `file:///C:/...`，代码与配置文件用 `vscode://file/C:/...:<line>`（无行号补 `:1`）。

企业云桌面（VDI）客户端与本地 TUN 代理共存时，确保 VDI 内网网段保留在 TUN 路由排除列表中以便正常回退云桌面代理；排查连通性时区分本地 TUN 假握手成功与真实上游可达。
