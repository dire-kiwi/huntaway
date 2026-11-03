//! The assistant's Markdown as Telegram's HTML (its `parse_mode: "HTML"`, which is easier to get
//! right than MarkdownV2's escaping), in messages short enough to send.
//!
//! Telegram takes a few tags (b, i, s, code, pre, a, blockquote) and refuses a message whose tags
//! don't balance, so every tag here is opened and closed in one place, and anything that doesn't
//! close on its line (a lone `*`) stays as it was typed. A message it still refuses is sent as
//! plain text (see telegram.rs).

/// The longest message Telegram takes, in characters (after its markup is taken out).
pub const MAX_CHARS: usize = 4096;

/// How long a piece of a long reply is, at most, in characters of Markdown: the HTML's text is no
/// longer than that, so it fits with room to spare.
pub const PIECE_CHARS: usize = 3800;

/// Text as it goes between Telegram's HTML tags.
pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `text` cut to `max` characters, with an ellipsis if it was longer.
pub fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max.saturating_sub(1)).collect::<String>())
}

/// Splits Markdown into pieces of at most `max` characters, at blank lines where it can, else at
/// line ends, else anywhere. A code block that's split is closed at the end of one piece and opened
/// again at the start of the next, so each piece reads on its own.
pub fn split(md: &str, max: usize) -> Vec<String> {
    let md = md.trim_end();
    if md.chars().count() <= max {
        return if md.trim().is_empty() { vec![] } else { vec![md.to_string()] };
    }
    let mut pieces = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0;
    // The fence of the code block the current line is in, if any (its opening line).
    let mut fence: Option<String> = None;
    let close = |cur: &mut String, fence: &Option<String>| {
        if fence.is_some() {
            cur.push_str("\n```");
        }
    };
    // Lines are long at most `max - 8` (room for the fences a piece may gain): longer ones are cut.
    let room = max.saturating_sub(8).max(1);
    let lines = md.split('\n').flat_map(|l| {
        let chars: Vec<char> = l.chars().collect();
        if chars.len() <= room { vec![l.to_string()] } else { chars.chunks(room).map(|c| c.iter().collect()).collect() }
    });
    for line in lines {
        let len = line.chars().count() + 1;
        let reopen = fence.as_ref().map_or(0, |f| f.chars().count() + 1);
        if cur_len + len + 4 > max && !cur.is_empty() {
            // Back to the last blank line outside a code block, if there's one in the second half.
            let cut_at = if fence.is_none() { cur.rfind("\n\n").filter(|&i| i > cur.len() / 2) } else { None };
            match cut_at {
                Some(i) => {
                    let rest = cur[i + 2..].to_string();
                    cur.truncate(i);
                    pieces.push(std::mem::take(&mut cur));
                    cur_len = rest.chars().count();
                    cur = rest;
                    if cur_len + len + 4 > max {
                        pieces.push(std::mem::take(&mut cur));
                        cur_len = 0;
                    }
                }
                None => {
                    close(&mut cur, &fence);
                    pieces.push(std::mem::take(&mut cur));
                    cur_len = 0;
                    if let Some(f) = &fence {
                        cur.push_str(f);
                        cur_len = reopen;
                    }
                }
            }
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(&line);
        cur_len += len;
        if line.trim_start().starts_with("```") {
            fence = if fence.is_some() { None } else { Some(line.trim().to_string()) };
        }
    }
    if !cur.trim().is_empty() {
        pieces.push(cur);
    }
    pieces.into_iter().map(|p| p.trim_matches('\n').to_string()).filter(|p| !p.trim().is_empty()).collect()
}

/// Markdown as Telegram's HTML: headings in bold, lists with bullets, quotes, code blocks, tables
/// as preformatted text, and inline bold, italics, strikethrough, code and links.
pub fn to_html(md: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let lines: Vec<&str> = md.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        if let Some(info) = trimmed.strip_prefix("```") {
            let lang: String = info.trim().chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+')).collect();
            let mut body = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                body.push(lines[i]);
                i += 1;
            }
            i += 1;
            let code = escape(&body.join("\n"));
            out.push(if lang.is_empty() { format!("<pre>{code}</pre>") } else { format!("<pre><code class=\"language-{lang}\">{code}</code></pre>") });
            continue;
        }
        if trimmed.starts_with('|') {
            let mut table = Vec::new();
            while i < lines.len() && lines[i].trim_start().starts_with('|') {
                // The line under the header (|---|---|) says nothing in plain text.
                let row = lines[i].trim();
                if !row.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
                    table.push(row);
                }
                i += 1;
            }
            out.push(format!("<pre>{}</pre>", escape(&table.join("\n"))));
            continue;
        }
        if trimmed.starts_with('>') {
            let mut quote = Vec::new();
            while i < lines.len() && lines[i].trim_start().starts_with('>') {
                let l = lines[i].trim_start().trim_start_matches('>');
                quote.push(inline(l.strip_prefix(' ').unwrap_or(l)));
                i += 1;
            }
            out.push(format!("<blockquote>{}</blockquote>", quote.join("\n")));
            continue;
        }
        out.push(block_line(line));
        i += 1;
    }
    out.join("\n")
}

