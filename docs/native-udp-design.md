# 原生 UDP 服务：设计与兼容边界

日期：2026-09-09。状态：桌面 UDP forwarding 已实现并通过自动化端到端
验收；Stardew Valley 真实游戏验收尚未完成。
本轮用户决定来自 FlickNote #2231；历史依据为 #1384 与 #1511。
传输语义决定见 [ADR 0011](adr/0011-preserve-datagram-semantics-for-udp-services.md)。

## 已确定的交付范围

- 实现通用、命名、固定目标的 UDP 服务，复用现有设备身份和服务授权。
- 在同一条已认证的 SecretStream/UDX 外层连接上，用加密无序消息承载 UDP；
  不为 UDP flow 创建新的 DHT 连接、Noise 握手或 Protomux data channel。
- 首个真实验收应用是星露谷的 direct-IP 联机。
- 先交付桌面端，只桌面端需要验证；不增加 Android 或独立 CLI 验收要求。
- 沿用当前本机服务投射模型；首轮按 IPv4 loopback 单播设计。
- 本轮不包含 WebRTC/TURN 集成、虚拟局域网、广播或组播发现。

## “原生 UDP”的含义

转发应用数据报的内容和边界，不由 Kepos 保证送达、顺序或可靠重传。
这不意味着复刻原始网络的丢包率、延迟、拥塞行为或源地址。
应用自己实现的重传、顺序控制、加密和会话协议保持在应用层。

一个 UDP Service 对应发布端配置的一个固定目标。订阅端按本地发送者
区分 UDP Flow，发布端为不同 flow 提供独立的目标通信 socket，回复返回
对应的本地发送者。订阅端不能在数据报中指定任意目标地址或端口。
UDP Flow 与现有表示字节流的 Active Service Channel 是不同概念。

## 应用兼容边界

| 应用行为 | 本轮边界 |
| --- | --- |
| 向指定地址和端口发送 UDP，目标向发送源回复 | 核心支持范围，具体应用仍须验收 |
| 多个本地发送者访问同一个服务 | 独立 flow，回复隔离 |
| 应用自行处理丢包、乱序、重传 | 保留该能力；Kepos 不增加可靠顺序交付 |
| 依赖真实客户端 IP 或源端口 | 不透明兼容；目标看到发布端代理 socket |
| 广播、组播、自动发现局域网房间 | 本轮不覆盖；支持手动地址的应用可绕过部分发现步骤 |
| 控制协议协商出其他目标端口或地址 | 固定目标转发不自动跟随，需要额外映射或适配 |
| 在报文内容中嵌入地址，要求对端据此另建连接 | 不自动改写，不能保证兼容 |
| 大数据报、IPv6 或特定 IP 层行为 | 不从 UDP 服务能力推导完整支持，分别验证或另行设计 |
| 任意现有浏览器网站的 WebRTC | 不会因增加 UDP 服务而自动改用 Kepos |

目标 connected UDP socket 的回复来源限制也意味着，应用若从不同端口
回复，不能假定该回复会被接受。flow 过期或外层连接替换后，源端口映射
可能变化；游戏会话不承诺无缝保留。

## 数据报大小和运行边界

本实现对单个应用 datagram 采用 1,200 字节硬上限。每个加密 carrier
envelope 的 payload 上限是 1,000 bytes；1,001 到 1,200 bytes 的应用报文
最多拆成两个有界分片并重组，不做可靠重传。这不是 UDP 协议上限，也不是
已经验证的星露谷最大负载。安装的 libudx 把 1,200 字节作为包含 IP、UDP 和
UDX header 的完整 packet budget；对一个不分片 envelope，按最坏 IPv6 的
68 字节网络/UDX 开销、SecretStream 24 字节、Kepos 信封 23 字节和最大 64
字节 service ID 计算，安全算术上限是 1,021 字节，故 1,000-byte carrier
policy 留出余量：

```text
1200 - 68 - 24 - 23 - 64 = 1021
```

UDX 可能针对具体路径探测到更大的 MTU，但路径、地址族和 direct/relay
状态会改变有效值。分片没有独立重传：丢失一个分片可以导致整个数据报被
丢弃，重组超时或资源受限也会丢弃它，后续完整数据报不等待它。超过 1,200
字节或 carrier 不支持的报文会被丢弃并记录 bounded diagnostic，不会静默
降级为可靠字节流。

实现需要限制 flow 数量、空闲寿命、待发送数据和重组资源，并处理
授权撤销、服务停止和外层重连后的清理。拥塞时不能无限排队。
这些是实现者负责的技术选择，不是待用户确认的配置清单。

本地依赖的 SecretStream 提供 send、trySend 和 message 无序消息接口，
但未完成握手或底层不支持该接口时可能直接不发送。必须验证实际 carrier
能力，不能仅凭方法存在宣称可用。直连、任何配置的中继及路径替换分别核验；
不由现有字节流可用推断无序消息一定可用。
无序消息仍可能与 TCP 服务共享带宽和底层资源，必须检查并发流量下的行为。
本轮不会让原本无法建立 Kepos 连接的 UDP 封锁网络自动变得可用。

