# Fal provider metadata

The Fal integration keeps runtime discovery deliberately small. The editor lists currently available image-to-image models in 100-item catalog pages, then matches each endpoint slug against `model_defs.json`. It does not fetch individual model schemas at runtime.

`model_defs.json` is the shipped, curated database. It contains editor classifications, display metadata, ratings, field mappings, capabilities, and actionable size constraints. Hand-authored values override generated values, so ratings and special cases such as measured output-size buckets are preserved when the database is refreshed.

Models missing from the database use the catalog tags for a minimal runtime classification. If no more specific classification is available, they are exposed as generic image-to-image models.

## Refreshing the database

Run the maintainer-only updater from the repository root:

```sh
node packages/texel-editor/fal/update-model-defs.cjs
```

The updater:

- lists active Fal image-to-image endpoints;
- inspects only curated definitions that do not yet have a resolved schema;
- requests schemas in small batches with an interval between batches;
- stops immediately on a `429` and preserves completed work, so running it again resumes the refresh;
- extracts request field mappings and normalized size constraints;
- merges generated metadata beneath existing hand-authored overrides;
- omits empty or non-actionable constraint placeholders.

Set `FAL_KEY` when authenticated catalog access is required:

```sh
FAL_KEY=your-key node packages/texel-editor/fal/update-model-defs.cjs
```

Use `--refresh` to re-inspect every curated definition, including entries that already have resolved request and output fields:

```sh
node packages/texel-editor/fal/update-model-defs.cjs --refresh
```

Use `--discover` to inspect every active image-to-image endpoint returned by Fal rather than only the curated slugs. This can be a large operation and should only be used intentionally:

```sh
node packages/texel-editor/fal/update-model-defs.cjs --discover
```

Use `--clean` to normalize and rewrite the existing database without making network requests:

```sh
node packages/texel-editor/fal/update-model-defs.cjs --clean
```

## Size constraints

All geometry and resolution rules live under `capabilities.size`. The database does not keep a second provider-specific copy of the same constraints.

Aspect constraints expand the generation lens outward. Pixel-area, short-side, exact-size, and min/max resolution constraints select an effective capture scale. Granularity expands the lens only as needed to align the requested pixel grid. `outputSizeBuckets` describe provider-selected output dimensions and influence the lens aspect without treating those output pixels as an input-size requirement.

Provider request encoding belongs under `fields`. For example, `imageSizeObject` records that an `image_size` field accepts a `{ width, height }` object; it is not itself a size constraint.

## Outpainting

The editor sends one provider-neutral request: an input image and four expansion amounts. The Fal service translates it according to each model's `expandApi` (`bria-canvas`, `side-margins`, or `luma-reframe`). Fixed provider parameters, such as disabling Image Outpaint's default zoom, live in `expandOptions`. Actionable expansion limits and output aspect/size buckets live under `capabilities.expand`.

An outpainting catalog entry without a reviewed `expandApi` definition is not offered by the Outpaint / Expand generator. Luma's Fal endpoint exposes an aspect-ratio target but does not document enough placement control for pixel-exact asymmetric margins, so its model cards constrain the outer frame to a centered, aspect-ratio-changing expansion and supported output buckets. A request that would require zooming out in both dimensions is rejected for Luma rather than silently changing its meaning.
