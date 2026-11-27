import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown.js";
import { highlightDiffCode, languageForPath } from "./review-diff.js";
import { AttachmentLightbox, type LightboxImage } from "./attachments.js";
import { cn } from "./lib/utils";
import type { Card, Status } from "./model.js";

/** Lets a card id in rendered text become a chip that summarises and opens that card. */
export const CardLinks = createContext<{
  open: (id: string) => void;
  /** The card's title and status when it is known here. */
  card: (id: string) => Pick<Card, "title" | "status"> | undefined;
  /** The card's own URL, so the chip also works as a link (new tab, copy link). */
  href?: (id: string) => string;
} | null>(null);

const statusDot: Record<Status, string> = {
  triage: "bg-muted-foreground/60",
  ready: "bg-status-ready",
  running: "bg-status-running",
  review: "bg-status-review",
  failed: "bg-status-failed",
  interrupted: "bg-status-interrupted",
  done: "bg-status-done",
  archived: "bg-muted-foreground/40",
};
const statusName = (status: Status) =>
  status === "done" || status === "archived" ? "finished" : status;

const cardId =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** A short, clickable stand-in for a card's full id. */
export function CardChip({ id }: { id: string }) {
  const links = useContext(CardLinks);
  const short = id.slice(0, 8);
  const card = links?.card(id);
  const className =
    "mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-muted px-1.5 py-px align-baseline text-[0.85em] text-foreground/80 no-underline";
  if (!links)
    return (
      <code className={cn(className, "font-mono")} title={id}>
        {short}
      </code>
    );
  const label = card ? `${card.title} (${statusName(card.status)}, ${id})` : id;
  const content = card ? (
    <>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", statusDot[card.status])}
      />
      <span className="min-w-0 max-w-[28ch] truncate">{card.title}</span>
      <span className="shrink-0 font-mono text-muted-foreground">{short}</span>
    </>
  ) : (
    <span className="font-mono">{short}</span>
  );
  const interactive = cn(
    className,
    "cursor-pointer hover:border-primary hover:text-primary",
  );
  const href = links.href?.(id);
  if (href)
    return (
      <a
        href={href}
        title={label}
        data-card-chip={id}
        className={interactive}
        onClick={(event) => {
          // Modified clicks keep the browser's own handling (new tab, new window).
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          links.open(id);
        }}
      >
        {content}
      </a>
    );
  return (
    <button
      type="button"
      title={label}
      data-card-chip={id}
      className={interactive}
      onClick={() => links.open(id)}
    >
      {content}
    </button>
  );
}

function withCardChips(text: string, key: number): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(cardId)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<CardChip key={`${key}-${match.index}`} id={match[0]} />);
    last = match.index + match[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** What a report's images share: the carousel they open in, and a way to drop one that cannot load. */
const MarkdownImages = createContext<{
  open: (src: string) => void;
  failed: (src: string) => void;
} | null>(null);

/** A stored image shown inline; a click opens it in the lightbox. If the file cannot load, a plain link to it takes its place. */
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const images = useContext(MarkdownImages);
  const name = alt || "image";
  if (failed)
    return (
      <a href={src} target="_blank" rel="noreferrer">
        {name} (image unavailable)
      </a>
    );
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        // Modified clicks keep the browser's own handling (new tab, new window).
        if (
          !images ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        images.open(src);
      }}
    >
      <img
        src={src}
        alt={name}
        loading="lazy"
        onError={() => {
          setFailed(true);
          images?.failed(src);
        }}
        className="my-3 max-h-[36rem] max-w-full rounded border border-border object-contain"
      />
    </a>
  );
}

function inlineImages(nodes: Inline[], out: LightboxImage[]) {
  for (const node of nodes) {
    if (node.type === "image") {
      if (!out.some((image) => image.url === node.src))
        out.push({ id: node.src, url: node.src, name: node.alt || "image" });
    } else if (
      node.type === "strong" ||
      node.type === "em" ||
      node.type === "del" ||
      node.type === "link"
    )
      inlineImages(node.children, out);
  }
}

/** Every distinct image in the document, in reading order. */
function blockImages(blocks: Block[], out: LightboxImage[] = []) {
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        inlineImages(block.children, out);
        break;
      case "quote":
        blockImages(block.children, out);
        break;
      case "table":
        for (const cell of [...block.header, ...block.rows.flat()])
          inlineImages(cell, out);
        break;
      case "list":
        for (const item of block.items) blockImages(item.children, out);
        break;
    }
  }
  return out;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return withCardChips(node.text, index);
      case "break":
        return <br key={index} />;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "del":
        return <del key={index}>{renderInline(node.children)}</del>;
      case "image":
        return <MarkdownImage key={index} src={node.src} alt={node.alt} />;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  // Reuse the review diff highlighter; it escapes code for unknown languages.
  const path = `snippet.${lang}`;
  return (
    <pre data-language={lang || undefined}>
      {lang && languageForPath(path) ? (
        <code
          dangerouslySetInnerHTML={{ __html: highlightDiffCode(text, path) }}
        />
      ) : (
        <code>{text}</code>
      )}
    </pre>
  );
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "heading": {
        const Heading = `h${block.level}` as "h1";
        return <Heading key={index}>{renderInline(block.children)}</Heading>;
      }
      case "paragraph":
        return <p key={index}>{renderInline(block.children)}</p>;
      case "code":
        return <CodeBlock key={index} lang={block.lang} text={block.text} />;
      case "quote":
        return (
          <blockquote key={index}>{renderBlocks(block.children)}</blockquote>
        );
      case "rule":
        return <hr key={index} />;
      case "table": {
        const cell = (children: Inline[], column: number, header: boolean) => {
          const Cell = header ? "th" : "td";
          return (
            <Cell
              key={column}
              style={{ textAlign: block.align[column] ?? undefined }}
            >
              {renderInline(children)}
            </Cell>
          );
        };
        return (
          <div key={index} className="markdown-table">
            <table>
              <thead>
                <tr>{block.header.map((c, i) => cell(c, i, true))}</tr>
              </thead>
              {block.rows.length > 0 && (
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>{row.map((c, i) => cell(c, i, false))}</tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        );
      }
      case "list": {
        const items = block.items.map((item, itemIndex) => (
          <li
            key={itemIndex}
            data-task={item.checked === undefined ? undefined : ""}
          >
            {item.checked !== undefined && (
              <input
                type="checkbox"
                checked={item.checked}
                disabled
                aria-label={item.checked ? "Completed" : "Not completed"}
              />
            )}
            {renderBlocks(item.children)}
          </li>
        ));
        return block.ordered ? (
          <ol key={index} start={block.start === 1 ? undefined : block.start}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      }
    }
  });
}

/** Renders a card description written in markdown. Raw HTML is shown as text. */
export function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const [broken, setBroken] = useState<string[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  // Images that failed to load are links now, so they stay out of the carousel.
  const images = useMemo(
    () => blockImages(blocks).filter((image) => !broken.includes(image.id)),
    [blocks, broken],
  );
  const shown = images.findIndex((image) => image.id === viewing);
  const controls = useMemo(
    () => ({
      open: setViewing,
      failed: (src: string) => setBroken((list) => [...list, src]),
    }),
    [],
  );
  return (
    <div className={cn("markdown", className)}>
      <MarkdownImages.Provider value={controls}>
        {renderBlocks(blocks)}
      </MarkdownImages.Provider>
      <AttachmentLightbox
        boardId=""
        images={images}
        index={shown < 0 ? null : shown}
        onIndexChange={(index) => setViewing(images[index]?.id ?? null)}
        onClose={() => setViewing(null)}
      />
    </div>
  );
}
