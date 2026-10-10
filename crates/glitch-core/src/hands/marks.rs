//! Set-of-marks vision for desktop control.
//!
//! A 4B model is bad at saying "click at pixel (812, 403)" and good at "click
//! 7". So the model gets the screenshot of the target window with a numbered
//! box on every actionable element, plus a compact text list ("[7] button
//! Save"). The numbers are the same ids `read_ui` uses, stable for a whole
//! task, so "7" always means the same element.
//!
//! * Boxes come from UI Automation first. Where UI Automation says nothing
//!   (a canvas, a game, an app that hides its tree) [`regions`] finds boxes
//!   from the picture itself with a plain edge/contrast grid.
//! * The marks are drawn only into the copy of the screenshot that goes to
//!   the model. Nothing is drawn on the user's screen and nothing is written
//!   to disk. Password fields are covered before anything else (see
//!   [`crate::vision::cover`]).
//! * All of it is pure: elements and pixels in, boxes and a JPEG out.

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{imageops, Rgba, RgbaImage};

use super::UiElement;
use crate::desktop::Capture;
use crate::vision;

/// Boxes drawn / listed per picture. More is noise for a small model.
pub const MAX_MARKS: usize = 40;
/// Boxes found from pixels alone.
pub const MAX_REGIONS: usize = 16;
/// Fewer UI Automation boxes than this and the pixel fallback is added.
pub const MIN_UIA_MARKS: usize = 4;

/// Screen px: x, y, width, height.
pub type Rect = (i32, i32, i32, i32);

/// One numbered box, in screen pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkBox {
    pub id: u32,
    pub rect: Rect,
    /// Found from pixels, not from UI Automation.
    pub region: bool,
}

/// How the picture sent to the model relates to the screen, so `x, y` the
/// model reads off the picture can be turned back into screen pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShotGeometry {
    /// Screen position of the picture's top-left corner.
    pub origin: (i32, i32),
    /// Size of the capture in screen px.
    pub capture: (u32, u32),
    /// Size of the picture the model got.
    pub image: (u32, u32),
}

impl ShotGeometry {
    /// A point of the model's picture -> screen px (`None`: outside it).
    pub fn to_screen(&self, x: i32, y: i32) -> Option<(i32, i32)> {
        if x < 0 || y < 0 || x >= self.image.0 as i32 || y >= self.image.1 as i32 {
            return None;
        }
        let (sx, sy) = (self.capture.0 as f64 / self.image.0 as f64, self.capture.1 as f64 / self.image.1 as f64);
        Some((self.origin.0 + (x as f64 * sx).round() as i32, self.origin.1 + (y as f64 * sy).round() as i32))
    }

    /// A screen rect -> the picture's pixels.
    pub fn to_image(&self, r: Rect) -> Rect {
        let (sx, sy) = (self.image.0 as f64 / self.capture.0 as f64, self.image.1 as f64 / self.capture.1 as f64);
        (
            ((r.0 - self.origin.0) as f64 * sx).round() as i32,
            ((r.1 - self.origin.1) as f64 * sy).round() as i32,
            ((r.2 as f64 * sx).round() as i32).max(1),
            ((r.3 as f64 * sy).round() as i32).max(1),
        )
    }
}

/// Roles that are worth a number even without a UI Automation pattern.
const CLICKABLE: &[&str] = &[
    "button",
    "check box",
    "radio button",
    "combo box",
    "edit",
    "link",
    "list item",
    "menu item",
    "tab item",
    "tree item",
    "split button",
    "slider",
    "spinner",
    "row",
    "data item",
    "document",
];

/// Containers and decoration never get a box.
const NEVER: &[&str] = &[
    "pane",
    "group",
    "custom",
    "window",
    "list",
    "tree",
    "table",
    "tab",
    "title bar",
    "tool bar",
    "menu bar",
    "menu",
    "status bar",
    "scroll bar",
    "thumb",
    "separator",
    "image",
    "text",
    "header",
    "header item",
    "progress bar",
    "data grid",
];

