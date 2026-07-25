# Plan: MLP V0 / P0 Hypertele Home Hello World

状态：待执行
日期：2026-07-10
目标仓库：`/Users/neil/Code/guion-opensource/kepos-neo`
目标分支：`feat/mlp-v0-hypertele-home`
依赖：远端 `main` 基线已初始化（已满足）

## 1. Goal

在一台桌面电脑上直接使用固定版本的 Hypertele，证明最小链路：

```text
publisher allowlist
  -> Hypertele Home server
  -> HyperDHT / Noise / UDX
  -> allowlisted Hypertele client
  -> localhost HTTP
  -> default Home page and Registry
```

这里的 P0 是 MLP V0 的第一个技术执行切片。它只验证 Hypertele baseline
和最小 Home 集成，不单独完成 MLP V0 的现有产品与用户价值 gate，也不是
MLP V1。

同一桌面运行一个 publisher 和两个独立 client identity。P0 必须证明：

- `homeKey` 是唯一 publisher 入口；
- `clientKey` 在 allowlist 中时可以访问 Home；
- 未授权 key 被 Hypertele firewall 拒绝；
- 修改 allowlist 后，重启 publisher 才加载新 trust；
- 两个 allowlisted client identity 可以同时打开同一个 Home；
- Home 提供人类页面和 `/.well-known/kepos/services.json`；
- 所有 secret 和临时状态都留在被 Git 忽略的目录。

## 2. Evidence boundary

P0 是单机协议和进程 smoke，不得作为以下结论的证据：

- 独立设备互通；
- 公网 DHT 可达性；
- NAT hole punching 或 CGNAT 成功率；
- 受限网络或跨区域网络质量；
- Android 生命周期；
- blind relay、TCP relay 或生产可用性；
- Hypertele backpressure 和长时间流媒体性能已经合格。
- 目标用户愿意为 controllerless、person-first service sharing 承担手工
  key 管理成本，或 Kepos 已经通过 MLP V0 产品价值 gate。

第一份真实跨设备、跨局域网证据必须等 Android client-only spike 完成后，用桌面宽带与手机蜂窝网络执行。

## 3. Anti-goals

本计划不实现：

- `*.kepos.localhost` 本地 gateway；
- 客户端自动拉取或消费 Registry；
- 多服务 publisher registry；
- Hypertele fork、library API 或源码修复；
- multiplex、Protomux 或单 daemon；
- Navidrome、RetroArch、Terraria 或 UDP service；
- QR、Person/Device 分层、signed grant/revoke 或动态 trust；
- desktop GUI、Android、relay、system DNS 或 VPN；
- CMS、Blog editor、文章数据库或内容同步。

## 4. Confirmed upstream behavior

计划基于 `hypertele@1.1.4` npm 发布包，而不是 README 推测：

- `hypertele-server` 接受 `-l <target-port>`, `--address`, `-c <config>`, `--seed`；
- server config 支持 `{ "seed": "...", "allow": ["clientPublicKey"] }`；
- `hypertele` client 接受 `-p <local-port>`, `--address`, `-i <identity.json>`, `-s <homeKey>`；
- identity JSON 是 `{ "secretKey": "hex", "publicKey": "hex" }`；
- server 在启动时一次性读取 allowlist；
- server 把缺失或 `null` 的 `allow` 当作 allow-all，而 `allow: []` 才是
  deny-all；Kepos 必须在启动前校验并 fail closed；
- 未公开的 `--bootstrap <port>` 可连接 isolated HyperDHT testnet；
- publisher stdout 是 `hypertele: <homeKey>`；
- client stdout 是 `Server ready @127.0.0.1:<port>`；
- `-p 0` 会请求 OS 分配 ephemeral port，ready 行包含实际端口；
- Hypertele 的 graceful signal handler 以 code `130` 退出；
- Hypertele 和 HyperDHT 都不发布 TypeScript declaration；
- `--private` 会共享 publisher seed，P0 禁止使用；
- `--compress` 的 chunk 处理不可靠，P0 禁止使用。

