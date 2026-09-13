cmake_minimum_required(VERSION 3.28)
project(texel_local_ai_host LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(USE_TLS OFF CACHE BOOL "" FORCE)
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
add_subdirectory(../third_party/IXWebSocket ixwebsocket)

add_executable(texel-local-ai src/main.cpp)
target_include_directories(texel-local-ai PRIVATE include)
target_link_libraries(texel-local-ai PRIVATE ixwebsocket)
target_compile_definitions(texel-local-ai PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX)

install(TARGETS texel-local-ai RUNTIME DESTINATION .)
install(FILES ../third_party/IXWebSocket/LICENSE.txt DESTINATION licenses RENAME IXWebSocket.txt)
