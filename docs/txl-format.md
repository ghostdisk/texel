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

The container version governs framing and binary interpretation. JSON has a separate schemaVersion, currently 4. The reader also accepts schemas 1–3. Unsupported container/schema versions are rejected explicitly; future breaking changes must increment the relevant version. Container version 1 requires exactly these two chunks.

## JSON metadata

The top-level object contains:

- format: "texel"
- schemaVersion: 4 (schemas 1–3 remain readable)
- document: canonical width/height, root layer, selectedLayerIds, activeLayerId, activeSelectionId, generationLens, gridSize, and guides
- buffers: descriptors for the binary pixel payloads

A layer contains id, kind ("image", "group", or "text"), properties, filters, buffer, children, and text (null for other layer types). Properties contain name, transform (six affine matrix values), opacity, visible, blendMode, and selection. Children are ordered from bottom to top. Filters are ordered from first to last and use each filter class's serialized id, kind, enabled, mix, and properties fields. Mask filters reference layer IDs.

Image layers have a buffer index and no children. Groups have a null buffer and may contain children. The root must be a group. Layer/filter IDs are unique and retained when opening a file, preserving cross-layer mask links.

Schema 2 adds text layers. Their text object stores text, fontFamily, fontSize, bold, italic, align (left/center/right), lineHeight (a font-size multiplier), and color (#RRGGBB). Placement uses the ordinary layer transform. Text has an RGBA buffer containing cached glyph pixels, no children, and cannot be a selection mask. The cached image preserves appearance when opening on a machine with different fonts; changing the text rasterizes it using locally available fonts.

activeSelectionId is the ID of the active temporary selection mask, or null. An inactive temporary mask may remain in the tree; its pixels and filter links are retained but it does not restrict editing. selectedLayerIds and activeLayerId describe layer selection independently of the pixel selection mask.

generationLens is an affine matrix mapping the canonical canvas rectangle to the lens frame. Lens placement is retained; provider settings and running generation jobs are not part of the document.

gridSize is a finite document-pixel spacing from 1 to 1,000,000. guides contains at most 1,000 objects with axis ("horizontal" or "vertical") and a finite document-coordinate position. Older schema 1 and 2 files without these fields open with a 32-pixel grid and no guides. Cropping translates guide positions with the document origin.

## Binary pixels

Each buffer descriptor contains byteOffset (relative to the BIN payload), byteLength (excluding padding), logical width/height, format, and a tiles array. Tile coordinates are zero-based 256×256 chunk coordinates; omitted coordinates are zero.

| Format | Bytes per pixel | Interpretation |
| --- | --- | --- |
| rgba16float | 8 | Four IEEE 754 binary16 channels in RGBA order; premultiplied linear-light color |
| r16float | 2 | One IEEE 754 binary16 mask coverage channel |

Schema 4 tile records are either { x, y } for resident pixels or { x, y, color: [r, g, b, a] } for a solid chunk. Solid colors contain the exactly representable stored half-float values, in premultiplied linear light; scalar masks use red. They require no BIN bytes and restore shared immutable 1×1 backing.

Resident payloads follow tiles-array order, skipping solid records. Each is a complete 256×256 tile, tightly packed row-major with little-endian binary16 channels. Edge padding outside the logical image is zero. Each buffer begins on a four-byte boundary. Empty and all-solid buffers have byteLength 0.

Schema 3 uses the same tile layout but has no solid-color records. Schemas 1–2 store dense row-major images; odd-sized single-channel buffers have two alignment padding bytes. Older dense or resident tiles that are uniformly colored can be restored as solid chunks without changing their stored values.

Source pixels and cached text pixels are stored. Filtered outputs, group composites, thumbnails, and undo snapshots are regenerated or discarded on opening. Restored layers own their sparse records; immutable solid backing can be shared across layers.

## Loading and saving

Readers check the total length, chunk types/lengths, UTF-8/JSON, buffer bounds and overlaps, dimensions, IDs, transforms, filter schemas, and layer dependency cycles. Missing mask targets retain their IDs, matching the editor's existing dangling-link behavior. Unknown layer types, filter kinds, pixel formats, or required versions fail instead of silently discarding content.

The current implementation supports files and decoded source pixels smaller than 2 GiB, JSON up to 16 MiB, up to 10,000 layers and filters, and nesting depth up to 128. Logical image dimensions are limited to 1,048,576 pixels per axis, with at most 1,000,000 records per buffer; individual GPU image allocations remain chunk-sized.

Resident GPU readback uses batches of at most 16 MiB. Saving solid records needs no GPU readback. Loading uploads resident data by chunk and restores solid records from metadata. The existing document stays alive until the new tree and GPU allocations have validated successfully.

Saving writes and flushes a temporary file in the destination directory, then renames it over the target. The original file remains intact if writing or renaming fails. Opening starts a fresh undo history; save markers track undo states during the current session.
