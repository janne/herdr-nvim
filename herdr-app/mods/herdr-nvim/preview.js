// The preview: a file shown as what it is, in the tab's nvim's place
// (the controller, sync.js `startSwap`, splits nvim's pane with this mod, props
// {preview: <file>, tab}, then closes nvim's pane; nvim keeps running).
// Markdown is rendered, images and SVGs drawn. It reloads when the file
// changes (saved in nvim, written by an agent). The pane header's Source
// button (mods/herdr-nvim-header) puts nvim back.
//
// Images are drawn with image(), which takes a path inside the app home: a
// copy goes to `mods/herdr-nvim/.cache` (hidden, so writing there reloads no
// mod), named by its content, the newest CACHE_KEEP kept. Mermaid blocks in
// markdown are drawn there too, when mermaid-cli is installed (mermaid.js).

import { div, image } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { appHome, exec, panes, settings, setShared, shared, theme, watchFolder, window } from "herdr";
import * as fs from "fs/promises";
import { HEADING, documentBlocks, frontMatter, linkDefinitions } from "./document.js";
import { drawMermaid, hashText, isDark, pngSize, splitMermaid } from "./mermaid.js";

// Markdown's padding left and right.
const PAD_X = 18;
// The page's font on macOS: the system font, as VS Code's and GitHub's
// previews use (-apple-system). Herdr's UI font (Geist) has no bold or italic
// installed, so **bold** and *italic* would read as plain text.
const MAC_FONT = ".SystemUIFont";

// The preview's text size: the terminals' font size, else Herdr's 14.
function textSize() {
  const size = settings().font_size;
  return typeof size === "number" ? size : 14;
}

// A markdown text as the preview lays it out (document.js): its front matter
// ({front: fields}), then its headings, rules, diagrams and the markdown
// between them, in order.
export function pageOf(text) {
  const front = frontMatter(text);
  const body = front ? front.body : text;
  const definitions = linkDefinitions(body);
  const parts = front ? [{ front: front.fields }] : [];
  for (const p of splitMermaid(body)) {
    if (p.mermaid !== undefined) parts.push(p);
    else parts.push(...documentBlocks(p.md, definitions));
  }
  return parts;
}

const markdown = (id, text) => TextView.markdown(id, text).selectable(true);

// Markdown inside a heading that plain text would show as written.
const INLINE = /[`*_[\]<>\\&]/;

// A heading at GitHub's scale of the body text (document.js HEADING); a rule
// under h1 and h2.
function heading(h, i, t) {
  const style = HEADING[h.level];
  const size = textSize() * style.em;
  return div()
    .w_full()
    .flex_none()
    .mt(i === 0 ? 0 : Math.round(size * 0.9))
    .mb(Math.round(textSize() * 0.6))
    .text_size(size)
    .font_weight(600)
    .when(Boolean(style.dim), (el) => el.text_color(t.dim))
    .when(Boolean(style.rule), (el) => el.pb(Math.round(size * 0.3)).border_b(1).border_color(t.border))
    .child(INLINE.test(h.text) ? markdown(`herdr-nvim-preview-h-${i}`, `**${h.text}**`) : div().line_height(1.25).child(h.text));
}

// Front matter as VS Code shows it: a bordered key/value table, keys bold.
function frontTable(fields, t, room) {
  const size = textSize();
  const longest = Math.max(...fields.map(([k]) => k.length));
  const keyWidth = Math.min(Math.ceil(longest * size * 0.55) + 26, room ? Math.round(room * 0.4) : 240);
  return v_flex()
    .self_start()
    .max_w_full()
    .flex_none()
    .mb(16)
    .border(1)
    .border_color(t.border)
    .children(
      fields.map(([key, value], i) =>
        h_flex()
          .items_start()
          .when(i > 0, (el) => el.border_t(1).border_color(t.border))
          .child(div().w(keyWidth).flex_none().px(13).py(7).font_weight(600).child(key))
          .child(div().min_w(0).px(13).py(7).border_l(1).border_color(t.border).child(value)),
      ),
    );
}

const KINDS = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", ico: "image", svg: "image",
};
const MAX_BYTES = { markdown: 2 * 1024 * 1024, image: 30 * 1024 * 1024 };
const CACHE = "mods/herdr-nvim/.cache";
const CACHE_KEEP = 40;
// shared(): which file each tab's preview shows, for its pane header.
const SHOWN = "herdr-nvim.previews";

// "markdown", "image", or null: what a file previews as.
export function previewKind(path) {
  const ext = /\.([^./]+)$/.exec(path ?? "")?.[1]?.toLowerCase();
  return (ext && KINDS[ext]) || null;
}

const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";

// FNV-1a over the bytes: the cache name of an image's content.
function hashOf(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0") + bytes.length.toString(16);
}

async function cached(bytes, ext) {
  const name = `${hashOf(bytes)}.${ext}`;
  const dir = `${appHome()}/${CACHE}`;
  if (!(await fs.exists(`${dir}/${name}`))) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/${name}`, bytes);
  }
  return remember(name);
}

