import { desktopStyles } from "./ui-styles.js";

const iconPaths = {
  device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/>',
  laptop: '<rect x="4" y="4" width="16" height="12" rx="2"/><path d="m4 16-2 4h20l-2-4"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18m-9-9a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/>',
  book: '<path d="M12 5v16M12 5C8 2 3 4 3 4v15s5-2 9 2c4-4 9-2 9-2V4s-5-2-9 1Z"/>',
  git: '<circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="6" r="2"/><path d="M7 7v10m10-9v3a5 5 0 0 1-5 5H7"/>',
  build: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="11" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 18h7m-7 3h7"/>',
  dagger: '<path d="m15 3 6 0 0 6-10 10-6-6L15 3ZM3 21l5-5m-4-5 9 9m0-9 5-5"/>',
  proxy: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5m-7 5v-5h14v5"/>',
  music: '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  photos: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  port: '<path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v3"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
};

export interface DesktopUiOptions {
  smokeAcknowledgement?: boolean;
  localDeviceName?: string;
}

/** The native hosts use the same offline, device-oriented service browser. */
export function renderDesktopUi(options: DesktopUiOptions = {}): string {
  const localName = JSON.stringify(options.localDeviceName ?? "This device").replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" data-theme="kepos">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kepos</title>
  <style>${desktopStyles}</style>
</head>
<body>
  <main class="grid h-dvh grid-cols-[178px_minmax(0,1fr)] overflow-hidden min-[1000px]:grid-cols-[194px_minmax(0,1fr)] max-[620px]:grid-cols-[142px_minmax(0,1fr)] max-[450px]:grid-cols-[112px_minmax(0,1fr)]">
    <aside class="flex min-h-0 flex-col border-r border-secondary/15 bg-base-200 px-3.5 pt-7 pb-5 max-[620px]:px-2 max-[450px]:px-1.5">
      <div class="flex items-center gap-2.5 px-1.5 max-[450px]:gap-1">
        <svg class="size-7 shrink-0 text-primary max-[620px]:size-6" viewBox="0 0 32 32" aria-hidden="true"><path stroke-width="2.5" d="M13 6H5v20h8M19 6h8v20h-8M9 16h14"/></svg>
        <div><p class="text-sm font-bold tracking-[.22em] max-[620px]:text-xs max-[450px]:tracking-[.12em]">KEPOS</p><p class="mt-0.5 text-[8px] tracking-[.18em] text-base-content/60">DESKTOP</p></div>
      </div>
      <p class="px-2.5 pt-10 pb-3 text-[9px] tracking-[.16em] text-base-content/60">DEVICES</p>
      <nav class="min-h-0 flex-1 overflow-y-auto" aria-label="Devices"><ul class="menu menu-vertical w-full gap-1.5 p-0" data-role="devices"></ul></nav>
      <div class="grid gap-2 pt-5">
        <button class="btn btn-outline h-[31px] min-h-0 border-secondary/15 text-[10px] font-medium text-secondary w-full justify-start px-2.5 font-normal max-[450px]:px-1.5 max-[450px]:text-[9px]" type="button" data-action="invite" disabled><svg class="size-3.5" viewBox="0 0 24 24" aria-hidden="true">${iconPaths.plus}</svg>Invite device</button>
        <button class="btn btn-ghost h-[31px] min-h-0 text-[10px] w-full justify-start px-2.5 font-normal text-base-content/60" type="button" data-action="settings"><svg class="size-3.5" viewBox="0 0 24 24" aria-hidden="true">${iconPaths.settings}</svg>Settings</button>
      </div>
    </aside>
    <section class="workspace min-w-0 overflow-auto" aria-label="Device workspace">
      <div class="mx-auto max-w-[1100px] px-7 pt-7 pb-6 min-[1000px]:px-9 min-[1000px]:pt-8 max-[620px]:px-4.5 max-[620px]:pt-6 max-[450px]:px-3.5">
        <header class="flex items-center justify-between gap-4 border-b border-secondary/15 pb-5 max-[450px]:flex-col max-[450px]:items-start max-[450px]:gap-2.5">
          <div class="min-w-0"><p class="text-[9px] tracking-[.14em] text-secondary uppercase" data-role="kicker">YOUR PRIVATE NETWORK</p><h1 class="mt-1.5 font-(family-name:--font-display) text-4xl leading-tight font-normal tracking-tight wrap-anywhere max-[620px]:text-[31px]" data-role="title">Your devices</h1></div>
          <div class="flex shrink-0 items-center gap-2 text-[9px] tracking-[.08em] text-secondary uppercase" data-role="status" data-state="starting"><span class="status-dot"></span><span data-role="status-label">Starting</span></div>
        </header>
        <div class="flex items-center justify-between gap-4 py-4.5 text-[10px] leading-relaxed text-base-content/60" data-role="summary"></div>
        <section class="mb-5 rounded border border-secondary/15 bg-base-200 p-4.5" data-role="pairing" aria-label="Device invitation" hidden></section>
        <div data-role="device-page">
          <div class="notice mb-4.5 border-l-2 border-warning bg-warning/5 px-3.5 py-3 text-[11px] leading-relaxed wrap-anywhere" data-role="error" role="status" hidden></div>
          <details class="mb-5 rounded border border-secondary/15 bg-base-200" data-role="details">
            <summary class="cursor-pointer px-3.5 py-2.5 text-[10px] text-base-content/60">Device details</summary>
            <div class="px-3.5 pb-3.5" data-role="detail-body"></div>
          </details>
          <div class="mb-3 flex items-center justify-between gap-3.5 max-[450px]:flex-wrap">
            <h2 class="text-[10px] font-medium tracking-widest uppercase">Services<span class="ml-2 text-[9px] font-normal text-base-content/60" data-role="service-count"></span></h2>
            <input class="input h-7.5 w-[150px] rounded border-secondary/15 bg-transparent text-[10px] shadow-none placeholder:text-base-content/50 max-[620px]:w-[118px] max-[450px]:w-full" type="search" aria-label="Filter services" placeholder="Find a service…" data-role="search" autocomplete="off">
          </div>
          <div class="grid gap-2 min-[1000px]:grid-cols-2" data-role="services"></div>
          <p class="mt-4.5 text-[9px] leading-relaxed text-base-content/50" data-role="footnote"></p>
        </div>
        <section data-role="settings-page" hidden>
          <div class="border-b border-secondary/15 py-5"><h2 class="mb-2 text-xs">Local identity</h2><p class="text-[11px] leading-relaxed text-base-content/60">One identity for this device and the services it shares.</p><p class="mt-3 text-[10px] leading-relaxed wrap-anywhere select-text" data-role="local-key"></p><button class="btn btn-outline h-[31px] min-h-0 border-secondary/15 text-[10px] font-medium text-secondary mt-3" type="button" data-action="copy-local-key">Copy public key</button></div>
          <div class="border-b border-secondary/15 py-5"><h2 class="mb-2 text-xs">Local gateway</h2><p class="text-[11px] leading-relaxed text-base-content/60" data-role="gateway"></p></div>
          <div class="border-b border-secondary/15 py-5"><h2 class="mb-2 text-xs">Diagnostics</h2><p class="text-[11px] leading-relaxed text-base-content/60">Copy connection and service details for troubleshooting. Private keys are never included.</p><button class="btn btn-outline h-[31px] min-h-0 border-secondary/15 text-[10px] font-medium text-secondary mt-3" type="button" data-action="copy-diagnostics">Copy diagnostics</button></div>
          <div class="py-5"><p class="text-[11px] leading-relaxed text-base-content/60">Closing the window keeps your services connected.</p><button class="btn btn-ghost h-[31px] min-h-0 text-[10px] mt-3 px-0 text-error" type="button" data-action="quit">Quit Kepos</button></div>
        </section>
      </div>
    </section>
  </main>
  <div class="toast-message pointer-events-none fixed bottom-5 left-[calc(50%+70px)] z-10 max-w-[calc(100%-32px)] rounded border border-secondary/20 bg-base-300 px-4 py-2.5 text-[11px] max-[450px]:left-1/2" data-role="toast" role="status" aria-live="polite"></div>
<script>
(function () {
  'use strict';
  var localName = ${localName};
  var icons = ${JSON.stringify(iconPaths)};
  var snapshot;
  var selected;
  var settings = false;
  var query = '';
  var toastTimer;
  var diagnosticsPending = false;
  var smokeSent = false;
  var preferenceKey = 'kepos.selected-device';
  try { selected = window.localStorage.getItem(preferenceKey) || undefined; } catch (_) {}
  var nodes = {};
  ['devices','title','kicker','status','status-label','summary','pairing','device-page','settings-page','error','details','detail-body','service-count','search','services','footnote','local-key','gateway','toast'].forEach(function (key) { nodes[key] = document.querySelector('[data-role="' + key + '"]'); });
  var inviteButton = document.querySelector('[data-action="invite"]');
  var diagnosticsButton = document.querySelector('[data-action="copy-diagnostics"]');
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function icon(name, classes) { return '<svg class="' + (classes || 'size-5') + '" viewBox="0 0 24 24" aria-hidden="true">' + (icons[name] || icons.web) + '</svg>'; }
  function post(message) { window.bareNative.postMessage(JSON.stringify(message)); }
  function html(node, value) { if (node.innerHTML !== value) node.innerHTML = value; }
  function labelForState(state) { return ({running:'Connected',connected:'Connected',starting:'Starting',connecting:'Connecting',reconnecting:'Reconnecting',offline:'Offline',stopped:'Stopped',failed:'Needs attention'})[state] || state; }
  function remember() { try { window.localStorage.setItem(preferenceKey, selected); } catch (_) {} }
  function deviceList(peer) {
    return peer.connections.map(function (connection) { return {key:connection.publicKey,name:connection.label,local:false,state:connection.status,connection:connection}; }).concat([{key:peer.peerKey || 'local',name:localName,local:true,state:peer.phase}]);
  }
  function deviceServices(peer, device) {
    return peer.services.filter(function (service) { return device.local ? !service.peer : service.peer === device.name || service.peer === device.key; });
  }
  function bindingFor(peer, device, serviceId) {
    return peer.bindings.find(function (binding) { return !device.local && (binding.peer === device.name || binding.peer === device.key) && binding.service === serviceId; });
  }
  function endpoint(binding) { return binding.port ? '127.0.0.1:' + binding.port : binding.listen && binding.listen.unixSocket ? 'unix://' + binding.listen.unixSocket : ''; }
  function serviceToken(service) { return encodeURIComponent(service.peer || '') + '/' + encodeURIComponent(service.id); }
  function selectedDevice() { return snapshot && snapshot.peer && deviceList(snapshot.peer).find(function (device) { return device.key === selected; }); }
  function showToast(text) {
    nodes.toast.textContent = text; nodes.toast.dataset.visible = 'true';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { nodes.toast.dataset.visible = 'false'; }, 2000);
  }
  async function copy(text, label) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else {
        var area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
        document.body.append(area); area.select(); var ok = document.execCommand('copy'); area.remove(); if (!ok) throw new Error('copy failed');
      }
      showToast(label + ' copied');
    } catch (_) { showToast('Could not copy. Try again.'); }
  }
  function renderNav(peer, devices) {
    var focusedKey = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.device;
    html(nodes.devices, devices.map(function (device) {
      var caption = device.local ? 'This device' : labelForState(device.state);
      return '<li><button class="device-button grid! min-w-0 grid-cols-[22px_minmax(0,1fr)_6px] items-center gap-2! px-2.5! py-3! max-[450px]:grid-cols-[minmax(0,1fr)_5px] max-[450px]:px-2!" type="button" data-device="' + escapeHtml(device.key) + '" data-state="' + escapeHtml(device.state) + '" aria-current="' + (!settings && device.key === selected ? 'page' : 'false') + '">' + icon(device.local ? 'laptop' : 'device','size-4.5 max-[450px]:hidden') + '<span class="grid min-w-0 gap-1"><span class="truncate text-[11px] font-semibold">' + escapeHtml(device.name) + '</span><span class="text-[9px] leading-tight text-base-content/60 max-[620px]:text-[8px]">' + escapeHtml(caption) + '</span></span><span class="status-dot"></span></button></li>';
    }).join(''));
    if (focusedKey) { var buttons = nodes.devices.querySelectorAll('[data-device]'); for (var i=0;i<buttons.length;i++) if (buttons[i].dataset.device === focusedKey) buttons[i].focus(); }
    inviteButton.disabled = peer.phase !== 'running' || (peer.pairing && peer.pairing.phase !== 'idle');
  }
  function sourceLabel(service) {
    var source = service.source || {};
    if (source.localPort) return '127.0.0.1:' + source.localPort;
    if (source.unixSocket) return source.unixSocket;
    if (source.peer) return 'Via ' + source.peer + ' / ' + source.service;
    return service.id;
  }
  function renderCard(peer, device, service) {
    var binding = bindingFor(peer, device, service.id);
    var action = service.action;
    var canAct = !device.local && service.available && (action === 'open' ? Boolean(service.url) : Boolean(service.copyText));
    var actionLabel = action === 'open' ? 'Open' : action === 'copy-command' ? 'Copy command' : action === 'copy-url' ? 'Copy URL' : 'Copy';
    var actionTitle = action === 'open' ? 'Open ' + service.name : action === 'copy-command' ? 'Copy ' + service.name + ' command' : action === 'copy-url' ? 'Copy ' + service.name + ' URL' : 'Copy ' + service.name + ' endpoint';
    var metadata = device.local ? sourceLabel(service) : binding && endpoint(binding) ? endpoint(binding) : service.url ? service.url.replace(/^https?:\\/\\//, '').replace(/\\/$/, '') : service.id;
    var error = !service.available ? service.error || 'Service unavailable' : !device.local && !canAct ? service.kind === 'udp' ? 'Configure a local UDP endpoint.' : 'Local endpoint unavailable.' : '';
    var button = device.local ? '<span class="text-[9px] text-base-content/60">' + (service.available ? 'Shared' : 'Unavailable') + '</span>' : '<button class="btn btn-outline h-[31px] min-h-0 border-secondary/15 text-[10px] font-medium text-secondary min-w-16 shrink-0 px-2.5 max-[620px]:min-w-13 max-[620px]:px-2" type="button" data-service="' + escapeHtml(serviceToken(service)) + '" aria-label="' + escapeHtml(actionTitle) + '"' + (canAct ? '' : ' disabled') + '>' + actionLabel + (action === 'open' ? icon('arrow','size-3') : '') + '</button>';
    return '<article class="service card card-border flex-row items-center gap-3.5 rounded-[5px] border-secondary/15 px-3.5 py-4 max-[620px]:gap-2 max-[620px]:px-2.5 max-[450px]:flex-wrap" data-available="' + service.available + '"><span class="service-icon grid h-9 w-8 shrink-0 place-items-center text-secondary max-[620px]:w-6">' + icon(service.icon || 'port','size-6') + '</span><div class="card-body block min-w-0 flex-1 p-0"><h3 class="card-title block text-xs leading-snug font-medium wrap-anywhere">' + escapeHtml(service.name) + '</h3><p class="mt-1 text-[9px] leading-relaxed wrap-anywhere text-base-content/60">' + escapeHtml(metadata) + '</p>' + (error ? '<p class="mt-1.5 text-[10px] leading-relaxed wrap-anywhere text-warning">' + escapeHtml(error) + '</p>' : '') + '</div><div class="card-actions shrink-0 max-[450px]:ml-8">' + button + '</div></article>';
  }
  function empty(title, text, name) { return '<div class="col-span-full rounded-[5px] border border-dashed border-secondary/15 px-6 py-9 text-center">' + icon(name || 'device','mx-auto mb-4 size-8 text-secondary') + '<h2 class="mb-2 font-(family-name:--font-display) text-2xl font-normal">' + escapeHtml(title) + '</h2><p class="mx-auto max-w-[310px] text-[11px] leading-relaxed text-base-content/60">' + escapeHtml(text) + '</p></div>'; }
  function renderServices(peer, device) {
    var services = deviceServices(peer, device);
    var visible = services.filter(function (service) { return (service.name + ' ' + service.id).toLowerCase().includes(query.toLowerCase()); });
    var missingBindings = device.local ? [] : peer.bindings.filter(function (binding) { return (binding.peer === device.key || binding.peer === device.name) && !services.some(function (service) { return service.id === binding.service; }); });
    nodes['service-count'].textContent = ' ' + String(services.length + missingBindings.length);
    var content = visible.map(function (service) { return renderCard(peer, device, service); }).join('');
    if (!query) content += missingBindings.map(function (binding) {
      var location = endpoint(binding);
      return '<article class="service card card-border flex-row items-center gap-3.5 rounded-[5px] border-secondary/15 p-3.5">' + icon('port','size-6 shrink-0 text-base-content/60') + '<div class="card-body block min-w-0 p-0"><h3 class="card-title text-xs font-medium">' + escapeHtml(binding.service) + '</h3><p class="mt-1 text-[9px] text-base-content/60">' + escapeHtml(location) + '</p><p class="mt-1.5 text-[10px] leading-relaxed text-warning">' + escapeHtml(binding.error || 'Waiting for this device’s service catalog.') + '</p></div></article>';
    }).join('');
    if (!content) content = query ? empty('No matching services', 'Try another service name.', 'web') : device.local ? empty('Nothing shared from ' + localName + ' yet', 'Services you configure on this device will appear here. Connecting a device does not share services automatically.', 'laptop') : empty(device.state === 'connected' ? 'No services shared yet' : 'Waiting for ' + device.name, device.state === 'connected' ? 'This device has not made any services available to you.' : 'Your services will appear when the device is connected.', 'device');
    var focusedService = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.service;
    html(nodes.services, content);
    if (focusedService) { var buttons = nodes.services.querySelectorAll('[data-service]'); for (var i=0;i<buttons.length;i++) if (buttons[i].dataset.service === focusedService) buttons[i].focus(); }
    nodes.footnote.textContent = device.local ? 'Only explicitly authorized devices can use these services.' : 'Private services from ' + device.name + '. Local endpoints are managed on ' + localName + '.';
  }
  function renderDetails(peer, device) {
    var connection = device.connection;
    html(nodes['detail-body'], '<p class="mb-1.5 text-[9px] text-base-content/60">PUBLIC KEY</p><div class="flex items-start justify-between gap-3"><p class="min-w-0 text-[10px] leading-relaxed wrap-anywhere select-text">' + escapeHtml(device.key === 'local' ? 'Waiting for identity…' : device.key) + '</p><button class="btn btn-ghost h-[31px] min-h-0 text-[10px] shrink-0 px-2" type="button" data-action="copy-device-key">Copy</button></div>' + (connection ? '<div class="mt-3 flex justify-between gap-3 text-[10px] text-base-content/60"><span>Connection</span><span>' + (connection.connection === 'dial' ? 'Initiated here' : 'Accepted here') + '</span></div><div class="mt-2 flex justify-between gap-3 text-[10px] text-base-content/60"><span>Service sharing</span><span>' + escapeHtml(connection.capability === 'ready' ? 'Bidirectional' : connection.capability === 'pending' ? 'Checking capabilities' : 'Limited by peer') + '</span></div>' : ''));
  }
  function renderPairing(peer) {
    var pairing = peer.pairing;
    nodes.pairing.hidden = !pairing || pairing.phase === 'idle';
    if (nodes.pairing.hidden) return;
    if (pairing.phase === 'pending') {
      html(nodes.pairing, '<h2 class="mb-2 font-(family-name:--font-display) text-2xl font-normal">Allow ' + escapeHtml(pairing.label) + ' to connect?</h2><p class="text-[11px] leading-relaxed text-base-content/60">Check this fingerprint on the other device.</p><p class="mt-2 text-[11px] leading-relaxed wrap-anywhere select-text">' + escapeHtml(pairing.keyFingerprint || pairing.peerKey) + '</p><p class="mt-3 text-[10px] leading-relaxed text-base-content/60">Approval allows a connection. Service access is granted separately.</p><div class="mt-3.5 flex gap-2"><button class="btn btn-outline h-[31px] min-h-0 border-secondary/15 text-[10px] font-medium text-secondary" type="button" data-action="deny">Deny</button><button class="btn btn-primary h-[31px] min-h-0 text-[10px] font-medium" type="button" data-action="approve">Allow connection</button></div>');
    } else {
      var expired = pairing.expired || pairing.expiresAt <= Date.now();
      html(nodes.pairing, '<div class="flex items-start gap-5 max-[620px]:flex-col">' + (!expired && pairing.qrSvg ? '<div class="pairing-qr shrink-0 rounded bg-base-content p-2">' + pairing.qrSvg + '</div>' : '') + '<div class="min-w-0"><h2 class="mb-2 font-(family-name:--font-display) text-2xl font-normal">' + (expired ? 'Invitation expired' : 'Invite a device') + '</h2><p class="text-[11px] leading-relaxed text-base-content/60">' + (expired ? 'Create a new invitation when the other device is ready.' : 'Scan this invitation on the other device. You will confirm its identity before it connects.') + '</p><p class="mt-2 text-[10px] leading-relaxed text-base-content/60">Service access is granted separately.</p><div class="mt-3.5 flex flex-wrap gap-2"><button class="btn btn-outline h-[31px] min-h-0 border-secondary/15 text-[10px] font-medium text-secondary" type="button" data-action="cancel">Cancel</button>' + (expired ? '<button class="btn btn-primary h-[31px] min-h-0 text-[10px] font-medium" type="button" data-action="invite">New invitation</button>' : pairing.uri ? '<button class="btn btn-outline h-[31px] min-h-0 border-secondary/15 text-[10px] font-medium text-secondary" type="button" data-action="copy-invitation">Copy invitation</button>' : '') + '</div></div></div>');
    }
  }
  function render() {
    var peer = snapshot && snapshot.peer;
    if (!peer) return;
    var devices = deviceList(peer);
    var device = devices.find(function (item) { return item.key === selected; });
    if (!device) {
      device = devices[0];
      if (peer.peerKey) { selected = device.key; remember(); }
    }
    renderNav(peer, devices);
    nodes['device-page'].hidden = settings; nodes['settings-page'].hidden = !settings;
    nodes.title.textContent = settings ? 'Settings' : device.name;
    nodes.kicker.textContent = settings || device.local ? 'THIS DEVICE' : 'REMOTE DEVICE';
    var state = settings ? peer.phase : device.state;
    nodes.status.dataset.state = state;
    nodes['status-label'].textContent = settings || device.local ? (peer.phase === 'running' ? 'Ready' : labelForState(peer.phase)) : labelForState(state);
    html(nodes.summary, settings ? '<span>Your local Kepos preferences and diagnostics.</span>' : device.local ? '<span>Services shared from <strong class="font-normal text-base-content">' + escapeHtml(localName) + '</strong></span><span>LOCAL</span>' : '<span><strong class="font-normal text-base-content">' + escapeHtml(localName) + '</strong> &nbsp;↔&nbsp; <strong class="font-normal text-base-content">' + escapeHtml(device.name) + '</strong></span><span>PRIVATE CONNECTION</span>');
    var error = peer.error || (!device.local && device.connection.error) || '';
    nodes.error.textContent = error; nodes.error.hidden = !error;
    nodes['local-key'].textContent = peer.peerKey || 'Waiting for identity…';
    nodes.gateway.textContent = peer.gatewayPort ? '127.0.0.1:' + peer.gatewayPort : 'Not available';
    diagnosticsButton.disabled = diagnosticsPending;
    renderDetails(peer, device); renderServices(peer, device); renderPairing(peer);
    ${options.smokeAcknowledgement ? `if (!smokeSent) { smokeSent = true; post({type:'windows-smoke-rendered',role:'peer',connection:peer.connections.some(function (connection) { return connection.status === 'connected'; }) ? 'connected' : 'connecting',serviceCount:peer.services.length,peerKeyPresent:Boolean(peer.peerKey),connectFormVisible:false}); }` : ''}
  }
  nodes.search.addEventListener('input', function () { query = nodes.search.value; var device = selectedDevice(); if (device) renderServices(snapshot.peer, device); });
  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!target || target.disabled) return;
    if (target.dataset.device) { selected = target.dataset.device; settings = false; query = ''; nodes.search.value = ''; nodes.details.open = false; remember(); render(); return; }
    var action = target.dataset.action;
    var peer = snapshot && snapshot.peer;
    if (action === 'settings') { settings = true; render(); }
    else if (action === 'copy-local-key') { if (peer) void copy(peer.peerKey, 'Public key'); }
    else if (action === 'copy-device-key') { var device = selectedDevice(); if (device && device.key !== 'local') void copy(device.key, 'Public key'); }
    else if (action === 'copy-diagnostics') { if (diagnosticsPending) return; diagnosticsPending = true; diagnosticsButton.disabled = true; showToast('Preparing diagnostics…'); post({type:'copyDiagnostics'}); }
    else if (action === 'invite') post({type:'createPairingInvitation'});
    else if (action === 'cancel') post({type:'cancelPairing'});
    else if (action === 'approve') post({type:'approvePairing'});
    else if (action === 'deny') post({type:'denyPairing'});
    else if (action === 'copy-invitation') { if (peer && peer.pairing) void copy(peer.pairing.uri, 'Invitation'); }
    else if (action === 'quit') post({type:'quit'});
    else if (target.dataset.service && peer) {
      var device = selectedDevice();
      var service = device && !device.local && deviceServices(peer, device).find(function (item) { return serviceToken(item) === target.dataset.service; });
      if (!service || !service.available) return;
      if (service.action === 'open' && service.url) post({type:'openService',serviceId:service.id});
      else if (service.copyText) void copy(service.copyText, service.action === 'copy-command' ? 'Command' : 'Address');
    }
  });
  window.addEventListener('bare-native-message', function (event) {
    try {
      var message = JSON.parse(event.data);
      if (message && message.type === 'diagnosticsResult') {
        diagnosticsPending = false; diagnosticsButton.disabled = false;
        if (message.ok && typeof message.summary === 'string') void copy(message.summary, 'Diagnostics');
        else showToast('Diagnostics unavailable. Try again.');
      } else if (message && message.type === 'snapshot') { snapshot = message; render(); }
    } catch (_) { diagnosticsPending = false; diagnosticsButton.disabled = false; showToast('Could not update the view.'); }
  });
  post({type:'ready'});
}());
</script>
</body>
</html>`;
}
