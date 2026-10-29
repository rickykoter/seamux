// cards — the Tour's words: an opening title card and a caption per beat.
//
// Rendered from HTML in the same headless Chromium that records the scenes, so
// the type is real type, not ffmpeg's drawtext. stitch.mjs overlays the PNGs.
// The look follows the original Tour: Everforest colours, "sea" in sand and
// "mux" in green, captions as a dark pill low in the frame.

import { chromium } from 'playwright-core'

export const TITLE = {
  name: 'seamux',
  line: 'Run a fleet of Claude Code agents from one screen.',
}

const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`

const titleHtml = (t) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  .card { width: 1920px; height: 1080px; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 34px; font-family: ${FONT}; }
  h1 { margin: 0; font-size: 132px; font-weight: 800; letter-spacing: -4px; line-height: 1; }
  .sea { color: #d3c6aa; } .mux { color: #a7c080; }
  p { margin: 0; font-size: 46px; color: #859289; font-weight: 500; }
</style><div class="card"><h1><span class="sea">${t.name.slice(0, 3)}</span><span
  class="mux">${t.name.slice(3)}</span></h1><p>${esc(t.line)}</p></div>`

const captionHtml = (text) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  .pill { display: inline-block; padding: 16px 30px; border-radius: 12px;
          background: rgba(30, 35, 38, 0.94); border: 1px solid #414b50;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
          color: #d3c6aa; font: 600 30px/1.25 ${FONT}; white-space: nowrap; }
  .pill b { color: #a7c080; font-weight: 700; }
</style><span class="pill">${mark(text)}</span>`

// A freeze frame's panel: a heading and the points to read while the frame holds.
const panelHtml = (title, bullets, width) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  .panel { box-sizing: border-box; width: ${width}px; padding: 38px 42px 40px; border-radius: 16px;
           background: rgba(30, 35, 38, 0.95); border: 1px solid #414b50;
           box-shadow: 0 14px 40px rgba(0, 0, 0, 0.4); font-family: ${FONT}; }
  h2 { margin: 0 0 26px; font-size: 40px; line-height: 1.15; font-weight: 750; color: #a7c080;
       letter-spacing: -0.5px; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { position: relative; padding-left: 30px; margin: 0 0 20px; color: #d3c6aa;
       font: 500 28px/1.35 ${FONT}; }
  li:last-child { margin-bottom: 0; }
  li::before { content: ""; position: absolute; left: 2px; top: 14px; width: 11px; height: 11px;
               border-radius: 3px; background: #dbbc7f; }
  li b { color: #a7c080; font-weight: 700; }
</style><div class="panel">${title ? `<h2>${mark(title)}</h2>` : ''}<ul>${bullets.map((b) => `<li>${mark(b)}</li>`).join('')}</ul></div>`

// A topsight: what the whole clip covers, as named features in two columns.
const overviewHtml = (title, line, items) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  .ov { box-sizing: border-box; width: 1700px; padding: 54px 64px 58px; border-radius: 20px;
        background: rgba(30, 35, 38, 0.93); border: 1px solid #414b50;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45); font-family: ${FONT}; }
  h2 { margin: 0; font-size: 54px; line-height: 1.1; font-weight: 800; letter-spacing: -1px; color: #a7c080; }
  .line { margin: 14px 0 40px; font-size: 28px; color: #859289; font-weight: 500; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 56px; row-gap: 30px; }
  .it { padding-left: 22px; border-left: 4px solid #dbbc7f; }
  .it h3 { margin: 0 0 6px; font-size: 29px; font-weight: 750; color: #d3c6aa; }
  .it p { margin: 0; font: 500 23px/1.35 ${FONT}; color: #9da9a0; }
  .it b { color: #a7c080; font-weight: 700; }
</style><div class="ov"><h2>${mark(title)}</h2>${line ? `<p class="line">${mark(line)}</p>` : ''}
<div class="grid">${items.map((i) => `<div class="it"><h3>${mark(i.label)}</h3><p>${mark(i.text)}</p></div>`).join('')}</div></div>`

// A callout: one feature's name and a line, set beside its spotlight.
const calloutHtml = (title, text, width) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  .co { box-sizing: border-box; width: ${width}px; padding: 28px 34px 30px; border-radius: 14px;
        background: rgba(30, 35, 38, 0.96); border: 1px solid #5c6a5e; border-left: 6px solid #dbbc7f;
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5); font-family: ${FONT}; }
  h3 { margin: 0 0 10px; font-size: 38px; line-height: 1.1; font-weight: 780; color: #a7c080; letter-spacing: -0.5px; }
  p { margin: 0; font: 500 27px/1.35 ${FONT}; color: #d3c6aa; }
  b { color: #a7c080; font-weight: 700; }
</style><div class="co"><h3>${mark(title)}</h3><p>${mark(text)}</p></div>`

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// `go 3` style spans in a caption are picked out in green, like a board chip.
function mark(s) {
  return esc(s).replace(/`([^`]+)`/g, '<b>$1</b>')
}

// jobs: [{ kind: 'title' | 'caption' | 'panel' | 'overview' | 'callout', text?, title?, line?,
//          bullets?, items?, width?, out }]
// A title job's `title` ({ name, line }) replaces the Tour's.
export async function renderCards(jobs) {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  try {
    for (const j of jobs) {
      if (j.kind === 'title') {
        await page.setContent(titleHtml(j.title || TITLE))
        await page.screenshot({ path: j.out, omitBackground: true })
      } else if (j.kind === 'callout') {
        await page.setContent(calloutHtml(j.title, j.text, j.width))
        await page.locator('.co').screenshot({ path: j.out, omitBackground: true })
      } else if (j.kind === 'overview') {
        await page.setContent(overviewHtml(j.title, j.line, j.items))
        await page.locator('.ov').screenshot({ path: j.out, omitBackground: true })
      } else if (j.kind === 'panel') {
        await page.setContent(panelHtml(j.title, j.bullets, j.width))
        await page.locator('.panel').screenshot({ path: j.out, omitBackground: true })
      } else {
        await page.setContent(captionHtml(j.text))
        await page.locator('.pill').screenshot({ path: j.out, omitBackground: true })
      }
    }
  } finally {
    await browser.close()
  }
}