// A cache file just used: the newest first; the rest go (every preview's
// names, so none on screen). Its path for image().
async function remember(name) {
  const dir = `${appHome()}/${CACHE}`;
  // A list here; newer herdr-nvim keeps {recent, shown} under the same name.
  const was = shared("herdr-nvim.preview-cache");
  const listed = Array.isArray(was) ? was : Array.isArray(was?.recent) ? was.recent : [];
  const keep = [name, ...listed.filter((n) => n !== name)];
  for (const old of keep.slice(CACHE_KEEP)) await fs.unlink(`${dir}/${old}`).catch(() => {});
  setShared("herdr-nvim.preview-cache", keep.slice(0, CACHE_KEEP));
  return `${CACHE}/${name}`;
}

// A mermaid part drawn (or found drawn) into the cache: the part gets {src,
// width, height} in pixels as shown (drawn at twice that), or {missing} /
// {error}.
async function diagram(part, dark) {
  const name = `mermaid-${hashText(`${dark ? "dark" : "light"}\n${part.mermaid}`)}.png`;
  const dir = `${appHome()}/${CACHE}`;
  if (!(await fs.exists(`${dir}/${name}`))) {
    const r = await drawMermaid(part.mermaid, dark, dir, name);
    if (!r.drawn) return r;
  }
  const size = pngSize(await fs.readFile(`${dir}/${name}`).catch(() => null));
  if (!size) return { error: "mmdc wrote no picture." };
  return { src: await remember(name), width: size.width / 2, height: size.height / 2 };
}

// A mod reads files only inside the home folder: one elsewhere (/tmp, a
// screenshot under /private/var/folders) is read through a process.
async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    const r = await exec("cat", [file]);
    if (r.code !== 0) throw new Error(r.stderr);
    return r.stdout;
  }
}

