# Texel

Texel is a desktop image editor built around the GPU. Its goal is to make everyday image editing responsive, keep filters editable and real-time, and treat AI generation and editing as first-class parts of the workflow.

> Texel is in an early stage of development. Features, workflows, and the project file format may still change, and there are rough edges.

Today, Texel supports layered documents, non-destructive filters, masks and selections, drawing and transform tools, undo history, native project files, and local or hosted AI image models.

## Philosophy



## Run it from source

You need Node.js 22.12 or newer and a WebGPU-capable GPU and driver.

```sh
npm install
npm run dev
```

Closing the Electron window also stops the development server.

## Documentation

The [documentation index](docs/README.md) covers the editor, its tools and filters, AI integrations, the project format, and development setup.

## Status

Texel is currently a personal, experimental project rather than a finished product. Bug reports and focused contributions are welcome, but expect active development and incomplete polish.
