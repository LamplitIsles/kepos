import Foundation

enum WorkletFrameError: Error {
    case invalidFrame
    case truncatedFrame
}

/// Provider/worklet byte stream framing; peer-to-peer framing remains unchanged.
struct WorkletFrames {
    static let control: UInt8 = 1
    static let packet: UInt8 = 2
    static let maxLength = 32_768

    private var header: [UInt8] = []
    private var expectedLength: Int?
    private var body = Data()

    static func encode(kind: UInt8, payload: Data) throws -> Data {
        let length = payload.count + 1
        guard (kind == control || kind == packet), length <= maxLength else {
            throw WorkletFrameError.invalidFrame
        }
        var frame = Data([UInt8(length >> 8), UInt8(length & 0xff), kind])
        frame.append(payload)
        return frame
    }

    mutating func append(_ bytes: Data, deliver: (UInt8, Data) throws -> Void) throws {
        var index = bytes.startIndex
        while index < bytes.endIndex {
            if expectedLength == nil {
                header.append(bytes[index])
                bytes.formIndex(after: &index)
                if header.count < 2 { continue }
                let length = Int(header[0]) << 8 | Int(header[1])
                guard length > 0 && length <= Self.maxLength else { throw WorkletFrameError.invalidFrame }
                expectedLength = length
                header.removeAll(keepingCapacity: true)
                body.removeAll(keepingCapacity: true)
            }
            let count = min(expectedLength! - body.count, bytes.distance(from: index, to: bytes.endIndex))
            let end = bytes.index(index, offsetBy: count)
            body.append(contentsOf: bytes[index..<end])
            index = end
            if body.count == expectedLength {
                let kind = body[body.startIndex]
                guard kind == Self.control || kind == Self.packet else { throw WorkletFrameError.invalidFrame }
                let payload = body.dropFirst()
                expectedLength = nil
                try deliver(kind, Data(payload))
            }
        }
    }

    func finish() throws {
        guard header.isEmpty && expectedLength == nil else { throw WorkletFrameError.truncatedFrame }
    }
}

/// One IPC write at a time, with a bounded number of frames including the
/// in-flight write. Packets beyond the bound are dropped in batch order.
struct WorkletOutput {
    private static let limit = 32
    private var pending: [(kind: UInt8, data: Data)] = []
    private var inFlight = false
    private var readingPackets = false

    var isIdle: Bool { !inFlight && pending.isEmpty }
    private var count: Int { pending.count + (inFlight ? 1 : 0) }

    mutating func beginPacketRead() -> Bool {
        guard isIdle, !readingPackets else { return false }
        readingPackets = true
        return true
    }

    mutating func finishPacketRead() { readingPackets = false }

    mutating func enqueueControl(_ payload: Data) throws {
        guard count < Self.limit else { throw WorkletFrameError.invalidFrame }
        pending.append((WorkletFrames.control, try WorkletFrames.encode(kind: WorkletFrames.control, payload: payload)))
    }

    mutating func enqueuePackets(_ packets: [Data], protocols: [NSNumber], ipv4: Int) throws {
        for (packet, family) in zip(packets, protocols) where family.intValue == ipv4 {
            guard packet.count >= 20 && packet.count <= 1400 else { continue }
            guard count < Self.limit else { break }
            pending.append((WorkletFrames.packet, try WorkletFrames.encode(kind: WorkletFrames.packet, payload: packet)))
        }
    }

    mutating func discardPackets() {
        pending.removeAll { $0.kind == WorkletFrames.packet }
    }

    mutating func next() -> Data? {
        guard !inFlight, !pending.isEmpty else { return nil }
        inFlight = true
        return pending.removeFirst().data
    }

    mutating func complete() { inFlight = false }
}
