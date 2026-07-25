# Kepos Neo 中间人权限最小化的产品价值

状态：讨论稿
日期：2026-07-17

## 1. 结论

Kepos Neo 不应被定义为自建 Tailscale、轻量 VPN 或另一种端口转发器。

它要验证的价值是：

> 让发现、打洞和中继基础设施只能帮助连接，不能增加成员、扩大权限或解密服务数据。

用户信任某个人之后，可以把一个明确发布的本地服务或一次共同活动交给对方。服务 owner 的本地状态是授权事实，不需要云账号、外部 IdP 或常驻授权 controller 在线批准连接。

这是一种 **controllerless、publisher-authorized 的私有服务与会话网络**。它不是整机或子网级 VPN。

当前阶段的优先级是：

```text
能连
  -> 延迟足够低，且稳定
  -> 用户不需要理解网络
  -> 再按真实风险收紧安全和隐私
```

低延迟是产品成立的门槛，不是发布后的优化项。能建立连接但交互迟钝、抖动明显或频繁绕远路，等同于不可用。Kepos Neo 应优先争取 direct path，并用相对原始网络路径的额外 RTT、p95 RTT、抖动和切换恢复时间判断连接是否有使用价值。

Kepos Neo 不应为了提前完成一套理想身份或 capability 模型，延迟 direct path、低延迟 relay、受限网络兼容性和真实用户验证。当前只保留不能妥协的最低边界：peer 间端到端加密、publisher 本地授权、relay 不持有 endpoint secret。

本文是
[竞争价值分析](./competitive-value-analysis.md) 中“无授权 controller”方向的聚焦补充。原文继续负责完整竞品和产品定位，本讨论稿只说明中间人授权权力为什么值得缩小。它不改变
[MLP decisions](./mlp-decisions.md) 中已经接受的范围，也不承诺尚未实现的身份、权限或 relay 能力。

## 2. 用户真正购买的安全属性

“端到端加密”不足以描述 Kepos Neo 的差异。Tailscale、Headscale、NetBird 和许多其他方案也能保证数据面端到端加密。

Kepos Neo 要减少的是中间基础设施的**授权权力**：

- bootstrap 可以帮助设备进入 DHT，但不能授权 peer；
- DHT 可以帮助发现和打洞，但不能把一个 key 加入 publisher allowlist；
- relay 可以转发密文，但不能开放一个本地服务；
- 每个 publisher 只对自己明确发布的服务负责；
- publisher 不需要询问一个在线 controller 才能接受已信任 peer。

中间设施仍可能拒绝服务、降低连接质量或观察部分元数据。Kepos Neo 不承诺消除所有中间人，而是把它们限制在发现、传输和可用性范围内。

这里的“中间设施”主要指运行时网络路径。软件发布者在能够替换 endpoint 程序时仍属于 trusted computing base；当前讨论稿不声称已经消除这项权力。

## 3. 与主流私网方案的真实差异

| 方案 | 授权事实 | 中间控制面的权力 | 默认资源模型 |
| --- | --- | --- | --- |
| Tailscale | tailnet control plane 的 identity、Grants 和 ACL | 分发成员、网络图和策略；Tailnet Lock 可约束节点加入 | user、node、service、IP 和 port |
| Headscale | 自托管 Headscale policy 和注册状态 | 权力结构与 tailnet controller 相近，只是由 owner 自己运行 | node 和 network service |
| NetBird | Management service 的 peer、group 和 policy | 分发 peer key、地址和访问策略 | peer、network resource 和 route |
| Kepos Neo MLP | 每个 publisher 本地 peer-key allowlist | bootstrap、DHT 和 relay 没有服务授权权 | person、明确发布的 service 和 session |

Headscale 解决的是“谁运行 controller”，不是“controller 是否存在或有多少权力”。NetBird 提供更完整的自托管管理面，但仍以中心 policy 作为授权事实。

Tailscale Tailnet Lock 是最接近 Kepos 原则的成熟能力。它通过受信节点签名约束 control plane 单独加入新节点，但没有移除 control plane 对 tailnet metadata、policy 分发和可用性的作用。

Kepos Neo 的差异不是拥有更强的密码算法，也不是拥有更强的 NAT 打洞。它的差异是：

```text
发现与传输
  不等于
成员与授权
```

## 4. 为什么不是整张虚拟网络

整机 VPN 默认把“加入网络”作为第一步，然后再通过 IP、端口、DNS 和 ACL 缩小权限。

Kepos Neo 从相反方向开始：

```text
确认一个人
  -> owner 明确发布一个服务或会话
  -> 本地验证对方 peer key
  -> 只代理该目标
```

远端不能自行选择 publisher 上的任意 host 或 port。未发布的 SSH、数据库、管理页面和 LAN 设备不会因为建立 trust 自动变得可达。

这个较窄的资源模型有三个价值：

