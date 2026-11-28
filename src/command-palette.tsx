import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./dialog.js";
import { cn } from "./lib/utils";
import { searchRank } from "./model.js";

/** The modifier for Cmd+K and friends: ⌘ on Apple platforms, Ctrl elsewhere. */
export const modKey =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘"
    : "Ctrl";

/** One row. It either runs something or opens a page of further rows (a board list, a theme list). */
export type PaletteItem = {
  id: string;
  label: string;
  /** Muted text after the label, such as a card's lane or the card a command acts on. */
  detail?: string;
  /** The shortcut that does the same outside the palette, one entry per key. */
  keys?: string[];
  icon?: LucideIcon;
  /** Words the search matches besides the label. */
  keywords?: string;
  /** Marks the board or theme in use on a picker page. */
  current?: boolean;
} & (
  | { run: () => void; page?: undefined }
  | { page: PalettePage; run?: undefined }
);
export type PalettePage = { placeholder: string; items: PaletteItem[] };
/** The first page's groups. Cards show only once something is typed, so the empty palette lists commands. */
export type PaletteGroup = {
  heading: string;
  items: PaletteItem[];
  whenSearching?: boolean;
};

const MAX_CARDS = 50;

export function CommandPalette({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: PaletteGroup[];
}) {
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<(PalettePage & { title: string })[]>([]);
  const [active, setActive] = useState(0);
  // The chosen row's action waits until the palette has finished closing, so a dialog it opens never overlaps the
  // palette: two modal layers at once lose Escape presses and fight over focus.
  const [pending, setPending] = useState<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Each opening starts on an empty first page.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setPages([]);
      setActive(0);
      setPending(null);
    }
  }
  const page = pages.at(-1);
  const shown = useMemo(() => {
    if (page) return [{ heading: "", items: searchRank(page.items, query) }];
    return groups
      .filter((group) => !group.whenSearching || query.trim())
      .map((group) => ({
        heading: group.heading,
        items: searchRank(group.items, query).slice(
          0,
          group.whenSearching ? MAX_CARDS : undefined,
        ),
      }))
      .filter((group) => group.items.length);
  }, [groups, page, query]);
  const rows = shown.flatMap((group) => group.items);
  const current = Math.min(active, rows.length - 1);
  useEffect(() => {
    listRef.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, [current, shown]);
  const choose = (item: PaletteItem) => {
    if (item.page) {
      setPages((stack) => [...stack, { ...item.page!, title: item.label }]);
      setQuery("");
      setActive(
        Math.max(
          0,
          item.page.items.findIndex((row) => row.current),
        ),
      );
      return;
    }
    setPending(() => item.run);
    onOpenChange(false);
  };
  const back = () => {
    setPages((stack) => stack.slice(0, -1));
    setQuery("");
    setActive(0);
  };
  const optionId = (item: PaletteItem) => `palette-${item.id}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="Command palette"
        aria-describedby={undefined}
        showClose={false}
        // Sits high, like Spotlight, so the list grows down without moving the field.
        className="top-[14vh] right-0 left-0 mx-auto flex max-h-[min(70vh,520px)] w-[min(92vw,560px)] translate-0 flex-col overflow-hidden p-0 text-[13px]"
        onEscapeKeyDown={(event) => {
          if (!pages.length) return;
          event.preventDefault();
          back();
        }}
        // Runs after the exit animation; focus returns first, then a dialog the action opens takes it.
        onCloseAutoFocus={() => {
          setPending(null);
          pending?.();
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          {page ? (
            <button
              type="button"
              onClick={back}
              className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {page.title.replace(/…$/, "")}
            </button>
          ) : (
            <Search
              size={15}
              aria-hidden="true"
              className="shrink-0 text-muted-foreground"
            />
          )}
          <input
            data-palette-input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={
              rows[current] ? optionId(rows[current]) : undefined
            }
            aria-label={page?.placeholder ?? "Search cards and commands"}
            placeholder={page?.placeholder ?? "Search cards and commands"}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              const step =
                event.key === "ArrowDown" ||
                (event.ctrlKey && event.key === "n")
                  ? 1
                  : event.key === "ArrowUp" ||
                      (event.ctrlKey && event.key === "p")
                    ? -1
                    : 0;
              if (step && rows.length) {
                event.preventDefault();
                setActive((current + step + rows.length) % rows.length);
              } else if (event.key === "Enter" && rows[current]) {
                event.preventDefault();
                choose(rows[current]);
              } else if (event.key === "Backspace" && !query && pages.length) {
                event.preventDefault();
                back();
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div
          ref={listRef}
          id="palette-list"
          role="listbox"
          aria-label={page?.title ?? "Results"}
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {rows.length === 0 && (
            <p className="px-2.5 py-2 text-muted-foreground">No matches.</p>
          )}
          {shown.map((group) => (
            <div
              key={group.heading}
              role="group"
              aria-label={group.heading || undefined}
            >
              {group.heading && (
                <div className="px-2.5 pt-2 pb-1 text-[11px] text-muted-foreground">
                  {group.heading}
                </div>
              )}
              {group.items.map((item) => {
                const index = rows.indexOf(item);
                const Icon = item.icon;
                return (
                  <div
                    key={item.id}
                    id={optionId(item)}
                    role="option"
                    aria-selected={index === current}
                    data-active={index === current || undefined}
                    onPointerMove={() => index !== current && setActive(index)}
                    onClick={() => choose(item)}
                    className={cn(
                      "group flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5",
                      index === current && "bg-accent text-accent-foreground",
                    )}
                  >
                    {Icon && (
                      <Icon
                        size={14}
                        aria-hidden="true"
                        className="shrink-0 text-muted-foreground group-data-active:text-accent-foreground/80"
                      />
                    )}
                    <span className="truncate">{item.label}</span>
                    {item.detail && (
                      <span className="min-w-0 truncate text-muted-foreground group-data-active:text-accent-foreground/80">
                        {item.detail}
                      </span>
                    )}
                    {item.current && (
                      <span className="shrink-0 text-[11px] text-muted-foreground group-data-active:text-accent-foreground/80">
                        Current
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      {item.keys?.map((key) => (
                        <kbd
                          key={key}
                          className="rounded border border-border px-1 font-mono text-[11px] text-muted-foreground group-data-active:text-accent-foreground/80"
                        >
                          {key}
                        </kbd>
                      ))}
                      {item.page && (
                        <ChevronRight
                          size={14}
                          aria-hidden="true"
                          className="text-muted-foreground group-data-active:text-accent-foreground/80"
                        />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
