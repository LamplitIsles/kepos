# Kepos Neo 竞争价值分析

> Historical discussion of the retired service-proxy product; see [Linux peer VPN](peer-vpn.md) for current behavior.

状态：讨论稿
日期：2026-07-10

## 1. 立场

Kepos Neo 没有比 Tailscale、ZeroTier 更强的打洞原理，也不应尝试复制它们的整张网络能力。

它可能拥有的价值来自更小的控制边界和不同的产品模型：

> Tailscale 从账号和 tailnet 出发，ZeroTier 从网络和节点出发；Kepos 从持久 peer key、某个人的本地 Blog 和命名 localhost service 出发。

MLP 的 person-first 首先是信息架构和使用路径，不是独立 Person root 协议。Person/Device 分层、QR 和 signed grant/revoke 都已延后。

当前确认的硬要求进一步收窄为：

- 不使用外部 IdP 或传统云账号；
- 不运行常驻授权 controller；
- trust 是 owner 本地维护的长期 peer-key allowlist；
- 一个命名 localhost 服务可被多个受信成员并发访问。

在这些条件下，没有找到可以直接使用的完整替代品。但这只是架构空位，不等于已经证明用户需求。

## 1.1 Use / fork / build 结论

| 候选 | 最接近之处 | 淘汰原因 | 当前用途 |
| --- | --- | --- | --- |
| Hypertele | Holepunch、无账号、localhost TCP proxy、key allowlist | 一进程一服务、无 registry/local gateway、无 blind relay、无 library API | 已完成的历史技术 baseline 与迁移来源；当前 runtime 不再依赖它 |
| Magic Wormhole `fowl` | 无账号、named localhost TCP、E2E、direct/relay | 一次性 code、1:1 session、无长期 identity/family、双 NAT 通常经中心 TCP relay | 一次性分享和 UX baseline |
| Headscale + Tailscale | 长期多人、成熟 desktop/headless、P2P/DERP | 常驻授权 controller、tailnet/network-first、localhost service 支持仍有缺口 | 控制器方案的成熟度 baseline |
| ZeroTier self-host | 无 Central 账号、签名 device membership、多人 P2P network | controller authority、虚拟网络、无 localhost service；controller 商业 fork 有许可证限制 | device-network 模型 baseline |
| Syncthing | 无账号、无 controller、长期多设备、direct/relay | 只做文件复制，device-first，无 service/session proxy | 身份、发现和 relay 原理参考 |
| remote.it | named localhost service、多用户分享、本地 endpoint | 云账号、中心授权、闭源核心 | 最接近的 service UX baseline |

历史 P0 曾直接使用固定版本的 Hypertele。随后已经把有价值的 transport、
observability 和 route control 迁入 Kepos，删除 Hypertele runtime，并实现
publisher service registry、hostname gateway 和一条连接上的 Protomux 多服务。
当前验证目标是 Android subscriber 通过 Navic 使用远端 Navidrome，而不是
继续扩展旧 Hypertele P0。迁移来源与许可证边界记录在
[`hypertele-provenance.md`](./hypertele-provenance.md)。

若放弃“无常驻授权 controller”，应停止 Kepos Neo，优先采用 Headscale。若放弃长期多人 trust，应停止 Kepos Neo，优先采用 `fowl`。

## 2. 不能低估现有产品

### 2.1 Tailscale 不只是 IP 和设备列表

Tailscale 已经支持：

- 通过 IdP 定义 user identity；
- Device Sharing，把一台机器分享给另一个指定用户；
- Grants/ACL，对 user、group、tag、device、service 和 TCP/UDP port 授权；
- Tailscale Services，把服务名与具体宿主解绑；
- Serve，把 localhost 服务代理给 tailnet；
- Tailnet Lock，由受信节点签新 node key，限制控制面单独加入节点。

因此 Kepos 不能声称：

- Tailscale 只能按 IP 授权；
- Tailscale 不能命名服务；
- Tailscale 只能暴露整台机器；
- 自签名设备成员是 Kepos 独有。

### 2.2 Headscale 不一定依赖外部 IdP

Headscale 可以使用本地 user 和 pre-auth key，OIDC 是可选项。它解决的是自托管 Tailscale 控制面，而不是 person-to-person 社交关系。

### 2.3 ZeroTier 已有密码学设备身份

ZeroTier 节点会生成自己的 cryptographic identity。Controller 签发网络 membership、tag 和 capability。ZeroTier Central 账号不是节点数据面的身份根。