fn area(r: Rect) -> i64 {
    i64::from(r.2.max(0)) * i64::from(r.3.max(0))
}

fn overlap(a: Rect, b: Rect) -> i64 {
    let w = (a.0 + a.2).min(b.0 + b.2) - a.0.max(b.0);
    let h = (a.1 + a.3).min(b.1 + b.3) - a.1.max(b.1);
    if w <= 0 || h <= 0 {
        0
    } else {
        i64::from(w) * i64::from(h)
    }
}

/// Indexes of the elements that get a box, in reading order (top to bottom,
/// then left to right), at most [`MAX_MARKS`]. `view` is the captured area
/// in screen px. Passwords, disabled, scrolled-out and off-picture elements,
/// tiny ones, containers and exact duplicates are left out.
pub fn select(els: &[UiElement], view: Rect) -> Vec<usize> {
    let mut picked: Vec<(i32, usize)> = Vec::new();
    for (i, e) in els.iter().enumerate() {
        if e.password || !e.enabled || e.offscreen {
            continue;
        }
        let role = e.role.as_str();
        if NEVER.contains(&role) || !(CLICKABLE.contains(&role) || e.actionable && role != "element") {
            continue;
        }
        let r = e.rect;
        if r.2 < 6 || r.3 < 6 || area(r) * 2 < 1 || overlap(r, view) * 2 < area(r) {
            continue;
        }
        // A big document / edit is fine; a thing that fills the whole view is a container.
        if area(r) * 10 > area(view) * 9 && role != "document" && role != "edit" {
            continue;
        }
        if picked.iter().any(|&(_, j)| {
            let o = &els[j];
            o.rect == r && o.role == e.role && o.name == e.name
        }) {
            continue;
        }
        // Priority when there are too many: named and small beats big and unnamed.
        let mut prio = 0;
        if !e.name.trim().is_empty() {
            prio += 4;
        }
        if e.actionable {
            prio += 2;
        }
        if area(r) * 4 < area(view) {
            prio += 1;
        }
        picked.push((prio, i));
    }
    if picked.len() > MAX_MARKS {
        picked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        picked.truncate(MAX_MARKS);
    }
    let mut idx: Vec<usize> = picked.into_iter().map(|(_, i)| i).collect();
    reading_order(&mut idx, |i| els[i].rect);
    idx
}

/// Top to bottom in bands of ~half a line, then left to right.
pub fn reading_order<T: Copy>(items: &mut [T], rect: impl Fn(T) -> Rect) {
    items.sort_by_key(|&t| {
        let r = rect(t);
        (((r.1 + r.3 / 2) as f64 / 18.0).round() as i32, r.0)
    });
}

// ------------------------------------------------------------------ pixels

/// Grid size in px for the edge / contrast fallback.
const CELL: u32 = 8;
/// Smallest box the fallback reports (px).
const MIN_W: u32 = 16;
const MIN_H: u32 = 10;

fn luma(p: &[u8]) -> i32 {
    (i32::from(p[0]) * 299 + i32::from(p[1]) * 587 + i32::from(p[2]) * 114) / 1000
}

