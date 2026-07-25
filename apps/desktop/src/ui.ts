const keposMark = `
  <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M13 6H5v20h8M19 6h8v20h-8M9 16h14" />
  </svg>`;

export function renderDesktopUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Kepos</title>
  <style>
    :root {
      color-scheme: dark;
      --ink: #0d1209;
      --deep: #11180c;
      --panel: #172010;
      --panel-high: #1d2814;
      --cream: #f0f1e7;
      --muted: #a8ad9e;
      --green: #b7ee45;
      --green-soft: #d7f798;
      --line: rgba(215, 247, 152, 0.18);
      --soft-line: rgba(240, 241, 231, 0.09);
      --danger: #ff9f82;
      --display: "Iowan Old Style", "Baskerville", Georgia, serif;
      --mono: "SFMono-Regular", Menlo, Monaco, monospace;
    }

    * { box-sizing: border-box; }
    html, body { min-width: 560px; min-height: 520px; }
    body {
      margin: 0;
      overflow: hidden;
      background:
        radial-gradient(circle at 86% -8%, rgba(183, 238, 69, .11), transparent 320px),
        linear-gradient(rgba(183, 238, 69, .018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(183, 238, 69, .018) 1px, transparent 1px),
        var(--ink);
      background-size: auto, 56px 56px, 56px 56px, auto;
      color: var(--cream);
      font-family: var(--mono);
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }

    body::after {
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 120 120' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E");
      content: "";
      mix-blend-mode: soft-light;
      opacity: .025;
    }

    button, summary { font: inherit; }
    button { color: inherit; }
    [hidden] { display: none !important; }
    .shell {
      display: grid;
      grid-template-columns: 176px minmax(0, 1fr);
      width: 100vw;
      height: 100vh;
    }
    .sidebar {
      display: flex;
      min-width: 0;
      flex-direction: column;
      padding: 28px 18px 22px;
      border-right: 1px solid var(--line);
      background: rgba(17, 24, 12, .76);
    }
    .workspace {
      display: grid;
      min-width: 0;
      min-height: 0;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      padding: 28px 30px 22px;
    }
    .workspace-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 32px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      width: 30px;
      height: 30px;
      fill: none;
      stroke: var(--green);
      stroke-width: 2.5;
    }
    .wordmark { font-size: 15px; font-weight: 700; letter-spacing: .22em; }
    .edition { margin-left: 1px; color: var(--muted); font-size: 9px; letter-spacing: .16em; }
    .role-nav { display: grid; gap: 8px; margin-top: 48px; }
    .role-tab {
      position: relative;
      display: grid;
      width: 100%;
      gap: 5px;
      padding: 13px 12px 12px 16px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      text-align: left;
      transition: border-color 130ms ease, background 130ms ease, color 130ms ease;
    }
    .role-tab::before {
      position: absolute;
      top: 16px;
      left: 0;
      width: 2px;
      height: 24px;
      background: transparent;
      content: "";
    }
    .role-tab:hover, .role-tab:focus-visible { color: var(--cream); outline: none; }
    .role-tab.selected {
      border-color: var(--line);
      background: rgba(183, 238, 69, .055);
      color: var(--cream);
    }
    .role-tab.selected::before { background: var(--green); }
    .role-name { font-size: 11px; font-weight: 700; letter-spacing: .02em; }
    .role-kind { color: var(--green); font-size: 8px; letter-spacing: .16em; text-transform: uppercase; }
    .role-state {
      overflow: hidden;
      font-size: 8px;
      letter-spacing: .08em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .role-tab[data-state="failed"] .role-state { color: var(--danger); }
    .role-tab[data-state="connected"] .role-state { color: var(--green-soft); }
    .sidebar-note {
      margin-top: auto;
      color: rgba(168, 173, 158, .68);
      font-size: 8px;
      letter-spacing: .12em;
      line-height: 1.7;
      text-transform: uppercase;
    }
    .view-title { color: var(--muted); font-size: 9px; letter-spacing: .15em; text-transform: uppercase; }

    .status {
      display: flex;
      align-items: center;
      gap: 9px;
      color: var(--muted);
      font-size: 10px;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--muted);
      box-shadow: 0 0 0 4px rgba(168, 173, 158, .08);
    }
    .status[data-state="connected"], .status[data-state="running"] { color: var(--green-soft); }
    .status[data-state="connected"] .status-dot {
      background: var(--green);
      box-shadow: 0 0 13px rgba(183, 238, 69, .62);
    }
    .status[data-state="running"] .status-dot {
      background: var(--green);
      box-shadow: 0 0 13px rgba(183, 238, 69, .62);
    }
    .status[data-state="connecting"] .status-dot,
    .status[data-state="reconnecting"] .status-dot { animation: pulse 1.3s ease-in-out infinite; }
    .status[data-state="failed"] { color: var(--danger); }
    .status[data-state="failed"] .status-dot { background: var(--danger); }

    .intro {
      display: flex;
      align-items: end;
      justify-content: space-between;
      padding: 25px 0 18px;
    }
    .eyebrow { margin: 0 0 6px; color: var(--green); font-size: 9px; letter-spacing: .2em; }
    h1 {
      margin: 0;
      font-family: var(--display);
      font-size: clamp(30px, 5vw, 44px);
      font-weight: 400;
      letter-spacing: -.035em;
      line-height: .95;
    }
    h1 em { color: var(--green); font-weight: 400; }
    .count { color: var(--muted); font-size: 10px; letter-spacing: .12em; }

    .surfaces {
      min-height: 0;
      overflow-y: auto;
      border-top: 1px solid var(--soft-line);
    }
    .surface-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 38px;
      border-bottom: 1px solid var(--soft-line);
      color: var(--muted);
      font-size: 9px;
      letter-spacing: .15em;
      text-transform: uppercase;
    }
    .surface-head strong { color: var(--cream); font-weight: 600; }
    .publisher-summary { display: flex; align-items: center; gap: 12px; }
    .publisher-key {
      max-width: 280px;
      overflow: hidden;
      color: var(--muted);
      font-size: 9px;
      text-overflow: ellipsis;
      text-transform: none;
      user-select: text;
      white-space: nowrap;
    }
    .key-copy { min-width: auto; padding: 6px 8px; }
    .service {
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr) auto;
      min-height: 66px;
      align-items: center;
      gap: 14px;
      border-bottom: 1px solid var(--soft-line);
      animation: arrive 280ms both;
    }
    .service:nth-child(2) { animation-delay: 35ms; }
    .service:nth-child(3) { animation-delay: 70ms; }
    .service:nth-child(4) { animation-delay: 105ms; }
    .service.published { grid-template-columns: 38px minmax(0, 1fr); }
    .service-icon {
      display: grid;
      width: 34px;
      height: 34px;
      place-items: center;
      border: 1px solid var(--line);
      color: var(--green-soft);
    }
    .service-icon svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; }
    .service-copy { min-width: 0; }
    .service-name { margin: 0 0 4px; font-size: 13px; font-weight: 600; letter-spacing: .015em; }
    .service-address {
      overflow: hidden;
      margin: 0;
      color: var(--muted);
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
      user-select: text;
    }
    .unavailable { opacity: .48; }
    .actions { display: flex; gap: 7px; }
    .action {
      min-width: 76px;
      padding: 8px 11px;
      border: 1px solid var(--line);
      border-radius: 2px;
      background: transparent;
      color: var(--green-soft);
      cursor: pointer;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      transition: background 130ms ease, border-color 130ms ease, color 130ms ease;
    }
    .action:hover:not(:disabled), .action:focus-visible {
      border-color: var(--green);
      background: var(--green);
      color: var(--ink);
      outline: none;
    }
    .action:disabled { cursor: default; opacity: .35; }

    .empty, .error {
      display: grid;
      min-height: 180px;
      place-items: center;
      border-bottom: 1px solid var(--soft-line);
      color: var(--muted);
      font-family: var(--display);
      font-size: 18px;
      font-style: italic;
      text-align: center;
    }
    .error { color: var(--danger); }

    footer {
      display: flex;
      align-items: end;
      justify-content: space-between;
      padding-top: 16px;
      color: var(--muted);
      font-size: 9px;
    }
    details { position: relative; }
    summary {
      color: var(--muted);
      cursor: pointer;
      letter-spacing: .1em;
      list-style: none;
      text-transform: uppercase;
    }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: "⌁ "; color: var(--green); }
    .settings-card {
      position: absolute;
      right: 0;
      bottom: 24px;
      width: 310px;
      padding: 17px;
      border: 1px solid var(--line);
      background: rgba(23, 32, 16, .97);
      box-shadow: 0 18px 50px rgba(0, 0, 0, .45);
    }
    .setting-label { margin: 0 0 5px; color: var(--muted); font-size: 8px; letter-spacing: .16em; text-transform: uppercase; }
    .setting-value { overflow: hidden; margin: 0 0 13px; color: var(--cream); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; user-select: text; }
    .quit { width: 100%; color: var(--muted); }
    .toast {
      position: fixed;
      right: 28px;
      bottom: 26px;
      padding: 9px 12px;
      border: 1px solid var(--green);
      background: var(--green);
      color: var(--ink);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .08em;
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
      transition: opacity 140ms ease, transform 140ms ease;
    }
    .toast.visible { opacity: 1; transform: translateY(0); }

    @keyframes pulse { 50% { opacity: .28; } }
    @keyframes arrive { from { opacity: 0; transform: translateY(5px); } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  </style>
</head>
<body>
  <main class="shell">
    <aside class="sidebar">
      <div class="brand">${keposMark}<div><div class="wordmark">KEPOS</div><div class="edition">DESKTOP / DIRECT</div></div></div>
      <nav class="role-nav" data-role="role-nav" aria-label="Kepos roles">
        <button class="role-tab" type="button" data-role-tab="subscriber" hidden>
          <span class="role-kind">Subscriber</span>
          <span class="role-name">Remote services</span>
          <span class="role-state" data-role="connection">Connecting</span>
        </button>
        <button class="role-tab" type="button" data-role-tab="publisher" hidden>
          <span class="role-kind">Publisher</span>
          <span class="role-name">Shared services</span>
          <span class="role-state" data-role="sharing">Starting</span>
        </button>
      </nav>
      <div class="sidebar-note">One app<br>Independent identities<br>Direct links</div>
    </aside>
    <section class="workspace">
      <header class="workspace-header">
        <span class="view-title" data-role="view-title">Remote services</span>
        <div class="status" data-role="view-status" data-state="connecting"><span class="status-dot"></span><span data-role="view-status-label">Connecting</span></div>
      </header>
      <section class="intro" aria-labelledby="service-heading">
        <div><p class="eyebrow" data-role="eyebrow">LOCAL SURFACE / DIRECT</p><h1 id="service-heading" data-role="headline">Far away. <em>Here.</em></h1></div>
        <div class="count" data-role="service-count">0 SERVICES</div>
      </section>
      <div class="surfaces">
        <section class="surface" data-role="remote-surface">
          <div class="surface-head"><strong>Available here</strong><span data-role="remote-label">Remote publisher</span></div>
          <div class="services" data-role="services" aria-live="polite"><div class="empty">Finding your private services…</div></div>
        </section>
        <section class="surface" data-role="publisher-surface" hidden>
          <div class="surface-head">
            <strong>Available remotely</strong>
            <div class="publisher-summary"><span data-role="subscriber-count">0 connected</span><span class="publisher-key" data-role="publisher-key">Publisher key pending</span><button class="action key-copy" type="button" data-action="copy-publisher-key" disabled>Copy key</button></div>
          </div>
          <div class="services" data-role="shared-services" aria-live="polite"><div class="empty">Starting local publisher…</div></div>
        </section>
      </div>
      <footer>
        <span>ONE LINK · MANY LOCAL ADDRESSES</span>
        <details data-role="settings">
          <summary>Settings</summary>
          <div class="settings-card">
            <p class="setting-label">Remote publisher</p><p class="setting-value" data-role="publisher">Not available</p>
            <p class="setting-label">Gateway</p><p class="setting-value" data-role="gateway">Not available</p>
            <p class="setting-label">Local sharing</p><p class="setting-value" data-role="local-publisher">Not configured</p>
            <button class="action quit" type="button" data-command="quit">Quit Kepos</button>
          </div>
        </details>
      </footer>
    </section>
  </main>
  <div class="toast" data-role="toast">Copied</div>
  <script>
    (() => {
      "use strict";
      let snapshot = null;
      let selectedRole = "subscriber";
      let toastTimer;
      const roleButtons = Array.from(document.querySelectorAll('[data-role-tab]'));
      const servicesNode = document.querySelector('[data-role="services"]');
      const sharedServicesNode = document.querySelector('[data-role="shared-services"]');
      const remoteSurfaceNode = document.querySelector('[data-role="remote-surface"]');
      const publisherSurfaceNode = document.querySelector('[data-role="publisher-surface"]');
      const countNode = document.querySelector('[data-role="service-count"]');
      const connectionNode = document.querySelector('[data-role="connection"]');
      const sharingNode = document.querySelector('[data-role="sharing"]');
      const viewTitleNode = document.querySelector('[data-role="view-title"]');
      const viewStatusNode = document.querySelector('[data-role="view-status"]');
      const viewStatusLabel = document.querySelector('[data-role="view-status-label"]');
      const headlineNode = document.querySelector('[data-role="headline"]');
      const eyebrowNode = document.querySelector('[data-role="eyebrow"]');
      const publisherNode = document.querySelector('[data-role="publisher"]');
      const localPublisherNode = document.querySelector('[data-role="local-publisher"]');
      const gatewayNode = document.querySelector('[data-role="gateway"]');
      const publisherKeyNode = document.querySelector('[data-role="publisher-key"]');
      const subscriberCountNode = document.querySelector('[data-role="subscriber-count"]');
      const publisherKeyButton = document.querySelector('[data-action="copy-publisher-key"]');
      const toastNode = document.querySelector('[data-role="toast"]');

      const escapeHtml = (value) => String(value)
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

      const icons = {
        build: '<svg viewBox="0 0 24 24"><path d="m15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9m6-6 3 3-6.5 6.5-3-3Z"/></svg>',
        git: '<svg viewBox="0 0 24 24"><circle cx="6" cy="4" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12M8 8c2 0 3 2 3 4s1 4 5 4V8"/></svg>',
        music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13M9 9l10-2M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/></svg>',
        photos: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 4"/></svg>',
        storage: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
        terminal: '<svg viewBox="0 0 24 24"><path d="m4 17 6-6-6-6M12 19h8"/></svg>',
        web: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
        port: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.5 7.5 7.5 4 7.5-4M12 12v9"/></svg>'
      };

      const icon = (service) => icons[service.icon] || icons.port;

      const primaryLabel = (service) => {
        if (service.action === "copy-command") return "Copy command";
        if (service.action === "copy-url") return "Copy URL";
        return service.action === "open" ? "Open" : "";
      };

      const renderService = (service) => {
        const address = service.url || service.copyText || "Local endpoint pending";
        const action = service.action === "open" ? "open" : "copy";
        const actionButton = '<button class="action" type="button" data-action="' + action + '" data-service="' + escapeHtml(service.id) + '"' +
          (service.available ? '' : ' disabled') + '>' + primaryLabel(service) + '</button>';
        return '<article class="service' + (service.available ? '' : ' unavailable') + '">' +
          '<div class="service-icon">' + icon(service) + '</div>' +
          '<div class="service-copy"><h2 class="service-name">' + escapeHtml(service.name) + '</h2>' +
          '<p class="service-address">' + escapeHtml(address) + '</p></div>' +
          '<div class="actions">' + actionButton + '</div></article>';
      };

      const renderPublishedService = (service) => {
        const address = service.id + ' · 127.0.0.1:' + service.targetPort;
        return '<article class="service published">' +
          '<div class="service-icon">' + icons.port + '</div>' +
          '<div class="service-copy"><h2 class="service-name">' + escapeHtml(service.name) + '</h2>' +
          '<p class="service-address">' + escapeHtml(address) + '</p></div></article>';
      };

      const selectRole = (role) => {
        selectedRole = role;
        render();
      };

      const render = () => {
        if (!snapshot) return;
        const subscriber = snapshot.subscriber;
        const publisher = snapshot.publisher;
        const services = subscriber && Array.isArray(subscriber.services) ? subscriber.services : [];
        if (selectedRole === 'subscriber' && !subscriber) selectedRole = 'publisher';
        if (selectedRole === 'publisher' && !publisher) selectedRole = 'subscriber';
        const showingSubscriber = selectedRole === 'subscriber' && subscriber;
        const showingPublisher = selectedRole === 'publisher' && publisher;
        for (const button of roleButtons) {
          const role = button.dataset.roleTab;
          const configured = Boolean(snapshot[role]);
          button.hidden = !configured;
          button.classList.toggle('selected', role === selectedRole);
          button.setAttribute('aria-pressed', String(role === selectedRole));
        }
        remoteSurfaceNode.hidden = !showingSubscriber;
        publisherSurfaceNode.hidden = !showingPublisher;
        if (subscriber) {
          const state = subscriber.phase === 'failed' ? 'failed' : subscriber.connection;
          connectionNode.textContent = subscriber.phase === 'failed' ? 'Failed' : subscriber.connection;
          connectionNode.closest('[data-role-tab]').dataset.state = state;
        }
        if (publisher) {
          const state = publisher.phase === 'running' ? 'connected' : publisher.phase;
          sharingNode.textContent = publisher.phase === 'running'
            ? publisher.activeSubscribers + ' connected'
            : publisher.phase;
          sharingNode.closest('[data-role-tab]').dataset.state = state;
        }
        const activeState = showingSubscriber
          ? (subscriber.phase === 'failed' ? 'failed' : subscriber.connection)
          : showingPublisher
            ? (publisher.phase === 'running' ? 'running' : publisher.phase)
            : 'stopped';
        const activeLabel = showingSubscriber
          ? (subscriber.phase === 'failed' ? 'Subscriber failed' : subscriber.connection)
          : showingPublisher
            ? (publisher.phase === 'running' ? 'Sharing' : publisher.phase)
            : 'Stopped';
        viewStatusNode.dataset.state = activeState;
        viewStatusLabel.textContent = activeLabel;
        viewTitleNode.textContent = showingSubscriber ? 'Remote services' : 'Shared services';
        const visibleCount = showingSubscriber
          ? services.length
          : showingPublisher
            ? publisher.services.length
            : 0;
        countNode.textContent = visibleCount + (visibleCount === 1 ? " SERVICE" : " SERVICES");
        headlineNode.innerHTML = showingSubscriber ? 'Far away. <em>Here.</em>' : 'From here. <em>Shared.</em>';
        eyebrowNode.textContent = showingSubscriber ? 'LOCAL SURFACE / DIRECT' : 'LOCAL PUBLISHER / DIRECT';
        publisherNode.textContent = subscriber && subscriber.remotePublisher
          ? subscriber.remotePublisher.displayName + " · " + subscriber.remotePublisher.keyFingerprint
          : "Not available";
        gatewayNode.textContent = subscriber && subscriber.gatewayPort ? "localhost:" + subscriber.gatewayPort : "Not available";
        localPublisherNode.textContent = publisher && publisher.displayName
          ? publisher.displayName + ' · ' + (publisher.keyFingerprint || 'starting')
          : publisher ? publisher.phase : 'Not configured';
        if (subscriber) {
          servicesNode.innerHTML = subscriber.error
            ? '<div class="error">' + escapeHtml(subscriber.error) + '</div>'
            : services.length
              ? services.map(renderService).join('')
              : '<div class="empty">Finding your private services…</div>';
        }
        if (publisher) {
          subscriberCountNode.textContent = publisher.activeSubscribers + ' connected';
          publisherKeyNode.textContent = publisher.publisherKey || 'Publisher key pending';
          publisherKeyButton.disabled = !publisher.publisherKey;
          sharedServicesNode.innerHTML = publisher.error
            ? '<div class="error">' + escapeHtml(publisher.error) + '</div>'
            : publisher.services.length
              ? publisher.services.map(renderPublishedService).join('')
              : '<div class="empty">No services configured</div>';
        }
      };

      const send = (command) => window.bareNative.postMessage(JSON.stringify(command));
      const showToast = (text) => {
        toastNode.textContent = text;
        toastNode.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastNode.classList.remove('visible'), 1300);
      };
      const copy = async (text) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const area = document.createElement('textarea');
          area.value = text; document.body.append(area); area.select();
          document.execCommand('copy'); area.remove();
        }
        showToast('Copied');
      };

      window.addEventListener("bare-native-message", (event) => {
        try {
          const next = JSON.parse(event.data);
          if (next && next.type === "snapshot") { snapshot = next; render(); }
        } catch { showToast('Invalid host message'); }
      });

      document.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        if (button.dataset.roleTab) { selectRole(button.dataset.roleTab); return; }
        if (button.dataset.command === 'quit') { send({ type: "quit" }); return; }
        try {
          if (button.dataset.action === 'copy-publisher-key') {
            if (snapshot && snapshot.publisher && snapshot.publisher.publisherKey) await copy(snapshot.publisher.publisherKey);
            return;
          }
          const service = snapshot && snapshot.subscriber && snapshot.subscriber.services.find((item) => item.id === button.dataset.service);
          if (!service || !service.available) return;
          if (button.dataset.action === 'copy' && service.copyText) { await copy(service.copyText); return; }
          if (button.dataset.action === 'open' && service.url) send({ type: "openService", serviceId: service.id });
        } catch { showToast('Copy failed'); }
      });

      window.bareNative.postMessage(JSON.stringify({ type: "ready" }));
    })();
  </script>
</body>
</html>`;
}
