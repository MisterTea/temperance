import { expect, test } from "@playwright/test";
import { layoutProblems } from "./layout";

test.use({ storageState: { cookies: [], origins: [] } });

test("layout audit detects overflow, clipping, overlap, and small targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 600 });
  await page.setContent(`
    <body style="margin:0">
      <div style="width:600px">wide block</div>
      <button style="width:40px;white-space:nowrap;overflow:hidden">Very long button label</button>
      <div style="position:relative;height:60px">
        <button style="position:absolute;top:0;left:0;width:80px;height:40px">One</button>
        <button style="position:absolute;top:10px;left:10px;width:80px;height:40px">Two</button>
      </div>
      <p style="margin:0">first paragraph</p><p style="margin-top:-12px">second paragraph</p>
      <img src="data:image/png;base64,broken" style="width:10px;height:10px">
    </body>`);
  const problems = (await layoutProblems(page)).join("\n");
  expect(problems).toContain("page scrolls horizontally");
  expect(problems).toContain("extends outside the viewport");
  expect(problems).toContain("text overflows its box");
  expect(problems).toMatch(/"One" overlaps .*"Two"/);
  expect(problems).toContain("overlaps text");
  expect(problems).toContain("image failed to load");
});

test("layout audit accepts a clean page and scrollable tables", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 600 });
  await page.setContent(`
    <body style="margin:0;padding:8px">
      <h1>Clean</h1>
      <div style="overflow-x:auto"><table style="width:900px"><tr><td>wide but scrollable</td></tr></table></div>
      <button style="padding:8px">OK</button>
    </body>`);
  expect(await layoutProblems(page)).toEqual([]);
});
