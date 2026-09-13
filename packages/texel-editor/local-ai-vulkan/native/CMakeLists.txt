cmake_minimum_required(VERSION 3.28)
project(texel_local_ai_vulkan LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(SD_VULKAN ON CACHE BOOL "" FORCE)
set(SD_CUDA OFF CACHE BOOL "" FORCE)
set(SD_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SD_WEBP OFF CACHE BOOL "" FORCE)
set(SD_WEBM OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(TEXEL_SHARED_VULKAN_RUNTIME ON)
set(TEXEL_VULKAN_RUNTIME_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/include")
set(TEXEL_VOLK_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/volk")
set(VOLK_STATIC_DEFINES "VK_NO_PROTOTYPES;VK_USE_PLATFORM_WIN32_KHR;NOMINMAX")

add_subdirectory(../third_party/volk volk)
add_subdirectory(../third_party/stable-diffusion.cpp stable-diffusion)

include(ExternalProject)
set(TEXEL_VISION_BINARY_DIR "${CMAKE_BINARY_DIR}/vision")
set(TEXEL_VISION_LIBRARY_DIR "${TEXEL_VISION_BINARY_DIR}/lib")
set(TEXEL_VISION_LIBRARIES visioncpp ggml ggml-base ggml-cpu ggml-vulkan stb)
set(TEXEL_VISION_ARGS)
foreach(setting CMAKE_TOOLCHAIN_FILE CMAKE_MAKE_PROGRAM CMAKE_C_COMPILER CMAKE_CXX_COMPILER CMAKE_MSVC_RUNTIME_LIBRARY
        CMAKE_C_FLAGS_MINSIZEREL CMAKE_CXX_FLAGS_MINSIZEREL CMAKE_SHARED_LINKER_FLAGS_MINSIZEREL
        GGML_NATIVE GGML_AVX GGML_AVX2 GGML_FMA GGML_F16C GGML_AVX512)
    if(DEFINED ${setting})
        list(APPEND TEXEL_VISION_ARGS "-D${setting}=${${setting}}")
    endif()
endforeach()
ExternalProject_Add(texel-vision-build
    SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vision"
    BINARY_DIR "${TEXEL_VISION_BINARY_DIR}"
    DOWNLOAD_COMMAND ""
    UPDATE_COMMAND ""
    CMAKE_ARGS ${TEXEL_VISION_ARGS}
        "-DCMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE}"
        "-DCMAKE_ARCHIVE_OUTPUT_DIRECTORY=${TEXEL_VISION_LIBRARY_DIR}"
        "-DTEXEL_MIGAN_SOURCE=${CMAKE_CURRENT_SOURCE_DIR}/src/migan.cpp"
        "-DTEXEL_MIGAN_INCLUDE=${CMAKE_CURRENT_SOURCE_DIR}/include"
        "-DTEXEL_VULKAN_RUNTIME_INCLUDE=${TEXEL_VULKAN_RUNTIME_INCLUDE}"
        "-DTEXEL_VOLK_SOURCE_DIR=${TEXEL_VOLK_SOURCE_DIR}"
    BUILD_COMMAND "${CMAKE_COMMAND}" --build <BINARY_DIR> --config $<CONFIG> --target visioncpp
    BUILD_BYPRODUCTS
        "${TEXEL_VISION_LIBRARY_DIR}/visioncpp.lib"
        "${TEXEL_VISION_LIBRARY_DIR}/ggml.lib"
        "${TEXEL_VISION_LIBRARY_DIR}/ggml-base.lib"
        "${TEXEL_VISION_LIBRARY_DIR}/ggml-cpu.lib"
        "${TEXEL_VISION_LIBRARY_DIR}/ggml-vulkan.lib"
        "${TEXEL_VISION_LIBRARY_DIR}/stb.lib"
    BUILD_ALWAYS TRUE
    INSTALL_COMMAND ""
)

set(TEXEL_PREFIXED_LIBRARY_DIR "${CMAKE_BINARY_DIR}/vision-prefixed")
set(TEXEL_PREFIXED_STAMP "${TEXEL_PREFIXED_LIBRARY_DIR}/complete.stamp")
set(TEXEL_VISION_LIBRARY_PATHS)
set(TEXEL_PREFIXED_LIBRARY_PATHS)
foreach(library ${TEXEL_VISION_LIBRARIES})
    list(APPEND TEXEL_VISION_LIBRARY_PATHS "${TEXEL_VISION_LIBRARY_DIR}/${library}.lib")
    list(APPEND TEXEL_PREFIXED_LIBRARY_PATHS "${TEXEL_PREFIXED_LIBRARY_DIR}/${library}.lib")
endforeach()
add_custom_command(
    OUTPUT "${TEXEL_PREFIXED_STAMP}"
    BYPRODUCTS ${TEXEL_PREFIXED_LIBRARY_PATHS}
    COMMAND node "${CMAKE_CURRENT_SOURCE_DIR}/tools/prefix-archives.mjs"
        "${TEXEL_PREFIXED_LIBRARY_DIR}" -- ${TEXEL_VISION_LIBRARY_PATHS}
    DEPENDS texel-vision-build ${TEXEL_VISION_LIBRARY_PATHS} "${CMAKE_CURRENT_SOURCE_DIR}/tools/prefix-archives.mjs"
    COMMENT "Isolate vision.cpp's private GGML revision"
)
add_custom_target(texel-vision-prefix DEPENDS "${TEXEL_PREFIXED_STAMP}")

set(TEXEL_PREFIXED_TARGETS)
foreach(library ${TEXEL_VISION_LIBRARIES})
    set(target "texel-vision-${library}")
    add_library(${target} STATIC IMPORTED GLOBAL)
    set_target_properties(${target} PROPERTIES IMPORTED_LOCATION "${TEXEL_PREFIXED_LIBRARY_DIR}/${library}.lib")
    add_dependencies(${target} texel-vision-prefix)
    list(APPEND TEXEL_PREFIXED_TARGETS ${target})
endforeach()

add_library(texel-local-ai-vulkan SHARED
    src/backend.cpp
    src/shader-runtime.cpp
    src/vulkan-runtime.cpp
)
target_include_directories(texel-local-ai-vulkan PRIVATE
    include
    ../third_party/stable-diffusion.cpp/thirdparty
    ../third_party/volk
)
target_compile_definitions(texel-local-ai-vulkan PRIVATE
    VK_NO_PROTOTYPES
    VK_USE_PLATFORM_WIN32_KHR
    NOMINMAX
    _CRT_SECURE_NO_WARNINGS
)
target_link_libraries(texel-local-ai-vulkan PRIVATE
    stable-diffusion
    zip
    volk
    ${TEXEL_PREFIXED_TARGETS}
)
set_target_properties(texel-local-ai-vulkan PROPERTIES PREFIX "")

install(TARGETS texel-local-ai-vulkan RUNTIME DESTINATION . LIBRARY DESTINATION .)
install(FILES ../third_party/stable-diffusion.cpp/LICENSE DESTINATION licenses RENAME stable-diffusion.txt)
install(FILES ../third_party/stable-diffusion.cpp/ggml/LICENSE DESTINATION licenses RENAME ggml.txt)
install(FILES ../third_party/vision.cpp/LICENSE DESTINATION licenses RENAME vision.cpp.txt)
install(FILES ../third_party/vision.cpp/depend/llama/LICENSE DESTINATION licenses RENAME vision-ggml.txt)
install(FILES ../third_party/volk/LICENSE.md DESTINATION licenses RENAME volk.txt)
