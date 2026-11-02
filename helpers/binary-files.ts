import { deflateRawSync, deflateSync, inflateRawSync } from 'zlib';

/**
 * Arquivos binários montados em memória para os testes de limite de entrada
 * (PLANO-SEGURANCA §12): PNG válido de um tamanho escolhido e DOCX (ZIP) com o
 * tamanho descompactado declarado no diretório central — o zip bomb que o back
 * recusa antes de abrir o pacote.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * PNG válido (RGB 8 bits) de `width` x `height`. Com `totalBytes`, um chunk
 * ancilar privado (`teXt` minúsculo é ignorado pelos leitores) completa o
 * arquivo até esse tamanho: é o jeito de ter "um logo de 500 KB" ou "um anexo
 * de 20 MB" com cabeçalho e dimensões de imagem de verdade.
 */
export function pngBytes(opts: { width?: number; height?: number; totalBytes?: number } = {}): Buffer {
  const width = opts.width ?? 16;
  const height = opts.height ?? 16;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // Uma linha = byte de filtro + 3 bytes por pixel.
  const raw = Buffer.alloc((1 + width * 3) * height, 0x7f);
  for (let y = 0; y < height; y++) raw[y * (1 + width * 3)] = 0;
  const idat = pngChunk('IDAT', deflateSync(raw));
  const head = Buffer.concat([signature, pngChunk('IHDR', ihdr)]);
  const iend = pngChunk('IEND', Buffer.alloc(0));

  const base = head.length + idat.length + iend.length;
  if (!opts.totalBytes || opts.totalBytes <= base + 12) return Buffer.concat([head, idat, iend]);
  const padding = pngChunk('prVt', Buffer.alloc(opts.totalBytes - base - 12, 0x20));
  return Buffer.concat([head, padding, idat, iend]);
}

interface ZipEntry {
  name: string;
  data: Buffer;
  /** Tamanho descompactado gravado nos cabeçalhos; default = o real. */
  declaredSize?: number;
}

/** ZIP (deflate) com as entradas dadas; `declaredSize` mente sobre o tamanho descompactado. */
function zipBytes(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const size = entry.declaredSize ?? entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

/**
 * DOCX mínimo (content types, rels e `word/document.xml`). Com
 * `declaredDocumentBytes`, o `document.xml` declara esse tamanho descompactado
 * no ZIP (ex.: 1 GB) — o pacote em si continua com poucos KB.
 */
export function docxBytes(text: string, opts: { declaredDocumentBytes?: number } = {}): Buffer {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    `<w:p><w:r><w:t>${escaped}</w:t></w:r></w:p>` +
    '</w:body></w:document>';
  return zipBytes([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    {
      name: 'word/document.xml',
      data: Buffer.from(document, 'utf8'),
      declaredSize: opts.declaredDocumentBytes,
    },
  ]);
}

/**
 * Entradas de um ZIP baixado do back (pacote LGPD do titular, PLANO-SEGURANCA
 * §14): nome -> conteúdo descompactado. Lê pelo diretório central, que traz os
 * tamanhos mesmo quando o `ZipArchive` do .NET grava o local header com data
 * descriptor; só `stored` (0) e `deflate` (8), os dois que o back produz.
 */
export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('readZipEntries: fim do diretório central não encontrado');

  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('readZipEntries: diretório central inválido');
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
