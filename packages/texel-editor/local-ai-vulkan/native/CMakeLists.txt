cmake_minimum_required(VERSION 3.28)
project(texel_local_ai_vulkan LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
get_filename_component(TEXEL_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../.." ABSOLUTE)
set(TEXEL_VENDOR_DIR "${TEXEL_ROOT}/vendor")
set(TEXEL_GGML_SOURCE "${TEXEL_VENDOR_DIR}/ggml")
set(TEXEL_STB_SOURCE "${TEXEL_VENDOR_DIR}/stb")
set(TEXEL_SHARED_VULKAN_RUNTIME ON)
set(TEXEL_VULKAN_RUNTIME_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/include")
set(TEXEL_VOLK_SOURCE_DIR "${TEXEL_VENDOR_DIR}/volk")
set(Vulkan_INCLUDE_DIRS "${TEXEL_VENDOR_DIR}/vulkan-headers/include")
set(VULKAN_HEADERS_INSTALL_DIR "${TEXEL_VENDOR_DIR}/vulkan-headers")
if(DEFINED ENV{TEXEL_GLSLC})
    set(Vulkan_GLSLC_EXECUTABLE "$ENV{TEXEL_GLSLC}")
else()
    set(Vulkan_GLSLC_EXECUTABLE "${TEXEL_VENDOR_DIR}/glslc/glslc.exe")
endif()
if(NOT EXISTS "${Vulkan_GLSLC_EXECUTABLE}")
    message(FATAL_ERROR "Vendored glslc was not found at ${Vulkan_GLSLC_EXECUTABLE}")
endif()

set(SD_VULKAN ON CACHE BOOL "" FORCE)
set(SD_CUDA OFF CACHE BOOL "" FORCE)
set(SD_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SD_WEBP OFF CACHE BOOL "" FORCE)
set(SD_WEBM OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)
set(GGML_CUDA OFF CACHE BOOL "" FORCE)
set(VOLK_STATIC_DEFINES "VK_NO_PROTOTYPES;VK_USE_PLATFORM_WIN32_KHR;NOMINMAX")
add_subdirectory("${TEXEL_VENDOR_DIR}/volk" volk)
add_subdirectory("${TEXEL_VENDOR_DIR}/stable-diffusion.cpp" stable-diffusion)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(VISP_STATIC_GGML ON CACHE BOOL "" FORCE)
set(VISP_TESTS OFF CACHE BOOL "" FORCE)
set(VISP_CLI OFF CACHE BOOL "" FORCE)
set(VISP_INSTALL_MODELS OFF CACHE BOOL "" FORCE)
set(VISP_VULKAN ON CACHE BOOL "" FORCE)
add_subdirectory("${TEXEL_VENDOR_DIR}/vision.cpp" visioncpp)
target_sources(visioncpp PRIVATE src/migan.cpp)
target_include_directories(visioncpp PRIVATE include)

add_library(texel-local-ai-vulkan SHARED
    src/backend.cpp
    src/shader-runtime.cpp
    src/vulkan-runtime.cpp
)
target_include_directories(texel-local-ai-vulkan PRIVATE
    include
    "${TEXEL_VENDOR_DIR}/stable-diffusion.cpp/thirdparty"
    "${TEXEL_STB_SOURCE}"
    "${TEXEL_VOLK_SOURCE_DIR}"
)
target_compile_definitions(texel-local-ai-vulkan PRIVATE
    VK_NO_PROTOTYPES
    VK_USE_PLATFORM_WIN32_KHR
    NOMINMAX
    _CRT_SECURE_NO_WARNINGS
)
target_link_libraries(texel-local-ai-vulkan PRIVATE stable-diffusion zip volk visioncpp)
set_target_properties(texel-local-ai-vulkan PROPERTIES PREFIX "")

install(TARGETS texel-local-ai-vulkan RUNTIME DESTINATION . LIBRARY DESTINATION .)
install(FILES "${TEXEL_VENDOR_DIR}/stable-diffusion.cpp/LICENSE" DESTINATION licenses RENAME stable-diffusion.txt)
install(FILES "${TEXEL_VENDOR_DIR}/ggml/LICENSE" DESTINATION licenses RENAME ggml.txt)
install(FILES "${TEXEL_VENDOR_DIR}/vision.cpp/LICENSE" DESTINATION licenses RENAME vision.cpp.txt)
install(FILES "${TEXEL_VENDOR_DIR}/volk/LICENSE.md" DESTINATION licenses RENAME volk.txt)
install(FILES "${TEXEL_VENDOR_DIR}/stb/LICENSE" DESTINATION licenses RENAME stb.txt)
install(FILES "${TEXEL_VENDOR_DIR}/vulkan-headers/LICENSE.md" DESTINATION licenses RENAME vulkan-headers.txt)
install(FILES "${TEXEL_VENDOR_DIR}/vulkan-headers/SPIRV-LICENSE" DESTINATION licenses RENAME spirv-headers.txt)
