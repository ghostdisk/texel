# Filters

Filters are non-destructive and run on the GPU. Each layer and group, including the document root, has an ordered filter stack. Changes appear immediately without replacing source pixels.

## Working with filters

Add filters from the Filter menu. A filter can be enabled or disabled, removed, collapsed, reordered, and blended with its input using **Mix**. A Mix value of 0% shows the input; 100% shows the full filtered result.

Filters are evaluated from top to bottom in stack order. Reordering them can substantially change the result. Applying a filter to the document root affects the complete composition; applying one to a group affects that isolated group.

Pixel layers can bake a filter into their source. Baking replaces the source pixels, updates the transform if necessary, removes the baked stack state, and remains undoable.

## Available filters

### Adjustments

- **Brightness / contrast** adjusts tonal brightness and contrast.
- **Curves** maps input intensity through editable color curves.
- **Exposure** adjusts exposure in linear light.
- **Grayscale** removes color while retaining luminance.
- **Hue / saturation** shifts hue and changes saturation.
- **Invert** inverts color values.
- **Levels** controls input range, gamma, and output range.
- **Posterize** reduces the number of tonal levels.
- **White balance** adjusts color temperature and tint.

### Blur and sharpening

- **Gaussian blur** uses a separable Gaussian kernel. Large radii may use a lower-resolution intermediate surface.
- **Smart blur** averages nearby pixels only when their color and alpha are within a threshold.
- **Sharpen** increases local contrast around edges.

### Effects

- **Border** adds a border around layer content.
- **Drop shadow** expands the output bounds and renders an offset, blurred shadow.

### Masks

- **Mask** uses another layer as filter coverage. Layer references are validated so masks and groups cannot form circular dependencies.

## Implementation

Every filter subclasses `Filter` and owns its parameter validation, UI, serialization, output bounds, dependencies, and GPU rendering. The compositor supplies reusable intermediate surfaces scoped to the filter and mixes the result with the original input when needed.

Filter state is stored in `.txl` documents and retained by duplication, grouping, and undo. Derived filter textures are caches and are rebuilt when a document opens.
