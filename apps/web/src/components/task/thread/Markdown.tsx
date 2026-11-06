import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// An image is a link to it rather than loaded: an agent's `![](https://…/?k=<secret>)` would send the secret out as
// soon as the text was shown, with nothing to approve (the phone doesn't load them either).
const imageLink = ({ src, alt }: { src?: unknown; alt?: string }) => {
  const href = typeof src === "string" ? src : undefined;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {alt || href}
    </a>
  );
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ ...p }) => <a {...p} target="_blank" rel="noreferrer" />, img: imageLink }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
