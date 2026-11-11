// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One layout for every staff queue (overhaul wave 4, D7.5): a 384 px sunken list beside the open
 * item's detail card at lg and up; below lg the list shows alone, and an open item replaces it
 * with a Back button (the page keeps the item in its URL, so Back and a reload agree).
 *
 * Keyboard: j and k move between rows (the elements marked `data-queue-row`, usually each row's
 * open button, so Enter opens natively), `e` focuses the decision (`data-queue-decision` in the
 * detail), `?` lists the shortcuts in a Dialog. No single-key shortcut fires while a text field,
 * a select or a dialog has focus, or with a modifier held.
 */
import * as React from "react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@commonair/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@commonair/ui/components/dialog";
import { Kbd } from "@commonair/ui/components/kbd";
import { cn } from "@commonair/ui/lib/utils";

export interface QueueShortcut {
  keys: string[];
  label: string;
}
export interface QueueShortcutsCopy {
  title: string;
  description?: string;
  items: QueueShortcut[];
}
export interface QueueLayoutProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Names the list region ("Cases"). */
  listLabel: string;
  /** Names the detail region ("Case detail"). */
  detailLabel: string;
  /** Search and filter controls above the list. */
  filters?: React.ReactNode;
  /** The result count line ("12 results"), with any select-all control. */
  count?: React.ReactNode;
  list: React.ReactNode;
  /** The open item; null when nothing is open. */
  detail: React.ReactNode | null;
  /** In the detail pane at lg and up while nothing is open ("Pick a case to see it here"). */
  detailEmpty?: React.ReactNode;
  /** Below lg, the Back button over an open item calls this (usually clearing the selection). */
  onBack?: () => void;
  backLabel: string;
  /** The bulk bar's content while rows are selected (null or undefined hides it). */
  bulk?: React.ReactNode;
  bulkLabel?: string;
  /** The `?` dialog. Without it `?` does nothing. */
  shortcuts?: QueueShortcutsCopy;
  /** Turns the j/k/e/? shortcuts off (another queue on the page owns them). */
  keyboard?: boolean;
}

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]";
const focusable = (el: HTMLElement): boolean => el.matches(FOCUSABLE) && el.getAttribute("tabindex") !== "-1";
/** The decision itself when it is a control, else its first control. */
function firstFocusable(root: HTMLElement | null | undefined): HTMLElement | null {
  if (!root) return null;
  if (focusable(root)) return root;
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find(focusable) ?? null;
}

/** Whether a key press belongs to the element that has focus, not to the queue. */
export function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest("input, textarea, select, [role='textbox'], [role='combobox'], [role='listbox']")) return true;
  return target.closest("[role='dialog'], [role='alertdialog']") !== null;
}

function visibleRows(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  // A list hidden below lg (an item open) has no rows to move through.
  return [...root.querySelectorAll<HTMLElement>("[data-queue-row]")].filter(
    (el) => !el.hasAttribute("disabled") && (typeof el.checkVisibility !== "function" || el.checkVisibility()),
  );
}

/** The next row to focus for j (+1) or k (-1), from the row holding focus (or none). */
export function nextRowIndex(count: number, current: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + step));
}

export function QueueLayout({
  listLabel,
  detailLabel,
  filters,
  count,
  list,
  detail,
  detailEmpty,
  onBack,
  backLabel,
  bulk,
  bulkLabel,
  shortcuts,
  keyboard = true,
  className,
  ...props
}: QueueLayoutProps): React.JSX.Element {
  const listRef = React.useRef<HTMLElement>(null);
  const detailRef = React.useRef<HTMLElement>(null);
  const [help, setHelp] = React.useState(false);
  const open = detail !== null && detail !== undefined;
  const hasShortcuts = shortcuts !== undefined;

  React.useEffect(() => {
    if (!keyboard) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (ownsKeys(event.target)) return;
      if (event.key === "j" || event.key === "k") {
        const rows = visibleRows(listRef.current);
        const active = document.activeElement;
        const current = rows.findIndex((row) => row === active || (active !== null && row.contains(active)));
        const next = rows[nextRowIndex(rows.length, current, event.key === "j" ? 1 : -1)];
        if (!next) return;
        event.preventDefault();
        next.focus();
        next.scrollIntoView({ block: "nearest" });
      } else if (event.key === "e") {
        const target = firstFocusable(detailRef.current?.querySelector<HTMLElement>("[data-queue-decision]"));
        if (!target) return;
        event.preventDefault();
        target.focus();
      } else if (event.key === "?" && hasShortcuts) {
        event.preventDefault();
        setHelp(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keyboard, hasShortcuts]);

  return (
    <div
      data-slot="queue-layout"
      data-open={open ? "true" : "false"}
      className={cn("flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start", className)}
      {...props}
    >
      <section
        ref={listRef}
        aria-label={listLabel}
        data-slot="queue-list"
        className={cn(
          "min-w-0 flex-col gap-3 bg-surface-sunken p-3 ring-1 ring-border lg:flex lg:w-96 lg:shrink-0",
          open ? "hidden" : "flex",
        )}
      >
        {filters ? <div className="flex min-w-0 flex-col gap-2">{filters}</div> : null}
        {count ? (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
            {count}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-2">{list}</div>
        {bulk ? (
          <section
            aria-label={bulkLabel}
            data-slot="queue-bulk"
            className="sticky bottom-2 flex min-w-0 flex-wrap items-center gap-2 bg-surface-raised p-2 shadow-raised ring-1 ring-border"
          >
            {bulk}
          </section>
        ) : null}
      </section>
      <section
        ref={detailRef}
        aria-label={detailLabel}
        data-slot="queue-detail"
        className={cn(
          "min-w-0 flex-1 flex-col gap-4 lg:flex",
          open ? "flex bg-card p-4 text-card-foreground ring-1 ring-border" : "hidden",
        )}
      >
        {open ? (
          <>
            {onBack ? (
              <div className="lg:hidden">
                <Button variant="ghost" size="sm" onClick={onBack}>
                  <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} aria-hidden className="rtl:rotate-180" />
                  {backLabel}
                </Button>
              </div>
            ) : null}
            {detail}
          </>
        ) : (
          <div className="flex min-h-40 items-center justify-center p-6 text-center text-sm text-muted-foreground ring-1 ring-border">
            {detailEmpty}
          </div>
        )}
      </section>
      {shortcuts ? (
        <Dialog open={help} onOpenChange={setHelp}>
          <DialogContent data-slot="queue-shortcuts">
            <DialogHeader>
              <DialogTitle>{shortcuts.title}</DialogTitle>
              {shortcuts.description ? <DialogDescription>{shortcuts.description}</DialogDescription> : null}
            </DialogHeader>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              {shortcuts.items.map((item) => (
                <React.Fragment key={item.label}>
                  <dt className="flex flex-wrap gap-1">
                    {item.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </dt>
                  <dd>{item.label}</dd>
                </React.Fragment>
              ))}
            </dl>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
