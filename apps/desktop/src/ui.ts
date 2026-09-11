export interface DesktopUiOptions {
  smokeAcknowledgement?: boolean;
}

/** Render the canonical peer surface used by both desktop hosts. */
export function renderDesktopUi(options: DesktopUiOptions = {}): string {
  const smokeAcknowledgement = options.smokeAcknowledgement === true;
  const smokeScript = smokeAcknowledgement
    ? `
    if (!smokeSent) {
      smokeSent = true;
      var connected = peer.connections.some(function (connection) { return connection.status === 'connected'; });
      post({ type: 'windows-smoke-rendered', role: 'peer', connection: connected ? 'connected' : 'connecting', serviceCount: peer.services.length, peerKeyPresent: Boolean(peer.peerKey), connectFormVisible: false });
    }`
    : "";
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kepos</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background: #f5f7f2; color: #172016; }
    body { margin: 0; min-width: 360px; }
    main { max-width: 900px; margin: 0 auto; padding: 28px; }
    .card { background: white; border: 1px solid #dce4d6; border-radius: 18px; box-shadow: 0 8px 24px #17201612; }
    .card-body { padding: 22px; }
    .row { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
    .stack { display: grid; gap: 12px; }
    .muted { color: #687466; }
    .error { color: #a32222; white-space: pre-wrap; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 10px; font-size: 12px; background: #e8f2df; color: #35552c; }
    .btn { border: 0; border-radius: 9px; padding: 8px 13px; cursor: pointer; background: #314f2b; color: white; }
    .btn:disabled { cursor: default; opacity: .45; }
    .btn-secondary { background: #e8eee3; color: #243221; }
    .mono { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { border-top: 1px solid #edf1eb; padding: 12px 0; }
  </style>
</head>
<body>
  <main>
    <header class="row">
      <div><p class="muted">Kepos peer network</p><h1>Peer services</h1></div>
      <span class="badge" data-role="peer-status">Starting</span>
    </header>
    <section class="card" data-role="peer-surface">
      <div class="card-body stack">
        <div class="row"><strong>Identity</strong><span><button class="btn btn-secondary" type="button" data-action="copy-peer-key">Copy key</button> <button class="btn btn-secondary" type="button" data-action="copy-diagnostics">Copy diagnostics</button></span></div>
        <div class="mono" data-role="peer-key">Waiting for identity…</div>
        <div class="muted" data-role="peer-error" hidden></div>
        <div class="row"><strong>Connections</strong><span class="muted" data-role="connection-count">0</span></div>
        <ul data-role="peer-connections"><li class="muted">No configured peers.</li></ul>
        <div class="row"><strong>Services</strong><span class="muted" data-role="service-count">0</span></div>
        <ul data-role="peer-services"><li class="muted">No services configured.</li></ul>
        <div class="row"><strong>Bindings</strong><span class="muted" data-role="binding-count">0</span></div>
        <ul data-role="peer-bindings"><li class="muted">No local bindings.</li></ul>
        <div class="stack" data-role="peer-pairing"></div>
      </div>
    </section>
  </main>
<script>
(function () {
  'use strict';
  var lastSnapshot;
  var smokeSent = false;
  var peerKeyNode = document.querySelector('[data-role="peer-key"]');
  var peerStatusNode = document.querySelector('[data-role="peer-status"]');
  var peerErrorNode = document.querySelector('[data-role="peer-error"]');
  var connectionCountNode = document.querySelector('[data-role="connection-count"]');
  var serviceCountNode = document.querySelector('[data-role="service-count"]');
  var bindingCountNode = document.querySelector('[data-role="binding-count"]');
  var connectionsNode = document.querySelector('[data-role="peer-connections"]');
  var servicesNode = document.querySelector('[data-role="peer-services"]');
  var bindingsNode = document.querySelector('[data-role="peer-bindings"]');
  var pairingNode = document.querySelector('[data-role="peer-pairing"]');
  var diagnosticsButton = document.querySelector('[data-action="copy-diagnostics"]');

  function post(message) { window.bareNative.postMessage(JSON.stringify(message)); }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character];
    });
  }
  function fingerprint(value) { return value ? String(value).slice(0, 16) : '—'; }
  function list(node, items, empty) {
    node.innerHTML = items.length ? items.join('') : '<li class="muted">' + empty + '</li>';
  }
  function renderPairing(peer) {
    var pairing = peer.pairing;
    if (!pairing) { pairingNode.innerHTML = '<button class="btn" type="button" data-action="create-peer-pairing">Invite a peer</button>'; return; }
    if (pairing.phase === 'pending') {
      pairingNode.innerHTML = '<div class="row"><span>Approve <strong>' + escapeHtml(pairing.label) + '</strong>?</span><span><button class="btn" type="button" data-action="approve-peer-pairing">Approve</button> <button class="btn btn-secondary" type="button" data-action="deny-peer-pairing">Deny</button></span></div><div class="mono muted">' + escapeHtml(fingerprint(pairing.peerKey)) + '</div>';
    } else if (pairing.phase === 'inviting') {
      pairingNode.innerHTML = '<div class="row"><span>Invitation ready</span><button class="btn btn-secondary" type="button" data-action="cancel-peer-pairing">Cancel</button></div>' + (pairing.qrSvg || '');
    } else {
      pairingNode.innerHTML = '<button class="btn" type="button" data-action="create-peer-pairing">Invite a peer</button>';
    }
  }
  function render(snapshot) {
    lastSnapshot = snapshot;
    var peer = snapshot && snapshot.peer;
    if (!peer) return;
    peerStatusNode.textContent = peer.phase;
    peerKeyNode.textContent = peer.peerKey || 'Waiting for identity…';
    peerErrorNode.textContent = peer.error || '';
    peerErrorNode.hidden = !peer.error;
    connectionCountNode.textContent = String(peer.connections.length);
    serviceCountNode.textContent = String(peer.services.length);
    bindingCountNode.textContent = String(peer.bindings.length);
    list(connectionsNode, peer.connections.map(function (connection) {
      return '<li><div class="row"><strong>' + escapeHtml(connection.label) + '</strong><span class="badge">' + escapeHtml(connection.status) + '</span></div><div class="mono muted">' + escapeHtml(fingerprint(connection.publicKey)) + '</div></li>';
    }), 'No configured peers.');
    list(servicesNode, peer.services.map(function (service) {
      return '<li><div class="row"><strong>' + escapeHtml(service.name) + '</strong><span class="badge">' + escapeHtml(service.available ? 'available' : 'unavailable') + '</span></div><div class="muted">' + escapeHtml(service.id + ' · ' + service.kind) + (service.error ? ' · ' + escapeHtml(service.error) : '') + '</div></li>';
    }), 'No services configured.');
    list(bindingsNode, peer.bindings.map(function (binding) {
      var button = '<button class="btn" type="button" data-action="open-peer-binding" data-service="' + escapeHtml(binding.service) + '"' + (binding.available ? '' : ' disabled') + '>Open</button>';
      return '<li><div class="row"><strong>' + escapeHtml(binding.service) + '</strong>' + button + '</div><div class="muted">' + escapeHtml(fingerprint(binding.peer)) + '</div></li>';
    }), 'No local bindings.');
    renderPairing(peer);
${smokeScript}
  }
  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target) return;
    var action = target.dataset.action;
    if (action === 'copy-peer-key') {
      if (lastSnapshot && lastSnapshot.peer && lastSnapshot.peer.peerKey && navigator.clipboard) navigator.clipboard.writeText(lastSnapshot.peer.peerKey);
    } else if (action === 'copy-diagnostics') {
      if (diagnosticsButton.disabled) return;
      diagnosticsButton.disabled = true;
      post({ type: 'copyDiagnostics' });
    } else if (action === 'open-peer-binding') {
      post({ type: 'openService', serviceId: target.dataset.service });
    } else if (action === 'create-peer-pairing') post({ type: 'createPairingInvitation' });
    else if (action === 'cancel-peer-pairing') post({ type: 'cancelPairing' });
    else if (action === 'approve-peer-pairing') post({ type: 'approvePairing' });
    else if (action === 'deny-peer-pairing') post({ type: 'denyPairing' });
  });
  window.addEventListener('bare-native-message', function (event) {
    try {
      var message = JSON.parse(event.data);
      if (message && message.type === 'diagnosticsResult') {
        if (message.ok && navigator.clipboard && typeof message.summary === 'string') navigator.clipboard.writeText(message.summary);
        diagnosticsButton.disabled = false;
      } else {
        render(message);
      }
    } catch (_) {
      diagnosticsButton.disabled = false;
    }
  });
  post({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
