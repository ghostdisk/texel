# Texel document format (.txl), version 1

TXL is a lossless project container. All integer fields are unsigned little-endian values. Files contain one 12-byte header, one JSON chunk, and one BIN chunk. Chunk payloads and binary buffer offsets are aligned to four bytes.

## Container

| Byte offset | Size | Meaning |
| --- | --- | --- |
| 0 | 4 | Magic bytes: 54 58 4C 00, ASCII TXL followed by NUL |
| 4 | 4 | Container version: 1 |
| 8 | 4 | Total file byte length, including headers and padding |
| 12 | 4 | JSON payload byte length, including padding |
| 16 | 4 | Chunk type: ASCII JSON |
| 20 | variable | UTF-8 JSON, padded with spaces to a multiple of four bytes |
| after JSON | 4 | BIN payload byte length, including padding |
| after JSON + 4 | 4 | Chunk type: ASCII BIN followed by NUL |
| after JSON + 8 | variable | Binary buffers, with zero padding |

The container version governs framing and binary interpretation. JSON has a separate schemaVersion, currently 2. The reader also accepts schema 1 documents. Unsupported container/schema versions are rejected explicitly; future breaking changes must increment the relevant version. Container version 1 requires exactly these two chunks.

## JSON metadata

The top-level object contains:

- format: "texel"
- schemaVersion: 2 (schema 1 remains readable)
- document: canonical width/height, root layer, selectedLayerIds, activeLayerId, activeSelectionId, generationLens, gridSize, and guides
- buffers: descriptors for the binary pixel payloads

A layer contains id, kind ("image", "group", or "text"), properties, filters, buffer, children, and text (null for other layer types). Properties contain name, transform (six affine matrix values), opacity, visible, blendMode, and selection. Children are ordered from bottom to top. Filters are ordered from first to last and use each filter class's serialized id, kind, enabled, mix, and properties fields. Mask filters reference layer IDs.

Image layers have a buffer index and no children. Groups have a null buffer and may contain children. The root must be a group. Layer/filter IDs are unique and retained when opening a file, preserving cross-layer mask links.

Schema 2 adds text layers. Their text object stores text, fontFamily, fontSize, bold, italic, align (left/center/right), lineHeight (a font-size multiplier), and color (#RRGGBB). Placement uses the ordinary layer transform. Text has an RGBA buffer containing cached glyph pixels, no children, and cannot be a selection mask. The cached image preserves appearance when opening on a machine with different fonts; changing the text rasterizes it using locally available fonts.

activeSelectionId is the ID of the active temporary selection mask, or null. An inactive temporary mask may remain in the tree; its pixels and filter links are retained but it does not restrict editing. selectedLayerIds and activeLayerId describe layer selection independently of the pixel selection mask.

generationLens is an affine matrix mapping the canonical canvas rectangle to the lens frame. Lens placement is retained; provider settings and running generation jobs are not part of the document.

gridSize is a finite document-pixel spacing from 1 to 1,000,000. guides contains at most 1,000 objects with axis ("horizontal" or "vertical") and a finite document-coordinate position. Older schema 1 and 2 files without these fields open with a 32-pixel grid and no guides. Cropping translates guide positions with the document origin.

## Binary pixels

Each buffer descriptor contains byteOffset (relative to the BIN payload), byteLength (excluding padding), width, height, and format.

| Format | Bytes per pixel | Interpretation |
| --- | --- | --- |
| rgba16float | 8 | Four IEEE 754 binary16 channels in RGBA order; premultiplied linear-light color |
| r16float | 2 | One IEEE 754 binary16 mask coverage channel |

Pixels are tightly packed in row-major order, left to right and top to bottom. Each 16-bit value is little-endian. There is no compression, color conversion, or quantization. Each buffer begins on a four-byte boundary; odd-sized single-channel buffers need two padding bytes.

Source pixels and cached text pixels are stored. Filtered outputs, group composites, thumbnails, and undo snapshots are regenerated or discarded on opening. Each restored image or text layer owns its GPU texture, even if multiple layers refer to one buffer descriptor.

## Loading and saving

Readers check the total length, chunk types/lengths, UTF-8/JSON, buffer bounds and overlaps, dimensions, IDs, transforms, filter schemas, and layer dependency cycles. Missing mask targets retain their IDs, matching the editor's existing dangling-link behavior. Unknown layer types, filter kinds, pixel formats, or required versions fail instead of silently discarding content.

The current implementation supports files and decoded source pixels smaller than 2 GiB, JSON up to 16 MiB, up to 10,000 layers and filters, and nesting depth up to 128. Texture and canvas dimensions must fit the current GPU's limits.

GPU readback strips WebGPU row padding in bands of at most 32 MiB. Loading uploads the raw bytes directly into GPU textures. The existing document stays alive until the new tree and GPU allocations have validated successfully.

Saving writes and flushes a temporary file in the destination directory, then renames it over the target. The original file remains intact if writing or renaming fails. Opening starts a fresh undo history; save markers track undo states during the current session.
