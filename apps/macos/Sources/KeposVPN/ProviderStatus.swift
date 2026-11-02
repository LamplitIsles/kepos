import Foundation

private struct ProviderSnapshot: Decodable {
    struct Peer: Decodable {
        let publicKey: String
        let label: String
        let connected: Bool
    }
    let running: Bool
    let peers: [Peer]
}

enum ProviderStatus {
    static func peers(from data: Data) -> [VPNPeerStatus]? {
        guard data.count <= 32_768,
              let value = try? JSONDecoder().decode(ProviderSnapshot.self, from: data),
              value.running, value.peers.count <= 16 else { return nil }
        var peers: [VPNPeerStatus] = []
        var keys = Set<String>()
        for row in value.peers {
            guard row.publicKey.utf8.count == 64,
                  row.publicKey.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                  keys.insert(row.publicKey).inserted, !row.label.isEmpty,
                  row.label.utf8.count <= 128,
                  !row.label.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
            peers.append(VPNPeerStatus(publicKey: row.publicKey, label: row.label, connected: row.connected))
        }
        return peers
    }
}
