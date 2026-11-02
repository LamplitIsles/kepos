import Foundation
import CoreFoundation

/// Bounded private messages: no identity secret or invitation is returned.
enum ManagedStateMessage {
    static let prepare = Data([1])

    static func response(_ state: ManagedState) -> Data? {
        try? JSONSerialization.data(withJSONObject: ["publicKey": state.publicKey, "paired": state.paired])
    }

    static func failure(_ error: ManagedVPNError) -> Data? {
        let reason = error == .identityInUse ? "identityInUse" : "localState"
        return try? JSONSerialization.data(withJSONObject: ["error": reason])
    }

    static func parse(_ data: Data) throws -> ManagedState {
        guard data.count <= 1024, let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw ManagedVPNError.providerUnavailable }
        if Set(object.keys) == ["error"], let error = object["error"] as? String {
            if error == "identityInUse" { throw ManagedVPNError.identityInUse }
            if error == "localState" { throw ManagedVPNError.localState }
            throw ManagedVPNError.providerUnavailable
        }
        guard Set(object.keys) == ["publicKey", "paired"], let key = object["publicKey"] as? String,
              key.utf8.count == 64, key.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let number = object["paired"] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw ManagedVPNError.providerUnavailable }
        let paired = number.boolValue
        return ManagedState(publicKey: key, paired: paired)
    }
}