1. 用户不需要理解 TUN、CIDR、路由表或虚拟 IP；
2. publisher 的失误不会自动暴露整台机器或整个子网；
3. 产品可以围绕人、服务和共同活动设计，而不是围绕设备列表设计。

如果用户真正需要的是自己的所有设备互通、子网路由、exit node 或企业网络管理，Tailscale、Headscale、NetBird 或直接 WireGuard 更合适。Kepos Neo 不应在这些能力上竞争。

## 5. Person-first 的价值边界

MLP 的 Person 仍是本地 label，映射到一个或多个 persistent peer key。它目前不是独立、可恢复的协议身份。

因此当前可以诚实声称：

- 用户从“谁”和“对方提供什么”开始，而不是从 IP 和 node 开始；
- trust 是 publisher-local、单向的；
- Alice 允许 Bob 访问，不代表 Bob 自动允许 Alice；
- 同一个命名服务可以长期提供给多个已信任 peer；
- owner 不需要在线逐次批准连接。

当前不能声称：

- 已经存在跨设备 Person root；
- Family 是同步的密码学成员表；
- 已经支持 signed grant、即时 revoke 或身份恢复；
- peer key 等同于经过现实身份验证的人；
- 中间基础设施看不到任何 metadata。

Person-first 首先是一条更短的产品路径。只有真实用户能更容易完成“把这个服务交给这个人”，它才构成产品价值。

## 6. 对 relay 的价值要求

Relay 是否能解密数据不是唯一问题。一个 relay 或 relay controller 如果能够决定谁有权访问服务，仍然拥有过大的权限。

价值篇只保留一个原则：直接 UDX、blind UDX relay 和未来 TCP/TLS 或 WSS relay 应共享同一 publisher authorization，relay 不持有 endpoint secret，也不能授予服务访问。

具体的 admission、quota、metadata 和错误处理属于
[改进讨论](./authority-minimization-improvements.md)，不在价值篇重复设计。在协议和 endpoint 实现正确的前提下，relay compromise 不应导致服务明文泄露或权限提升；它仍可能观察 metadata、消耗资源、攻击实现、降级或阻断连接。

## 7. 必须接受的代价

减少 controller 权力会把一部分责任交还给 endpoint 和用户：

- 初次 key 交换需要可靠核对；
- 丢钥后的恢复更难；
- 不同 publisher 的授权不会自动同步；
- 动态撤销和多设备身份需要单独设计；
- relay 和 bootstrap 仍需要运维；
- UDP、跨网络和受限网络兼容性需要实测；
- 没有中心账号系统代为完成 MFA、offboarding 和审计；
- 用户双方都需要安装和运行 Kepos endpoint。

这些不是可以用文案隐藏的实现细节。它们是 controllerless 模型的直接成本。

## 8. 最可能成立的产品场景

### 8.1 长期家庭服务

Owner 信任少量稳定成员，并明确发布 Navidrome、照片服务、Home Assistant 或个人 Blog。多人可以长期使用，但 relay 和云端不能增加成员。

### 8.2 受信朋友之间的临时活动

目标假设是：用户选择一个已确认的人，发起一局游戏、一次远程协助或一个临时开发预览，未来 session 权限可以随活动结束。当前 MLP 尚未提供自动过期的 session grant。

### 8.3 无账号的个人服务入口

用户持有自己的 key，通过本地 Home 和命名服务进入朋友或自己的 headless 设备，不需要注册一个新的 SaaS 账号。

仅在自己的设备之间做通用网络互通，不足以证明 Kepos Neo 的价值。该需求已有成熟方案。

## 9. 可证伪的价值命题

Kepos Neo 只有在以下命题被真实使用证明时才值得继续：

1. 目标用户在意 relay 和 control plane 没有授权权力；
2. 用户愿意核对长期 key，而不是只接受账号登录；
3. “选择人并打开服务或活动”明显短于配置一张虚拟网络；
4. 用户需要 service/session 范围，而不是整机和子网访问；
5. 多人长期使用一个 publisher service 是稳定需求；
6. controllerless 的价值足以抵消恢复、同步和兼容性的成本。

以下结果应促使项目停止或重新定位：

- 用户只把它理解为更难用的 Tailscale 或 frp；
- 用户只需要自己的设备互通；
- 最终仍必须建设中心账号、全局 roster 和完整 RBAC；
- person/session UX 没有减少操作步骤；
- 大多数连接长期依赖无法负担的 relay；
- 身份、PKI 或 capability 工作持续推迟连接成功率和用户验证；
- 用户并不在意中间基础设施是否具有授权权力。

## 10. 建议定位

建议对外定位：

> 无账号，由服务 owner 本地授权，把一个明确的本地服务或共同活动交给一个已确认信任的人；发现和 relay 只能帮助连接，不能授予访问权。

不建议定位：

> 基于 Holepunch 的轻量 Tailscale。

后者会把 Kepos Neo 拉回虚拟网络、DNS、路由、exit node、ACL 和全球 relay SLA 的竞争，同时丢失它最重要的权限边界。
