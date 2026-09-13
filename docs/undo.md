# Undo and history

Every open document has its own history. Use **Ctrl+Z** to undo and **Ctrl+Shift+Z** or **Ctrl+Y** to redo. The History panel shows retained states and can jump directly to an earlier or later state.

New edits made after undoing discard the redo branch. Closing a document discards its history, and opening a `.txl` file starts with a fresh history. History is not saved into project files.

## Gesture behavior

A continuous gesture normally creates one entry. Examples include a brush stroke, transform drag, filter slider adjustment, layer reorder, crop, reframing operation, or completed generator result. Live previews do not create a stream of history entries.

Text fields retain their normal editing shortcuts while focused. Switching tools or starting a document command finishes the current canvas gesture before the next action begins.

## Implementation

An `UndoOperation` contains a label, an undo payload, a redo payload, and optional GPU snapshots. Payloads are JSON-shaped descriptions routed by type:

- `image` operations change document structure, selection, guides, or batches of layers.
- `layer` operations change properties, pixels, reframing, or filter membership.
- `filter` operations restore serialized filter state.
- `tool` operations restore tool-owned edits such as brush pixels or transforms.

Pixel operations keep complete before-and-after source textures as GPU snapshots. Metadata operations generally store only serialized values. Snapshot boundaries flush queued painting first so the captured texture includes the complete gesture.

History retains at most 100 entries and approximately 256 MiB of GPU snapshots. The newest entry is retained even when it alone exceeds the memory budget. Evicted entries destroy their GPU resources.

The document's dirty state compares the current history state ID with the state ID recorded by the last successful save. Undoing back to that state clears the unsaved marker; moving away from it restores the marker.
