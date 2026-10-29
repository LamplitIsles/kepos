# Kepos Neo 用户与需求分析

> Historical discussion of the retired service-proxy product; see [Linux peer VPN](peer-vpn.md) for current behavior.

状态：讨论稿
日期：2026-07-10

## 1. 结论

Kepos Neo 不应被定义为“小型 Tailscale”或“P2P 端口转发器”。

它更合理的产品定义是：

> 人们先交换并确认长期 peer key，再把一个本地服务或一次共同活动交给对方使用。

网络连接是实现手段。用户面对的对象应是人、关系、服务和会话，而不是节点、IP、子网和路由。

这个方向有潜力，但还没有被 MLP 自动证明。MLP V1 只能证明底层代理可行；还需要用真实用户任务证明“以人为中心”比传统账号网络或设备网络更简单。

## 2. 第一公民

建议把 MLP 产品对象限制为：

- **Person**：本地名称和展示信息，映射到一个或多个长期 peer key。
- **Peer**：持有 HyperDHT/Noise key 并实际联网的端点。
- **Trust**：publisher 本地维护的单向 peer-key allowlist。
- **Family**：本地 UI 分组，不是共享或同步的授权 roster。
- **Service**：某台设备上显式发布的本地能力。
- **Session**：人与人围绕某个服务进行的一次临时活动。

不需要重新加入聊天、动态、帖子、关注、群聊或内容流。这里的“社交”只表示：

```text
我知道你是谁
  -> 我信任你
  -> 我邀请你使用这个东西
  -> 我们完成一次共同活动
```

如果 UI 最终仍是设备列表、IP、端口和 relay 配置，只把 `device` 改名成 `person`，就不算 person-first。

## 3. 最有希望的用户

### 3.1 有 WSL、NAS 或家庭服务器的人

这类用户已经有明确的本地服务，也愿意安装 headless daemon。

典型需求：

- 在自己的另一台电脑上打开 WSL 里的 SSH、数据库或开发服务；
- 让家人访问 NAS、照片服务或家庭管理页面；
- 临时让受信朋友查看本地 AI、Jupyter 或开发预览；
- 在没有公网 IP 和路由器权限时访问自己的服务。

这类用户适合验证网络和 daemon，但不一定证明长期产品价值。若需求只是自己的设备互通，Tailscale 已经很成熟。

### 3.2 有固定共同活动的受信朋友

典型需求：

- 发起一次 RetroArch 对局；
- 加入 Terraria 私服；
- 临时共享一个协作工具；
- 远程协助处理某台电脑上的本地服务。

这类场景最能体现 person-first：用户的目标是“和 Neil 玩这一局”，不是“连接节点 A 的 55435 端口”。

当前 full-family 权限对普通游戏好友可能太重。MLP 可以先接受这个限制，但必须观察用户是否因此拒绝建立 trust。

### 3.3 小型稳定家庭

Family 模型适合人数少、成员稳定、owner 明确的家庭：

- owner 对成员有最终授权权；
- 所有成员知道彼此身份；
- 设备数量有限；
- 不需要组织级 RBAC、审计或多管理员。

它不适合临时访客、大型群组、公司部门或频繁变化的协作者。

### 3.4 长期家庭服务

Navidrome、家庭照片、Home Assistant、开发服务和管理页面比一次性 echo tunnel 更能验证产品边界。

典型路径：

```text
owner 一次 trust 多位家庭成员
  -> headless 设备长期发布 Navidrome
  -> 多位成员可以同时访问
  -> owner 不需要在线逐次批准
```

Navidrome 是 HTTP/TCP 服务，适合当前 TCP proxy。Kepos 提供网络可达性和 family 身份边界，不替代 Navidrome 自己的用户、媒体权限和应用认证。

Android 已确定只做 subscriber。当前移动端成功标准是让 Navic 通过固定
localhost 地址使用远端 Navidrome，并在 UI 关闭、锁屏和网络切换后保持或
恢复代理；Kepos 不承担音频播放。

## 4. Jobs to be done

### Job A：访问自己的 headless 服务

```text
安装 daemon
  -> 信任自己的另一台设备
  -> 选择一个命名服务
  -> 在 localhost 打开
```

作用：验证 identity、trust、发现、TCP proxy、持久化和 headless 生命周期。

风险：这可能只是较弱的 Tailscale。它是 MLP 验证场，不应自动成为最终定位。

### Job A2：多人长期访问一个家庭服务

```text
owner trust Alice 和 Bob
  -> headless 发布 Navidrome
  -> Alice 与 Bob 分别从本地入口连接
  -> 两人可并发使用
```

作用：验证 Kepos 与一次性 `fowl`、1:1 配对工具和整网 VPN 的真实差异。

关键证据是 publisher 不需要常驻 controller，也不需要为每次连接重新发 code；服务端只验证连接 key 是否在 publisher-local allowlist 中。

### Job B：把一个本地服务交给受信的人

```text
打开对方的人物页
  -> 选择服务或活动
  -> 发送邀请
  -> 对方接受并在本机打开
```

作用：验证 person-first 是否真实缩短用户路径。

关键差异不是能不能转发 TCP，而是用户不需要注册账号、加入网络、理解 ACL、查 IP 或配置路由。

### Job C：发起一次游戏会话

```text
选择朋友
  -> 选择游戏和本地实例
  -> 检查版本与内容
  -> 建立私有连接
  -> 游戏结束后关闭会话
```

