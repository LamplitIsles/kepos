# Kepos Neo 游戏联机场景分析

状态：讨论稿
日期：2026-07-10

## 1. 结论

Kepos Neo 不应承诺“让任意游戏联机”。游戏能否适配取决于协议和产品入口。

当前最清楚的三个场景是：

| 游戏 | Direct-IP 数据面 | TCP MLP | 结论 |
| --- | --- | --- | --- |
| RetroArch netplay | TCP `55435` | 可以 | 很适合验证 person-first 游戏 session |
| Terraria desktop | TCP `7777` | 可以 | 很适合验证 headless dedicated server |
| Stardew Valley PC | UDP `24642` | 有界 UDP service | 已实现 forwarding；真实 join/play 验收待完成 |

平台好友大厅、Steam/GOG relay、反作弊和专有 P2P 不是简单端口代理能够替代的。Kepos 应优先支持游戏自己的 Join via IP 或 host/client 模式。

## 2. 游戏适配分类

### A. 固定 TCP 端口

最适合当前 MLP：

- 游戏或 server 监听固定 TCP 端口；
- 客户端允许手工输入地址；
- 不要求真实客户端源 IP；
- 不依赖广播或额外动态端口。

Kepos 只需为每个玩家建立独立 TCP tunnel。

### B. 固定 unicast UDP 端口

可以做 service-level UDP proxy，但不是 TCP proxy：

- 必须保留 datagram 边界、丢包和乱序；
- 按本地客户端源地址维护独立 session；
- 远端每个 session 使用独立 UDP socket；
- 只允许固定 service target；
- 不补 ACK、重传或可靠排序。

Kepos 的 SecretStream/UDX path 使用加密 unordered message 承载这个最小模型。
当前实现只接受固定目标、IPv4 loopback unicast，单个应用 datagram 上限为
1200 bytes；每个 carrier fragment 最多 1000 bytes，最多两个分片重组，但不
提供可靠重传、广播、组播或任意目的地。

### C. LAN 广播、组播或动态端口

不适合 MLP：

- UDP broadcast discovery；
- mDNS、SSDP 或 multicast；
- payload 内嵌 IP/port；
- server 从动态 endpoint 回包；
- 一局游戏临时打开多个未知端口。

若必须透明模拟整个 LAN，就会走向 TUN/VPN、虚拟二层和路由系统，偏离 Kepos 的 service-only 目标。

### D. 平台大厅和专有 relay

Steam Networking、Steam Datagram Relay、GOG Galaxy 和其他平台协议通常由游戏 SDK 控制。Kepos 不能通过转发一个本地端口接管它们。

正确做法是：

- 游戏提供 Join via IP 时使用该入口；
- 平台路径已经足够好时不介入；
- 不宣传任意 Steam 游戏支持；
- 不尝试绕过反作弊或平台权限。

## 3. RetroArch

### 3.1 网络协议

RetroArch `v1.22.2` 的 netplay gameplay 使用 TCP，默认端口 `55435`。

源码使用 `SOCK_STREAM` 和 `TCP_NODELAY`。握手、逐帧 input、聊天、savestate、同步和 spectator 都在 TCP 连接中。每个 player 或 spectator 是一条独立 TCP connection。

UDP 只用于辅助功能：

- IPv4 LAN broadcast discovery；
- Apple 平台的 mDNS discovery；
- UPnP/SSDP 发现路由器并映射最终的 TCP 端口。

Kepos 自己提供 person/session discovery 后，客户端可以直接连接本机 Kepos listener，不需要代理这些 UDP discovery 功能。

### 3.2 RetroArch 自带 relay

RetroArch 已有 MITM tunnel server：

- host 和 client 都主动连接公网 TCP relay；
- 不需要端口转发；
- 数据不再 P2P direct；
- relay 会增加 RTT，并依赖公服和跨境路径；
- 当前 tunnel 是普通 TCP，不提供 Kepos person trust 和端到端 Noise identity。

因此 Kepos 不是第一次解决 RetroArch NAT 问题。它可能提供的价值是：

- 用已经确认的人际 trust 发起私有 session；
- 不向公开 lobby announce；
- 不依赖 Libretro 公共 relay；
- 优先使用 Holepunch direct path；
- 使用 Noise 做端到端 peer authentication 和 encryption；
- 把 core/content/version 检查放进邀请流程。

### 3.3 Session metadata

可靠的 RetroArch session 至少需要：

- RetroArch build/version；
- core identity 和 version；
- content hash，建议 SHA-256；
- core options；
- player/spectator role；
- host service identity；
- session expiration。

RetroArch 对某些 core version 或 content CRC mismatch 只给 warning，但 rollback netplay 很容易因此 desync。Kepos 产品层应更严格。

MLP 不传输 ROM。它只比较内容 hash，并让用户自行持有合法内容。

### 3.4 最小测试

- 两台桌面使用相同 RetroArch、core 和 ROM；
- 关闭 public announce、UPnP NAT traversal 和 RetroArch MITM；
- host 监听本地 TCP `55435`；
- Kepos 向受信 person 发布 session；
- client RetroArch 连接本机 Kepos listener；
- 测试 play、spectate、late join、2+ clients、断线和 30 分钟会话；
- 记录 tunnel 增加的 RTT、stall、rollback 和 desync。

## 4. Terraria

Terraria desktop `1.4.5.6` 的 direct-IP/dedicated server 默认使用 TCP `7777`。