审计时已在 macOS + Node `22.23.1` 跑通 isolated allow/deny/restart/two-client
smoke。Hypertele 未声明 `engines`，上游 CI 只覆盖过 Node 18；这不是
Linux、WSL 或 Windows 上的 Node 22 兼容性证据。

## 5. Repository shape after P0

```text
kepos-neo/
  .gitignore
  .node-version
  README.md
  package.json
  package-lock.json
  tsconfig.json
  src/
    config.ts
    keys.ts
    home/
      registry.ts
      server.ts
    p0/
      setup.ts
      publisher.ts
      client.ts
      hypertele-process.ts
  home/
    index.html
    styles.css
    styles.input.css
  test/
    config.test.ts
    keys.test.ts
    home.test.ts
    hypertele-process.test.ts
    hypertele-smoke.test.ts
  tmp/
    p0/                       # generated, gitignored
  docs/
    evidence/
      p0-single-desktop.md
```

`home/styles.css` 是可重复生成并提交的静态产物，使默认 Home 在安装后不依赖 Tailwind CLI 才能显示。

## 6. Task 1: Scaffold the Node/TypeScript workspace

Files:

- `.gitignore` (create)
- `.node-version` (create, Node 22)
- `README.md` (create)
- `package.json` (create)
- `package-lock.json` (create via npm)
- `tsconfig.json` (create)

Steps:

1. 在远端 `main` 初始化完成后，拉取 `main` 并创建 `feat/mlp-v0-hypertele-home`；不得直接推 `main`。
2. 创建 private npm package，固定 Node 22 LTS；`package.json` 使用 `"type": "module"` 和 `engines.node: ">=22 <23"`。
3. 运行：

   ```bash
   npm install --save-exact hypertele@1.1.4 hyperdht@6.20.1
   npm install --save-dev typescript tsx @types/node tailwindcss @tailwindcss/cli daisyui
   ```

4. 配置 TypeScript `module`/`moduleResolution` 为 `NodeNext`，开启 strict mode 和 `noEmit`。Hypertele 是 CommonJS CLI，后续通过 `createRequire(import.meta.url)` 解析其 subpath，不导入缺失的 package main。未带类型的 HyperDHT export 只能经过一个窄 `createRequire` wrapper 和本地 typed interface，不能把 `any` 扩散到 domain code。
5. 配置 scripts：

   ```json
   {
     "typecheck": "tsc --noEmit",
     "test": "node --import tsx --test",
     "build:home": "tailwindcss -i home/styles.input.css -o home/styles.css --minify",
     "p0:setup": "tsx src/p0/setup.ts",
     "p0:home": "tsx src/home/server.ts",
     "p0:publisher": "tsx src/p0/publisher.ts",
     "p0:client": "tsx src/p0/client.ts"
   }
   ```

6. `.gitignore` 至少忽略 `node_modules/`, `tmp/`, logs, coverage 和本地 secret/config override。
7. `README.md` 只说明 P0 目的、非目标、Node/npm 前置和 secret 不得提交；不要提前写未来产品功能。
8. 运行 `npm ci`、`npm run typecheck`，预期 exit 0。
9. 检查 `git diff --cached` 后提交：

   ```text
   chore(repo): scaffold the Hypertele P0 workspace
   ```

## 7. Task 2: Generate persistent P0 keys and configs

Files:

- `src/config.ts` (create)
- `src/keys.ts` (create)
- `src/p0/setup.ts` (create)
- `test/config.test.ts` (create)
- `test/keys.test.ts` (create)

Required output under `tmp/p0/`:

```text
publisher.json
client-a.identity.json
client-b.identity.json
client-a.contact.json
client-b.contact.json
```

Config semantics:

- `publisher.json` uses Hypertele's native `{ seed, allow }` format；
- `allow` 必须存在且是合法 client public-key hex array；空数组表示
  deny-all，missing、`null`、non-array 或 malformed entry 都必须让 Kepos
  拒绝启动，不能把 fail-open config 传给 Hypertele；
