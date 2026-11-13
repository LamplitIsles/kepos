//! The outbox between the session and the worklet IPC.
//!
//! The Bare Kit IPC accepts a byte stream with backpressure: a write may take
//! part of the buffer, or nothing at all. Keeping this state machine separate
//! from the Windows API makes the backpressure and failure behaviour testable:
//! * a partial write keeps the remainder queued,
//! * `WouldBlock` keeps everything queued and reports success,
//! * a write error is reported immediately, and the queue is dropped, because
//!   the stream is gone and the attempt must fail now — not on some later write
//!   that may never come.

use crate::dispatch::IpcError;
use crate::framing::Frame;

/// The worklet IPC as the outbox needs it.
pub trait FrameWriter {
    /// Write as much as the IPC accepts. `Ok(None)` means "would block",
    /// `Ok(Some(0))` is treated the same way.
    fn write(&mut self, bytes: &[u8]) -> Result<Option<usize>, ()>;
}

/// Bounded queue of encoded frames.
pub struct Outbox {
    buffer: Vec<u8>,
    capacity: usize,
    /// Bytes ever appended and bytes ever accepted by the writer, so a caller
    /// can tell "queued" from "handed to the IPC".
    queued: usize,
    written: usize,
}

impl Outbox {
    pub fn new(capacity: usize) -> Self {
        Self {
            buffer: Vec::new(),
            capacity,
            queued: 0,
            written: 0,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    /// Total bytes ever appended to the queue.
    pub fn queued_total(&self) -> usize {
        self.queued
    }

    /// Total bytes the writer has accepted. Equal to `queued_total` only when
    /// every queued byte has been handed to the IPC.
    pub fn written_total(&self) -> usize {
        self.written
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
        // Offsets are per stream: a cleared outbox starts from zero again.
        self.queued = 0;
        self.written = 0;
    }

    /// Queue one frame. A full queue is a congestion failure, not a slow path.
    pub fn queue(&mut self, frame: &Frame) -> Result<(), IpcError> {
        let encoded = frame.encode().map_err(|_| IpcError::Closed)?;
        if self.buffer.len() + encoded.len() > self.capacity {
            self.buffer.clear();
            return Err(IpcError::Congested);
        }
        self.buffer.extend_from_slice(&encoded);
        self.queued += encoded.len();
        Ok(())
    }

    /// Push as much as the writer accepts. A write error is reported at once.
    pub fn flush(&mut self, writer: &mut dyn FrameWriter) -> Result<(), IpcError> {
        while !self.buffer.is_empty() {
            match writer.write(&self.buffer) {
                Ok(Some(0)) | Ok(None) => return Ok(()),
                Ok(Some(written)) => {
                    let taken = written.min(self.buffer.len());
                    self.buffer.drain(..taken);
                    self.written += taken;
                }
                Err(()) => {
                    // The stream is gone: drop the queue and fail now.
                    self.buffer.clear();
                    return Err(IpcError::Closed);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod byte_accounting_tests {
    use super::*;
    use crate::framing::Frame;

    struct Stoppable {
        budget: usize,
        written: Vec<u8>,
    }

    impl FrameWriter for Stoppable {
        fn write(&mut self, bytes: &[u8]) -> Result<Option<usize>, ()> {
            if self.budget == 0 {
                return Ok(None);
            }
            let take = self.budget.min(bytes.len());
            self.written.extend_from_slice(&bytes[..take]);
            self.budget -= take;
            Ok(Some(take))
        }
    }

    #[test]
    fn written_total_separates_queued_from_handed_to_ipc() {
        let mut outbox = Outbox::new(1024);
        let ready = Frame::control(br#"{"type":"ready"}"#.to_vec());
        outbox.queue(&ready).unwrap();
        let ready_end = outbox.queued_total();

        // Backpressure: nothing accepted yet.
        let mut blocked = Stoppable {
            budget: 0,
            written: Vec::new(),
        };
        outbox.flush(&mut blocked).unwrap();
        assert!(outbox.written_total() < ready_end, "queued is not written");

        // A partial write still leaves the frame incomplete.
        let mut partial = Stoppable {
            budget: 2,
            written: Vec::new(),
        };
        outbox.flush(&mut partial).unwrap();
        assert!(outbox.written_total() < ready_end);

        // Once every byte is accepted the frame is complete.
        let mut rest = Stoppable {
            budget: 4096,
            written: Vec::new(),
        };
        outbox.flush(&mut rest).unwrap();
        assert_eq!(outbox.written_total(), ready_end);
        assert!(outbox.is_empty());
        let mut all = partial.written.clone();
        all.extend_from_slice(&rest.written);
        assert_eq!(all, ready.encode().unwrap());
    }

    #[test]
    fn several_frames_are_accounted_in_order() {
        let mut outbox = Outbox::new(4096);
        let first = Frame::control(br#"{"type":"settings"}"#.to_vec());
        let ready = Frame::control(br#"{"type":"ready"}"#.to_vec());
        outbox.queue(&first).unwrap();
        let first_end = outbox.queued_total();
        outbox.queue(&ready).unwrap();
        let ready_end = outbox.queued_total();
        assert!(first_end < ready_end);

        let mut writer = Stoppable {
            budget: first_end,
            written: Vec::new(),
        };
        outbox.flush(&mut writer).unwrap();
        assert_eq!(
            outbox.written_total(),
            first_end,
            "first frame complete, ready not yet"
        );
        assert!(outbox.written_total() < ready_end);

        let mut rest = Stoppable {
            budget: 4096,
            written: Vec::new(),
        };
        outbox.flush(&mut rest).unwrap();
        assert_eq!(outbox.written_total(), ready_end);
    }
}

#[cfg(test)]
mod partial_write_tests {
    use super::*;
    use crate::framing::Frame;

    /// A writer that accepts at most one byte per call, like a congested IPC.
    struct Dribble {
        written: Vec<u8>,
    }

    impl FrameWriter for Dribble {
        fn write(&mut self, bytes: &[u8]) -> Result<Option<usize>, ()> {
            self.written.push(bytes[0]);
            Ok(Some(1))
        }
    }

    #[test]
    fn a_ready_frame_is_written_completely_across_partial_writes() {
        let frame = Frame::control(br#"{"type":"ready"}"#.to_vec());
        let expected = frame.encode().unwrap();
        let mut outbox = Outbox::new(64);
        outbox.queue(&frame).unwrap();
        let mut writer = Dribble {
            written: Vec::new(),
        };
        outbox.flush(&mut writer).unwrap();
        assert!(outbox.is_empty(), "the outbox must be drained");
        assert_eq!(
            writer.written, expected,
            "every byte of the frame must be written"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    enum Step {
        Block,
        Take(usize),
        Fail,
    }

    struct Scripted {
        steps: Vec<Step>,
    }

    impl FrameWriter for Scripted {
        fn write(&mut self, bytes: &[u8]) -> Result<Option<usize>, ()> {
            match self.steps.pop().unwrap_or(Step::Take(bytes.len())) {
                Step::Block => Ok(None),
                Step::Take(count) => Ok(Some(count.min(bytes.len()))),
                Step::Fail => Err(()),
            }
        }
    }

    fn frame(text: &str) -> Frame {
        Frame::control(text.as_bytes().to_vec())
    }

    #[test]
    fn a_blocked_write_keeps_the_frame_queued() {
        let mut outbox = Outbox::new(4096);
        outbox.queue(&frame("{\"type\":\"stop\"}")).unwrap();
        let queued = outbox.len();
        // Steps are popped from the back, so this script blocks on the first call.
        let mut writer = Scripted {
            steps: vec![Step::Block],
        };
        assert_eq!(outbox.flush(&mut writer), Ok(()));
        assert_eq!(outbox.len(), queued, "nothing may be lost while blocked");
    }

    #[test]
    fn a_partial_write_keeps_the_remainder() {
        let mut outbox = Outbox::new(4096);
        outbox.queue(&frame("{\"type\":\"stop\"}")).unwrap();
        let queued = outbox.len();
        let mut writer = Scripted {
            steps: vec![Step::Block, Step::Take(3)],
        };
        outbox.flush(&mut writer).unwrap();
        assert_eq!(outbox.len(), queued - 3);
    }

    #[test]
    fn a_later_write_error_fails_that_flush_and_drops_the_queue() {
        let mut outbox = Outbox::new(4096);
        outbox.queue(&frame("{\"type\":\"stop\"}")).unwrap();
        // The first flush blocks and keeps the frame; the next flush fails. The
        // failure must be reported by that flush, not deferred to a later write
        // that may never happen on an idle connection.
        let mut writer = Scripted {
            steps: vec![Step::Fail, Step::Block],
        };
        assert_eq!(outbox.flush(&mut writer), Ok(()));
        assert!(!outbox.is_empty(), "a blocked write keeps the frame queued");
        assert_eq!(outbox.flush(&mut writer), Err(IpcError::Closed));
        assert!(outbox.is_empty());
    }

    #[test]
    fn a_full_queue_is_congestion() {
        let mut outbox = Outbox::new(4);
        assert_eq!(
            outbox.queue(&frame("{\"type\":\"stop\"}")),
            Err(IpcError::Congested)
        );
        assert!(outbox.is_empty());
    }
}
