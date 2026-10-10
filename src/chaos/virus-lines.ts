// What Glitch's fake popups say and how they play out (chaos mode 2). Pure, so
// it is unit-tested: every text is playful and unmistakably Glitch's, and none
// of it can pass for a Windows dialog, a security or antivirus warning, a
// system error, an update, a login or a payment screen.

export type PopupKind = "ram" | "raccoons" | "adopted";

export const FOOTER = "Glitch is only playing";

export interface Stage {
  /** The headline. */
  title: string;
  /** One line under it. */
  body: string;
  /** 0..1, or null for no bar. */
  progress: number | null;
  /** What the bar says on its right ("37%"). */
  meter: string;
  /** How many tiny raccoons have arrived (raccoons popup). */
  raccoons: number;
  /** The punchline has landed. */
  done: boolean;
}

export const POPUP_KINDS: readonly PopupKind[] = ["ram", "raccoons", "adopted"];

/** The popup closes itself this long after it opened at the latest (Rust enforces 20 s too). */
export const POPUP_LIFE_MS = 14_000;

function ease(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

/** What the popup shows `ms` after it opened. */
export function stageAt(kind: PopupKind, ms: number): Stage {
  switch (kind) {
    case "ram": {
      // The bar climbs to 37%, hangs there, then: just kidding.
      const climb = ease(ms / 3200) * 0.37;
      if (ms < 5200) {
        const shown = ms < 3200 ? climb : 0.37;
        return { title: "GLITCH.EXE is eating your RAM", body: ms < 3200 ? "nom nom nom..." : "37%... and holding. chewing slowly.", progress: shown, meter: `${Math.round(shown * 100)}%`, raccoons: 0, done: false };
      }
      const back = 1 - ease((ms - 5200) / 700);
      return { title: "just kidding!", body: "i only licked it. all your RAM is still yours.", progress: 0.37 * back, meter: `${Math.round(37 * back)}%`, raccoons: 0, done: true };
    }
    case "raccoons": {
      const p = Math.min(1, ms / 4200);
      const n = Math.min(3, Math.floor(p * 3.4));
      if (p < 1) return { title: "Installing 3 new raccoons", body: ["unpacking tiny raccoons...", "this one is sleepy...", "feeding them pixels..."][Math.min(2, n)], progress: p, meter: `${n} / 3`, raccoons: n, done: false };
      return { title: "done!", body: "they are very small and very proud of it.", progress: 1, meter: "3 / 3", raccoons: 3, done: true };
    }
    case "adopted":
      return {
        title: "Your cursor has been adopted",
        body: ms < 3500 ? "his name is Pointer. he is doing great." : "i will bring him back. probably.",
        progress: null,
        meter: "",
        raccoons: 0,
        done: ms >= 3500,
      };
  }
}

/** The label on the button (it is always there, from the first frame). */
export function closeLabel(kind: PopupKind): string {
  return kind === "adopted" ? "OK, fine" : "Close";
}

/** Every string the popups can show (for the "never looks like a system dialog" test). */
export function allCopy(): string[] {
  const out: string[] = [FOOTER];
  for (const kind of POPUP_KINDS) {
    out.push(closeLabel(kind));
    for (let ms = 0; ms <= POPUP_LIFE_MS; ms += 250) {
      const s = stageAt(kind, ms);
      out.push(s.title, s.body, s.meter);
    }
  }
  return out;
}

/** Words that would make a popup look like something it is not. None may appear. */
export const BANNED_WORDS = [
  "windows",
  "microsoft",
  "defender",
  "antivirus",
  "virus",
  "malware",
  "trojan",
  "ransom",
  "infected",
  "threat",
  "security",
  "warning",
  "alert",
  "error",
  "failed",
  "critical",
  "blue screen",
  "update",
  "upgrade",
  "restart",
  "reboot",
  "password",
  "login",
  "log in",
  "sign in",
  "verify",
  "account",
  "payment",
  "credit",
  "bank",
  "bitcoin",
  "encrypted",
  "hacked",
  "your files",
  "administrator",
  "permission",
  "license",
];