因此“无传统账号的设备密钥”也不是 Kepos 独有。真正差异必须是 person identity 和人际关系。

## 3. 基本对象对比

| 产品 | 身份根 | 管理边界 | 首要成员 | 首要资源 | 授权方式 |
| --- | --- | --- | --- | --- | --- |
| Tailscale | 外部 IdP 账号 + node key | tailnet | user-owned/tagged node | node、service、IP/port | control-plane Grants/ACL/Sharing |
| Headscale | 本地 user 或 OIDC + node key | 自托管 tailnet | node | node、network service | 自托管 policy |
| ZeroTier | node cryptographic identity | controller 管理的 network | member node | L2/L3 virtual network | controller-signed credentials |
| Kepos Neo MLP | persistent peer key + local Person label | owner-local allowlist | trusted peer | Blog、named localhost service | static key allowlist loaded at startup |

## 4. 真实的原则差异

### 4.1 Person root identity 延后

Tailscale 明确把 user identity 委托给 IdP。个人邮箱和工作邮箱会成为两个身份。账号恢复、MFA 和 offboarding 也由账号体系承担。

Kepos 未来可以让 person public key 成为身份根，通过 QR、线下核对或已有关系确认。MLP 暂时只使用 persistent peer key，并在本地 UI 中映射为 Person label。

这是真实差异，也有真实代价：

- 丢钥恢复更难；
- 人类可读名称不能自动可信；
- 新设备绑定和撤销必须自己设计；
- 没有组织管理员替用户恢复账号。

### 4.2 Static allowlist 先验证长期 trust

Tailscale 的基本关系是 user/node 属于 tailnet。Sharing 是控制面保存的跨 tailnet 分享。

ZeroTier 的基本关系是 controller 授权 node 加入 network。

长期可以考虑保存可离线验证的关系记录：

```text
Alice signs: I trust Bob in family F
Bob confirms: I am joining Alice's family F
```

DHT、bootstrap 和 relay 不具备授权权力。MLP 的授权 SSOT 先是 owner 本地 allowlist；修改后重启 daemon 生效。

这不是独特的身份协议。MLP 必须靠 controllerless、service registry/multiplex、普通 Blog 与本地 gateway 的组合证明价值，不能把静态 key allowlist 包装成 person-to-person cryptographic relationship。

### 4.3 Named session 比 named service 更有差异

Named service 已被 Tailscale Services 覆盖。

Kepos 更有价值的对象是人与人之间有时间和上下文的活动：

```text
Alice 邀请 Bob 加入 RetroArch session X，持续到 22:00
```

Tailscale 可以用 Sharing、Serve 和 Grants 拼出相近的网络效果，但它没有把“这一局游戏”“这次远程协助”作为参与者签名的产品和协议对象。

### 4.4 无授权控制器

Tailscale、Headscale 和 ZeroTier 都有控制面权威。它们的数据面可以 P2P，所以“数据不经过中心”不是 Kepos 独有。

Kepos 的不同之处可以是：

- 没有必须注册的授权账号；
- 没有必须自托管的授权数据库；
- bootstrap 和 relay 不能增加成员；
- publisher 本地 allowlist 才是 MLP 授权事实。

这不代表没有服务器。bootstrap、relay、更新和可观测性仍然需要基础设施。

“无授权 controller”也不等于“没有 publisher authority”。Publisher 仍决定自己的 allowlist，并在本地验证连接 key，不需要在每次连接时查询中心数据库。

这带来明确限制：MLP 修改 allowlist 后需要重启 publisher 才加载；不同 publisher 的 allowlist 不自动同步。Signed grant/revoke 与跨设备传播属于后续范围。

### 4.5 One-to-many family service

`fowl` 的基本会话只有两个 peer。Hypertele 的静态 allowlist 可以接多个 client，但没有 person、family、service lifecycle 或签名状态。Headscale、ZeroTier 和 remote.it 可以多人访问，但授权依赖 controller 或云账号。

Kepos 的目标路径是：

```text
publisher 一次把 Alice 与 Bob 的 peer key 加入 allowlist
  -> headless 发布一个命名 Navidrome TCP service
  -> Alice 与 Bob 同时连接
  -> service host 本地验证 peer key
```

这比一次性 tunnel 更适合长期家庭服务，也比 virtual network 更窄。它是当前最具体的竞争价值假设。

### 4.6 Service-only UX