/// Boxes found from the picture alone: cells with enough edges / contrast
/// are joined into blocks, and the blocks that look like a control (not
/// the whole window, not already covered by `skip`) are returned in the
/// picture's own px, biggest first, at most [`MAX_REGIONS`].
pub fn regions(rgba: &[u8], width: u32, height: u32, skip: &[Rect]) -> Vec<Rect> {
    if width < CELL * 3 || height < CELL * 3 || rgba.len() < (width * height * 4) as usize {
        return vec![];
    }
    let (gw, gh) = (width.div_ceil(CELL), height.div_ceil(CELL));
    let mut busy = vec![false; (gw * gh) as usize];
    for gy in 0..gh {
        for gx in 0..gw {
            let (x0, y0) = (gx * CELL, gy * CELL);
            let (x1, y1) = ((x0 + CELL).min(width - 1), (y0 + CELL).min(height - 1));
            let mut strong = 0;
            for y in y0..y1 {
                for x in x0..x1 {
                    let at = |xx: u32, yy: u32| luma(&rgba[((yy * width + xx) * 4) as usize..]);
                    let c = at(x, y);
                    if (c - at(x + 1, y)).abs() > 28 || (c - at(x, y + 1)).abs() > 28 {
                        strong += 1;
                    }
                }
            }
            busy[(gy * gw + gx) as usize] = strong >= 5;
        }
    }
    // Join neighbouring busy cells (8-connected, bridging one empty cell so
    // letters of one label and a button's border become one block).
    let mut dil = busy.clone();
    for gy in 0..gh as i32 {
        for gx in 0..gw as i32 {
            if !busy[(gy as u32 * gw + gx as u32) as usize] {
                continue;
            }
            for (dx, dy) in [(1, 0), (0, 1), (1, 1), (-1, 1)] {
                let (nx, ny) = (gx + dx * 2, gy + dy * 2);
                let (mx, my) = (gx + dx, gy + dy);
                if nx >= 0
                    && ny >= 0
                    && (nx as u32) < gw
                    && (ny as u32) < gh
                    && busy[(ny as u32 * gw + nx as u32) as usize]
                {
                    dil[(my as u32 * gw + mx as u32) as usize] = true;
                }
            }
        }
    }
    let mut seen = vec![false; dil.len()];
    let mut out: Vec<Rect> = Vec::new();
    for start in 0..dil.len() {
        if !dil[start] || seen[start] {
            continue;
        }
        let (mut minx, mut miny, mut maxx, mut maxy) = (u32::MAX, u32::MAX, 0, 0);
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(c) = stack.pop() {
            let (cx, cy) = (c as u32 % gw, c as u32 / gw);
            if busy[c] {
                minx = minx.min(cx);
                miny = miny.min(cy);
                maxx = maxx.max(cx);
                maxy = maxy.max(cy);
            }
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (cx as i32 + dx, cy as i32 + dy);
                    if nx < 0 || ny < 0 || nx as u32 >= gw || ny as u32 >= gh {
                        continue;
                    }
                    let n = (ny as u32 * gw + nx as u32) as usize;
                    if dil[n] && !seen[n] {
                        seen[n] = true;
                        stack.push(n);
                    }
                }
            }
        }
        if minx == u32::MAX {
            continue;
        }
        let r: Rect = (
            (minx * CELL) as i32,
            (miny * CELL) as i32,
            (((maxx + 1) * CELL).min(width) - minx * CELL) as i32,
            (((maxy + 1) * CELL).min(height) - miny * CELL) as i32,
        );
        let whole = i64::from(width) * i64::from(height);
        if (r.2 as u32) < MIN_W || (r.3 as u32) < MIN_H || area(r) * 100 > whole * 70 {
            continue;
        }
        if skip.iter().any(|s| overlap(r, *s) * 10 >= area(r) * 6) {
            continue;
        }
        out.push(r);
    }
    out.sort_by_key(|r| std::cmp::Reverse(area(*r)));
    out.truncate(MAX_REGIONS);
    out
}

// ------------------------------------------------------------------ drawing

/// 3x5 digits, one row per byte (bit 2 = left pixel).
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b001, 0b001, 0b001],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

/// Bright, clearly different colours (box + tag background).
const PALETTE: [[u8; 3]; 6] =
    [[255, 20, 147], [0, 200, 255], [60, 220, 60], [255, 140, 0], [255, 40, 40], [140, 90, 255]];

fn fill(img: &mut RgbaImage, x: i32, y: i32, w: i32, h: i32, c: [u8; 3]) {
    let (iw, ih) = img.dimensions();
    for yy in y.max(0)..(y + h).min(ih as i32) {
        for xx in x.max(0)..(x + w).min(iw as i32) {
            img.put_pixel(xx as u32, yy as u32, Rgba([c[0], c[1], c[2], 255]));
        }
    }
}

