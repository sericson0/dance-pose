// Build public/models/man.glb and woman.glb from Microsoft Rocketbox avatars
// (MIT license — see public/models/ATTRIBUTION.md).
//
// The Rocketbox sources are FBX (3ds Max Biped rig) with 2048² TGA textures.
// This script takes the FBX2glTF conversions (which come out untextured
// because the FBX references 3ds Max map names), decodes the TGAs itself,
// downsizes them, wires them onto the right materials, and Draco-compresses.
// The skin (bones + weights) is kept intact: at runtime Figure re-parents the
// Biped bones onto our joint rig (see BODY_BONE_MAP in src/skeletonMesh.js).
//
// Usage:  node scripts/build-body.mjs <srcDir> <texPrefix> <outFile>
//   e.g.  node scripts/build-body.mjs rocketbox/Business_Male_01 m005 public/models/man.glb
//   srcDir must contain <name>.glb (from FBX2glTF) and Textures/<texPrefix>_*.tga.
//
// Requires (install once, not committed to package.json):
//   npm install --no-save @gltf-transform/core @gltf-transform/extensions \
//     @gltf-transform/functions draco3dgltf sharp fbx2gltf

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const [srcDir, texPrefix, outFile] = process.argv.slice(2);
if (!srcDir || !texPrefix || !outFile) {
  console.error('Usage: node scripts/build-body.mjs <srcDir> <texPrefix> <outFile>');
  process.exit(1);
}

const glbIn = fs.readdirSync(srcDir).find((f) => f.endsWith('.glb'));
if (!glbIn) throw new Error(`No .glb in ${srcDir} — run FBX2glTF on the FBX first.`);

// --- Minimal TGA reader (uncompressed or RLE truecolor) → RGBA buffer. ---
function readTGA(file) {
  const buf = fs.readFileSync(file);
  const idLen = buf[0], type = buf[2];
  const w = buf.readUInt16LE(12), h = buf.readUInt16LE(14);
  const bpp = buf[16] / 8, topOrigin = (buf[17] & 0x20) !== 0;
  if (type !== 2 && type !== 10) throw new Error(`${file}: unsupported TGA type ${type}`);
  const out = Buffer.alloc(w * h * 4);
  let src = 18 + idLen;
  const putPixel = (i) => {
    out[i] = buf[src + 2]; out[i + 1] = buf[src + 1]; out[i + 2] = buf[src];
    out[i + 3] = bpp === 4 ? buf[src + 3] : 255;
  };
  if (type === 2) {
    for (let p = 0; p < w * h; p++, src += bpp) putPixel(p * 4);
  } else {
    let p = 0;
    while (p < w * h) {
      const packet = buf[src++], count = (packet & 0x7f) + 1;
      if (packet & 0x80) { // RLE run: one pixel repeated
        for (let k = 0; k < count; k++, p++) putPixel(p * 4);
        src += bpp;
      } else {
        for (let k = 0; k < count; k++, p++, src += bpp) putPixel(p * 4);
      }
    }
  }
  if (!topOrigin) { // bottom-left origin → flip rows
    const flipped = Buffer.alloc(out.length);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.copy(flipped, y * row, (h - 1 - y) * row, (h - y) * row);
    return { data: flipped, width: w, height: h };
  }
  return { data: out, width: w, height: h };
}

async function encode(tgaFile, { size = 1024, format }) {
  const { data, width, height } = readTGA(tgaFile);
  const img = sharp(data, { raw: { width, height, channels: 4 } }).resize(size, size);
  if (format === 'png') return { data: await img.png().toBuffer(), mime: 'image/png' };
  return { data: await img.jpeg({ quality: 88 }).toBuffer(), mime: 'image/jpeg' };
}

const tex = (name) => path.join(srcDir, 'Textures', `${texPrefix}_${name}.tga`);
console.log(`Reading ${glbIn} + ${texPrefix}_* textures…`);
const [bodyColor, bodyNormal, headColor, headNormal, opacityColor] = await Promise.all([
  encode(tex('body_color'), { format: 'jpeg' }),
  encode(tex('body_normal'), { format: 'jpeg' }),
  encode(tex('head_color'), { format: 'jpeg' }),
  encode(tex('head_normal'), { format: 'jpeg' }),
  // Alpha channel: hair / lashes. Some avatars have no hair-card mesh at all.
  fs.existsSync(tex('opacity_color')) ? encode(tex('opacity_color'), { format: 'png' }) : null,
]);

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const doc = await io.read(path.join(srcDir, glbIn));
const root = doc.getRoot();

function makeTexture(name, { data, mime }) {
  return doc.createTexture(name).setImage(data).setMimeType(mime);
}
const textures = {
  body_color: makeTexture('body_color', bodyColor),
  body_normal: makeTexture('body_normal', bodyNormal),
  head_color: makeTexture('head_color', headColor),
  head_normal: makeTexture('head_normal', headNormal),
  opacity_color: opacityColor && makeTexture('opacity_color', opacityColor),
};

for (const mat of root.listMaterials()) {
  const n = mat.getName();
  mat.setMetallicFactor(0).setRoughnessFactor(0.9);
  if (n.endsWith('_body')) {
    mat.setBaseColorTexture(textures.body_color).setNormalTexture(textures.body_normal);
  } else if (n.endsWith('_head')) {
    mat.setBaseColorTexture(textures.head_color).setNormalTexture(textures.head_normal);
  } else if (n.endsWith('_opacity') && textures.opacity_color) {
    // Hair cards / eyelashes: color texture carries alpha.
    mat.setBaseColorTexture(textures.opacity_color)
      .setAlphaMode('BLEND').setDoubleSided(true);
  } else {
    console.warn(`  unexpected material "${n}" left untextured`);
  }
}

// The GLB carries no animations we want, and FBX2glTF sometimes leaves an
// empty take; drop them all.
for (const anim of root.listAnimations()) anim.dispose();

await doc.transform(dedup(), prune(), draco());
await io.write(outFile, doc);
const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`Wrote ${outFile} (${kb} kB)`);
