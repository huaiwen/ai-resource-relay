# 实验室 AI 资源中转站

独立部署的模型网关，基于未修改的 [New API](https://github.com/QuantumNous/new-api)。中转站负责供应商凭据、协议转换、模型路由和中转密钥；LabHub 保留成员身份、权限和成员额度。两边可单独部署、升级或停用。

## 上游同步与授权

本仓库是 New API 的公开 GitHub fork，保留上游源码和 Git 历史；实验室部署脚本及工作台位于 `lab-relay/`。试用脚本使用固定版本的 New API 官方二进制，而不是从根目录当前源码构建；升级二进制时应同时更新版本与校验值，并重新通过集成测试。

```sh
git remote add upstream https://github.com/QuantumNous/new-api.git
git fetch upstream --tags
git switch -c update-new-api main
git merge upstream/main
```

同步后在独立分支审查上游改动，确认测试后再通过 PR 合入；不要推送上游发布标签，以免触发发布工作流。保留上游的 [AGPLv3 授权](../LICENSE)、[署名](../NOTICE)和可见项目链接。若运行修改过的 AGPL 覆盖版本，须向远程用户明确提供部署版本的对应源码获取入口，或取得适用的商业授权。密钥、部署配置和运行数据不进入公开仓库。

## 实验室 AI 工作台

在隔离控制台打开 `/workspace`，登录沿用 New API 原生账号和会话。默认品牌为「内蒙古大学多媒体计算实验室」，Logo 来自 [IMMC 实验室 GitHub 组织](https://github.com/immc-lab)。运营管理员可在「品牌设置」改名、上传或移除 Logo；设置保存在控制台持久化状态目录。

运营管理员可以创建实验室分组、分配已有普通账号、调整额度和查看分组统计；普通成员只看本人的用量与额度。创建账号、密钥管理、用量明细、供应商配置和模型路由仍在完整 New API 后台完成。实验室分组不是独立租户边界，新增分组不会自动获得模型渠道；对外运营前需要单独验证数据隔离、角色和每组路由授权。

模拟试用服务的 `/workspace` 不需要 New API 账号。成员账目为示例，修改只保存在当前浏览器；模型试用走本地模拟上游。模拟工作台不提供真实项目密钥。

## GitHub 方案比较

星数取自 2026-11-27 的 GitHub 仓库页面。以下比较的是自托管路径，不把仅限云端或企业版的功能算进首版。

| 方案 | Stars | 哪些设计值得用 | 本项目的取舍 |
|---|---:|---|---|
| [New API](https://github.com/QuantumNous/new-api#capabilities) | 52.6k | 供应商渠道与客户端模型名解耦；中文控制台、分组、密钥限制、额度与统计；同时提供 OpenAI、Anthropic、Gemini 等协议 | **采用。** 单机可用 SQLite，无需另写管理台。上游是 AGPL-3.0；本项目不修改其源码。 |
| [LiteLLM](https://github.com/BerriAI/litellm) | 64.0k | Python SDK 和统一代理；虚拟密钥、预算、路由、回退与广泛的供应商适配 | 适合优先用代码管理模型的团队。此处优先中文运营台和单机落地。 |
| [Portkey Gateway](https://github.com/Portkey-AI/gateway) | 13.5k | 可编排负载均衡、回退和缓存；OpenAI 兼容的多模态网关 | 自托管网关适合以路由配置为核心的场景；完整运营能力要按版本和部署模式另核。 |
| [Helicone](https://github.com/Helicone/helicone) | 6.3k | 请求级成本、时延与追踪；适合作为独立可观测层 | 不在首版叠加一套日志服务；等确有跨应用追踪需求再看。 |

落地采用 **渠道隔离**（按供应商配置）、**客户端密钥隔离**（不给客户端上游密钥），以及 **独立核算**（LabHub 的成员额度不替换为中转统计）。

## 运行独立试用版

从仓库根目录进入 `lab-relay/`。需要 Linux amd64 / arm64、Node.js 22+、`curl` 和 `sha256sum`，隔离控制台还需要 Docker。安装器只接受 SHA-256 匹配的 [New API v1.0.0-rc.51](https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.51) 官方二进制；未修改上游二进制。版本为上游 RC，正式接入前应复核安全公告和升级说明。

```sh
node relay-demo.mjs
node --test  # 应用运行时，在另一终端执行
```

打开 `http://localhost:9125`，试用文本对话和文本向量。页面只暴露受限演示入口；New API 的原生控制台、管理 API、演示密钥和模拟上游都不对外暴露。两条请求经过真实 New API 的渠道和密钥检查，但响应为本地模拟，不依赖任何第三方密钥，也不产生模型费用。页面上的模型名仅表示演示协议与渠道，不代表付费模型已连通。每次启动用隔离的临时 SQLite；不和正式实例共用数据。请不要在试用中输入敏感内容。

并行运行另一份试用版时，用 `PORT`、`DEMO_GATEWAY_PORT` 指定两个不同于当前试用版的端口。自定义端口时，测试分别读取 `DEMO_URL` 和 `DEMO_GATEWAY_URL`。

托管版适合团队浏览器试用；Devin 登录保护不等同于供 LabHub 后端调用的网关鉴权。试用链接依赖宿主会话；会话被结束或归档时可能离线。

## 在本机试用完整 New API 管理台

此入口保留 New API 原生界面，只监听 `127.0.0.1:9129`。New API 在无外网的 Docker 容器中运行，只连接本地模拟上游。启动器要求本机 rootful Docker 且未启用用户命名空间重映射：容器以宿主当前 UID/GID 访问私有状态目录。管理员为 `labadmin`；首次启动前，从密码管理器生成不少于 16 字符的独立密码，通过环境变量 `RELAY_ADMIN_PASSWORD` 注入。不要把密码写入仓库或命令行。第二次启动不再需要此变量。

```sh
node relay-console.mjs
```

使用 `http://127.0.0.1:9129` 登录。控制台可管理渠道、模型映射、账号、密钥、额度及日志。容器数据保存在 `RELAY_CONSOLE_STATE`（默认本地状态目录下的 `ai-relay-console`）；与公开试用页不共享数据库。不要放入真实供应商密钥，不要把这个试用入口转发到公网。

测试使用全新状态目录和一次性密码：启动实例后，在保留相同密码环境变量的另一终端运行 `CONSOLE_URL=http://127.0.0.1:9129 node --test test/console.test.mjs`。测试会创建两个实验室的模拟账户；不要在使用中的数据库运行。将组分配给用户只是配置的一步：还须检查全局可用组、自动回退组和渠道归属。这里验证的是普通用户的渠道、密钥和账务记录隔离，不是独立租户的管理员或账单系统。

### 需登录的自助初始化预览

为预览分配独立的空状态目录，设 `RELAY_CONSOLE_PREVIEW=1` 启动，不设置 `RELAY_ADMIN_PASSWORD`。只通过要求登录的 Devin 浏览器预览转发该端口；拿到预览地址后，用精确的 HTTPS origin 设置 `RELAY_CONSOLE_PREVIEW_ORIGIN` 并重启同一实例。缺少该设置时初始化始终锁定。

管理员在外部浏览器打开 `/activate-setup`，从本人可信的会话发送确认码。部署人核实身份后，把确认码单独写入状态目录下的 `setup.approved`，权限为 0600；确认有效期为 15 分钟，且只授权发起请求的浏览器。管理员用同一浏览器刷新并在原生向导中创建账号和密码。初始化成功后禁止再次提交，且预览不接受自助注册。两条模拟渠道在初始化成功后自动配置，不发送任何请求到外网。

请保留宿主进程日志以审计 `relay.owner_setup` 事件；事件只记录时间和结果，不含确认码、Cookie、账号或密码。隔离桥接不信任外部转发头，因此 New API 的登录、续期和退出共享同一个来源 IP 的限流配额。此入口仅供小范围试用，不用于团队或对外运营；正式部署须在受控代理后配置可信代理与独立客户端限流。

## 在实验室服务器部署

试用版不公开上游控制台或真实密钥。作为正式接入的前置条件，请确认所用版本已修复上游仍未列出修复版本的 [管理端密钥二次验证公告](https://github.com/QuantumNous/new-api/security/advisories/GHSA-5353-f8fq-65vc)，再放入真实供应商密钥。

1. 通过部署环境的秘密管理能力提供固定、高熵的 `SESSION_SECRET`，然后用 `./run-gateway.sh` 启动；默认只监听 `127.0.0.1:3000`。用服务管理器托管进程并备份持久数据目录（`RELAY_DATA_DIR`，默认为本地状态目录下的 `ai-resource-relay/gateway`）。此入口不启动试用页面或模拟上游。
2. 先通过 SSH 隧道访问本机管理端完成初始化，设置管理员和站点名，关闭开放注册和不需要的登录方式，然后再设置访问入口。不把管理后台公开到互联网；通过 HTTPS 提供控制台时，按 [上游说明](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.51/docs/authentication.md) 设置 `SESSION_COOKIE_SECURE=true` 与精确的 `SESSION_COOKIE_TRUSTED_URL`。只有已知代理应加入 `TRUSTED_PROXIES`。
3. 在 New API 中逐一添加获得授权的上游渠道（如 OpenAI、Anthropic 或 Gemini），在控制台单独测试每条渠道。为 LabHub 新建独立密钥，限制到所需模型与额度，先小流量试运行；不导入个人网页会话或非授权凭据。
4. LabHub 后端使用可从其运行环境访问的私网 HTTPS 地址（例如 `https://relay.internal.example/v1`）和中转密钥。选 OpenAI 兼容渠道：客户端会追加 `/chat/completions`。在 New API 先测试流式响应和实际用量，再验证 LabHub 能按成员计量。本项目没有改动 LabHub 或完成这一生产联调。