fn outline(img: &mut RgbaImage, r: Rect, t: i32, c: [u8; 3]) {
    fill(img, r.0, r.1, r.2, t, c);
    fill(img, r.0, r.1 + r.3 - t, r.2, t, c);
    fill(img, r.0, r.1, t, r.3, c);
    fill(img, r.0 + r.2 - t, r.1, t, r.3, c);
}

fn tag_size(id: u32, s: i32) -> (i32, i32) {
    let digits = id.to_string().len() as i32;
    (digits * (3 * s + s) + s + 2, 5 * s + 2 * s + 2)
}

fn draw_number(img: &mut RgbaImage, id: u32, x: i32, y: i32, s: i32, bg: [u8; 3]) {
    let (w, h) = tag_size(id, s);
    fill(img, x, y, w, h, bg);
    // Dark text on the bright tag.
    let ink = [0, 0, 0];
    for (n, ch) in id.to_string().chars().enumerate() {
        let d = &DIGITS[ch.to_digit(10).unwrap_or(0) as usize];
        let ox = x + s + n as i32 * 4 * s;
        for (row, bits) in d.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    fill(img, ox + col * s, y + s + 1 + row as i32 * s, s, s, ink);
                }
            }
        }
    }
}

/// Draw the boxes and numbers into `img` (already scaled; `geo` maps screen
/// rects onto it).
pub fn draw(img: &mut RgbaImage, boxes: &[MarkBox], geo: &ShotGeometry) {
    let s = if img.width().max(img.height()) >= 900 { 3 } else { 2 };
    for (n, b) in boxes.iter().enumerate() {
        let c = PALETTE[n % PALETTE.len()];
        let r = geo.to_image(b.rect);
        outline(img, r, 2, c);
        let (tw, th) = tag_size(b.id, s);
        // The tag sits on the box's top-left corner, above it when there's room.
        // A thin row (a list item) would have its text covered, so its tag goes
        // inside, at the right end, where rows have no text.
        let (tx, ty) = if r.3 < th * 2 && r.2 > tw * 3 {
            (r.0 + r.2 - tw - 2, r.1 + (r.3 - th) / 2)
        } else {
            (r.0, if r.1 >= th { r.1 - th } else { r.1 })
        };
        let tx = tx.clamp(0, (img.width() as i32 - tw).max(0));
        draw_number(img, b.id, tx, ty, s, c);
    }
}

/// What goes to the model.
#[derive(Debug, Clone, PartialEq)]
pub struct Rendered {
    pub base64_jpeg: String,
    pub geometry: ShotGeometry,
    /// Password fields that were covered.
    pub covered: usize,
}

/// Cover password fields, scale to the model's size, draw the numbered boxes
/// and encode a JPEG. The capture is consumed; nothing touches the disk.
pub fn render(capture: Capture, origin: (i32, i32), boxes: &[MarkBox]) -> Result<Rendered, String> {
    let Capture { width, height, rgba, redact, .. } = capture;
    if width < 16 || height < 16 {
        return Err("the captured area was empty".into());
    }
    let mut img = RgbaImage::from_raw(width, height, rgba).ok_or("the screenshot had the wrong size")?;
    let covered = vision::cover(&mut img, &redact);
    let (w, h) = vision::fit(width, height, vision::MAX_SIDE);
    let mut img = if (w, h) == (width, height) { img } else { imageops::thumbnail(&img, w, h) };
    let geometry = ShotGeometry { origin, capture: (width, height), image: (w, h) };
    draw(&mut img, boxes, &geometry);
    let rgb = image::DynamicImage::ImageRgba8(img).into_rgb8();
    let mut jpeg = Vec::with_capacity((w * h / 4) as usize);
    JpegEncoder::new_with_quality(&mut jpeg, 85)
        .encode_image(&rgb)
        .map_err(|e| format!("could not encode the screenshot: {e}"))?;
    Ok(Rendered { base64_jpeg: base64::engine::general_purpose::STANDARD.encode(&jpeg), geometry, covered })
}

