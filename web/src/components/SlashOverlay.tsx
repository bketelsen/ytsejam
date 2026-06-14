import type { RankedSkill } from "./useSlashMenu";

export interface SlashOverlayProps {
  items: RankedSkill[];
  activeIndex: number;
  onSelect: (name: string) => void;
  onActiveChange: (index: number) => void;
}

/**
 * Positioned listbox shown above the composer when the user is typing a
 * slash command. Stateless and presentational — useSlashMenu owns the
 * filtering/ranking, Chat owns the open state and keyboard wiring.
 *
 * mouseDown (not click) is used for selection so the textarea doesn't lose
 * focus between mousedown and click — the textarea blur path would close
 * the menu before click fires.
 */
export function SlashOverlay({
  items,
  activeIndex,
  onSelect,
  onActiveChange,
}: SlashOverlayProps) {
  if (items.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="pointer-events-auto absolute bottom-full left-0 right-0 z-20 mb-2 max-h-48 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    >
      {items.map((item, i) => {
        const active = i === activeIndex;
        return (
          <div
            key={item.skill.name}
            role="option"
            aria-selected={active}
            data-active={active}
            className={`flex cursor-pointer items-baseline gap-2 px-3 py-2 text-sm ${
              active ? "bg-accent" : ""
            }`}
            onMouseDown={(e) => {
              // mousedown not click: see comment above. preventDefault keeps
              // focus on the textarea so Enter/Esc still target it.
              e.preventDefault();
              onSelect(item.skill.name);
            }}
            onMouseEnter={() => onActiveChange(i)}
          >
            <span className="font-medium">{item.skill.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.skill.description}
            </span>
            {item.reason === "trigger" && item.matchedTrigger && (
              <span className="shrink-0 text-xs text-muted-foreground">
                match: {item.matchedTrigger}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
