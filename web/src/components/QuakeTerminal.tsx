import { useEffect, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { connectTerminalWs } from "@/lib/terminal-ws";

export function QuakeTerminal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !containerElement) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      convertEol: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerElement);

    const ws = connectTerminalWs({
      onOutput: (data) => terminal.write(data),
      onExit: (code) => {
        terminal.options.disableStdin = true;
        terminal.write(`\r\n[process exited${code === undefined ? "" : ` with code ${code}`}]\r\n`);
      },
      onClose: () => {
        terminal.options.disableStdin = true;
      },
    });

    const fitAndResize = () => {
      try {
        fitAddon.fit();
        ws.send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
      } catch {
        // xterm can throw while the Sheet is measuring during mount/unmount.
      }
    };
    let resizeFrame: number | undefined;
    const scheduleFitAndResize = () => {
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        fitAndResize();
      });
    };

    const dataDisposable = terminal.onData((data) => ws.send({ type: "input", data }));
    const resizeDisposable = terminal.onResize(({ cols, rows }) => ws.send({ type: "resize", cols, rows }));
    const observer = new ResizeObserver(scheduleFitAndResize);
    observer.observe(containerElement);
    window.addEventListener("resize", scheduleFitAndResize);
    const frame = requestAnimationFrame(() => {
      fitAndResize();
      terminal.focus();
    });

    return () => {
      cancelAnimationFrame(frame);
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      window.removeEventListener("resize", scheduleFitAndResize);
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      ws.close();
      terminal.dispose();
    };
  }, [containerElement, open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="top"
        className="h-[min(70dvh,42rem)] gap-0 overflow-hidden border-border bg-background p-0 text-foreground"
      >
        <SheetTitle className="sr-only">Terminal</SheetTitle>
        <SheetDescription className="sr-only">Interactive server shell</SheetDescription>
        <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3 pt-12">
          <div ref={setContainerElement} className="h-full min-h-0 overflow-hidden" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