async function readBytes(file) {
  try {
    return await fs.readFile(file);
  } catch {
    // Copied into the cache (inside the app home), read there, then gone.
    const dir = `${appHome()}/${CACHE}`;
    await fs.mkdir(dir, { recursive: true });
    const copy = `${dir}/.copy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r = await exec("cp", [file, copy]);
    if (r.code !== 0) throw new Error(r.stderr);
    try {
      return await fs.readFile(copy);
    } finally {
      await fs.unlink(copy).catch(() => {});
    }
  }
}

// {kind, text} / {kind, src}, or {error}.
async function load(file) {
  const kind = previewKind(file);
  if (!kind) return { error: "Can't preview this kind of file." };
  let data;
  try {
    data = kind === "markdown" ? await readText(file) : await readBytes(file);
  } catch {
    return { error: "The file is gone." };
  }
  if (data.length > MAX_BYTES[kind]) return { error: `Too big to preview (${(data.length / 1048576).toFixed(1)} MB).` };
  if (kind === "markdown") {
    return { kind, parts: pageOf(data) };
  }
  const ext = /\.([^./]+)$/.exec(file)[1].toLowerCase();
  return { kind, src: await cached(data, ext) };
}

export class Preview {
  constructor(props, cx) {
    this.file = props.preview;
    this.tab = props.tab;
    this.shown = null;
    // Only tabs that still show a preview keep their entry.
    const showing = new Set(panes().filter((p) => p.terminal === null && p.mod === "herdr-nvim").map((p) => p.tab));
    const kept = Object.fromEntries(Object.entries(shared(SHOWN) ?? {}).filter(([tab]) => showing.has(tab)));
    setShared(SHOWN, { ...kept, [this.tab]: this.file });
    cx.spawn(async (cx) => {
      // A changed path of the folder's root means "anything may have changed".
      const ours = (changed) => !changed.length || changed.some((p) => p === this.file || p === dirname(this.file));
      while (!this.closed) {
        this.shown = await load(this.file);
        cx.notify();
        // Diagrams draw beside the watch, so a save meanwhile isn't missed.
        if (this.shown.parts) this.draw(this.shown, cx);
        while (!this.closed && !ours(await watchFolder(dirname(this.file))));
      }
    });
  }

  // The pane is gone (main.js `close`): the watch loop ends.
  close() {
    this.closed = true;
  }

  // Draws a load's mermaid parts in order, each shown as it lands; a newer
  // load (or the pane closing) stops it.
  async draw(s, cx) {
    const dark = isDark(theme().background);
    for (const part of s.parts) {
      if (part.mermaid === undefined) continue;
      if (this.closed || this.shown !== s) return;
      Object.assign(part, await diagram(part, dark).catch((e) => ({ error: String(e?.message ?? e) })), { done: true });
      if (this.shown === s) cx.notify();
    }
  }

  // Markdown with mermaid parts: the text between them as markdown, each
  // diagram as its picture, at most the pane's width, all in one scroll.
  parts(s, t) {
    const fenced = (code) => TextView.markdown(`herdr-nvim-preview-code-${hashText(code)}`, "```mermaid\n" + code + "\n```").selectable(true);
    const room = this.width ? Math.max(40, this.width - 36) : null;
    const diagramOf = (p) => {
      if (!p.done) return div().py(6).text_color(t.dim).child("Drawing diagram…");
      if (p.src) {
        const w = room ? Math.min(p.width, room) : p.width;
        return div().py(6).child(image(p.src).w(w).h((p.height * w) / p.width));
      }
      const note = p.missing ? "Install mermaid-cli (mmdc) to draw this diagram." : `Mermaid: ${p.error}`;
      return v_flex().gap(4).child(div().text_size(12).text_color(p.missing ? t.dim : t.ansi1).child(note)).child(fenced(p.mermaid));
    };
    return v_flex()
      .id("herdr-nvim-preview-parts")
      .flex_1()
      .min_h(0)
      .w_full()
      .px(18)
      .py(12)
      .overflow_y_scrollbar()
      .on_size_change((size, cx) => {
        if (size.width !== this.width) {
          this.width = size.width;
          cx.notify();
        }
      })
      .children(
        s.parts.map((p, i) =>
          p.front ? frontTable(p.front, t, room)
          : p.heading ? heading(p.heading, i, t)
          : p.rule ? div().my(20).h(1).w_full().flex_none().bg(t.border)
          : p.mermaid !== undefined ? diagramOf(p)
          : markdown(`herdr-nvim-preview-${i}`, p.md),
        ),
      );
  }

  render() {
    const t = theme();
    const s = this.shown;
    const body = !s
      ? div()
      : s.error
        ? div().m_auto().text_color(t.dim).child(s.error)
        : s.kind === "image"
          ? div().flex_1().min_h(0).w_full().p(14).child(image(s.src).size_full())
          : this.parts(s, t);
    return v_flex()
      .id("herdr-nvim-preview")
      .size_full()
      .bg(t.background)
      .text_size(textSize())
      .when(window()?.platform === "macos", (el) => el.font_family(MAC_FONT))
      .text_color(t.foreground)
      .child(body);
  }
}
