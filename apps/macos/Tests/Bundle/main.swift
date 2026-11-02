import Foundation

enum BundleCheckError: Error { case invalidBundle }

func dictionary(at path: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: path)
    guard let value = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { throw BundleCheckError.invalidBundle }
    return value
}

do {
    guard CommandLine.arguments.count == 5 else { throw BundleCheckError.invalidBundle }
    let app = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let appInfo = try dictionary(at: app.appendingPathComponent("Contents/Info.plist"))
    let appEntitlements = try dictionary(at: URL(fileURLWithPath: CommandLine.arguments[2]))
    let providerEntitlements = try dictionary(at: URL(fileURLWithPath: CommandLine.arguments[3]))
    let team = CommandLine.arguments[4]
    guard let bundleID = appInfo["CFBundleIdentifier"] as? String, !bundleID.isEmpty,
          appEntitlements["com.apple.application-identifier"] as? String == "\(team).\(bundleID)",
          let group = appInfo["KeposAppGroupID"] as? String, group == "\(team).\(bundleID)",
          (appEntitlements["com.apple.security.application-groups"] as? [String]) == [group],
          (providerEntitlements["com.apple.security.application-groups"] as? [String]) == [group],
          appEntitlements["com.apple.developer.system-extension.install"] == nil,
          providerEntitlements["com.apple.security.app-sandbox"] as? Bool == true,
          (appEntitlements["com.apple.developer.networking.networkextension"] as? [String]) == ["packet-tunnel-provider"],
          (providerEntitlements["com.apple.developer.networking.networkextension"] as? [String]) == ["packet-tunnel-provider"],
          providerEntitlements["com.apple.security.network.client"] as? Bool == true,
          providerEntitlements["com.apple.security.network.server"] as? Bool == true,
          providerEntitlements["com.apple.security.cs.allow-jit"] as? Bool == true,
          let identifier = appInfo["KeposProviderBundleID"] as? String, identifier == "\(bundleID).tunnel" else { throw BundleCheckError.invalidBundle }
    let provider = app.appendingPathComponent("Contents/PlugIns/\(identifier).appex", isDirectory: true)
    let providerInfo = try dictionary(at: provider.appendingPathComponent("Contents/Info.plist"))
    guard providerInfo["CFBundleIdentifier"] as? String == identifier,
          providerInfo["CFBundleExecutable"] as? String == "KeposTunnel",
          providerInfo["CFBundlePackageType"] as? String == "XPC!",
          providerInfo["KeposAppGroupID"] as? String == group,
          providerInfo["CFBundleVersion"] as? String == appInfo["CFBundleVersion"] as? String,
          let ext = providerInfo["NSExtension"] as? [String: Any],
          ext["NSExtensionPointIdentifier"] as? String == "com.apple.networkextension.packet-tunnel",
          ext["NSExtensionPrincipalClass"] as? String == "KeposTunnel.PacketTunnelProvider" else { throw BundleCheckError.invalidBundle }
    print("macOS app extension identifiers, entitlements and provider metadata verified")
} catch {
    fputs("macOS app extension bundle validation failed\n", stderr)
    exit(1)
}
