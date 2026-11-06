// Markdown as React Native views: parsed with mdast-util-from-markdown (GitHub's flavour), as the web board's is, and
// drawn here, so there's no web view or HTML. Images aren't fetched; links open in the browser.
import type { Nodes, Parents, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { memo, type ReactNode } from "react";
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "./theme";

export function parseMarkdown(text: string): Root {
  try {
    return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  } catch {
    return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] };
  }
}

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/** The text of a node and its children, for the places that only take text. */
export function plainText(n: Nodes): string {
  if ("value" in n && typeof n.value === "string") return n.value;
  if ("children" in n) return (n.children as Nodes[]).map(plainText).join("");
  return "";
}

function inline(nodes: Nodes[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.type) {
      case "text":
        return n.value;
      case "strong":
        return (
          <Text key={k} style={s.strong}>
            {inline(n.children, k)}
          </Text>
        );
      case "emphasis":
        return (
          <Text key={k} style={s.em}>
            {inline(n.children, k)}
          </Text>
        );
      case "delete":
        return (
          <Text key={k} style={s.del}>
            {inline(n.children, k)}
          </Text>
        );
      case "inlineCode":
        return (
          <Text key={k} style={s.code}>
            {n.value}
          </Text>
        );
      case "break":
        return "\n";
      case "link":
        return (
          <Text key={k} style={s.link} onPress={() => /^https?:|^mailto:/i.test(n.url) && Linking.openURL(n.url)}>
            {inline(n.children, k)}
          </Text>
        );
      case "image":
        return `[${n.alt || "image"}]`;
      case "html":
        return n.value;
      default:
        return "children" in n ? inline(n.children as Nodes[], k) : null;
    }
  });
}

function block(n: Nodes, key: string, depth = 0): ReactNode {
  switch (n.type) {
    case "paragraph":
      return (
        <Text key={key} style={s.p}>
          {inline(n.children, key)}
        </Text>
      );
    case "heading":
      return (
        <Text key={key} style={[s.p, s.h, n.depth <= 2 && s.h1]}>
          {inline(n.children, key)}
        </Text>
      );
    case "code":
      return (
        <ScrollView key={key} horizontal style={s.pre} contentContainerStyle={s.preInner}>
          <Text style={s.preText}>{n.value}</Text>
        </ScrollView>
      );
    case "blockquote":
      return (
        <View key={key} style={s.quote}>
          {blocks(n, key, depth)}
        </View>
      );
    case "list":
      return (
        <View key={key} style={s.list}>
          {n.children.map((item, i) => (
            <View key={`${key}.${i}`} style={s.item}>
              <Text style={s.bullet}>{item.checked != null ? (item.checked ? "☑" : "☐") : n.ordered ? `${(n.start ?? 1) + i}.` : "•"}</Text>
              <View style={s.itemBody}>{blocks(item, `${key}.${i}`, depth + 1)}</View>
            </View>
          ))}
        </View>
      );
    case "thematicBreak":
      return <View key={key} style={s.hr} />;
    case "table":
      return (
        <ScrollView key={key} horizontal style={s.table}>
          <View>
            {n.children.map((row, r) => (
              <View key={r} style={[s.row, r === 0 && s.headRow]}>
                {row.children.map((cell, c) => (
                  <Text key={c} style={[s.cell, r === 0 && s.strong]}>
                    {inline(cell.children, `${key}.${r}.${c}`)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "html":
      return (
        <Text key={key} style={s.p}>
          {n.value}
        </Text>
      );
    default:
      return "children" in n ? <View key={key}>{blocks(n as Parents, key, depth)}</View> : null;
  }
}

function blocks(parent: Parents, key: string, depth: number): ReactNode[] {
  return (parent.children as Nodes[]).map((c, i) => block(c, `${key}.${i}`, depth));
}

/** Markdown text, drawn. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <View style={s.root}>{blocks(parseMarkdown(text), "md", 0)}</View>;
});

const s = StyleSheet.create({
  root: { gap: 6 },
  p: { color: colors.fg, fontSize: 15, lineHeight: 21 },
  h: { fontWeight: "700", marginTop: 4 },
  h1: { fontSize: 17 },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  code: { fontFamily: mono, fontSize: 13, backgroundColor: colors.raised, color: "#e5c07b" },
  link: { color: colors.accent, textDecorationLine: "underline" },
  pre: { backgroundColor: colors.raised, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  preInner: { padding: 8 },
  preText: { fontFamily: mono, fontSize: 12.5, color: colors.fg },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.line, paddingLeft: 10, gap: 6 },
  list: { gap: 4 },
  item: { flexDirection: "row", gap: 6 },
  bullet: { color: colors.muted, fontSize: 15, lineHeight: 21, minWidth: 14 },
  itemBody: { flex: 1, gap: 4 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: 6 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 4 },
  row: { flexDirection: "row" },
  headRow: { backgroundColor: colors.raised },
  cell: { color: colors.fg, fontSize: 13, padding: 6, minWidth: 80, maxWidth: 220, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
});