- client identity uses Hypertele's native `{ secretKey, publicKey }` format；
- each contact stores the pinned `homeKey`, local label, and requested local port；
- P0 contacts default `requestedLocalPort` to `0`, meaning that Hypertele asks
  the OS for an ephemeral loopback port; the resolved runtime port is not
  persisted as identity or trust state；
- `homeKey` is derived from the publisher seed with `HyperDHT.keyPair(seed)`；
- publisher seed、`homeKey` and client public keys are exactly 32 bytes / 64
  hex chars; client secret keys are exactly 64 bytes / 128 hex chars；
- parsing a client identity re-derives its HyperDHT keypair from the 32-byte
  seed portion and rejects a mismatched public or secret key before spawn；
- no `publisherKey` or Person root exists；
- generated secret-bearing files use owner-only permissions where the OS supports it；
- `p0:setup` is create-once and idempotent: a complete valid `tmp/p0/` is
  validated and preserved byte-for-byte, while partial or invalid existing
  state fails without regenerating or overwriting any key；
- first creation writes the complete file set into an owner-only temporary
  sibling directory and renames it into place only after every file validates；
- logs print public keys and paths, never seed or secret key。

TDD steps:

1. 写 failing tests：32-byte publisher seed、HyperDHT-compatible client keypair、exact public/secret hex lengths、round-trip parse、mismatched identity rejection、secret file mode、空 `allow` 被接受为 deny-all、missing/`null`/non-array/malformed `allow` 被拒绝、second setup preserves every key，以及 partial existing state refuses overwrite。
2. 运行：

   ```bash
   npm test -- test/keys.test.ts test/config.test.ts
   ```

   预期 tests fail for missing implementation。
3. 实现最小 key/config functions 和 `p0:setup`。
4. On first creation, `p0:setup` 默认生成 publisher、client A、client B，并把 A 加入初始 allowlist；B 留作 denied/restart 测试。On later runs it validates and preserves the complete existing state。
5. 再次运行 focused tests，预期全部通过。
6. 运行 `npm run p0:setup`，确认文件只出现在 `tmp/p0/`，`git status --short` 不显示 secret。
7. 检查 `git diff --cached` 后提交：

   ```text
   feat(p0): add persistent Hypertele key setup
   ```

## 8. Task 3: Add the default Home and Registry endpoint

Files:

- `src/home/registry.ts` (create)
- `src/home/server.ts` (create)
- `home/index.html` (create)
- `home/styles.input.css` (create)
- `home/styles.css` (create/generated)
- `test/home.test.ts` (create)

HTTP contract:

```text
GET /                                      -> default Home HTML
GET /styles.css                            -> local compiled CSS
GET /.well-known/kepos/services.json       -> Registry JSON
GET /healthz                               -> 200 text/plain
other path                                 -> 404
```