Tailscale 和 ZeroTier 的主模型是网络与节点。Tailscale 已有 Serve、Services 和 tsnet，所以它在技术上也能做 service-level access。

Kepos 的优势只能来自默认路径更短：

```text
确认这个人
  -> 选择这次活动
  -> 对方本机打开
```

用户不应看到 TUN、CIDR、DNS、ACL 文件、设备 IP 或路由表。

MLP 采用一个不修改系统 DNS 的本地 HTTP gateway：

```text
alice-a1b2.kepos.localhost:<gateway-port>
navidrome.alice-a1b2.kepos.localhost:<gateway-port>
```

它提供接近 MagicDNS 的人类可读名称，但不安装 TUN、DNS resolver 或 Android `VpnService`。Blog 和 HTTP service 可以互相使用普通链接；raw TCP 游戏仍由 Kepos 分配本地端口。

## 5. Kepos 不应竞争的能力

- 整机和整个子网互通；
- 企业 SSO、SCIM、审计和多管理员；
- 跨平台 VPN 和 exit node；
- DNS、路由和虚拟二层网络；
- 全球成熟 relay SLA；
- 公开 Web 服务和匿名分享。

在这些方向上，直接采用 Tailscale、Headscale、ZeroTier 或 Cloudflare Tunnel 更合理。

## 6. 竞争定位

有价值的定位：

> 无账号，由人自己持有身份，把一个本地服务或游戏会话交给一个已确认信任的人。

没有足够价值的定位：

> 用 family trust 后访问命名 TCP 服务的轻量 Tailscale。

后者会直接撞上 Tailscale Sharing、Grants、Services、Serve，用户不会只为更纯粹的密码学承担更差的网络覆盖和恢复体验。

## 7. 原理上的优势与劣势

### 优势

- peer identity 和 allowlist 可以脱离 SaaS 账号及 IdP；
- 不需要中心服务在线决定某个 key 能否连接；
- 每个 publisher 独立控制自己暴露的服务；
- 不创建虚拟网卡，不扩大到整个设备网络；
- relay 不能凭自己的数据库提升权限。

### 劣势

- 不能借用成熟账号恢复、MFA 和组织管理；
- MLP 的 Person 只是本地 label，不是可恢复、跨设备的协议身份；
- 网络成功率、relay 覆盖和平台支持远弱于成熟产品；
- 用户双方都必须安装客户端；
- service/session 适配需要逐类验证；
- full-family trust 可能比 Tailscale 的细粒度 Grants 更粗。

## 8. 必须验证的产品命题

1. 用户是否愿意手工交换和核对长期 peer key，而不是直接登录账号。
2. “选择人并发起活动”是否明显短于配置 Tailscale Sharing/Serve。
3. 用户是否理解 publisher-local allowlist 和 service availability 的区别。
4. 人们是否需要 named session，还是长期 service 就足够。
5. publisher-wide allowlist 是否对朋友和临时协作者过宽。
6. 无账号的价值是否足以抵消手工 key 管理成本。
7. 目标用户是否真的在意 relay/control plane 没有授权权力。

## 9. Kill criteria

- 用户只能描述“它是另一个 VPN/端口映射工具”；
- person-first 流程没有比 Tailscale Sharing 更短；
- 用户仍需理解设备、端口、relay 和网络；
- 为了恢复、同步和组织管理重新建设一套中心账号系统；
- full-family trust 必须演化成完整 RBAC 才有人愿意使用；
- 唯一稳定需求是自己的设备互通；
- 网络和 relay 成本远高于 person/session 带来的价值。

## 10. 官方参考

- [Tailscale identity](https://tailscale.com/docs/concepts/tailscale-identity)
- [Tailscale tailnet](https://tailscale.com/docs/concepts/tailnet)
- [Tailscale Device Sharing](https://tailscale.com/docs/features/sharing)
- [Tailscale Grants](https://tailscale.com/docs/features/access-control/grants)
- [Tailscale Services](https://tailscale.com/docs/features/tailscale-services)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Tailnet Lock](https://tailscale.com/docs/features/tailnet-lock)
- [Headscale registration](https://headscale.net/stable/ref/registration/)
- [Headscale policy](https://headscale.net/stable/ref/policy/)
- [ZeroTier protocol](https://docs.zerotier.com/protocol/)
- [ZeroTier controller](https://docs.zerotier.com/controller/)
- [ZeroTier rules](https://docs.zerotier.com/rules/)