它非常适合 MLP V1：

- 官方提供真正的 headless `TerrariaServer`；
- Windows 随游戏提供 server，Linux/macOS 可单独下载；
- server 可以运行在 Linux/WSL；
- 玩家可以通过 Join via IP 输入地址和端口；
- 多玩家只是多条 TCP connection；
- gameplay 不要求 UDP。

产品流程可以是：

```text
owner 在 WSL 启动 TerrariaServer
  -> Kepos 发布 Terraria session
  -> 邀请受信 person
  -> 对方接受
  -> 游戏连接本机 Kepos TCP listener
```

Steam lobby 是另一条平台路径，不应被简单 TCP proxy 混用。MLP 应明确引导 Join via IP。

## 5. Stardew Valley

Stardew Valley PC `1.6.15` 的 direct-IP 路径使用 UDP `24642`。它是 host-authoritative：房主保存 world，房主不在线时 farmhand 无法进入。官方没有独立 headless server。

现有 bounded UDP service 可以承载这条形状的 forwarding，但这不等于已经
证明 Stardew gameplay 兼容。最小路径是：

```text
game UDP datagram
  -> local Kepos UDP listener
  -> serviceId + sessionId + payload
  -> encrypted unordered UDX message
  -> owner-side connected UDP socket
  -> Stardew host UDP 24642
```

这个场景不需要桥接 subnet broadcast。当前 PC direct-IP client 会对用户输入的已知地址发送 discovery request，因此可以输入本机 Kepos endpoint。

最小限制应是：

- IPv4 loopback unicast；
- 固定 UDP target；
- 每个 guest/session 独立 owner UDP socket；
- 单个应用 datagram 不超过 1200 bytes；每个 carrier fragment 不超过 1000
  bytes，这是 Kepos 的保守实现上限，不是 Stardew 最大报文证据；
- 60 秒默认 idle timeout；
- session、pps 和带宽硬限制；
- 不做广播、组播、任意目标和可靠重传；有界分片重组不提供丢片恢复；
- 需要已建立的 Kepos 外层路径；本轮未完成真实 Stardew join/play，不能
  将 echo 或自动化 UDP 交换当作游戏验收。

Steam 和 GOG 路径使用平台 lobby/P2P API。Kepos 的 UDP `24642` proxy 只对应 Join via IP，不能取代平台好友路径。

## 6. 游戏为何能验证 person-first

通用网络工具的路径通常是：

```text
加入网络
  -> 找设备
  -> 找 IP/port
  -> 配置游戏
```

Kepos 应验证另一条路径：

```text
选择一个人
  -> 选择一局游戏
  -> 自动检查必要 metadata
  -> 接受邀请
  -> 启动或连接本机游戏
```

这里真正的产品对象是人与会话。TCP/UDP tunnel 只是 adapter。

如果用户仍需手动创建 family、复制端口、配置 Clash、查公网 IP 或理解 relay，那么 person-first 价值没有成立。

## 7. 建议顺序

1. 用 Terraria 验证最简单的 headless TCP server。
2. 用 RetroArch 验证 person、invite、session metadata 和临时 TCP tunnel。
3. 使用可用的 Windows 游戏主机，以隔离配置验证 Stardew join、world sync
   和双向 gameplay；记录真实报文大小和网络路径。
4. 不因为一个游戏扩展到虚拟 LAN、任意 UDP 或平台协议代理。

## 8. 主要来源

### RetroArch

- [Netplay FAQ](https://docs.libretro.com/guides/netplay-faq/)
- [Netplay getting started](https://docs.libretro.com/guides/netplay-getting-started/)
- [Netplay protocol](https://docs.libretro.com/development/retroarch/netplay/)
- [RetroArch netplay frontend](https://github.com/libretro/RetroArch/blob/v1.22.2/network/netplay/netplay_frontend.c)
- [RetroArch netplay private definitions](https://github.com/libretro/RetroArch/blob/v1.22.2/network/netplay/netplay_private.h)
- [RetroArch NAT traversal](https://github.com/libretro/RetroArch/blob/v1.22.2/tasks/task_netplay_nat_traversal.c)
- [Libretro tunnel server](https://github.com/libretro/netplay-tunnel-server)

### Terraria

- [Official Terraria Server](https://terraria.wiki.gg/wiki/Server)
- [Official Terraria Multiplayer](https://terraria.wiki.gg/wiki/Multiplayer)
- [Setting up Steam Multiplayer](https://terraria.wiki.gg/wiki/Guide:Setting_up_Steam_Multiplayer)
- [tModLoader TcpSocket](https://github.com/tModLoader/tModLoader/blob/1.4.5/patches/tModLoader/Terraria/Net/Sockets/TcpSocket.cs.patch)

### Stardew Valley

- [Official Stardew Valley Multiplayer](https://stardewvalleywiki.com/Multiplayer)
- [Stardew Valley Version History](https://stardewvalleywiki.com/Version_History)
- [Official multiplayer troubleshooting](https://www.stardewvalley.net/multiplayer-troubleshooting-guide/)
- [Stardew Valley 1.6 decompiled network mirror](https://github.com/Dannode36/StardewValleyDecompiled)

### UDP transport

- [UDX](https://github.com/holepunchto/udx-native)
- [SecretStream](https://github.com/holepunchto/hyperswarm-secret-stream)
- [RFC 8085](https://www.rfc-editor.org/rfc/rfc8085.html)
