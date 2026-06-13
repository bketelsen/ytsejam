/**
 * Turn chunking: one episodic record per turn, except long turns which split
 * on paragraph (then sentence) boundaries so each record stays under the
 * configured ceiling and embeds coherently.
 */

export function chunkText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed ? [trimmed] : [];

  const paragraphs = trimmed.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    const units = para.length > maxChars ? splitSentences(para, maxChars) : [para];
    for (const unit of units) {
      if (current.length + unit.length + 2 > maxChars) flush();
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  flush();
  return chunks;
}

function splitSentences(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current.length + s.length > maxChars && current) {
      out.push(current.trim());
      current = "";
    }
    // A single sentence longer than maxChars gets hard-split.
    if (s.length > maxChars) {
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars).trim());
    } else {
      current += s;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
