import { expect, type Page } from "@playwright/test";

/**
 * Audits the rendered page for visual defects that screenshots often miss:
 * horizontal page overflow, content pushed off-screen, clipped text,
 * overlapping controls or text, undersized touch targets, and broken images.
 * When a modal dialog is open only the dialog is audited (it is the top layer).
 */
export async function expectCleanLayout(page: Page, label: string) {
  expect(await layoutProblems(page), `layout problems: ${label}`).toEqual([]);
}
export async function layoutProblems(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const issues: string[] = [];
    const vw = document.documentElement.clientWidth;
    const touch = matchMedia("(pointer: coarse)").matches;
    const root: Element =
      document.querySelector("dialog[open]") ?? document.body;
    const describe = (el: Element) => {
      const text = (el.textContent ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40);
      const name =
        el.getAttribute("aria-label") ?? el.getAttribute("name") ?? text;
      return `<${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).trim().replace(/\s+/g, ".") : ""}> "${name}"`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== "hidden" &&
        s.display !== "none" &&
        Number(s.opacity) > 0
      );
    };
    const scrollsX = (el: Element | null) => {
      for (
        let p = el?.parentElement;
        p && p !== document.body;
        p = p.parentElement
      ) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowX)) return true;
      }
      return false;
    };

    if (document.documentElement.scrollWidth > vw + 1)
      issues.push(
        `page scrolls horizontally (${document.documentElement.scrollWidth}px > ${vw}px)`,
      );

    const all = [root, ...root.querySelectorAll("*")].filter(visible);
    for (const el of all) {
      if (el.closest("svg") && el.tagName !== "svg") continue;
      const r = el.getBoundingClientRect();
      if ((r.right > vw + 1 || r.left < -1) && !scrollsX(el))
        issues.push(
          `${describe(el)} extends outside the viewport (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`,
        );
      const s = getComputedStyle(el);
      const clips = ["hidden", "clip"].includes(s.overflowX);
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
      );
      if (
        hasText &&
        (clips ||
          ["BUTTON", "A", "SPAN", "STRONG", "TH", "TD", "LABEL"].includes(
            el.tagName,
          )) &&
        el.scrollWidth > el.clientWidth + 1 &&
        el.clientWidth > 0 &&
        s.textOverflow !== "ellipsis" &&
        s.display !== "inline"
      )
        issues.push(
          `${describe(el)} text overflows its box (${el.scrollWidth}px > ${el.clientWidth}px)`,
        );
      if (el.tagName === "IMG" && !(el as HTMLImageElement).naturalWidth)
        issues.push(`${describe(el)} image failed to load`);
    }

    const controls = all.filter((el) =>
      el.matches(
        "button, a[href], input:not([type=hidden]), select, textarea, progress",
      ),
    );
    const overlaps = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i],
          b = controls[j];
        if (a.contains(b) || b.contains(a)) continue;
        if (overlaps(a.getBoundingClientRect(), b.getBoundingClientRect()))
          issues.push(`${describe(a)} overlaps ${describe(b)}`);
      }

    const text = all.filter(
      (el) =>
        el.matches(
          "h1, h2, h3, p, strong, small, span, label, legend, td, th",
        ) &&
        [...el.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
        ),
    );
    for (let i = 0; i < text.length; i++)
      for (let j = i + 1; j < text.length; j++) {
        const a = text[i],
          b = text[j];
        if (a.contains(b) || b.contains(a)) continue;
        if (overlaps(a.getBoundingClientRect(), b.getBoundingClientRect()))
          issues.push(`${describe(a)} overlaps text ${describe(b)}`);
      }

    if (touch)
      for (const el of controls) {
        if (el.matches("progress")) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 24 || r.width < 24)
          issues.push(
            `${describe(el)} touch target too small (${Math.round(r.width)}x${Math.round(r.height)})`,
          );
      }
    return [...new Set(issues)];
  });
}
