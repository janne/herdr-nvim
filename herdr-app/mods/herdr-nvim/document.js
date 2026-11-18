// The markdown preview's page: the parts of a markdown text that the preview
// lays out itself, the way GitHub and VS Code show them, instead of leaving
// them to the TextView (preview.js):
// - YAML front matter (`---` … `---` at the very top): a key/value table, not
//   a paragraph run together into a heading;
// - headings: their sizes, weight, rules under h1/h2 and spacing;
// - thematic breaks (`---`, `***`, `___`): a rule.
// Everything else (paragraphs, lists, quotes, tables, code) stays markdown for
// the TextView, which keeps bold, code and links inline.

// The fence that opens a code block, as mermaid.js tracks it: nothing inside
// one is a heading or a rule.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
// A line a setext underline can't turn into a heading: blank, or one that
// starts a block of its own (a list item, a quote, a table row, a heading,
// indented code).
const NOT_PARAGRAPH = /^\s*$|^ {0,3}([-*+]\s|\d+[.)]\s|>|\||#)|^ {4}|^\t/;
const LINK_DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/;

// YAML front matter at the top: {fields: [[key, value]], body}, or null. Only
// what a plan's or a post's front matter holds is read: `key: value` lines,
// quotes taken off, a nested list or block joined into its key's value.
export function frontMatter(text) {
  const lines = text.split("\n");
  if (!/^---\s*$/.test(lines[0] ?? "")) return null;
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return null;
  const fields = [];
  for (const line of lines.slice(1, end)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = /^([^\s:#][^:]*?):(?:\s+(.*?))?\s*$/.exec(line);
    if (m) fields.push([m[1].trim(), unquote(m[2] ?? "")]);
    else if (fields.length) {
      const last = fields[fields.length - 1];
      const item = unquote(line.trim().replace(/^-\s+/, ""));
      if (item) last[1] = last[1] && !/^[|>][-+]?$/.test(last[1]) ? `${last[1]}, ${item}` : item;
    }
  }
  if (!fields.length) return null;
  return { fields, body: lines.slice(end + 1).join("\n") };
}

const unquote = (v) => (/^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);

// A markdown text's blocks in order: {md}, {heading: {level, text}}, {rule}.
// `definitions` (link reference definitions) go with each {md} block, so a
// reference resolves whichever block its definition is in.
export function documentBlocks(text, definitions = []) {
  const blocks = [];
  let md = [];
  let fence = null;
  const flush = () => {
    if (md.some((l) => l.trim())) blocks.push({ md: withDefinitions(md.join("\n"), definitions) });
    md = [];
  };
  for (const line of text.split("\n")) {
    if (fence) {
      md.push(line);
      if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) fence = null;
      continue;
    }
    const f = FENCE.exec(line);
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      md.push(line);
      continue;
    }
    const prev = md[md.length - 1];
    const setext = SETEXT.exec(line);
    if (setext && prev !== undefined && !NOT_PARAGRAPH.test(prev)) {
      md.pop();
      flush();
      blocks.push({ heading: { level: setext[1][0] === "=" ? 1 : 2, text: prev.trim() } });
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      flush();
      blocks.push({ heading: { level: atx[1].length, text: (atx[2] ?? "").trim() } });
    } else if (RULE.test(line)) {
      flush();
      blocks.push({ rule: true });
    } else md.push(line);
  }
  flush();
  return blocks;
}

const withDefinitions = (md, definitions) => (definitions.length ? `${md}\n\n${definitions.join("\n")}` : md);

// The link reference definitions of a text, outside code blocks.
export function linkDefinitions(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line);
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) fence = null;
    } else if (f && !(f[1][0] === "`" && f[2].includes("`"))) fence = f[1];
    else if (LINK_DEFINITION.test(line)) out.push(line);
  }
  return out;
}

// GitHub's (and VS Code's) heading scale: size in ems of the body text,
// whether a rule runs under it, and h6 dimmed.
export const HEADING = {
  1: { em: 2, rule: true },
  2: { em: 1.5, rule: true },
  3: { em: 1.25 },
  4: { em: 1 },
  5: { em: 0.875 },
  6: { em: 0.85, dim: true },
};
