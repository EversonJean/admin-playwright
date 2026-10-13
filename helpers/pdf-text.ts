import { inflateSync } from 'zlib';

/**
 * Texto de um PDF, sem dependência de npm: o bastante para o e2e afirmar que um
 * trecho ESTÁ no documento (cláusulas de um contrato, nome do contratante).
 *
 * Cobre o PDF que o back gera (QuestPDF sobre o Skia): objetos sem object
 * stream, conteúdo com `FlateDecode`, fontes Type0 com `ToUnicode` (`bfchar` e
 * `bfrange`), texto por `Tj`/`TJ`/`'`/`"`, formulários (`Do`) e recursos
 * herdados do `/Pages`. Não é um leitor geral de PDF.
 *
 * Os trechos saem na ordem do conteúdo de cada página, sem a posição: um mesmo
 * parágrafo pode vir partido em vários `Tj`, e o espaço entre palavras às vezes
 * é só avanço, sem glifo. Por isso a comparação se faz sem espaços
 * (`pdfContains`).
 */

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

type CMap = { bytesPerCode: number; map: Map<string, string> };

function parseObjects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text)) !== null) {
    const num = Number(match[1]);
    const start = match.index + match[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) break;
    let body = text.slice(start, end);
    let stream: Buffer | null = null;
    const streamAt = body.search(/\bstream\r?\n/);
    if (streamAt >= 0) {
      const dataStart = start + streamAt + body.slice(streamAt).match(/^stream\r?\n/)![0].length;
      const dataEnd = text.indexOf('endstream', dataStart);
      let raw = pdf.subarray(dataStart, dataEnd);
      if (raw.length > 0 && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1);
      if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
      body = body.slice(0, streamAt);
      stream = raw;
      if (/\/FlateDecode/.test(body)) {
        try {
          stream = inflateSync(raw);
        } catch {
          stream = raw;
        }
      }
      header.lastIndex = dataEnd > 0 ? dataEnd : end;
    } else {
      header.lastIndex = end;
    }
    objects.set(num, { dict: body, stream });
  }
  return objects;
}

/** Valor de `/Key` num dicionário: `<<...>>`, `[...]`, `N G R` ou um token. */
function dictValue(dict: string, key: string): string | null {
  const re = new RegExp(`/${key}(?=[\\s/<\\[(])`, 'g');
  const found = re.exec(dict);
  if (!found) return null;
  let i = found.index + found[0].length;
  while (i < dict.length && /\s/.test(dict[i]!)) i++;
  if (dict.startsWith('<<', i)) {
    let depth = 0;
    for (let j = i; j < dict.length - 1; j++) {
      if (dict.startsWith('<<', j)) {
        depth++;
        j++;
      } else if (dict.startsWith('>>', j)) {
        depth--;
        j++;
        if (depth === 0) return dict.slice(i, j + 1);
      }
    }
    return dict.slice(i);
  }
  if (dict[i] === '[') {
    let depth = 0;
    for (let j = i; j < dict.length; j++) {
      if (dict[j] === '[') depth++;
      else if (dict[j] === ']' && --depth === 0) return dict.slice(i, j + 1);
    }
    return dict.slice(i);
  }
  const ref = /^(\d+)\s+(\d+)\s+R/.exec(dict.slice(i));
  if (ref) return ref[0];
  const token = /^[^\s/<>\[\]()]+|^\/[^\s/<>\[\]()]+/.exec(dict.slice(i));
  return token ? token[0] : null;
}

function refNumber(value: string | null): number | null {
  const m = value ? /^(\d+)\s+\d+\s+R$/.exec(value.trim()) : null;
  return m ? Number(m[1]) : null;
}

/** Dicionário de um valor que pode ser inline ou referência. */
function resolveDict(objects: Map<number, PdfObject>, value: string | null): string | null {
  if (!value) return null;
  const ref = refNumber(value);
  return ref !== null ? (objects.get(ref)?.dict ?? null) : value;
}

/** Pares `/Nome N 0 R` de um dicionário de recursos (`/Font`, `/XObject`). */
function namedRefs(dict: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!dict) return out;
  const re = /\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dict)) !== null) out.set(m[1]!, Number(m[2]));
  return out;
}

function utf16beHex(hex: string): string {
  const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
  return out;
}

