# Vendored native dependencies

Texel's native packages build exclusively from this directory. Build scripts do not clone repositories or download dependencies.

| Directory | Source revision |
| --- | --- |
| `stable-diffusion.cpp` | `leejet/stable-diffusion.cpp@7f410a3793c5bba8eb198e962ce7a3d6095f9d89` |
| `ggml` | `leejet/ggml@e20c3a14aa70ee84ca58499814206dd08d8026bc` |
| `vision.cpp` | `Acly/vision.cpp@26a752912d49f6c4ff4545b35a1bdf7400d349ed` |
| `volk` | `zeux/volk@e640c6ea6420bdaf6248e85f736ab0b99491ae58` |
| `stb` | `nothings/stb@5736b15f7ea0ffb08dd38af21067c314d6a3aae9` |
| `vulkan-headers` | Vulkan SDK `1.4.350.0` headers, including SPIR-V headers |
| `glslc` | Shaderc `v2026.2` Windows x64 compiler |

Texel-specific integration changes live directly in these vendored sources. They connect stable-diffusion.cpp and vision.cpp to the shared GGML and Vulkan runtime and keep generated shader bytes outside the backend DLL.