Initial Registry shape:

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "publisher": {
    "displayName": "Local Publisher"
  },
  "services": [
    {
      "id": "home",
      "name": "Home",
      "kind": "http",
      "serviceKey": "<homeKey>"
    }
  ]
}
```

Rules:

- bind only `127.0.0.1`；
- Registry `home.serviceKey` must equal the derived `homeKey` passed at startup；
- JSON includes no target host/port, command, script, client key, seed, or secret；
- return `ETag: "<revision>"`; a matching `If-None-Match` returns `304` with no
  body; no polling or push in P0；
- Home is a small Hello World/instruction page, not a CMS；
- arbitrary user Blog replacement is later scope；
- no inline script and no privileged WebView assumption。

UI implementation:

- install Tailwind CSS 4 and daisyUI 5 locally；
- `home/styles.input.css` contains `@import "tailwindcss";`, `@plugin "daisyui";`, and an explicit source reference to `home/index.html`；
- use daisyUI `navbar`, `list`, `link`, and `status` components；
- use semantic `base-*` colors; no custom theme, gradients, decorative cards, or external assets；
- display publisher name, a short explanation, one Home service row, online status, and Registry link；
- the page remains readable at narrow Android and desktop widths。

TDD steps:

1. 写 failing HTTP tests for all four routes, content types, Registry schema, homeKey binding, ETag and 404。
2. 运行 `npm test -- test/home.test.ts`，预期 fail。
3. 实现 Registry builder、loopback HTTP server 和 static responses。
4. 运行 `npm run build:home` 生成本地 CSS；不得使用 CDN。
5. 运行 focused tests and `npm run typecheck`，预期全部通过。
6. 启动 `npm run p0:home`，用浏览器和窄窗口人工检查无溢出、无重叠，Home 与 Registry link 可打开。
7. 检查 `git diff --cached` 后提交：

   ```text
   feat(home): add the default publisher home endpoint
   ```

## 9. Task 4: Supervise Hypertele publisher and client processes

Files:

- `src/p0/hypertele-process.ts` (create)
- `src/p0/publisher.ts` (create)
- `src/p0/client.ts` (create)
- `test/hypertele-process.test.ts` (create)

Process rules:

- do not import `hypertele` as a library; its declared `main` file is missing；
- resolve `hypertele/server.js` and `hypertele/client.js` from the installed package, then spawn them with `process.execPath`；
- publisher starts Home on a random loopback target port, then starts `hypertele-server -l <port> --address 127.0.0.1 -c <publisher.json>`；
- publisher parses stdout and asserts the emitted key equals the locally derived `homeKey`；
- client starts `hypertele -p 0 --address 127.0.0.1 -i <identity> -s <homeKey>` and parses the assigned loopback port；
- print the local Home URL only after Hypertele reports ready；
- use a 30-second readiness timeout for public-DHT commands and allow the
  isolated test harness to override it to 10 seconds；
- pass optional `--bootstrap` only from the test harness, never normal user config；
- never pass `--private`, `--compress`, `--cert-skip` or non-loopback bind；
- redact seed and secret keys from arguments shown in logs；
- intentional shutdown 先标记 child stopping，发送 SIGTERM，最多等待五秒；
  只有在该状态下，Hypertele exit code `130` 才视为预期，然后关闭 Home
  并 await 所有 child exit；
- 五秒内未退出则发送 SIGKILL、await exit、记录 forced shutdown，并让
  supervisor exit non-zero；
- child error 或未进入 stopping 状态的任何 exit 都让 supervisor exit
  non-zero，包括 unsolicited code `130`。

Steps:

1. Write focused tests for publisher/client readiness parsing, readiness
   timeout, intentional code `130`, unsolicited code `130`, and forced-kill
   escalation. Avoid mocking the end-to-end network path。
2. Implement child resolution、readiness parsing、intentional-stop state、
   five-second signal/KILL timeout 和 awaited cleanup as isolated helpers。
3. Implement publisher and client CLIs using the files from `tmp/p0/` by default, with explicit override flags for tests。
4. Run `npm run typecheck` and focused tests, expected exit 0。
5. Start publisher/client once against the public default DHT on the single desktop; verify the client prints a loopback URL without leaking secrets。
6. Stop both and confirm no child Hypertele process remains。
7. 检查 `git diff --cached` 后提交：

   ```text
   feat(p0): supervise Hypertele publisher and clients
   ```

## 10. Task 5: Verify allowlist, restart, and one-to-many locally

Files:

- `test/hypertele-smoke.test.ts` (create)
- `docs/evidence/p0-single-desktop.md` (create)

Automated isolated-testnet cases:

1. Start a three-node `hyperdht/testnet` and pass one bootstrap port to child processes。
2. Start Home and publisher with `allow: []`。Wait for client A to report
   ready, then verify a request produces no HTTP response before a three-second
   timeout。Accept timeout、`ECONNRESET` or socket hangup, but no HTTP status or
   body and no exact upstream error string。
3. Restart publisher with only client A in allowlist。
4. Start client A and verify `GET /`, Registry, and health return expected content。
5. Start client B, wait for its local listener to report ready, then make the
   same three-second no-response assertion。Client readiness alone is not proof of
   remote authorization。
6. While publisher remains running, rewrite its config to allow A and B。Retry
   through B and confirm it is still denied, proving the running process did
   not hot-reload trust。
7. Stop publisher, await its exit, then restart with the same seed/homeKey and
   updated config。
8. Verify A and B can concurrently fetch Home and Registry。
9. Stop and await every process and testnet node even when an assertion fails。

Fresh verification commands:

```bash
npm ci
npm run build:home
npm run typecheck
npm test
npm run p0:setup
```

Expected result：all commands exit 0; tests include deny-all、malformed-config
fail-closed behavior、allow、no hot reload、restart、stable homeKey、intentional
exit `130` and two-client concurrency。

Manual public-DHT single-desktop smoke:

1. Run publisher using the generated config。
2. Run client A, open its printed local URL, and verify Home + Registry。
3. Run client B before allowlist reload and record rejection。
4. Add B public key to publisher allowlist, restart publisher, reconnect A and B, and open both URLs concurrently。
5. Record Node version, Hypertele version, OS, local ports, public Home key, timestamps, outcomes, process RSS, and relevant non-secret logs in `docs/evidence/p0-single-desktop.md`。
6. State prominently that this was one physical desktop and is not NAT/cross-device evidence。

Final review:

- `git status --short` contains no `tmp/`, seed, identity JSON, logs or unrelated files；
- `git ls-files 'tmp/**'` prints nothing；
- `git grep -nE '"seed"[[:space:]]*:[[:space:]]*"[[:xdigit:]]{64}"|"secretKey"[[:space:]]*:[[:space:]]*"[[:xdigit:]]{128}"' -- ':!package-lock.json' ':!docs/**'` finds no tracked generated secret value；
- no source path imports Hypertele's missing `index.js`；
- no child runs `--private` or `--compress`；
- evidence matches actual commands and observed output。

After reviewing `git diff --cached`, commit：

```text
test(p0): verify the single-desktop Home smoke
```

## 11. P0 exit and stop gates

P0 passes only when：

- automated fail-closed/allow/deny/no-hot-reload/restart/two-client tests pass
  against isolated testnet；
- manual public-DHT smoke opens Home and Registry through Hypertele；
- `homeKey` remains stable across publisher restart；
- client secret material never appears in publisher config or logs；
- no generated secret enters Git；
- repeated setup preserves the same publisher and client identities；
- all processes stop cleanly；
- evidence explicitly preserves the single-desktop limitation。

Stop before P1 if：

- Hypertele cannot run reliably on the chosen Node version；
- allowlist identity files do not work as documented；
- public-DHT same-machine connection is unstable enough to block repeatable smoke；
- child-process supervision requires patching large parts of Hypertele；
- the Home/Registry contract already requires application-specific behavior。

If a stop gate fires, record the failure first. Then choose between pinning an older supported Node LTS, applying a narrowly scoped upstream-compatible patch, or replacing only the small Hypertele proxy core with direct HyperDHT code. Do not proceed to gateway, Android, relay, or multiplex while P0 is red.

## 12. Follow-up plans after P0

These require separate design review and PRs：

1. Close the remaining MLP V0 value gate with target-user workflow tests and a
   written go/no-go decision against Tailscale Sharing, Headscale, `fowl`, and
   direct Hypertele use。
2. Publisher Service Registry consumption and `*.kepos.localhost` gateway。
3. Multiple services with one publisher allowlist, initially allowing separate Hypertele processes。
4. Navidrome streaming and backpressure evidence。
5. Android client-only Bare/HyperDHT spike and desktop-broadband-to-cellular smoke。
6. Multiplex only if measured process/connection cost justifies it。
7. Blind UDX relay after direct-path evidence exists。
