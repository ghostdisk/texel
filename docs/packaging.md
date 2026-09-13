# Packaging notes

## Optional AI runtime package

The local inference runtime should move into an optional package or plugin when Texel gains package management. The current Vulkan build embeds two large shader sets:

- stable-diffusion.cpp / GGML Vulkan shaders: approximately 46 MiB
- MI-GAN vision runtime / GGML Vulkan shaders: approximately 52.5 MiB

Together they account for roughly 99 MiB of the unpacked core application. The split should keep the native host and its model registry versioned together with these runtime components, and install them only when a user enables local image generation or local object removal.
