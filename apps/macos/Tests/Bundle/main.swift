import Foundation

enum BundleCheckError: Error {
    case invalidBundle
    case missingUsageDescription
    case invalidApplicationIdentifier
}

func info(at path: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: path.appendingPathComponent("Contents/Info.plist"))
    guard let result = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
        throw BundleCheckError.invalidBundle
    }
    return result
}

func checkUsage(_ info: [String: Any]) throws {
    guard let usage = info["NSSystemExtensionUsageDescription"] as? String,
          !usage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw BundleCheckError.missingUsageDescription
    }
}

do {
    guard CommandLine.arguments.count == 4 else { throw BundleCheckError.invalidBundle }
    let app = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let appInfo = try info(at: app)
    try checkUsage(appInfo)
    guard let bundleID = appInfo["CFBundleIdentifier"] as? String, !bundleID.isEmpty else {
        throw BundleCheckError.invalidBundle
    }
    let entitlementsData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
    guard let entitlements = try PropertyListSerialization.propertyList(from: entitlementsData, format: nil) as? [String: Any],
          entitlements["com.apple.application-identifier"] as? String == "\(CommandLine.arguments[3]).\(bundleID)" else {
        throw BundleCheckError.invalidApplicationIdentifier
    }
    guard let identifier = appInfo["KeposProviderBundleID"] as? String, !identifier.isEmpty,
          !identifier.contains("/") else { throw BundleCheckError.invalidBundle }
    let provider = app.appendingPathComponent("Contents/Library/SystemExtensions/\(identifier).systemextension", isDirectory: true)
    let providerInfo = try info(at: provider)
    guard providerInfo["CFBundleIdentifier"] as? String == identifier else { throw BundleCheckError.invalidBundle }
    try checkUsage(providerInfo)
    print("macOS bundle usage descriptions and host application identifier verified")
} catch {
    fputs("macOS bundle validation failed: \(error)\n", stderr)
    exit(1)
}
