/**
 * CPU code window: parses the objdump-generated .dis file from the firmware build
 * and maps PC values to listing lines, so the emulator's live PC highlights the
 * exact instruction it is about to execute.
 *
 * objdump's tab-separated columns are compressed into a compact, vertically
 * aligned form: "2000023c: a7c58593  addi a1,a1,-1412 # 20006cb4 <__bss_start__>"
 * (bytes padded to 8 chars, mnemonics padded to the file's longest mnemonic, so
 * the operand columns line up).
 */

/** A parsed .dis listing: display lines plus the PC → line mapping. */
export class Disassembly {
  constructor(
    /** Listing lines (address lines normalized, everything else verbatim). */
    readonly lines: string[],
    /** Instruction addresses in ascending order (symbol headers etc. are skipped —
     * they would corrupt the binary search) ... */
    private readonly entryAddrs: Int32Array,
    /** ... and the listing line index of each. */
    private readonly entryLines: Int32Array
  ) {}

  /** Index into lines[] of the instruction containing pc (greatest entry addr ≤ pc), or -1. */
  lineIndexForPc(pc: number): number {
    const { entryAddrs, entryLines } = this;
    let lo = 0;
    let hi = entryAddrs.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (entryAddrs[mid] > pc) {
        hi = mid - 1;
      } else {
        result = mid;
        lo = mid + 1;
      }
    }
    return result === -1 ? -1 : entryLines[result];
  }
}

const DIS_LINE = /^\s*([0-9a-fA-F]+):\s*(\S+)\s*(.*)$/;

interface AddressLine {
  addr: string;
  bytes: string;
  mnem: string;
  ops: string;
}

export function parseDisassembly(text: string): Disassembly {
  const raws = text.split('\n');

  // Pass 1: tokenize address lines, track the longest mnemonic.
  const parsed: (AddressLine | null)[] = [];
  const entryIdx: number[] = [];
  const addrs: number[] = [];
  let maxMnem = 0;
  for (const raw of raws) {
    const match = DIS_LINE.exec(raw);
    if (!match) {
      parsed.push(null); // section header / symbol line
      continue;
    }
    const [, addr, bytes, rest] = match;
    // Collapse internal runs (objdump pads before trailing comments) — operands
    // then align via the padded mnemonic column, comments follow single-spaced.
    const tokens = rest.trim().replace(/\s+/g, ' ').split(' ', 2);
    const mnem = tokens[0];
    const ops = tokens[1] ?? '';
    if (mnem.length > maxMnem) maxMnem = mnem.length;
    parsed.push({ addr, bytes, mnem, ops });
    addrs.push(parseInt(addr, 16));
    entryIdx.push(parsed.length - 1);
  }

  // Pass 2: build the aligned display lines.
  const lines = raws.map((raw, i) => {
    const pc = parsed[i];
    if (!pc) return raw;
    if (!pc.mnem) return `${pc.addr}: ${pc.bytes}`; // bytes objdump could not decode
    return `${pc.addr}: ${pc.bytes.padEnd(8)}  ${pc.mnem.padEnd(maxMnem)}  ${pc.ops}`;
  });

  return new Disassembly(lines, Int32Array.from(addrs), Int32Array.from(entryIdx));
}

/** Address of a symbol as annotated by objdump (e.g. "2000042a <main>"), computed
 * from the first annotation seen (a "<main+0x140>" entry yields addr - 0x140). */
export function findSymbolAddr(text: string, symbol: string): number | null {
  const re = new RegExp(`([0-9a-fA-F]+) <${symbol}(?:\\+0x([0-9a-fA-F]+))?>`);
  const match = re.exec(text);
  if (!match) return null;
  const addr = parseInt(match[1], 16);
  const off = match[2] ? parseInt(match[2], 16) : 0;
  return addr - off;
}
