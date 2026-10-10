//! Turns a raw screenshot into what the vision model gets: password fields
//! covered, scaled down so its long side is at most [`MAX_SIDE`] px, JPEG,
//! base64. Everything happens in RAM; nothing is ever written to disk.

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{imageops, Rgba, RgbaImage};

use crate::desktop::{Capture, PixelRect};

/// Long side of the image the model sees. ~1000 image tokens for a 16:9
/// screen on qwen3.5; small text stays readable. A window smaller than this
/// is sent at full size (sharper).
pub const MAX_SIDE: u32 = 1280;
const JPEG_QUALITY: u8 = 82;

/// What covered password fields look like (flat grey, nothing to read).
const COVER: Rgba<u8> = Rgba([128, 128, 128, 255]);

#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub base64_jpeg: String,
    pub width: u32,
    pub height: u32,
    pub original: (u32, u32),
    pub covered: usize,
}

pub fn prepare(capture: Capture) -> Result<Prepared, String> {
    let Capture { width, height, rgba, redact, .. } = capture;
    if width < 16 || height < 16 {
        return Err("the captured area was empty".into());
    }
    let mut img = RgbaImage::from_raw(width, height, rgba).ok_or("the screenshot had the wrong size")?;
    let covered = cover(&mut img, &redact);
    let (w, h) = fit(width, height, MAX_SIDE);
    let img = if (w, h) == (width, height) { img } else { imageops::thumbnail(&img, w, h) };
    let rgb = image::DynamicImage::ImageRgba8(img).into_rgb8();
    let mut jpeg = Vec::with_capacity((w * h / 4) as usize);
    JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|e| format!("could not encode the screenshot: {e}"))?;
    Ok(Prepared {
        base64_jpeg: base64::engine::general_purpose::STANDARD.encode(&jpeg),
        width: w,
        height: h,
        original: (width, height),
        covered,
    })
}

/// Paint over every rectangle (clipped to the image). Returns how many were covered.
pub(crate) fn cover(img: &mut RgbaImage, rects: &[PixelRect]) -> usize {
    let (iw, ih) = img.dimensions();
    let mut n = 0;
    for r in rects {
        let (x0, y0) = (r.x.min(iw), r.y.min(ih));
        let (x1, y1) = (r.x.saturating_add(r.w).min(iw), r.y.saturating_add(r.h).min(ih));
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        for y in y0..y1 {
            for x in x0..x1 {
                img.put_pixel(x, y, COVER);
            }
        }
        n += 1;
    }
    n
}

/// Scale (w, h) down to fit `max` on the long side, keeping the aspect ratio.
pub fn fit(w: u32, h: u32, max: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= max {
        return (w, h);
    }
    let scale = max as f64 / long as f64;
    (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(w: u32, h: u32, redact: Vec<PixelRect>) -> Capture {
        Capture { width: w, height: h, rgba: vec![255; (w * h * 4) as usize], window: None, redact }
    }

    #[test]
    fn fit_keeps_aspect_ratio() {
        assert_eq!(fit(1920, 1080, 1280), (1280, 720));
        assert_eq!(fit(1080, 1920, 1280), (720, 1280));
        assert_eq!(fit(800, 600, 1280), (800, 600));
        assert_eq!(fit(3840, 2160, 1280), (1280, 720));
    }

    #[test]
    fn big_screens_are_scaled_down_to_a_jpeg() {
        let p = prepare(capture(2560, 1440, vec![])).unwrap();
        assert_eq!((p.width, p.height, p.original), (1280, 720, (2560, 1440)));
        let bytes = base64::engine::general_purpose::STANDARD.decode(&p.base64_jpeg).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "JPEG magic");
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1280, 720));
    }

    #[test]
    fn password_fields_are_covered_before_anything_else() {
        let rect = PixelRect { x: 10, y: 10, w: 40, h: 20 };
        let p = prepare(capture(200, 100, vec![rect, PixelRect { x: 500, y: 500, w: 5, h: 5 }])).unwrap();
        assert_eq!(p.covered, 1, "off-image rects are ignored");
        let bytes = base64::engine::general_purpose::STANDARD.decode(&p.base64_jpeg).unwrap();
        let img = image::load_from_memory(&bytes).unwrap().into_rgb8();
        let inside = img.get_pixel(30, 20);
        let outside = img.get_pixel(150, 80);
        assert!(inside.0.iter().all(|&c| (118..=138).contains(&c)), "{inside:?}");
        assert!(outside.0.iter().all(|&c| c > 240), "{outside:?}");
    }

    #[test]
    fn empty_or_broken_captures_are_refused() {
        assert!(prepare(capture(4, 4, vec![])).is_err());
        let broken = Capture { width: 100, height: 100, rgba: vec![0; 10], window: None, redact: vec![] };
        assert!(prepare(broken).is_err());
    }
}
