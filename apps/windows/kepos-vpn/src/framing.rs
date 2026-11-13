//! Host/worklet IPC framing.
//!
//! This is local IPC, not the peer VPN protocol. A frame carries a one-byte
//! kind and a bounded payload, both directions, matching the framing the other
//! Kepos hosts use: `[u16 length big-endian][u8 kind][payload]`, where the
//! length counts the kind byte. Packet payloads are bounded by the VPN MTU.

use std::io::{self, Read, Write};

pub const CONTROL: u8 = 1;
pub const PACKET: u8 = 2;

/// Largest frame the host accepts, mirroring the macOS and Android hosts.
pub const MAX_FRAME: usize = 32_768;
/// Smallest IPv4 packet the VPN carries.
pub const MIN_PACKET: usize = 20;
/// Overlay MTU.
pub const MTU: usize = 1400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn control(payload: impl Into<Vec<u8>>) -> Self {
        Self {
            kind: CONTROL,
            payload: payload.into(),
        }
    }

    pub fn packet(payload: impl Into<Vec<u8>>) -> Self {
        Self {
            kind: PACKET,
            payload: payload.into(),
        }
    }

    /// Reject a frame that the engine must not receive.
    pub fn validate(&self) -> Result<(), FrameError> {
        if self.kind != CONTROL && self.kind != PACKET {
            return Err(FrameError::UnknownKind(self.kind));
        }
        if self.payload.len() + 1 > MAX_FRAME {
            return Err(FrameError::TooLarge(self.payload.len()));
        }
        if self.kind == PACKET && (self.payload.len() < MIN_PACKET || self.payload.len() > MTU) {
            return Err(FrameError::InvalidPacketLength(self.payload.len()));
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, FrameError> {
        self.validate()?;
        let length = self.payload.len() + 1;
        let mut out = Vec::with_capacity(length + 2);
        out.extend_from_slice(&(length as u16).to_be_bytes());
        out.push(self.kind);
        out.extend_from_slice(&self.payload);
        Ok(out)
    }
}

#[derive(Debug)]
pub enum FrameError {
    UnknownKind(u8),
    TooLarge(usize),
    InvalidPacketLength(usize),
    InvalidLength(usize),
    /// Bytes remain that cannot form a frame.
    Truncated(usize),
    Io(io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownKind(kind) => write!(f, "unknown IPC frame kind {kind}"),
            Self::TooLarge(len) => write!(f, "IPC frame of {len} bytes is too large"),
            Self::InvalidPacketLength(len) => write!(f, "invalid VPN packet length {len}"),
            Self::InvalidLength(len) => write!(f, "invalid IPC frame length {len}"),
            Self::Truncated(len) => write!(f, "{len} bytes remain after the last complete frame"),
            Self::Io(error) => write!(f, "IPC transport error: {error}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Reads whole frames from a byte stream.
pub struct FrameReader<R: Read> {
    inner: R,
}

impl<R: Read> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        Self { inner }
    }

    /// Read one frame, or `None` at end of stream. A stream that ends between
    /// the length prefix and the payload is an error, not a clean close.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        let mut header = [0u8; 2];
        match read_exact_or_eof(&mut self.inner, &mut header)? {
            false => return Ok(None),
            true => {}
        }
        let length = u16::from_be_bytes(header) as usize;
        if length < 1 || length > MAX_FRAME {
            return Err(FrameError::InvalidLength(length));
        }
        let mut body = vec![0u8; length];
        self.inner.read_exact(&mut body)?;
        let frame = Frame {
            kind: body[0],
            payload: body[1..].to_vec(),
        };
        frame.validate()?;
        Ok(Some(frame))
    }
}

/// Writes whole frames to a byte stream. Packet writes stay serialized by the
/// caller: the engine allows one outstanding packet per direction.
pub struct FrameWriter<W: Write> {
    inner: W,
}

impl<W: Write> FrameWriter<W> {
    pub fn new(inner: W) -> Self {
        Self { inner }
    }

    pub fn write_frame(&mut self, frame: &Frame) -> Result<(), FrameError> {
        let encoded = frame.encode()?;
        self.inner.write_all(&encoded)?;
        self.inner.flush()?;
        Ok(())
    }
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buffer: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Ok(false);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stream ended inside a frame",
                ));
            }
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

/// Incremental decoder for a byte stream.
///
/// The Bare Kit IPC is a byte stream: one read may carry a partial frame, one
/// frame, or several frames. The decoder keeps only the bytes it still needs and
/// bounds the buffer, so a peer cannot make it grow without limit.
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

