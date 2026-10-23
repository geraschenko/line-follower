export type Line = Readonly<{
  text: string;
  /** 1-based; counts every line. */
  lineNumber: number;
  /** Offset from the first byte pushed. */
  byteOffset: number;
  /** Bytes from byteOffset through the terminating "\n" inclusive. */
  byteLength: number;
}>;

const NEWLINE = "\n".charCodeAt(0);

/** Splits on raw "\n" bytes and holds the torn suffix (an unfinished last
 *  line) until its
 *  newline arrives. Delivers every line, blank ones included. `text` is
 *  exactly the bytes before the "\n", including any "\r". Splitting before
 *  decoding keeps a UTF-8 code point split across chunks intact. Each push
 *  scans only its own chunk and a torn line is joined once, when its newline
 *  arrives, so a line torn across many pushes costs time linear in its
 *  length. */
export class LineReader {
  /** The torn suffix, one piece per push that extended it. */
  private tornPieces: Buffer[] = [];
  private tornLength = 0;
  private lineNumber = 0;
  private bytesPushed = 0;

  push(chunk: Buffer): Line[] {
    const chunkByteOffset = this.bytesPushed;
    this.bytesPushed += chunk.length;
    const lines: Line[] = [];
    let lineStart = 0;
    for (
      let lineEnd = chunk.indexOf(NEWLINE);
      lineEnd !== -1;
      lineEnd = chunk.indexOf(NEWLINE, lineStart)
    ) {
      // Only the chunk's first line can continue the torn suffix.
      const tornLength = this.tornLength;
      const text =
        tornLength === 0
          ? chunk.toString("utf8", lineStart, lineEnd)
          : Buffer.concat([
              ...this.tornPieces,
              chunk.subarray(0, lineEnd),
            ]).toString("utf8");
      this.tornPieces = [];
      this.tornLength = 0;
      this.lineNumber += 1;
      lines.push({
        text,
        lineNumber: this.lineNumber,
        byteOffset: chunkByteOffset + lineStart - tornLength,
        byteLength: lineEnd + 1 - lineStart + tornLength,
      });
      lineStart = lineEnd + 1;
    }
    if (lineStart < chunk.length) {
      // Copied, not a subarray view: a view would pin the (possibly large)
      // chunk for as long as the line stays torn, and the caller may reuse
      // the chunk's memory.
      const piece = Buffer.from(chunk.subarray(lineStart));
      this.tornPieces.push(piece);
      this.tornLength += piece.length;
    }
    return lines;
  }
}
