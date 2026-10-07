//! The microphone, via cpal (WASAPI on Windows, CoreAudio on macOS).
//!
//! A [`Mic`] exists only while recording: creating it opens the default
//! input device, dropping it closes the stream (and the OS's "microphone in
//! use" indicator goes away). Nothing audio-related exists otherwise.

/// Why the microphone couldn't be used. Mapped to friendly text in the UI.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub enum MicError {
    /// No microphone plugged in / enabled.
    NoDevice,
    /// The OS refused access (privacy settings).
    Denied(String),
    /// Another app has the microphone exclusively.
    Busy(String),
    Failed(String),
    /// Voice capture isn't built for this OS (Linux).
    #[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
    Unsupported,
}

impl MicError {
    pub fn code(&self) -> &'static str {
        match self {
            MicError::NoDevice => "mic_missing",
            MicError::Denied(_) => "mic_denied",
            MicError::Busy(_) => "mic_busy",
            MicError::Failed(_) => "mic_failed",
            MicError::Unsupported => "voice_unsupported",
        }
    }

    pub fn message(&self) -> String {
        match self {
            MicError::NoDevice => "no microphone found".into(),
            MicError::Denied(m) | MicError::Busy(m) | MicError::Failed(m) => m.clone(),
            MicError::Unsupported => "voice isn't available on this system".into(),
        }
    }
}

pub use imp::{open, Mic};

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod imp {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample};
    use glitch_core::voice::audio::mix_to_mono;

    use super::MicError;

    /// An open microphone stream. Drop it to stop recording.
    pub struct Mic {
        _stream: cpal::Stream,
        pub sample_rate: u32,
    }

    fn map_err(e: cpal::Error) -> MicError {
        let msg = e.to_string();
        match e.kind() {
            cpal::ErrorKind::PermissionDenied => MicError::Denied(msg),
            cpal::ErrorKind::DeviceNotAvailable => MicError::NoDevice,
            cpal::ErrorKind::DeviceBusy => MicError::Busy(msg),
            _ => {
                // WASAPI reports "access denied" (E_ACCESSDENIED) as a generic
                // backend error when Windows' microphone privacy switch is off.
                let lower = msg.to_lowercase();
                if lower.contains("0x80070005") || lower.contains("access is denied") || lower.contains("denied") {
                    MicError::Denied(msg)
                } else {
                    MicError::Failed(msg)
                }
            }
        }
    }

    /// Open the default input device. `on_audio` gets mono f32 samples at
    /// `Mic::sample_rate` (on the audio thread: keep it quick); `on_error`
    /// gets stream errors (device unplugged, ...).
    pub fn open(
        on_audio: impl FnMut(&[f32]) + Send + 'static,
        on_error: impl FnMut(String) + Send + 'static,
    ) -> Result<Mic, MicError> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or(MicError::NoDevice)?;
        let supported = device.default_input_config().map_err(map_err)?;
        let channels = supported.channels() as usize;
        let sample_rate = supported.sample_rate();
        let config = supported.config();
        let stream = match supported.sample_format() {
            SampleFormat::F32 => build::<f32>(&device, config, channels, on_audio, on_error),
            SampleFormat::I16 => build::<i16>(&device, config, channels, on_audio, on_error),
            SampleFormat::I32 => build::<i32>(&device, config, channels, on_audio, on_error),
            SampleFormat::U16 => build::<u16>(&device, config, channels, on_audio, on_error),
            SampleFormat::I8 => build::<i8>(&device, config, channels, on_audio, on_error),
            SampleFormat::U8 => build::<u8>(&device, config, channels, on_audio, on_error),
            SampleFormat::I24 => build::<cpal::I24>(&device, config, channels, on_audio, on_error),
            SampleFormat::U32 => build::<u32>(&device, config, channels, on_audio, on_error),
            SampleFormat::F64 => build::<f64>(&device, config, channels, on_audio, on_error),
            other => return Err(MicError::Failed(format!("unsupported sample format {other}"))),
        }
        .map_err(map_err)?;
        stream.play().map_err(map_err)?;
        Ok(Mic { _stream: stream, sample_rate })
    }

    /// Stream errors after which the stream keeps running.
    pub(super) fn harmless(kind: cpal::ErrorKind) -> bool {
        matches!(kind, cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::RealtimeDenied)
    }

    fn build<T>(
        device: &cpal::Device,
        config: cpal::StreamConfig,
        channels: usize,
        mut on_audio: impl FnMut(&[f32]) + Send + 'static,
        mut on_error: impl FnMut(String) + Send + 'static,
    ) -> Result<cpal::Stream, cpal::Error>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        // Reused between callbacks: no allocation on the audio thread
        // after the first few buffers.
        let mut interleaved: Vec<f32> = Vec::new();
        let mut mono: Vec<f32> = Vec::new();
        device.build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                interleaved.clear();
                interleaved.extend(data.iter().map(|s| s.to_sample::<f32>()));
                mono.clear();
                mix_to_mono(&mut mono, &interleaved, channels);
                on_audio(&mono);
            },
            move |e: cpal::Error| {
                // Only errors that end the stream stop the recording. WASAPI
                // reports a buffer overrun ("Xrun") whenever the audio thread
                // is a little late (seen on a real Windows 11 laptop within
                // the first 2 s); that's a tiny glitch, not a failure.
                if !harmless(e.kind()) {
                    on_error(e.to_string())
                }
            },
            None,
        )
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod imp {
    use super::MicError;

    pub struct Mic {
        pub sample_rate: u32,
    }

    pub fn open(
        _on_audio: impl FnMut(&[f32]) + Send + 'static,
        _on_error: impl FnMut(String) + Send + 'static,
    ) -> Result<Mic, MicError> {
        Err(MicError::Unsupported)
    }
}

/// Whether this build can record at all.
pub const SUPPORTED: bool = cfg!(any(target_os = "windows", target_os = "macos"));

#[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
mod tests {
    use cpal::ErrorKind;

    #[test]
    fn glitches_dont_end_a_recording() {
        assert!(imp::harmless(ErrorKind::Xrun));
        assert!(imp::harmless(ErrorKind::DeviceChanged));
        assert!(!imp::harmless(ErrorKind::DeviceNotAvailable));
        assert!(!imp::harmless(ErrorKind::StreamInvalidated));
        assert!(!imp::harmless(ErrorKind::BackendError));
    }

    use super::imp;
}