/// Tolerated backlog: enough for a burst of frames from one read, still bounded.
const MAX_BUFFER: usize = MAX_FRAME * 8;

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    /// Append bytes read from the stream.
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), FrameError> {
        if self.buffer.len() + bytes.len() > MAX_BUFFER {
            return Err(FrameError::TooLarge(self.buffer.len() + bytes.len()));
        }
        self.buffer.extend_from_slice(bytes);
        Ok(())
    }

    /// Take the next complete frame, or `None` while more bytes are needed.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        if self.buffer.len() < 2 {
            return Ok(None);
        }
        let length = u16::from_be_bytes([self.buffer[0], self.buffer[1]]) as usize;
        if length < 1 || length > MAX_FRAME {
            return Err(FrameError::InvalidLength(length));
        }
        if self.buffer.len() < 2 + length {
            return Ok(None);
        }
        let kind = self.buffer[2];
        let payload = self.buffer[3..2 + length].to_vec();
        self.buffer.drain(..2 + length);
        let frame = Frame { kind, payload };
        frame.validate()?;
        Ok(Some(frame))
    }

    /// Check the stream ended on a frame boundary.
    pub fn finish(&self) -> Result<(), FrameError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(FrameError::Truncated(self.buffer.len()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(len: usize) -> Frame {
        let mut payload = vec![0u8; len];
        payload[0] = 0x45;
        Frame::packet(payload)
    }

    #[test]
    fn round_trips_control_and_packet_frames() {
        let frames = vec![Frame::control(br#"{"type":"ready"}"#.to_vec()), packet(40)];
        let mut encoded = Vec::new();
        {
            let mut writer = FrameWriter::new(&mut encoded);
            for frame in &frames {
                writer.write_frame(frame).unwrap();
            }
        }
        let mut reader = FrameReader::new(encoded.as_slice());
        assert_eq!(reader.next_frame().unwrap(), Some(frames[0].clone()));
        assert_eq!(reader.next_frame().unwrap(), Some(frames[1].clone()));
        assert_eq!(reader.next_frame().unwrap(), None);
    }

    #[test]
    fn rejects_packets_outside_the_overlay_bounds() {
        assert!(packet(MIN_PACKET - 1).validate().is_err());
        assert!(packet(MTU + 1).validate().is_err());
        assert!(packet(MTU).validate().is_ok());
    }

    #[test]
    fn rejects_unknown_kinds_and_oversized_frames() {
        let unknown = Frame {
            kind: 3,
            payload: vec![0; 4],
        };
        assert!(unknown.validate().is_err());
        let large = Frame::control(vec![0u8; MAX_FRAME]);
        assert!(large.validate().is_err());
    }

    #[test]
    fn rejects_a_truncated_frame() {
        let frame = Frame::control(b"{\"type\":\"stop\"}".to_vec());
        let mut encoded = frame.encode().unwrap();
        encoded.pop();
        let mut reader = FrameReader::new(encoded.as_slice());
        assert!(reader.next_frame().is_err());
    }

    #[test]
    fn rejects_an_out_of_range_length_prefix() {
        let mut reader = FrameReader::new([0x00u8, 0x00].as_slice());
        assert!(matches!(
            reader.next_frame(),
            Err(FrameError::InvalidLength(0))
        ));
    }

    #[test]
    fn decodes_frames_split_across_reads_and_coalesced_in_one_read() {
        let first = Frame::control(br#"{"type":"ready"}"#.to_vec());
        let second = packet(40);
        let mut encoded = first.encode().unwrap();
        encoded.extend_from_slice(&second.encode().unwrap());

        // One byte at a time: length header, kind and payload all split.
        let mut decoder = FrameDecoder::new();
        let mut decoded = Vec::new();
        for byte in &encoded {
            decoder.push(&[*byte]).unwrap();
            while let Some(frame) = decoder.next_frame().unwrap() {
                decoded.push(frame);
            }
        }
        assert_eq!(decoded, vec![first.clone(), second.clone()]);
        decoder.finish().unwrap();

        // Both frames in a single read.
        let mut decoder = FrameDecoder::new();
        decoder.push(&encoded).unwrap();
        assert_eq!(decoder.next_frame().unwrap(), Some(first));
        assert_eq!(decoder.next_frame().unwrap(), Some(second));
        assert_eq!(decoder.next_frame().unwrap(), None);
    }

    #[test]
    fn a_partial_frame_is_not_decoded_and_is_reported_at_eof() {
        let encoded = Frame::control(b"{\"type\":\"stop\"}".to_vec())
            .encode()
            .unwrap();
        let mut decoder = FrameDecoder::new();
        decoder.push(&encoded[..encoded.len() - 1]).unwrap();
        assert_eq!(decoder.next_frame().unwrap(), None);
        assert!(matches!(decoder.finish(), Err(FrameError::Truncated(_))));
    }

    #[test]
    fn an_oversized_length_header_is_rejected_before_buffering() {
        let mut decoder = FrameDecoder::new();
        let length = (MAX_FRAME + 1) as u16;
        decoder.push(&length.to_be_bytes()).unwrap();
        assert!(matches!(
            decoder.next_frame(),
            Err(FrameError::InvalidLength(value)) if value == MAX_FRAME + 1
        ));
    }

    #[test]
    fn the_decoder_bounds_its_buffer() {
        let mut decoder = FrameDecoder::new();
        let chunk = vec![0u8; MAX_BUFFER];
        assert!(decoder.push(&chunk).is_ok());
        assert!(decoder.push(&[0u8]).is_err());
    }
}