作用：验证 trust、presence、邀请、named session 和本地进程适配是否能组成完整产品价值。

## 5. 明确不适合的需求

- 让没有安装 Kepos 的公众访问服务；
- 整个办公室的网络、DNS、子网路由和设备管理；
- 需要 SSO、审计、多管理员、组织离职流程的企业；
- 任意 LAN 广播、组播或虚拟二层网络；
- 依赖平台大厅、反作弊或专有 relay 的任意 Steam 游戏；
- 需要公网 SLA，但又不愿承担 relay 和 bootstrap 运维；
- 对 owner 丢钥恢复和即时撤销有强保证的安全场景。

## 6. MLP 的 Person 与 Device 边界

MLP 先不引入 Person root 和 Device attestation。一个长期 peer public key 同时承担传输身份和 allowlist 条目：

```text
本地 Person 名称
  -> 一个或多个 peer public key
  -> owner allowlist
```

HyperDHT/Noise 证明远端持有该 key。Owner 通过静态 allowlist 决定是否接收连接。修改 allowlist 后重启 daemon 生效，并断开已有 session。

一个朋友有多台设备时，MLP 先保存多个 key，并在 UI 中用同一个本地 Person label 分组。Person root、设备证明、动态撤销、恢复和跨设备同步全部延后。

因此 MLP 的 person-first 主要是产品信息架构：用户从某个人的 Blog 和服务开始，而不是从 Node ID、IP 和端口开始。协议身份仍是 device/peer key，这一点必须诚实标注。

## 7. 最小社交 UX

MLP 不需要做社交应用，但至少需要：

- 显示人的名称、头像或本地备注以及公钥指纹；
- P0 通过带外方式手工交换和核对 peer key；QR 延后；
- 清楚显示哪个 publisher allow 哪些 peer key；
- 从人的页面发起服务或游戏会话；
- 显示对方当前哪些服务可用；
- 能关闭会话、撤销 trust 和查看影响范围；
- 不把设备、端口和 relay 作为默认主导航。

设备、连接路径和错误码仍然需要存在，但属于诊断界面。

P0 自带一个极小的静态 Home/Hello World fixture，用来验证 bootstrap 和
Registry 链路。它不是 CMS 或 Blog 产品。后续每个人可以把普通静态 HTML、
Hugo、Astro 或任何本地 HTTP 应用注册为自己的 Blog；Kepos 不实现编辑器、
内容存储或内容同步。Blog 与 Navidrome 一样，只是一个注册的本地 HTTP
service，并可通过普通链接指向其他 Kepos HTTP 服务：

```text
http://alice-a1b2.kepos.localhost:17480/
http://navidrome.alice-a1b2.kepos.localhost:17480/
```

本地 HTTP gateway 根据 hostname 找到 person 和 service，再建立 P2P tunnel。这样用户看到的是人与链接，不需要理解 key、远端 IP 或动态端口。

非 HTTP 服务仍以 Connect 动作创建本地 TCP endpoint。Blog 链接可以先打开 Kepos action，再显示或启动该 endpoint。

Kepos 不读取或修改 Blog 与应用内容，也不为服务修复 Host、Cookie、redirect、CORS、CSP 或 OAuth 配置。服务必须能够通过本地入口正常工作。

## 8. 验证指标

MLP 不看下载量，先看任务是否完成：

- 从安装到第二个人或第二台设备打开第一个服务，中位数少于 10 分钟；
- 至少 80% 的首次成功不需要端口映射、Clash 规则或人工协助；
- 至少 90% 的测试者能正确回答谁可以访问哪个服务；
- 从 allowlist 删除 key 并重启 publisher 后拒绝该 key 的新连接；
- 安装 headless 的 owner 中，至少 70% 在 30 天内使用三次；
- 至少一半用户在第一个 demo 之后主动发布第二个服务或会话；
- 游戏会话在一次邀请内开始的成功率达到 8/10；
- 30 分钟游戏会话完成率达到 95%。

## 9. 停止条件

出现以下情况时，应停止或调整方向：

- 用户普遍评价为“更难用的 Tailscale/frp”；
- 超过 20% 的首次连接需要手改网络或 Clash；
- full-family 权限让用户不愿添加真实朋友；
- 用户不愿安装常驻 headless，或 30 天实际使用率低于 30%；
- 用户只在自己的设备间使用，且 person/session UX 没有产生额外价值；
- relay 成为大多数连接的长期路径，而成本无法承担；
- 社交模型不断要求聊天、内容流和复杂权限，重新造成项目膨胀。

## 10. 当前判断

当前验证顺序是：

1. 已完成：用 Hypertele P0 验证持久 key、allowlist、Home 和多 client
   语义；该 runtime 已迁移并删除。
2. 已完成：用 Kepos 自有 HyperDHT/Protomux runtime 在 Mac 与
   kosmos-wsl 间跑通 Home、Navidrome、SSH、multiplex 和重连。
3. 下一步：完成 Android subscriber-only host spike，证明 Kotlin
   foreground service 能持续拥有 Bare Kit Worklet 和 localhost gateway。
4. 随后用 Navic + Navidrome 验证锁屏播放、持续流量、Wi-Fi/蜂窝切换
   和固定 localhost URL。
5. 有真实移动 dogfood 后，再决定优先做 macOS 桌面壳、扩展更多服务，
   还是验证多 subscriber 与受信分享场景。