/// The compact list the model reads next to the picture:
/// `[7] button "Save"`, `[9] box (no name)`.
pub fn list_line(id: u32, role: &str, name: &str, value: Option<&str>, region: bool) -> String {
    if region {
        return format!("[{id}] box (something on the screen without a name)");
    }
    let mut s = format!("[{id}] {role}");
    let name = name.trim();
    if !name.is_empty() {
        s.push_str(&format!(" \u{201c}{}\u{201d}", crate::tools::ellipsize(name, 50)));
    }
    if let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) {
        s.push_str(&format!(" value=\u{201c}{}\u{201d}", crate::tools::ellipsize(v, 40)));
    }
    s
}

/// Blocks per side of the picture fingerprint.
const SIG_COLS: u32 = 64;
const SIG_ROWS: u32 = 40;

/// A coarse fingerprint of a picture (average brightness of 64x40 blocks), so
/// "did the screen change?" works for apps UI Automation can't read, and for
/// text that UI Automation doesn't expose (a status label).
pub fn picture_signature(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    if width == 0 || height == 0 || rgba.len() < (width * height * 4) as usize {
        return vec![];
    }
    let mut out = Vec::with_capacity((SIG_COLS * SIG_ROWS) as usize);
    for by in 0..SIG_ROWS {
        for bx in 0..SIG_COLS {
            let (x0, x1) = (bx * width / SIG_COLS, ((bx + 1) * width / SIG_COLS).max(bx * width / SIG_COLS + 1));
            let (y0, y1) = (by * height / SIG_ROWS, ((by + 1) * height / SIG_ROWS).max(by * height / SIG_ROWS + 1));
            let (mut sum, mut n) = (0u64, 0u64);
            for y in y0..y1.min(height) {
                for x in x0..x1.min(width) {
                    sum += luma(&rgba[((y * width + x) * 4) as usize..]) as u64;
                    n += 1;
                }
            }
            out.push(sum.checked_div(n).unwrap_or(0) as u8);
        }
    }
    out
}

