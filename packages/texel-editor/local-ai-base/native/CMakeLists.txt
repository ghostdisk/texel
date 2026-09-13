cmake_minimum_required(VERSION 3.28)
project(texel_local_ai_host LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
add_executable(texel-local-ai src/main.cpp src/websocket-server.cpp)
target_include_directories(texel-local-ai PRIVATE include)
target_link_libraries(texel-local-ai PRIVATE ws2_32)
target_compile_definitions(texel-local-ai PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX)

install(TARGETS texel-local-ai RUNTIME DESTINATION .)
