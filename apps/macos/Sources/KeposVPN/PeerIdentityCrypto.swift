import CryptoKit
import Foundation

func existingPeerIdentity() -> ExistingIdentity {
    ExistingIdentity { seed in
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        return key.publicKey.rawRepresentation
    }
}