/// One line outside code blocks, tables and quotes.
fn block_line(line: &str) -> String {
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    let hashes = trimmed.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
        return format!("<b>{}</b>", inline(trimmed[hashes..].trim()));
    }
    if trimmed.len() >= 3 && (trimmed.chars().all(|c| c == '-') || trimmed.chars().all(|c| c == '*') || trimmed.chars().all(|c| c == '_')) {
        return "──────────".into();
    }
    for bullet in ["- ", "* ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(bullet) {
            let item = match rest.strip_prefix("[ ] ").map(|r| ("☐ ", r)).or_else(|| rest.strip_prefix("[x] ").map(|r| ("☑ ", r))) {
                Some((box_, r)) => format!("{box_}{}", inline(r)),
                None => format!("• {}", inline(rest)),
            };
            return format!("{}{item}", escape(indent));
        }
    }
    format!("{}{}", escape(indent), inline(trimmed))
}

/// Inline Markdown in one line: `code`, **bold**, __bold__, *italics*, _italics_, ~~struck~~ and
/// [links](https://…). A delimiter with no partner on the line is kept as text.
pub fn inline(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let at = |i: usize, pat: &str| pat.chars().enumerate().all(|(k, c)| chars.get(i + k) == Some(&c));
    let find = |from: usize, pat: &str| (from..chars.len()).find(|&j| at(j, pat));
    let text = |a: usize, b: usize| chars[a..b].iter().collect::<String>();
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && chars.get(i + 1).is_some_and(|n| "\\`*_~[]()#>-+!|".contains(*n)) {
            out.push_str(&escape(&chars[i + 1].to_string()));
            i += 2;
            continue;
        }
        if c == '`' {
            // As many backticks close it as opened it.
            let n = chars[i..].iter().take_while(|&&c| c == '`').count();
            let fence: String = "`".repeat(n);
            if let Some(j) = find(i + n, &fence).filter(|&j| j > i + n) {
                out.push_str(&format!("<code>{}</code>", escape(text(i + n, j).trim())));
                i = j + n;
                continue;
            }
            out.push_str(&fence);
            i += n;
            continue;
        }
        if c == '[' {
            if let Some(close) = find(i + 1, "](") {
                if let Some(end) = find(close + 2, ")") {
                    let url = text(close + 2, end);
                    let url = url.trim();
                    if (url.starts_with("https://") || url.starts_with("http://")) && !url.contains(char::is_whitespace) {
                        out.push_str(&format!("<a href=\"{}\">{}</a>", escape(url).replace('"', "&quot;"), inline(&text(i + 1, close))));
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        let pairs: [(&str, &str); 5] = [("**", "b"), ("__", "b"), ("~~", "s"), ("*", "i"), ("_", "i")];
        let mut matched = false;
        for (delim, tag) in pairs {
            if !at(i, delim) {
                continue;
            }
            let n = delim.chars().count();
            // Not where it's part of a word (snake_case) or followed by a space (a list's "* ").
            let after = chars.get(i + n);
            if after.is_none_or(|a| a.is_whitespace()) || (delim.starts_with('_') && i > 0 && chars[i - 1].is_alphanumeric()) {
                continue;
            }
            let Some(j) = find(i + n, delim) else { continue };
            if j == i + n || chars[j - 1].is_whitespace() || (delim.starts_with('_') && chars.get(j + n).is_some_and(|c| c.is_alphanumeric())) {
                continue;
            }
            out.push_str(&format!("<{tag}>{}</{tag}>", inline(&text(i + n, j))));
            i = j + n;
            matched = true;
            break;
        }
        if matched {
            continue;
        }
        out.push_str(&escape(&c.to_string()));
        i += 1;
    }
    out
}
