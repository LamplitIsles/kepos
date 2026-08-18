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
      --line-strong: rgba(215, 247, 152, 0.34);
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

    button { color: inherit; font: inherit; }
    [hidden] { display: none !important; }
    .shell {
      display: grid;
      grid-template-columns: 194px minmax(0, 1fr);
      width: 100vw;
      height: 100vh;
    }
    .sidebar {
      display: flex;
      min-width: 0;
      flex-direction: column;
      padding: 28px 18px 20px;
      border-right: 1px solid var(--line);
      background: rgba(17, 24, 12, .78);
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
    .nav-label {
      margin: 48px 12px 10px;
      color: var(--muted);
      font-size: 8px;
      letter-spacing: .18em;
      text-transform: uppercase;
    }
    .relationship-nav { display: grid; gap: 8px; }
    .relationship-tab,
    .settings-tab {
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
    .relationship-tab::before,
    .settings-tab::before {
      position: absolute;
      top: 14px;
      bottom: 14px;
      left: 0;
      width: 2px;
      background: transparent;
      content: "";
    }
    .relationship-tab:hover,
    .relationship-tab:focus-visible,
    .settings-tab:hover,
    .settings-tab:focus-visible { color: var(--cream); outline: none; }
    .relationship-tab.selected,
    .settings-tab.selected {
      border-color: var(--line);
      background: rgba(183, 238, 69, .055);
      color: var(--cream);
    }
    .relationship-tab.selected::before,
    .settings-tab.selected::before { background: var(--green); }
    .relationship-direction {
      color: var(--green);
      font-size: 8px;
      letter-spacing: .15em;
      text-transform: uppercase;
    }
    .relationship-name {
      overflow: hidden;
      font-size: 11px;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .relationship-state {
      overflow: hidden;
      font-size: 8px;
      letter-spacing: .08em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .relationship-tab[data-state="failed"] .relationship-state { color: var(--danger); }
    .relationship-tab[data-state="connected"] .relationship-state,
    .relationship-tab[data-state="running"] .relationship-state { color: var(--green-soft); }
    .settings-tab { margin-top: auto; grid-template-columns: auto 1fr; align-items: center; }
    .settings-tab svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; }
    .settings-label { font-size: 9px; letter-spacing: .12em; text-transform: uppercase; }

    .workspace {
      display: grid;
      min-width: 0;
      min-height: 0;
      grid-template-rows: auto minmax(0, 1fr);
      padding: 28px 30px 22px;
    }
    .workspace-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 42px;
      gap: 20px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }
    .view-context { min-width: 0; }
    .view-kicker { margin: 0 0 5px; color: var(--green); font-size: 8px; letter-spacing: .17em; text-transform: uppercase; }
    .view-line { display: flex; min-width: 0; align-items: baseline; gap: 10px; }
    .view-title {
      overflow: hidden;
      color: var(--cream);
      font-family: var(--display);
      font-size: 25px;
      font-weight: 400;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .count { flex: none; color: var(--muted); font-size: 8px; letter-spacing: .1em; text-transform: uppercase; }
    .status {
      display: flex;
      flex: none;
      align-items: center;
      gap: 9px;
      color: var(--muted);
      font-size: 9px;
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
    .status[data-state="connected"],
    .status[data-state="running"] { color: var(--green-soft); }
    .status[data-state="connected"] .status-dot,
    .status[data-state="running"] .status-dot {
      background: var(--green);
      box-shadow: 0 0 13px rgba(183, 238, 69, .62);
    }
    .status[data-state="connecting"] .status-dot,
    .status[data-state="reconnecting"] .status-dot { animation: pulse 1.3s ease-in-out infinite; }
    .status[data-state="failed"] { color: var(--danger); }
    .status[data-state="failed"] .status-dot { background: var(--danger); }

    .surfaces { min-height: 0; overflow-y: auto; padding-top: 20px; }
    .surface { padding-bottom: 28px; }
    .relationship-map {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 48px minmax(0, 1fr);
      align-items: stretch;
      margin-bottom: 26px;
    }
    .identity-card {
      display: grid;
      min-width: 0;
      min-height: 128px;
      align-content: space-between;
      gap: 16px;
      padding: 16px;
      border: 1px solid var(--line);
      background: rgba(23, 32, 16, .72);
    }
    .identity-card.local { background: rgba(183, 238, 69, .045); }
    .identity-top { display: flex; min-width: 0; align-items: start; justify-content: space-between; gap: 12px; }
    .identity-role { margin: 0 0 7px; color: var(--green); font-size: 8px; letter-spacing: .16em; text-transform: uppercase; }
    .identity-name { overflow: hidden; margin: 0; font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    .identity-place { flex: none; color: var(--muted); font-size: 8px; letter-spacing: .1em; text-transform: uppercase; }
    .identity-key { min-width: 0; }
    .key-label { margin: 0 0 5px; color: var(--muted); font-size: 8px; letter-spacing: .13em; text-transform: uppercase; }
    .key-line { display: flex; min-width: 0; align-items: center; gap: 8px; }
    .key-value {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      color: var(--cream);
      font-size: 10px;
      text-overflow: ellipsis;
      user-select: text;
      white-space: nowrap;
    }
    .relation-flow { display: grid; place-items: center; color: var(--line-strong); }
    .relation-flow svg { width: 34px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.4; }
    .relation-flow-label { position: absolute; overflow: hidden; width: 1px; height: 1px; clip: rect(0 0 0 0); }
    .section-head {
      display: flex;
      min-height: 42px;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      border-bottom: 1px solid var(--soft-line);
      color: var(--muted);
      font-size: 8px;
      letter-spacing: .15em;
      text-transform: uppercase;
    }
    .section-head strong { color: var(--cream); font-size: 9px; font-weight: 600; }
    .section-note { color: var(--muted); font-size: 8px; letter-spacing: .08em; }
    .subscriber-roster { margin-bottom: 24px; }
    .subscriber-row {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) auto;
      min-height: 58px;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--soft-line);
    }
    .member-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); box-shadow: 0 0 10px rgba(183, 238, 69, .45); }
    .member-copy { min-width: 0; }
    .member-name { margin: 0 0 4px; font-size: 11px; font-weight: 700; }
    .member-key { overflow: hidden; margin: 0; color: var(--muted); font-size: 9px; text-overflow: ellipsis; user-select: text; white-space: nowrap; }
    .empty-roster {
      display: grid;
      min-height: 72px;
      place-items: center start;
      border-bottom: 1px solid var(--soft-line);
      color: var(--muted);
      font-family: var(--display);
      font-size: 16px;
      font-style: italic;
    }

    .publisher-primary-actions { display: flex; align-items: center; gap: 8px; }
    .pairing {
      display: grid;
      grid-template-columns: 154px minmax(0, 1fr);
      gap: 22px;
      align-items: center;
      margin-bottom: 18px;
      padding: 20px;
      border: 1px solid var(--line);
      background: rgba(183, 238, 69, .035);
    }
    .pairing.pending { grid-template-columns: minmax(0, 1fr) auto; }
    .pairing-qr { display: grid; width: 154px; height: 154px; place-items: center; padding: 8px; background: var(--cream); }
    .pairing-qr svg { width: 100%; height: 100%; }
    .pairing-title { margin: 0 0 8px; font-size: 14px; }
    .pairing-detail { margin: 0 0 16px; color: var(--muted); font-size: 10px; line-height: 1.55; }
    .pairing-error { color: var(--danger); }
    .pairing-actions { display: flex; gap: 8px; }

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
    .service-icon { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid var(--line); color: var(--green-soft); }
    .service-icon svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; }
    .service-copy { min-width: 0; }
    .service-name { margin: 0 0 4px; font-size: 13px; font-weight: 600; letter-spacing: .015em; }
    .service-address { overflow: hidden; margin: 0; color: var(--muted); font-size: 10px; text-overflow: ellipsis; user-select: text; white-space: nowrap; }
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
    .action:hover:not(:disabled), .action:focus-visible { border-color: var(--green); background: var(--green); color: var(--ink); outline: none; }
    .action:disabled { cursor: default; opacity: .35; }
    .action.compact { min-width: auto; padding: 6px 8px; }
    .action.danger { border-color: rgba(255, 159, 130, .35); color: var(--danger); }

    .empty, .error { display: grid; min-height: 150px; place-items: center; border-bottom: 1px solid var(--soft-line); color: var(--muted); font-family: var(--display); font-size: 18px; font-style: italic; text-align: center; }
    .error { color: var(--danger); }
    .settings-intro { max-width: 530px; margin: 2px 0 26px; color: var(--muted); font-family: var(--display); font-size: 18px; line-height: 1.45; }
    .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .settings-panel { min-height: 126px; padding: 16px; border: 1px solid var(--line); background: rgba(23, 32, 16, .68); }
    .setting-label { margin: 0 0 8px; color: var(--green); font-size: 8px; letter-spacing: .16em; text-transform: uppercase; }
    .setting-value { overflow: hidden; margin: 0 0 17px; color: var(--cream); font-size: 11px; text-overflow: ellipsis; user-select: text; white-space: nowrap; }
    .setting-value:last-child { margin-bottom: 0; }
    .runtime-actions { display: flex; justify-content: flex-end; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--soft-line); }
    .quit { color: var(--danger); }
    .toast { position: fixed; right: 28px; bottom: 26px; padding: 9px 12px; border: 1px solid var(--green); background: var(--green); color: var(--ink); font-size: 9px; font-weight: 700; letter-spacing: .08em; opacity: 0; pointer-events: none; transform: translateY(8px); transition: opacity 140ms ease, transform 140ms ease; }
    .toast.visible { opacity: 1; transform: translateY(0); }

    @keyframes pulse { 50% { opacity: .28; } }
    @keyframes arrive { from { opacity: 0; transform: translateY(5px); } }
    @media (max-width: 680px) {
      .shell { grid-template-columns: 176px minmax(0, 1fr); }
      .workspace { padding-inline: 22px; }
      .relationship-map { grid-template-columns: 1fr; gap: 0; }
      .relation-flow { min-height: 38px; transform: rotate(90deg); }
      .settings-grid { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  </style>
</head>
<body>
  <main class="shell">
    <aside class="sidebar">
      <div class="brand">${keposMark}<div><div class="wordmark">KEPOS</div><div class="edition">DESKTOP</div></div></div>
      <p class="nav-label">Relationships</p>
      <nav class="relationship-nav" data-role="relationship-nav" aria-label="Publisher relationships">
        <button class="relationship-tab" type="button" data-relationship-tab="remote" hidden>
          <span class="relationship-direction">Connected to</span>
          <span class="relationship-name" data-role="remote-relationship-name">Remote publisher</span>
          <span class="relationship-state" data-role="connection">Connecting</span>
        </button>
        <button class="relationship-tab" type="button" data-relationship-tab="hosted" hidden>
          <span class="relationship-direction">Published here</span>
          <span class="relationship-name" data-role="hosted-relationship-name">This Mac</span>
          <span class="relationship-state" data-role="sharing">Starting</span>
        </button>
      </nav>
      <button class="settings-tab" type="button" data-view-tab="settings" data-role="settings">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.16.39.38.73.7 1 .3.28.7.42 1.1.4H21v4h-.09a1.7 1.7 0 0 0-1.51.6Z"/></svg>
        <span class="settings-label">Settings</span>
      </button>
    </aside>
    <section class="workspace">
      <header class="workspace-header">
        <div class="view-context">
          <p class="view-kicker" data-role="view-kicker">Remote relationship</p>
          <div class="view-line"><span class="view-title" data-role="view-title">Remote publisher</span><span class="count" data-role="service-count">0 services</span></div>
        </div>
        <div class="status" data-role="view-status" data-state="connecting"><span class="status-dot"></span><span data-role="view-status-label">Connecting</span></div>
      </header>
      <div class="surfaces">
        <section class="surface" data-role="remote-surface">
          <div class="relationship-map">
            <article class="identity-card" data-role="relationship-publisher" data-identity="remote-publisher">
              <div class="identity-top"><div><p class="identity-role">Publisher</p><h2 class="identity-name" data-role="remote-publisher-name">Remote publisher</h2></div><span class="identity-place">Remote</span></div>
              <div class="identity-key"><p class="key-label">Public key</p><div class="key-line"><span class="key-value" data-role="remote-publisher-key">Pending</span><button class="action compact" type="button" data-action="copy-remote-publisher-key" aria-label="Copy remote publisher public key" disabled>Copy</button></div></div>
            </article>
            <div class="relation-flow"><span class="relation-flow-label">publishes services to</span><svg viewBox="0 0 36 18" aria-hidden="true"><path d="M2 9h30M26 3l6 6-6 6"/></svg></div>
            <article class="identity-card local" data-role="relationship-subscribers" data-identity="local-subscriber">
              <div class="identity-top"><div><p class="identity-role">Subscriber</p><h2 class="identity-name">This Mac</h2></div><span class="identity-place">Local</span></div>
              <div class="identity-key"><p class="key-label">Public key</p><div class="key-line"><span class="key-value" data-role="local-subscriber-key">Pending</span><button class="action compact" type="button" data-action="copy-local-subscriber-key" aria-label="Copy this Mac subscriber public key" disabled>Copy</button></div></div>
            </article>
          </div>
          <div class="section-head"><strong>Services from this publisher</strong><span data-role="remote-service-label">0 available</span></div>
          <div class="services" data-role="services" aria-live="polite"><div class="empty">Finding your private services…</div></div>
        </section>
        <section class="surface" data-role="hosted-surface" hidden>
          <article class="identity-card local" data-role="relationship-publisher" data-identity="local-publisher">
            <div class="identity-top"><div><p class="identity-role">Publisher</p><h2 class="identity-name" data-role="local-publisher-name">This Mac</h2></div><div class="publisher-primary-actions"><button class="action compact" type="button" data-action="create-pairing">Add device</button><span class="identity-place">Local</span></div></div>
            <div class="identity-key"><p class="key-label">Public key</p><div class="key-line"><span class="key-value" data-role="local-publisher-key">Pending</span><button class="action compact" type="button" data-action="copy-local-publisher-key" aria-label="Copy this Mac publisher public key" disabled>Copy</button></div></div>
          </article>
          <div class="pairing" data-role="pairing" hidden></div>
          <section class="subscriber-roster" data-role="relationship-subscribers">
            <div class="section-head"><strong>Connected subscribers</strong><span data-role="subscriber-count">0 connected</span></div>
            <div data-role="connected-subscribers"><div class="empty-roster">No subscribers connected</div></div>
          </section>
          <div class="section-head"><strong>Services published here</strong><span data-role="shared-service-label">0 shared</span></div>
          <div class="services" data-role="shared-services" aria-live="polite"><div class="empty">Starting local publisher…</div></div>
        </section>
        <section class="surface" data-role="settings-surface" hidden>
          <p class="settings-intro">Global runtime details live here. Public identities and membership stay with the publisher relationship they belong to.</p>
          <div class="settings-grid">
            <article class="settings-panel"><p class="setting-label">Subscriber runtime</p><p class="setting-value" data-role="subscriber-runtime">Not configured</p><p class="setting-label">Local gateway</p><p class="setting-value" data-role="gateway">Not available</p></article>
            <article class="settings-panel"><p class="setting-label">Publisher runtime</p><p class="setting-value" data-role="publisher-runtime">Not configured</p><p class="setting-label">Transport</p><p class="setting-value">One shared HyperDHT node</p></article>
          </div>
          <div class="runtime-actions"><button class="action quit" type="button" data-command="quit">Quit Kepos</button></div>
        </section>
      </div>
    </section>
  </main>
  <div class="toast" data-role="toast">Copied</div>
  <script>
    (() => {
      "use strict";
      let snapshot = null;
      let selectedView = "remote";
      let toastTimer;
      const relationshipButtons = Array.from(document.querySelectorAll('[data-relationship-tab]'));
      const settingsButton = document.querySelector('[data-view-tab="settings"]');
      const servicesNode = document.querySelector('[data-role="services"]');
      const sharedServicesNode = document.querySelector('[data-role="shared-services"]');
      const remoteSurfaceNode = document.querySelector('[data-role="remote-surface"]');
      const hostedSurfaceNode = document.querySelector('[data-role="hosted-surface"]');
      const settingsSurfaceNode = document.querySelector('[data-role="settings-surface"]');
      const countNode = document.querySelector('[data-role="service-count"]');
      const connectionNode = document.querySelector('[data-role="connection"]');
      const sharingNode = document.querySelector('[data-role="sharing"]');
      const viewKickerNode = document.querySelector('[data-role="view-kicker"]');
      const viewTitleNode = document.querySelector('[data-role="view-title"]');
      const viewStatusNode = document.querySelector('[data-role="view-status"]');
      const viewStatusLabel = document.querySelector('[data-role="view-status-label"]');
      const remoteRelationshipName = document.querySelector('[data-role="remote-relationship-name"]');
      const hostedRelationshipName = document.querySelector('[data-role="hosted-relationship-name"]');
      const remotePublisherName = document.querySelector('[data-role="remote-publisher-name"]');
      const remotePublisherKey = document.querySelector('[data-role="remote-publisher-key"]');
      const localSubscriberKey = document.querySelector('[data-role="local-subscriber-key"]');
      const localPublisherName = document.querySelector('[data-role="local-publisher-name"]');
      const localPublisherKey = document.querySelector('[data-role="local-publisher-key"]');
      const remotePublisherCopy = document.querySelector('[data-action="copy-remote-publisher-key"]');
      const localSubscriberCopy = document.querySelector('[data-action="copy-local-subscriber-key"]');
      const localPublisherCopy = document.querySelector('[data-action="copy-local-publisher-key"]');
      const subscriberCountNode = document.querySelector('[data-role="subscriber-count"]');
      const connectedSubscribersNode = document.querySelector('[data-role="connected-subscribers"]');
      const remoteServiceLabel = document.querySelector('[data-role="remote-service-label"]');
      const sharedServiceLabel = document.querySelector('[data-role="shared-service-label"]');
      const subscriberRuntimeNode = document.querySelector('[data-role="subscriber-runtime"]');
      const publisherRuntimeNode = document.querySelector('[data-role="publisher-runtime"]');
      const gatewayNode = document.querySelector('[data-role="gateway"]');
      const createPairingButton = document.querySelector('[data-action="create-pairing"]');
      const pairingNode = document.querySelector('[data-role="pairing"]');
      const toastNode = document.querySelector('[data-role="toast"]');

      const escapeHtml = (value) => String(value)
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

      const fingerprint = (key) => key ? key.slice(0, 8) + '…' + key.slice(-8) : 'Pending';
      const plural = (count, singular, pluralValue) => count + ' ' + (count === 1 ? singular : pluralValue);

      const icons = {
        book: '<svg viewBox="0 0 24 24"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3z"/><path d="M21 18a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-5a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3z"/></svg>',
        build: '<svg viewBox="0 0 24 24"><path d="m15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9"/><path d="M17.64 15 22 10.64"/><path d="m20.91 11.7-1.25-1.25a2.18 2.18 0 0 1 0-3.08l.52-.52a2.18 2.18 0 0 0-3.08 0L16 3.09a2.18 2.18 0 0 0-3.07 0L11.7 4.34a2.18 2.18 0 0 1 0 3.08l1.24 1.24"/></svg>',
        dashboard: '<svg viewBox="0 0 24 24"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
        dagger: '<svg viewBox="0 0 24 24"><path d="m11 19-6-6"/><path d="m5 21-2-2"/><path d="m8 16-4 4"/><path d="M9.5 17.5 21 6V3h-3L6.5 14.5"/></svg>',
        git: '<svg viewBox="0 0 24 24"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
        music: '<svg viewBox="0 0 24 24"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg>',
        photos: '<svg viewBox="0 0 24 24"><path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/></svg>',
        proxy: '<svg viewBox="0 0 24 24"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>',
        storage: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v7c0 1.66 4 3 9 3"/><path d="M3 12v7c0 1.66 4 3 9 3"/><path d="m16 19 2 2 4-4"/><path d="M21 12.35V5"/></svg>',
        terminal: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3z"/><path d="m7 11 2-2-2-2"/><path d="m11 13 4 0"/></svg>',
        web: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="m10 14 11-11"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
        port: '<svg viewBox="0 0 24 24"><path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>'
      };

      const icon = (service) => icons[service.icon] || icons.port;
      const primaryLabel = (service) => {
        if (service.action === "copy-command") return "Copy command";
        if (service.action === "copy-url") return "Copy URL";
        return service.action === "open" ? "Open" : "";
      };

      const renderService = (service) => {
        const action = service.action === "open" ? "open" : "copy";
        const actionButton = '<button class="action" type="button" data-action="' + action + '" data-service="' + escapeHtml(service.id) + '"' +
          (service.available ? '' : ' disabled') + '>' + primaryLabel(service) + '</button>';
        return '<article class="service' + (service.available ? '' : ' unavailable') + '">' +
          '<div class="service-icon">' + icon(service) + '</div>' +
          '<div class="service-copy"><h2 class="service-name">' + escapeHtml(service.name) + '</h2></div>' +
          '<div class="actions">' + actionButton + '</div></article>';
      };

      const renderPublishedService = (service) => {
        const address = service.id + ' · 127.0.0.1:' + service.targetPort;
        return '<article class="service published"><div class="service-icon">' + icons.port + '</div>' +
          '<div class="service-copy"><h2 class="service-name">' + escapeHtml(service.name) + '</h2>' +
          '<p class="service-address">' + escapeHtml(address) + '</p></div></article>';
      };

      const renderConnectedSubscriber = (key, index) => {
        const label = 'Subscriber ' + String(index + 1).padStart(2, '0');
        return '<article class="subscriber-row"><span class="member-dot"></span><div class="member-copy">' +
          '<p class="member-name">' + label + '</p>' +
          '<p class="member-key">' + escapeHtml(fingerprint(key)) + '</p></div>' +
          '<button class="action compact" type="button" data-action="copy-connected-subscriber" data-subscriber-index="' + index + '" aria-label="Copy ' + label + ' public key">Copy</button></article>';
      };

      const renderPairing = (pairing) => {
        if (!pairing || pairing.phase === 'idle') {
          pairingNode.hidden = true;
          pairingNode.innerHTML = '';
          createPairingButton.hidden = false;
          return;
        }
        createPairingButton.hidden = true;
        pairingNode.hidden = false;
        pairingNode.classList.toggle('pending', pairing.phase === 'pending');
        if (pairing.phase === 'pending') {
          pairingNode.innerHTML = '<div><h2 class="pairing-title">Approve this subscriber?</h2>' +
            '<p class="pairing-detail">' + escapeHtml(pairing.label) + ' · ' + escapeHtml(pairing.platform) + '<br>' +
            'Key ' + escapeHtml(pairing.keyFingerprint) +
            (pairing.error ? '<br><span class="pairing-error">' + escapeHtml(pairing.error) + '</span>' : '') + '</p></div>' +
            '<div class="pairing-actions"><button class="action danger" type="button" data-action="deny-pairing">Deny</button>' +
            '<button class="action" type="button" data-action="approve-pairing">Allow</button></div>';
          return;
        }
        const seconds = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
        pairingNode.innerHTML = '<div class="pairing-qr">' + (pairing.qrSvg || '') + '</div><div>' +
          '<h2 class="pairing-title">Add a subscriber</h2><p class="pairing-detail">' +
          (pairing.expired ? 'Invitation expired.' : 'Scan this invitation on the device that will subscribe. Expires in ' + seconds + ' seconds.') +
          '</p><div class="pairing-actions"><button class="action danger" type="button" data-action="cancel-pairing">Cancel</button>' +
          (pairing.expired ? '<button class="action" type="button" data-action="create-pairing">Generate new</button>' : '') +
          '</div></div>';
      };

      const selectView = (view) => { selectedView = view; render(); };

      const render = () => {
        if (!snapshot) return;
        const subscriber = snapshot.subscriber;
        const publisher = snapshot.publisher;
        const services = subscriber && Array.isArray(subscriber.services) ? subscriber.services : [];
        const availableServices = services.filter((service) => service.available);
        const subscriberKeys = publisher && Array.isArray(publisher.activeSubscriberKeys) ? publisher.activeSubscriberKeys : [];
        if (selectedView === 'remote' && !subscriber) selectedView = publisher ? 'hosted' : 'settings';
        if (selectedView === 'hosted' && !publisher) selectedView = subscriber ? 'remote' : 'settings';

        for (const button of relationshipButtons) {
          const view = button.dataset.relationshipTab;
          const configured = view === 'remote' ? Boolean(subscriber) : Boolean(publisher);
          button.hidden = !configured;
          button.classList.toggle('selected', view === selectedView);
          button.setAttribute('aria-pressed', String(view === selectedView));
        }
        settingsButton.classList.toggle('selected', selectedView === 'settings');
        settingsButton.setAttribute('aria-pressed', String(selectedView === 'settings'));
        remoteSurfaceNode.hidden = selectedView !== 'remote';
        hostedSurfaceNode.hidden = selectedView !== 'hosted';
        settingsSurfaceNode.hidden = selectedView !== 'settings';

        if (subscriber) {
          const remoteName = subscriber.remotePublisher ? subscriber.remotePublisher.displayName : 'Remote publisher';
          const state = subscriber.phase === 'failed' ? 'failed' : subscriber.connection;
          remoteRelationshipName.textContent = remoteName;
          connectionNode.textContent = subscriber.phase === 'failed' ? 'Failed' : subscriber.connection;
          connectionNode.closest('[data-relationship-tab]').dataset.state = state;
          remotePublisherName.textContent = remoteName;
          remotePublisherKey.textContent = fingerprint(subscriber.remotePublisher && subscriber.remotePublisher.publisherKey);
          localSubscriberKey.textContent = fingerprint(subscriber.subscriberKey);
          remotePublisherCopy.disabled = !(subscriber.remotePublisher && subscriber.remotePublisher.publisherKey);
          localSubscriberCopy.disabled = !subscriber.subscriberKey;
          subscriberRuntimeNode.textContent = subscriber.phase + ' · ' + subscriber.connection;
          gatewayNode.textContent = subscriber.gatewayPort ? 'localhost:' + subscriber.gatewayPort : 'Not available';
          remoteServiceLabel.textContent = plural(availableServices.length, 'available', 'available');
          servicesNode.innerHTML = subscriber.error
            ? '<div class="error">' + escapeHtml(subscriber.error) + '</div>'
            : services.length ? services.map(renderService).join('') : '<div class="empty">Finding your private services…</div>';
        } else {
          subscriberRuntimeNode.textContent = 'Not configured';
          gatewayNode.textContent = 'Not available';
        }

        if (publisher) {
          const localName = publisher.displayName || 'This Mac';
          const state = publisher.phase === 'running' ? 'running' : publisher.phase;
          hostedRelationshipName.textContent = localName;
          sharingNode.textContent = publisher.phase === 'running' ? plural(subscriberKeys.length, 'connected', 'connected') : publisher.phase;
          sharingNode.closest('[data-relationship-tab]').dataset.state = state;
          localPublisherName.textContent = localName;
          localPublisherKey.textContent = fingerprint(publisher.publisherKey);
          localPublisherCopy.disabled = !publisher.publisherKey;
          createPairingButton.disabled = publisher.phase !== 'running';
          subscriberCountNode.textContent = plural(subscriberKeys.length, 'connected', 'connected');
          connectedSubscribersNode.innerHTML = subscriberKeys.length
            ? subscriberKeys.map(renderConnectedSubscriber).join('')
            : '<div class="empty-roster">No subscribers connected</div>';
          publisherRuntimeNode.textContent = publisher.phase + ' · ' + plural(subscriberKeys.length, 'subscriber', 'subscribers');
          sharedServiceLabel.textContent = plural(publisher.services.length, 'shared', 'shared');
          renderPairing(publisher.pairing);
          sharedServicesNode.innerHTML = publisher.error
            ? '<div class="error">' + escapeHtml(publisher.error) + '</div>'
            : publisher.services.length ? publisher.services.map(renderPublishedService).join('') : '<div class="empty">No services configured</div>';
        } else {
          publisherRuntimeNode.textContent = 'Not configured';
        }

        const showingRemote = selectedView === 'remote' && subscriber;
        const showingHosted = selectedView === 'hosted' && publisher;
        const activeState = showingRemote
          ? (subscriber.phase === 'failed' ? 'failed' : subscriber.connection)
          : showingHosted ? (publisher.phase === 'running' ? 'running' : publisher.phase) : snapshot.appPhase;
        const activeLabel = showingRemote
          ? (subscriber.phase === 'failed' ? 'Subscriber failed' : subscriber.connection)
          : showingHosted ? (publisher.phase === 'running' ? 'Publishing' : publisher.phase) : snapshot.appPhase;
        viewStatusNode.dataset.state = activeState;
        viewStatusLabel.textContent = activeLabel;
        viewKickerNode.textContent = showingRemote ? 'Remote relationship' : showingHosted ? 'Hosted relationship' : 'This Mac';
        viewTitleNode.textContent = showingRemote
          ? (subscriber.remotePublisher ? subscriber.remotePublisher.displayName : 'Remote publisher')
          : showingHosted ? (publisher.displayName || 'Local publisher') : 'Settings';
        const visibleCount = showingRemote ? availableServices.length : showingHosted ? publisher.services.length : 0;
        countNode.textContent = selectedView === 'settings' ? 'DEVICE' : plural(visibleCount, 'SERVICE', 'SERVICES');
      };

      const send = (command) => window.bareNative.postMessage(JSON.stringify(command));
      const showToast = (text) => {
        toastNode.textContent = text;
        toastNode.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastNode.classList.remove('visible'), 1300);
      };
      const copy = async (text, label) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const area = document.createElement('textarea');
          area.value = text; document.body.append(area); area.select();
          document.execCommand('copy'); area.remove();
        }
        showToast(label + ' copied');
      };

      for (const button of relationshipButtons) {
        button.addEventListener('click', () =>
          selectView(button.dataset.relationshipTab),
        );
      }
      settingsButton.addEventListener('click', () => selectView('settings'));

      window.addEventListener("bare-native-message", (event) => {
        try {
          const next = JSON.parse(event.data);
          if (next && next.type === "snapshot") { snapshot = next; render(); }
        } catch { showToast('Invalid host message'); }
      });

      document.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        if (button.dataset.command === 'quit') { send({ type: "quit" }); return; }
        try {
          if (button.dataset.action === 'copy-remote-publisher-key') {
            const key = snapshot && snapshot.subscriber && snapshot.subscriber.remotePublisher && snapshot.subscriber.remotePublisher.publisherKey;
            if (key) await copy(key, 'Publisher key');
            return;
          }
          if (button.dataset.action === 'copy-local-subscriber-key') {
            const key = snapshot && snapshot.subscriber && snapshot.subscriber.subscriberKey;
            if (key) await copy(key, 'Subscriber key');
            return;
          }
          if (button.dataset.action === 'copy-local-publisher-key') {
            const key = snapshot && snapshot.publisher && snapshot.publisher.publisherKey;
            if (key) await copy(key, 'Publisher key');
            return;
          }
          if (button.dataset.action === 'copy-connected-subscriber') {
            const index = Number(button.dataset.subscriberIndex);
            const key = snapshot && snapshot.publisher && snapshot.publisher.activeSubscriberKeys[index];
            if (key) await copy(key, 'Subscriber key');
            return;
          }
          if (button.dataset.action === 'create-pairing') { send({ type: "createPairingInvitation" }); return; }
          if (button.dataset.action === 'cancel-pairing') { send({ type: "cancelPairing" }); return; }
          if (button.dataset.action === 'approve-pairing') { send({ type: "approvePairing" }); return; }
          if (button.dataset.action === 'deny-pairing') { send({ type: "denyPairing" }); return; }
          const service = snapshot && snapshot.subscriber && snapshot.subscriber.services.find((item) => item.id === button.dataset.service);
          if (!service || !service.available) return;
          if (button.dataset.action === 'copy' && service.copyText) { await copy(service.copyText, 'Service address'); return; }
          if (button.dataset.action === 'open' && service.url) send({ type: "openService", serviceId: service.id });
        } catch { showToast('Copy failed'); }
      });

      window.bareNative.postMessage(JSON.stringify({ type: "ready" }));
    })();
  </script>
</body>
</html>`;
}