/// Did the screen really change between two fingerprints? A blinking caret
/// touches one or two blocks; text, a menu or a dialog moves several.
pub fn pictures_differ(a: &[u8], b: &[u8]) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a.len() != b.len() {
        return true;
    }
    let diffs: Vec<u8> = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).collect();
    diffs.iter().filter(|d| **d >= 6).count() >= 4
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(role: &str, name: &str, rect: Rect) -> UiElement {
        UiElement { role: role.into(), name: name.into(), enabled: true, actionable: true, rect, ..Default::default() }
    }

    const VIEW: Rect = (100, 100, 800, 600);

    #[test]
    fn marks_are_numbered_top_to_bottom_then_left_to_right() {
        let els = [
            el("button", "Right", (400, 120, 80, 30)),
            el("button", "Left", (120, 122, 80, 30)),
            el("button", "Below", (120, 300, 80, 30)),
        ];
        let order = select(&els, VIEW);
        let names: Vec<&str> = order.iter().map(|&i| els[i].name.as_str()).collect();
        assert_eq!(names, ["Left", "Right", "Below"], "same row left to right, then the next row");
    }

    #[test]
    fn passwords_disabled_hidden_tiny_and_containers_get_no_box() {
        let mut pw = el("edit", "Password", (120, 150, 200, 24));
        pw.password = true;
        let mut off = el("button", "Hidden", (120, 200, 80, 24));
        off.offscreen = true;
        let mut dis = el("button", "Disabled", (120, 230, 80, 24));
        dis.enabled = false;
        let els = [
            pw,
            off,
            dis,
            el("button", "Tiny", (120, 260, 3, 3)),
            el("pane", "Sidebar", (100, 100, 200, 500)),
            el("button", "Outside", (2000, 2000, 80, 24)),
            el("button", "Fine", (120, 300, 80, 24)),
            el("button", "Fine", (120, 300, 80, 24)),
        ];
        let order = select(&els, VIEW);
        assert_eq!(order.len(), 1, "{order:?}");
        assert_eq!(els[order[0]].name, "Fine");
    }

    #[test]
    fn too_many_elements_keep_the_named_small_ones() {
        let mut els: Vec<UiElement> = (0..60)
            .map(|i| {
                el("button", if i % 2 == 0 { "Named" } else { "" }, (110 + (i % 10) * 40, 110 + (i / 10) * 30, 30, 24))
            })
            .collect();
        els.push(el("button", "Important", (120, 600, 60, 24)));
        let order = select(&els, VIEW);
        assert_eq!(order.len(), MAX_MARKS);
        assert!(order.iter().any(|&i| els[i].name == "Important"));
        assert!(order.iter().filter(|&&i| els[i].name.is_empty()).count() < 15, "unnamed ones go first");
    }

    #[test]
    fn geometry_maps_the_models_picture_back_to_the_screen() {
        let g = ShotGeometry { origin: (100, 50), capture: (2000, 1000), image: (1000, 500) };
        assert_eq!(g.to_screen(500, 250), Some((1100, 550)));
        assert_eq!(g.to_screen(0, 0), Some((100, 50)));
        assert_eq!(g.to_screen(1000, 10), None, "outside the picture");
        assert_eq!(g.to_screen(-1, 10), None);
        assert_eq!(g.to_image((1100, 550, 200, 100)), (500, 250, 100, 50));
    }

    /// A white picture with dark-bordered buttons.
    fn picture(w: u32, h: u32, rects: &[Rect]) -> Vec<u8> {
        let mut img = RgbaImage::from_pixel(w, h, Rgba([255, 255, 255, 255]));
        for r in rects {
            outline(&mut img, *r, 2, [20, 20, 20]);
        }
        img.into_raw()
    }

    #[test]
    fn the_pixel_fallback_finds_boxes_where_ui_automation_is_empty() {
        let buttons = [(40, 40, 120, 40), (40, 120, 120, 40), (300, 200, 160, 60)];
        let found = regions(&picture(640, 400, &buttons), 640, 400, &[]);
        assert_eq!(found.len(), 3, "{found:?}");
        for b in buttons {
            let hit = found.iter().any(|f| overlap(*f, b) * 10 >= area(b) * 8 && area(*f) < area(b) * 2);
            assert!(hit, "no region matches {b:?} in {found:?}");
        }
    }

    #[test]
    fn the_pixel_fallback_skips_known_boxes_empty_pictures_and_the_whole_window() {
        let buttons = [(40, 40, 120, 40), (300, 200, 160, 60)];
        let pic = picture(640, 400, &buttons);
        let found = regions(&pic, 640, 400, &[(36, 36, 130, 50)]);
        assert_eq!(found.len(), 1, "the first is already marked: {found:?}");
        assert!(regions(&vec![255; 640 * 400 * 4], 640, 400, &[]).is_empty(), "nothing to find on blank");
        // A frame around the whole window is not a control.
        assert!(regions(&picture(640, 400, &[(0, 0, 640, 400)]), 640, 400, &[]).is_empty());
        assert!(regions(&[0; 16], 2, 2, &[]).is_empty(), "tiny pictures are ignored");
    }

    #[test]
    fn numbers_are_drawn_into_the_picture_and_only_there() {
        let mut img = RgbaImage::from_pixel(400, 300, Rgba([255, 255, 255, 255]));
        let g = ShotGeometry { origin: (0, 0), capture: (400, 300), image: (400, 300) };
        let boxes = [MarkBox { id: 7, rect: (50, 80, 100, 40), region: false }];
        draw(&mut img, &boxes, &g);
        // The box outline is the palette colour...
        assert_eq!(img.get_pixel(50, 100).0[..3], PALETTE[0]);
        assert_eq!(img.get_pixel(149, 100).0[..3], PALETTE[0]);
        // ...there is a tag above it with dark digit pixels...
        let (tw, th) = tag_size(7, 2);
        let tag_y = 80 - th;
        let dark = (50..50 + tw)
            .flat_map(|x| (tag_y..tag_y + th).map(move |y| (x, y)))
            .filter(|&(x, y)| img.get_pixel(x as u32, y as u32).0[..3] == [0, 0, 0])
            .count();
        assert!(dark >= 8, "digit pixels: {dark}");
        // ...and the inside of the box is untouched.
        assert_eq!(img.get_pixel(100, 100).0, [255, 255, 255, 255]);
    }

    #[test]
    fn rendering_scales_covers_passwords_and_marks() {
        let cap = Capture {
            width: 2560,
            height: 1440,
            rgba: vec![255; 2560 * 1440 * 4],
            window: None,
            redact: vec![crate::desktop::PixelRect { x: 100, y: 100, w: 400, h: 60 }],
        };
        let boxes = [MarkBox { id: 12, rect: (1000, 600, 300, 80), region: false }];
        let r = render(cap, (0, 0), &boxes).unwrap();
        assert_eq!(r.covered, 1);
        assert_eq!(r.geometry.image, (1280, 720));
        let bytes = base64::engine::general_purpose::STANDARD.decode(&r.base64_jpeg).unwrap();
        let img = image::load_from_memory(&bytes).unwrap().into_rgb8();
        let grey = img.get_pixel(150, 65).0;
        assert!(grey.iter().all(|&c| (110..=146).contains(&c)), "password area covered: {grey:?}");
        let c = img.get_pixel(500, 320).0; // left edge of the box at half scale
        assert!(c[0] > 200 && c[1] < 120, "box outline is magenta-ish: {c:?}");
    }

    #[test]
    fn list_lines_are_short_and_say_when_a_box_has_no_name() {
        assert_eq!(list_line(7, "button", "Save", None, false), "[7] button \u{201c}Save\u{201d}");
        assert_eq!(
            list_line(3, "edit", "Name", Some("Ada"), false),
            "[3] edit \u{201c}Name\u{201d} value=\u{201c}Ada\u{201d}"
        );
        assert!(list_line(9, "", "", None, true).starts_with("[9] box"));
    }

    #[test]
    fn the_picture_signature_ignores_a_caret_but_sees_text_and_boxes() {
        let (w, h) = (900u32, 500u32);
        let a = picture(w, h, &[(20, 20, 100, 40)]);
        let sig = |p: &[u8]| picture_signature(p, w, h);
        let paint = |p: &mut Vec<u8>, x: u32, y: u32| {
            let i = 4 * (y * w + x) as usize;
            p[i..i + 3].copy_from_slice(&[0, 0, 0]);
        };
        // A blinking caret: one thin line.
        let mut caret = a.clone();
        for y in 250..265 {
            paint(&mut caret, 450, y);
        }
        assert!(!pictures_differ(&sig(&a), &sig(&caret)), "a caret is not a change");
        // A new box appears.
        let b = picture(w, h, &[(20, 20, 100, 40), (400, 200, 220, 80)]);
        assert!(pictures_differ(&sig(&a), &sig(&b)));
        // A short line of "text" (a few dark strokes): a status label changing.
        let mut text = a.clone();
        for x in (500..580).step_by(3) {
            for y in 60..74 {
                paint(&mut text, x, y);
            }
        }
        assert!(pictures_differ(&sig(&a), &sig(&text)), "text appearing is a change");
        assert!(picture_signature(&[], 0, 0).is_empty());
        assert!(!pictures_differ(&[], &[1, 2]));
    }
}
