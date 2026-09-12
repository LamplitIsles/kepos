# Desktop devices and services

The desktop is a browser for services provided by devices. Its left sidebar
lists devices such as `kosmos` and `mac`; selecting a device shows that device's
services on the right. The local device belongs in the same navigation list,
with a **This device** label. It is not a separate publisher or sharing mode.

This restores the visual identity used before the canonical peer refactor:
dark olive surfaces, lime accents, cream text, fine borders, the Kepos mark,
serif device headings, and monospace labels. Service cards carry the familiar
icons and explicit Open, Copy command, Copy URL, or endpoint actions.

## Information hierarchy

- Device names and connection state orient the user. Public keys, connection
  direction and capability details sit behind a device-details disclosure.
- The primary pane shows provided services. Consuming a remote service through
  a local endpoint does not move it to the local device's page. A republished
  service belongs to the device republishing it, even when its source is remote.
- Local cards show service sources and availability. Remote cards expose the
  canonical service action and the local endpoint when one exists.
- Device selection survives incoming snapshots. The page stores the selected
  public key in browser-local storage where that storage is available.
- Offline peers remain visible. Retained catalogs and configured bindings show
  unavailable reasons; an offline device does not silently disappear.
- Settings contains local identity, gateway information, diagnostics, and Quit.
  Closing the native window continues to hide it without stopping services.
- Invitations allow connection approval. They explicitly state that service
  access is granted separately; approval does not create service grants.

Names in the interface follow the [domain glossary](../../CONTEXT.md).
Transport direction, admission, and grants retain the existing
[canonical peer contract](../adr/0013-separate-connection-roles-from-service-roles.md).
Selecting a device does not override the gateway's same-ID ambiguity rules or
create a new hostname scheme.

## Rendering and styles

The shared macOS and Windows view remains raw HTML and JavaScript in
`apps/desktop/src/ui.ts`. Tailwind CSS 4 handles layout, spacing, typography,
responsive behavior and component states. daisyUI 5 supplies component styles;
`ui.css` supplies the Kepos theme and small shared visual treatments.

`runDesktopBuild` compiles these styles before TypeScript compilation. The
result is embedded through `ui-styles.ts`, so native WebViews load no remote
styles, fonts, scripts or assets. The generated module is checked in so portable
UI tests and source previews use the same stylesheet without a native build.
Regenerate it after editing the view or stylesheet:

```sh
node --import tsx scripts/build-desktop-styles.ts
```

## Validation

`test/desktop-ui-bridge.test.ts` runs the actual page script against a DOM with
synthetic peer snapshots. It covers device navigation, service ownership,
retained selection, search, current availability, copying, pairing and native
bridge commands. No test reads an installed app's configuration or identity.

Visual checks use synthetic browser fixtures at narrow, normal and wide desktop
sizes, including the local empty state, unavailable services and pairing. For
the native artifact, use the isolated rendered smoke and TCP binding check:

```sh
node --import tsx --test test/native/desktop-binding.native.ts
```

After a signed local installation, separately verify the real service routes
and the native window. Preserve a complete rollback app and state backup.
