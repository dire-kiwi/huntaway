import type { Nodes, Parents, Root, RootContent } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { gfm } from "micromark-extension-gfm"
import { memo, type ReactNode } from "react"
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native"
import { colors } from "../theme"

// Markdown as React Native views (the old app's markdown.tsx): parsed with mdast-util-from-markdown (GitHub's flavour),
// as the web board's is, and drawn here, so there is no web view or HTML. Images aren't fetched; links open the browser.

export function parseMarkdown(text: string): Root {
  try {
    return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  } catch {
    return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] }
  }
}

const mono = Platform.select({ ios: "Menlo", default: "monospace" })

const childrenOf = (n: Nodes): ReadonlyArray<RootContent> => ("children" in n ? n.children : [])

const openLink = (url: string): void => {
  if (/^https?:|^mailto:/i.test(url)) void Linking.openURL(url)
}

function inline(nodes: ReadonlyArray<Nodes>, key: string): Array<ReactNode> {
  return nodes.map((n, i) => inlineNode(n, `${key}${i}`))
}

function inlineNode(n: Nodes, k: string): ReactNode {
  if (n.type === "text" || n.type === "html") return n.value
  if (n.type === "break") return "\n"
  if (n.type === "image") return `[${n.alt ?? "image"}]`
  if (n.type === "inlineCode")
    return (
      <Text key={k} style={st.code}>
        {n.value}
      </Text>
    )
  if (n.type === "link")
    return (
      <Text key={k} style={st.link} onPress={() => openLink(n.url)}>
        {inline(n.children, k)}
      </Text>
    )
  const style = n.type === "strong" ? st.strong : n.type === "emphasis" ? st.em : n.type === "delete" ? st.del : undefined
  return style === undefined ? (
    inline(childrenOf(n), k)
  ) : (
    <Text key={k} style={style}>
      {inline(childrenOf(n), k)}
    </Text>
  )
}

function block(n: Nodes, key: string): ReactNode {
  if (n.type === "paragraph" || n.type === "html")
    return (
      <Text key={key} style={st.p}>
        {n.type === "html" ? n.value : inline(n.children, key)}
      </Text>
    )
  if (n.type === "heading")
    return (
      <Text key={key} style={[st.p, st.h, n.depth <= 2 && st.h1]}>
        {inline(n.children, key)}
      </Text>
    )
  if (n.type === "code")
    return (
      <ScrollView key={key} horizontal style={st.pre} contentContainerStyle={st.preInner}>
        <Text style={st.preText}>{n.value}</Text>
      </ScrollView>
    )
  if (n.type === "blockquote")
    return (
      <View key={key} style={st.quote}>
        {blocks(n, key)}
      </View>
    )
  if (n.type === "list")
    return (
      <View key={key} style={st.list}>
        {n.children.map((item, i) => (
          <View key={`${key}.${i}`} style={st.item}>
            <Text style={st.bullet}>{bulletOf(item.checked, n.ordered === true ? (n.start ?? 1) + i : null)}</Text>
            <View style={st.itemBody}>{blocks(item, `${key}.${i}`)}</View>
          </View>
        ))}
      </View>
    )
  if (n.type === "thematicBreak") return <View key={key} style={st.hr} />
  if (n.type === "table")
    return (
      <ScrollView key={key} horizontal style={st.table}>
        <View>
          {n.children.map((row, r) => (
            <View key={r} style={[st.row, r === 0 && st.headRow]}>
              {row.children.map((cell, c) => (
                <Text key={c} style={[st.cell, r === 0 && st.strong]}>
                  {inline(cell.children, `${key}.${r}.${c}`)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    )
  return "children" in n ? <View key={key}>{blocks(n, key)}</View> : null
}

/** A list item's marker: its checkbox, its number, or a bullet. */
const bulletOf = (checked: boolean | null | undefined, n: number | null): string => {
  if (checked === true) return "☑"
  if (checked === false) return "☐"
  return n === null ? "•" : `${n}.`
}

function blocks(parent: Parents, key: string): Array<ReactNode> {
  return parent.children.map((c, i) => block(c, `${key}.${i}`))
}

/** Markdown text, drawn. */
export const Markdown = memo(function Markdown({ text }: { readonly text: string }) {
  return <View style={st.root}>{blocks(parseMarkdown(text), "md")}</View>
})

const st = StyleSheet.create({
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
})