function parseCMap(source: string): CMap {
  const map = new Map<string, string>();
  const space = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(source);
  const bytesPerCode = space ? Math.max(1, space[1]!.length / 2) : 2;

  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(m[1]!.toUpperCase(), utf16beHex(m[2]!));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]!;
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      const width = m[1]!.length;
      if (m[4] !== undefined) {
        const base = Buffer.from(m[4], 'hex');
        for (let code = lo; code <= hi; code++) {
          const dst = Buffer.from(base);
          dst.writeUInt16BE((dst.readUInt16BE(dst.length - 2) + (code - lo)) & 0xffff, dst.length - 2);
          map.set(code.toString(16).toUpperCase().padStart(width, '0'), utf16beHex(dst.toString('hex')));
        }
      } else {
        const items = [...m[5]!.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => x[1]!);
        items.forEach((dst, k) => {
          map.set((lo + k).toString(16).toUpperCase().padStart(width, '0'), utf16beHex(dst));
        });
      }
    }
  }
  return { bytesPerCode, map };
}

type Token =
  | { kind: 'string'; bytes: Buffer }
  | { kind: 'name'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'op'; value: string }
  | { kind: 'array'; items: Token[] }
  | { kind: 'other' };

function tokenize(content: Buffer): Token[] {
  const s = content.toString('latin1');
  const root: Token[] = [];
  const stack: Token[][] = [root];
  const push = (t: Token) => stack[stack.length - 1]!.push(t);
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
    } else if (c === '(') {
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < s.length && depth > 0) {
        const ch = s[i]!;
        if (ch === '\\') {
          const next = s[i + 1] ?? '';
          const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
          if (next in escapes) {
            bytes.push(escapes[next]!);
            i += 2;
          } else if (/[0-7]/.test(next)) {
            const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0];
            bytes.push(parseInt(oct, 8) & 0xff);
            i += 1 + oct.length;
          } else {
            i += 2;
          }
          continue;
        }
        if (ch === '(') depth++;
        if (ch === ')' && --depth === 0) {
          i++;
          break;
        }
        bytes.push(ch.charCodeAt(0) & 0xff);
        i++;
      }
      push({ kind: 'string', bytes: Buffer.from(bytes) });
    } else if (c === '<' && s[i + 1] === '<') {
      push({ kind: 'other' });
      i += 2;
    } else if (c === '>' && s[i + 1] === '>') {
      push({ kind: 'other' });
      i += 2;
    } else if (c === '<') {
      const end = s.indexOf('>', i);
      const hex = s.slice(i + 1, end).replace(/\s+/g, '');
      push({ kind: 'string', bytes: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex') });
      i = end + 1;
    } else if (c === '[') {
      const arr: Token = { kind: 'array', items: [] };
      push(arr);
      stack.push(arr.items);
      i++;
    } else if (c === ']') {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === '/') {
      const m = /^\/[^\s/<>\[\]()%{}]*/.exec(s.slice(i))!;
      push({ kind: 'name', value: m[0].slice(1) });
      i += m[0].length;
    } else if (/[0-9+\-.]/.test(c)) {
      const m = /^[+\-]?(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (m) {
        push({ kind: 'number', value: Number(m[0]) });
        i += m[0].length;
      } else {
        i++;
      }
    } else {
      const m = /^[^\s/<>\[\]()%{}]+/.exec(s.slice(i));
      if (!m) {
        i++;
        continue;
      }
      const op = m[0];
      i += op.length;
      if (op === 'ID') {
        // Imagem inline: pula os bytes até o `EI` isolado.
        const ei = s.slice(i).search(/\sEI(\s|$)/);
        i = ei < 0 ? s.length : i + ei + 3;
        continue;
      }
      push({ kind: 'op', value: op });
    }
  }
  return root;
}

function decodeString(bytes: Buffer, cmap: CMap | undefined): string {
  if (!cmap) return bytes.toString('latin1');
  const hex = bytes.toString('hex').toUpperCase();
  const width = cmap.bytesPerCode * 2;
  let out = '';
  for (let i = 0; i + width <= hex.length; i += width) {
    const code = hex.slice(i, i + width);
    out += cmap.map.get(code) ?? '';
  }
  return out;
}

/** Texto de todas as páginas, na ordem da árvore de páginas. */
export function pdfText(pdf: Buffer): string {
  const objects = parseObjects(pdf);
  const cmaps = new Map<number, CMap | undefined>();

  const fontCMap = (fontRef: number): CMap | undefined => {
    if (cmaps.has(fontRef)) return cmaps.get(fontRef);
    const font = objects.get(fontRef);
    const toUnicode = refNumber(font ? dictValue(font.dict, 'ToUnicode') : null);
    const stream = toUnicode !== null ? objects.get(toUnicode)?.stream : null;
    const cmap = stream ? parseCMap(stream.toString('latin1')) : undefined;
    cmaps.set(fontRef, cmap);
    return cmap;
  };

  const resourcesOf = (dict: string): string | null => {
    let current: string | null = dict;
    for (let guard = 0; current && guard < 32; guard++) {
      const res = resolveDict(objects, dictValue(current, 'Resources'));
      if (res) return res;
      const parent = refNumber(dictValue(current, 'Parent'));
      current = parent !== null ? (objects.get(parent)?.dict ?? null) : null;
    }
    return null;
  };

  const runContent = (content: Buffer, resources: string | null, depth: number): string => {
    if (depth > 8) return '';
    const fonts = namedRefs(resolveDict(objects, resources ? dictValue(resources, 'Font') : null));
    const xobjects = namedRefs(resolveDict(objects, resources ? dictValue(resources, 'XObject') : null));
    let cmap: CMap | undefined;
    let out = '';
    const operands: Token[] = [];
    for (const token of tokenize(content)) {
      if (token.kind !== 'op') {
        operands.push(token);
        continue;
      }
      const last = operands[operands.length - 1];
      switch (token.value) {
        case 'Tf': {
          const name = operands.find((t) => t.kind === 'name') as { value: string } | undefined;
          const ref = name ? fonts.get(name.value) : undefined;
          cmap = ref !== undefined ? fontCMap(ref) : undefined;
          break;
        }
        case 'Tj':
        case "'":
        case '"':
          if (last?.kind === 'string') out += decodeString(last.bytes, cmap);
          break;
        case 'TJ':
          if (last?.kind === 'array') {
            for (const item of last.items) if (item.kind === 'string') out += decodeString(item.bytes, cmap);
          }
          break;
        case 'ET':
          out += '\n';
          break;
        case 'Do': {
          const ref = last?.kind === 'name' ? xobjects.get(last.value) : undefined;
          const xo = ref !== undefined ? objects.get(ref) : undefined;
          if (xo?.stream && /\/Subtype\s*\/Form/.test(xo.dict)) {
            out += runContent(xo.stream, resolveDict(objects, dictValue(xo.dict, 'Resources')) ?? resources, depth + 1);
          }
          break;
        }
        default:
          break;
      }
      operands.length = 0;
    }
    return out;
  };

  const pageOrder: number[] = [];
  const walk = (ref: number, guard: number) => {
    const node = objects.get(ref);
    if (!node || guard > 64) return;
    if (/\/Type\s*\/Pages\b/.test(node.dict)) {
      const kids = dictValue(node.dict, 'Kids') ?? '';
      for (const kid of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(kid[1]), guard + 1);
    } else if (/\/Type\s*\/Page\b/.test(node.dict)) {
      pageOrder.push(ref);
    }
  };
  for (const [num, obj] of objects) {
    if (/\/Type\s*\/Pages\b/.test(obj.dict) && dictValue(obj.dict, 'Parent') === null) walk(num, 0);
  }
  if (pageOrder.length === 0) {
    for (const [num, obj] of objects) if (/\/Type\s*\/Page\b/.test(obj.dict)) pageOrder.push(num);
  }

  let text = '';
  for (const pageRef of pageOrder) {
    const page = objects.get(pageRef)!;
    const resources = resourcesOf(page.dict);
    const contents = dictValue(page.dict, 'Contents') ?? '';
    for (const c of contents.matchAll(/(\d+)\s+\d+\s+R/g)) {
      const stream = objects.get(Number(c[1]))?.stream;
      if (stream) text += runContent(stream, resources, 0);
    }
    text += '\n';
  }
  return text.normalize('NFC');
}

/** Sem espaço nenhum: é assim que um trecho do contrato se procura no PDF. */
export function compactText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, '');
}

/** O PDF traz o trecho (comparado sem espaços)? */
export function pdfContains(pdf: Buffer, excerpt: string): boolean {
  return compactText(pdfText(pdf)).includes(compactText(excerpt));
}
