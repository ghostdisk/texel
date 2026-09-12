if(NOT WIN32)
    message(FATAL_ERROR "The distribution runtime currently targets Windows.")
endif()

# clang-cl builds must not depend on a Visual Studio developer shell for DLL discovery.
find_program(TEXEL_OBJDUMP llvm-objdump REQUIRED)
set(CMAKE_GET_RUNTIME_DEPENDENCIES_PLATFORM windows+pe)
set(CMAKE_GET_RUNTIME_DEPENDENCIES_TOOL objdump)
set(CMAKE_GET_RUNTIME_DEPENDENCIES_COMMAND "${TEXEL_OBJDUMP}")
install(CODE "
    set(CMAKE_GET_RUNTIME_DEPENDENCIES_PLATFORM windows+pe)
    set(CMAKE_GET_RUNTIME_DEPENDENCIES_TOOL objdump)
    set(CMAKE_GET_RUNTIME_DEPENDENCIES_COMMAND \"${TEXEL_OBJDUMP}\")
" COMPONENT texel-runtime)

install(TARGETS imged-native
    RUNTIME_DEPENDENCY_SET texel-runtime
    RUNTIME DESTINATION . COMPONENT texel-runtime
)
install(RUNTIME_DEPENDENCY_SET texel-runtime
    DIRECTORIES "$<TARGET_FILE_DIR:imged-native>" "${CMAKE_CURRENT_SOURCE_DIR}/../node_modules/electron/dist" "$ENV{VULKAN_SDK}/Bin" "$ENV{CUDA_PATH}/bin"
    PRE_EXCLUDE_REGEXES "api-ms-.*" "ext-ms-.*"
    POST_EXCLUDE_REGEXES ".*[/\\\\][Ww][Ii][Nn][Dd][Oo][Ww][Ss][/\\\\].*"
    RUNTIME DESTINATION . COMPONENT texel-runtime
)

# electron-builder copies its Vulkan loader beside the native executable after packaging.
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/models.json" DESTINATION . COMPONENT texel-runtime)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/stable-diffusion.cpp/LICENSE" DESTINATION licenses RENAME stable-diffusion.txt COMPONENT texel-runtime)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/stable-diffusion.cpp/ggml/LICENSE" DESTINATION licenses RENAME ggml.txt COMPONENT texel-runtime)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/IXWebSocket/LICENSE.txt" DESTINATION licenses RENAME IXWebSocket.txt COMPONENT texel-runtime)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/vision.cpp/LICENSE" DESTINATION licenses RENAME vision.cpp.txt COMPONENT texel-runtime)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/vision.cpp/depend/llama/LICENSE" DESTINATION licenses RENAME vision-ggml.txt COMPONENT texel-runtime)