## WebRTC 如何复用 Kepos

WebRTC 的 ICE 收集候选地址、执行连接检查并选择路径；STUN 支持地址发现
和连接检查，TURN 提供中继候选。实现支持 TURN 不等于每次连接都必须用 TURN。

Kepos 打洞建立的是自己的 socket 和对端之间的映射及加密通路，不是对两台
机器之间所有 UDP 的放行。浏览器使用自己的 ICE socket，既不能直接继承
该 NAT 映射，也不认识 Kepos 的封装。标准浏览器 API 不接受任意自定义
Kepos 连接作为 ICE 底层传输。

可以通过适配让 WebRTC 报文走 Kepos。TURN 是浏览器已有的标准接入口之一；
若能控制应用、信令或原生 WebRTC 网络接口，也可以探索其他适配方式。
候选地址重写不是通用浏览器兼容保证。

## TURN 何时不需要公网 IP

需要分别满足两条可达性，不能只问 TURN 是否有公网 IP：

| 路径 | Kepos 私网方案中的可达方式 |
| --- | --- |
| TURN 客户端（浏览器）到 TURN 监听入口 | 浏览器通过本机 Kepos 映射访问发布端 TURN |
| WebRTC 对端到 TURN 分配的中继地址 | 对端与 TURN 位于同一可达私网或主机网络，直接通信 |

浏览器通过 TURN 封装收发报文，无须直接访问分配的中继地址；WebRTC 对端
则必须能到达该中继地址，TURN 也必须能向它发包。因此，TURN 与 nosebleed
等对端应用部署在同一可达网络时，原则上不必为 TURN 提供公网 IP。
跨网络的浏览器到 TURN 通路由 Kepos 承担，TURN 不必增加一个公网中转跳点。

普通互联网部署没有这条私有通路，通常使用公网 TURN，或位于 NAT 后但拥有
正确公网地址映射的 TURN；监听端口和分配的中继端口都需要相应可达性。
若 WebRTC 对端是无法访问该私网的任意互联网用户，本方案的私网中继地址
不够，仍需为它提供可达路径。

上述 Kepos + TURN 拓扑是基于标准的可行性判断，尚未完成集成验证。
一个发布端 TURN server 加订阅端普通转发入口可能足够，不要求两端都运行
TURN server。具体仍需验证浏览器地址策略、候选检查、TURN 分配地址、
peer permission、双向可达性和数据报大小。容器共用宿主机不等于网络互通，
也不能假定 localhost 候选或 loopback peer 会被浏览器和 TURN 默认接受。
仅暴露 TURN 监听端口不能证明整条 WebRTC 路径成立。

TURN 能指定 peer，因此将它接入固定目标服务会增加间接目的地选择能力。
未来集成应只允许预定的应用目标，并限制 allocation、寿命和流量；Kepos
对 TURN 服务的授权不能替代 TURN 对后续目的地的约束。

## 完成标准与剩余工作

自动化检查已验证 envelope 边界、无序 carrier adapter、目标/回复隔离、
ACL、并发 TCP、policy revoke、外层 replacement 和保留本机 UDP listener
后的重连恢复。配置和使用过程中不要求用户了解 carrier 或 UDP Flow 内部标识。

一次 Windows NUC 游戏验收尝试无法开始，因为 wrapper 连接的 `nuc` 主机名
DNS 解析失败（`ssh: Could not resolve hostname nuc`）。因此本文件不宣称
Stardew Valley 可以 join 或双向 gameplay；需要可用的 Windows 游戏主机、
隔离的游戏配置和人工/真实游戏验收。所有自动检查使用测试拥有的配置、
目录和进程，不触碰安装中的真实身份或服务状态。实际桌面组合、游戏版本
和网络条件要在验收证据中记录，不能外推到未测平台。

本轮没有必须由用户进一步决定的产品问题；未完成的真实游戏验收是外部环境
阻塞，不改变已经实现的 bounded UDP service contract。

## 依据

- FlickNote #1384：Kepos TCP + UDP multiplex extension（2026-07-18）。
- FlickNote #1511：Holesail lessons for WebRTC-aware Kepos transport（2026-07-23）；其双 TURN 拓扑不是必要条件。
- FlickNote #2231：本次用户决定和边界讨论。
- [现有游戏场景](game-multiplayer-scenarios.md)：星露谷 direct-IP 方案及尚未验证的大小建议。
- [实现证据](evidence/native-udp-implementation-2026-09-09.md)：自动化结果、
  UDX/SecretStream payload 算术及 Windows NUC 阻塞。
- 本地 @hyperswarm/secret-stream README 与 index.js：无序消息接口和发送前置条件。
- [RFC 8835 §3.4](https://www.rfc-editor.org/rfc/rfc8835.html#section-3.4)：WebRTC 的 ICE、STUN/TURN 支持要求。
- [RFC 8656 §3](https://www.rfc-editor.org/rfc/rfc8656.html#section-3)：TURN allocation、监听地址、中继地址和 peer 转发。
