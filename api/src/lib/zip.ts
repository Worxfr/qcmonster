// Ecrivain de zip minimal (methode deflate, sans zip64): assez pour une archive de quelques Mo. Pas de dependance: node:zlib seulement.
// shortcut: pas de zip64, donc au plus 65 534 fichiers et 4 Go; l'archive de famille en a 1 + 5 et reste sous 100 Mo (50 000 passages).
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/** Date et heure MS-DOS (heure UTC, 1980 au plus tot). */
function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getUTCFullYear());
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

/**
 * Ecrivain de zip en flux (archive de l'eleve, R1 3.6): `add` renvoie les octets a ecrire pour UNE entree (en-tete local et corps), `end` le repertoire central.
 * Le corps d'une image (deja compressee) est stocke sans compression (`store`), le JSON est compresse. Une seule entree est en memoire a la fois.
 * shortcut: pas de zip64: une entree de moins de 4 Go et 65 534 fichiers au plus (150 Mo de figures, 8 par cours), assez pour cette archive.
 */
export class ZipWriter {
  private readonly central: Buffer[] = [];
  private offset = 0;
  private count = 0;
  private readonly stamp: { time: number; date: number };
  constructor(at: Date) {
    this.stamp = dosTime(at);
  }
  add(name: string, data: Buffer, method: 'store' | 'deflate' = 'deflate'): Buffer {
    if (++this.count > 0xfffe) throw new RangeError('trop de fichiers');
    const n = Buffer.from(name, 'utf8');
    const body = method === 'deflate' ? deflateRawSync(data) : data;
    if (body.length > 0xffffffff) throw new RangeError('fichier trop gros');
    const common = Buffer.concat([u16(20), u16(0x0800), u16(method === 'deflate' ? 8 : 0), u16(this.stamp.time), u16(this.stamp.date), u32(crc32(data)), u32(body.length), u32(data.length), u16(n.length), u16(0)]);
    const head = Buffer.concat([u32(0x04034b50), common, n]);
    this.central.push(Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(this.offset), n]));
    this.offset += head.length + body.length;
    return Buffer.concat([head, body]);
  }
  end(): Buffer {
    const cd = Buffer.concat(this.central);
    return Buffer.concat([cd, u32(0x06054b50), u16(0), u16(0), u16(this.count), u16(this.count), u32(cd.length), u32(this.offset), u16(0)]);
  }
}

export function zip(entries: ZipEntry[], at: Date): Buffer {
  if (entries.length > 0xfffe) throw new RangeError('trop de fichiers');
  const { time, date } = dosTime(at);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = deflateRawSync(e.data);
    if (body.length > 0xffffffff || e.data.length > 0xffffffff) throw new RangeError('fichier trop gros');
    // 20 = version 2.0 (deflate); 0x0800 = noms en UTF-8; 8 = deflate.
    const common = Buffer.concat([u16(20), u16(0x0800), u16(8), u16(time), u16(date), u32(crc32(e.data)), u32(body.length), u32(e.data.length), u16(name.length), u16(0)]);
    const head = Buffer.concat([u32(0x04034b50), common, name]);
    local.push(head, body);
    // En-tete central: version fabricante (20), puis les memes champs, commentaire 0, disque 0, attributs internes 0 et externes 0, decalage, nom.
    central.push(Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += head.length + body.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...local, cd, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
}
