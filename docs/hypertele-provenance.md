# Hypertele migration provenance

> Historical discussion of the retired service-proxy product; see [Linux peer VPN](peer-vpn.md) for current behavior.

Hypertele was the executable baseline used before Kepos Neo gained its own
persistent multiplex transport. No Hypertele source code or npm package is
shipped in the current Kepos runtime.

## Upstream reference

- package: `hypertele` 1.1.4;
- upstream repository: <https://github.com/bitfinexcom/hypertele>;
- package metadata author: Paolo Ardoino (`@prdn`);
- package metadata license: MIT;
- upstream commit used by the fork:
  `0432686b43623706b0345f34b434d324b8b7f587`.

The upstream repository's complete history and the published npm 1.1.4
tarball contain `license: MIT` metadata and a README line saying `MIT`. They do
not contain a standalone license, a copyright notice, or the MIT permission
text. This document therefore does not invent a copyright holder or present a
license notice as if upstream supplied one.

## Fork additions migrated into Kepos

The fork added route controls and transport observations after the upstream
commit. Git records `Neil <bn0010100@gmail.com>` as the author of the relevant
fork commits:

- `d648eb28b277ae4e61aaea9584e418ce2b411bf2`
  (`feat(transport): modernize hypertele with typescript`);
- `a7e75ca2a79fdd45f4f8b73a7c468436596d5f2a`
  (`fix(route): apply local connection mode per peer`);
- `eb1063b0d3136eb8c77e038e2bae5ad9c171eedd`
  (`feat(observability): log connection lifecycle events`);
- `a3e752edf118045e87b69f0497d70a61350270b9`
  (`fix(observability): label client byte directions`);
- `2f8f28e14f9673e4acaef6ca588745e04da57e6f`
  (`fix(observability): label client close sources`);
- `cdb851bf750369d5b9eaead3975580e8459fe025`
  (`feat(transport): retry and measure DHT connections`).

The same author identity wrote the Kepos migration commits. Those
author-owned additions supplied the route mapping, connection and retry
timing, sanitized DHT snapshots, first-byte and byte-count metrics,
transfer-rate calculation, and close-source observations. They are licensed
as part of Kepos Neo under Apache-2.0.

## Removal audit

The current production runtime:

- has no `hypertele` dependency or import;
- contains none of Hypertele's CLI or configuration parser;
- contains none of its raw stream piper or probe protocol;
- contains none of its gzip mode;
- replaces its one-DHT-connection-per-local-TCP design with a Kepos-specific
  persistent HyperDHT connection and independent Protomux channels.

Hypertele remains an important historical reference, but no copyrightable
third-party Hypertele implementation is included in the licensed Kepos work.
